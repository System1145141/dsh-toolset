import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeContinuation } from '../lib/restart.js';
import { createUserMessage, resumeAfterRestart } from '../lib/resume.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-toolset-resume-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('createUserMessage builds a frozen user message with one text block', () => {
  const message = createUserMessage('hello');
  assert.equal(message.role, 'user');
  assert.equal(typeof message.id, 'string');
  assert.deepEqual(message.source, { kind: 'user' });
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }]);
  assert.equal(Object.isFrozen(message), true);
  assert.equal(Object.isFrozen(message.content[0]), true);
});

test('resume claims the marker, resumes through the session controller and follows up', async () => {
  await withTempDir(async (dir) => {
    const marker = {
      armed: true,
      requestedAt: Date.now(),
      sessionId: 'session-1',
      reason: 'apply plugin update',
      resumePrompt: '继续验证插件。',
    };
    await writeFile(join(dir, 'restart-request.json'), JSON.stringify(marker));
    const followed = [];
    const result = await resumeAfterRestart({
      packageDir: dir,
      sessionController: {
        resolveAgent: async (sessionId) => {
          assert.equal(sessionId, 'session-1');
          return { agent: { followup: (message) => followed.push(message) } };
        },
      },
      retryDelayMs: 0,
      maxAttempts: 2,
    });
    assert.deepEqual(result, { status: 'resumed' });
    assert.equal(followed.length, 1);
    assert.equal(followed[0].role, 'user');
    assert.match(followed[0].content[0].text, /已按 dsh_safe_restart 工具请求完成重启/);
    assert.match(followed[0].content[0].text, /apply plugin update/);
    assert.match(followed[0].content[0].text, /继续验证插件/);
    await assert.rejects(readFile(join(dir, 'restart-request.json'), 'utf8'));
  });
});

test('resume retries transient failures and succeeds on a later attempt', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'restart-request.json'), JSON.stringify({ armed: true, requestedAt: Date.now(), sessionId: 's' }));
    let attempts = 0;
    const result = await resumeAfterRestart({
      packageDir: dir,
      sessionController: {
        resolveAgent: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error('writer held');
          return { agent: { followup: () => {} } };
        },
      },
      retryDelayMs: 0,
      maxAttempts: 5,
    });
    assert.deepEqual(result, { status: 'resumed' });
    assert.equal(attempts, 3);
  });
});

test('resume reports a failure file after exhausting attempts', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'restart-request.json'), JSON.stringify({ armed: true, requestedAt: Date.now(), sessionId: 's' }));
    const result = await resumeAfterRestart({
      packageDir: dir,
      sessionController: { resolveAgent: async () => ({ error: { message: 'session/not-found' } }) },
      retryDelayMs: 0,
      maxAttempts: 2,
    });
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /session\/not-found/);
    const failed = JSON.parse(await readFile(join(dir, 'restart-resume-failed.json'), 'utf8'));
    assert.equal(failed.sessionId, 's');
  });
});

test('resume ignores unarmed, stale or missing markers', async () => {
  await withTempDir(async (dir) => {
    const controller = {
      resolveAgent: async () => {
        throw new Error('must not be called');
      },
    };
    assert.equal((await resumeAfterRestart({ packageDir: dir, sessionController: controller })).status, 'skipped');
    await writeFile(join(dir, 'restart-request.json'), JSON.stringify({ armed: false, requestedAt: Date.now(), sessionId: 's' }));
    assert.equal((await resumeAfterRestart({ packageDir: dir, sessionController: controller })).status, 'skipped');
    await writeFile(join(dir, 'restart-request.json'), JSON.stringify({ armed: true, requestedAt: Date.now() - 60 * 60 * 1000, sessionId: 's' }));
    assert.equal((await resumeAfterRestart({ packageDir: dir, sessionController: controller })).status, 'skipped');
  });
});

test('continuation composition is stable for the same marker', () => {
  const marker = { reason: 'x', resumePrompt: 'y' };
  assert.equal(composeContinuation(marker), composeContinuation(marker));
});
