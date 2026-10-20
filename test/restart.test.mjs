import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  composeContinuation,
  createRestartController,
  helperLaunchCommand,
  isIdleForRestart,
  isRestartSupported,
  markerPath,
  readRestartMarker,
} from '../lib/restart.js';

function fakeCtx(state) {
  return {
    get(key) {
      if (key === 'agents') return state.agents === undefined ? undefined : { list: () => state.agents };
      if (key === 'jobs') return state.jobs;
      return undefined;
    },
  };
}

test('isRestartSupported only accepts a Windows Electron Host', () => {
  assert.equal(isRestartSupported({ platform: 'win32', versions: { electron: '32.0.0' }, ppid: 42 }), true);
  assert.equal(isRestartSupported({ platform: 'linux', versions: { electron: '32.0.0' }, ppid: 42 }), false);
  assert.equal(isRestartSupported({ platform: 'win32', versions: {}, ppid: 42 }), false);
  assert.equal(isRestartSupported({ platform: 'win32', versions: { electron: '32.0.0' }, ppid: 0 }), false);
  assert.equal(isRestartSupported(undefined), false);
});

test('helper launch command creates the helper outside the process tree', () => {
  const script = 'C:\\1\\Task\\dsh-toolset\\restart-helper.ps1';
  const request = 'C:\\1\\Task\\dsh-toolset\\restart-request.json';
  const { commandLine, psCommand } = helperLaunchCommand(script, request);
  assert.match(commandLine, /^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\1\\Task\\dsh-toolset\\restart-helper\.ps1" -RequestPath "C:\\1\\Task\\dsh-toolset\\restart-request\.json"$/u);
  assert.match(psCommand, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/u);
  assert.match(psCommand, /CommandLine = '/u);
  assert.match(psCommand, /ReturnValue/u);
  assert.match(psCommand, /ConvertTo-Json/u);
  assert.throws(() => helperLaunchCommand('C:\\bad\npath.ps1', request));
});

test('continuation message carries reason and custom prompt', () => {
  const custom = composeContinuation({ reason: 'load new plugin', resumePrompt: '继续完成剩余测试。' });
  assert.match(custom, /已按 dsh_safe_restart 工具请求完成重启/u);
  assert.match(custom, /重启原因：load new plugin/u);
  assert.match(custom, /继续完成剩余测试/u);
  const fallback = composeContinuation({});
  assert.match(fallback, /从中断处继续完成任务/u);
  assert.equal(fallback.startsWith('（系统通知：'), true);
  assert.equal(fallback.endsWith('）'), true);
});

test('idle gate rejects running agents, queued inbox input and live jobs', () => {
  const agent = { id: 's1', status: 'running', inbox: { nextTurn: [], nextStep: [] } };
  assert.equal(isIdleForRestart(fakeCtx({ agents: [agent] })), false);
  agent.status = 'idle';
  assert.equal(isIdleForRestart(fakeCtx({ agents: [agent] })), true);
  agent.inbox.nextStep = [{}];
  assert.equal(isIdleForRestart(fakeCtx({ agents: [agent] })), false);
  agent.inbox.nextStep = [];
  const jobs = { list: (caller) => (caller === 's1' ? [{ status: 'running' }] : []) };
  assert.equal(isIdleForRestart(fakeCtx({ agents: [agent], jobs })), false);
  jobs.list = () => [];
  assert.equal(isIdleForRestart(fakeCtx({ agents: [agent], jobs })), true);
  assert.equal(isIdleForRestart(fakeCtx({ agents: undefined })), false);
});

test('controller waits for a quiet window, arms the marker and spawns one helper', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-toolset-restart-'));
  const spawned = [];
  let nowValue = 1_000;
  const agent = { id: 's1', status: 'running', inbox: { nextTurn: [], nextStep: [] } };
  const controller = createRestartController({
    ctx: fakeCtx({ agents: [agent] }),
    packageDir: dir,
    now: () => nowValue,
    spawn: (command, args, options) => {
      spawned.push({ command, args, options });
      // Play the detached helper: its first log line proves it started.
      void writeFile(join(dir, 'restart.log'), '[test] helper started\n', { flag: 'a' });
      return { unref() {} };
    },
    quietMs: 2000,
    ackTimeoutMs: 500,
    ackPollMs: 20,
  });
  try {
    const scheduled = await controller.schedule({ sessionId: 's1', reason: 'test' });
    assert.equal(scheduled.status, 'scheduled');
    assert.equal(controller.armed, false);
    let marker = await readRestartMarker(dir);
    assert.equal(marker.armed, false);
    assert.equal(marker.sessionId, 's1');

    await controller.check();
    assert.equal(controller.armed, false);

    agent.status = 'idle';
    nowValue = 2_000;
    await controller.check();
    assert.equal(controller.armed, false);
    nowValue = 3_000;
    await controller.check();
    assert.equal(controller.armed, false);

    nowValue = 4_000;
    await controller.check();
    assert.equal(controller.armed, true);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].command, 'powershell.exe');
    assert.match(spawned[0].args.join(' '), /Win32_Process/u);

    marker = await readRestartMarker(dir);
    assert.equal(marker.armed, true);
    assert.equal(marker.appPid, process.ppid);
    assert.equal(marker.hostPid, process.pid);
    assert.equal(marker.gracefulClose, false);
    assert.deepEqual(marker.appArgs, []);
    assert.equal(marker.startDelayMs, 700);
    assert.equal(marker.forceTimeoutMs, 5000);
  } finally {
    controller.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a helper that never acknowledges unarms the request again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-toolset-restart-'));
  let nowValue = 1_000;
  const agent = { id: 's1', status: 'idle', inbox: { nextTurn: [], nextStep: [] } };
  const controller = createRestartController({
    ctx: fakeCtx({ agents: [agent] }),
    packageDir: dir,
    now: () => nowValue,
    spawn: () => ({ unref() {} }),
    quietMs: 100,
    ackTimeoutMs: 150,
    ackPollMs: 20,
  });
  try {
    await controller.schedule({ sessionId: 's1' });
    nowValue = 2_000;
    await controller.check();
    nowValue = 2_500;
    await controller.check();
    assert.equal(controller.armed, false, 'failed helper is not left armed');
    await assert.rejects(readFile(markerPath(dir), 'utf8'));
  } finally {
    controller.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rescheduling replaces the pending request; cancel removes an unarmed marker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-toolset-restart-'));
  const controller = createRestartController({
    ctx: fakeCtx({ agents: [{ id: 's1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] }),
    packageDir: dir,
    spawn: () => ({ unref() {} }),
  });
  try {
    assert.equal((await controller.schedule({ sessionId: 's1' })).status, 'scheduled');
    assert.equal((await controller.schedule({ sessionId: 's1', reason: 'again' })).status, 'updated');
    await controller.cancel('test');
    await assert.rejects(readFile(markerPath(dir), 'utf8'));
  } finally {
    controller.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
