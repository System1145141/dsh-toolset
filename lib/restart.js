/**
 * dsh-toolset — safe restart controller (Host side).
 *
 * The tool schedules a restart; this controller waits until every Agent, every
 * queued inbox message and every background job is idle before asking a
 * detached helper to relaunch the desktop app. The helper (restart-helper.ps1)
 * is created through WMI so it survives the Electron tree teardown, and the
 * pre-restart request file it reads is written here.
 *
 * The controller only schedules and arms; it never waits synchronously for the
 * process teardown (the process dies during it).
 */

import { readFile, writeFile, rename, mkdir, unlink, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

/** A restart is armed only after this much continuous idleness. */
export const DEFAULT_QUIET_MS = 2000;
/** Ticker cadence for the idleness check. */
export const DEFAULT_TICK_MS = 500;
/** A request file older than this is ignored on startup. */
export const MARKER_MAX_AGE_MS = 30 * 60 * 1000;
/** How long the Host waits for the detached helper to prove it started. */
export const DEFAULT_ACK_TIMEOUT_MS = 4000;
/** Helper-start log polling cadence. */
export const DEFAULT_ACK_POLL_MS = 150;

/**
 * Whether this Host can restart the desktop app at all.
 * Only the packaged Desktop profile runs under Electron; a plain `dsh web`
 * CLI process has no app shell to relaunch.
 * @param {NodeJS.Process} env - process-like object (injectable for tests).
 * @returns {boolean} whether the safe-restart feature can run here.
 */
export function isRestartSupported(env = process) {
  return (
    env?.platform === 'win32' &&
    typeof env?.versions?.electron === 'string' &&
    Number.isInteger(env?.ppid) &&
    env.ppid > 1
  );
}

/** @returns {string} absolute restart request path inside the package. */
export function markerPath(packageDir) {
  return join(packageDir, 'restart-request.json');
}

/** @returns {string} absolute helper log path inside the package. */
export function restartLogPath(packageDir) {
  return join(packageDir, 'restart.log');
}

/** @returns {string} absolute helper script path inside the package. */
export function helperPath(packageDir) {
  return join(packageDir, 'restart-helper.ps1');
}

/** Atomically write one JSON file. */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

/** Read and parse one JSON file; undefined when missing or malformed. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Remove a file, ignoring absence. */
async function removeFile(path) {
  try {
    await unlink(path);
  } catch {
    // Already gone.
  }
}

/** Let one idle check pass. */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether it is safe to stop the Host right now: no running Agent, no queued
 * inbox input, and no running/stopping background job.
 * @param {object} ctx - Host context with optional agents/jobs services.
 * @returns {boolean} true when nothing interruptible is live.
 */
export function isIdleForRestart(ctx) {
  const agents = ctx.get?.('agents');
  if (agents === undefined) return false;
  let list;
  try {
    list = agents.list();
  } catch {
    return false;
  }
  for (const agent of list) {
    if (agent.status === 'running') return false;
    const inbox = agent.inbox;
    if (inbox !== undefined) {
      if (Array.isArray(inbox.nextTurn) && inbox.nextTurn.length > 0) return false;
      if (Array.isArray(inbox.nextStep) && inbox.nextStep.length > 0) return false;
    }
  }
  const jobs = ctx.get?.('jobs');
  if (jobs !== undefined) {
    const callers = [undefined, ...list.map((agent) => agent.id)];
    for (const caller of callers) {
      let rows;
      try {
        rows = jobs.list(caller);
      } catch {
        rows = [];
      }
      if (rows.some((job) => job.status === 'running' || job.status === 'stopping')) return false;
    }
  }
  return true;
}

/**
 * Build the PowerShell command that creates the helper outside this process
 * tree through WMI `Win32_Process.Create`. The created process is parented by
 * WmiPrvSE, so killing the Electron tree does not kill it.
 *
 * The inner command line keeps its double quotes inside a PowerShell
 * single-quoted literal, so the `-Command` payload itself contains no double
 * quotes and Node's argv quoting cannot break it (verified on Windows).
 * @param {string} scriptPath - absolute helper script path.
 * @param {string} requestPath - absolute request JSON path.
 * @param {string} [logPath] - optional absolute helper log path (defaults next to the script).
 * @returns {{ commandLine: string, psCommand: string }} helper command line and the PowerShell -Command text.
 */
export function helperLaunchCommand(scriptPath, requestPath, logPath) {
  if (/[\r\n]/u.test(scriptPath) || /[\r\n]/u.test(requestPath) || (logPath !== undefined && /[\r\n]/u.test(logPath))) {
    throw new Error('restart helper path contains an unsupported character');
  }
  const logArgument = logPath === undefined ? '' : ` -LogPath "${logPath}"`;
  const inner = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}" -RequestPath "${requestPath}"${logArgument}`;
  const literal = `'${inner.replace(/'/gu, "''")}'`;
  const psCommand = [
    "$ErrorActionPreference='Stop';",
    '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine =',
    `${literal} };`,
    '@{ ReturnValue=[int]$r.ReturnValue; ProcessId=[int]$r.ProcessId } | ConvertTo-Json -Compress',
  ].join(' ');
  return { commandLine: inner, psCommand };
}

/**
 * Create the restart controller for one Host context.
 * @param {object} options - controller dependencies.
 * @param {object} options.ctx - Host context (`agents`, `jobs`, `effect`).
 * @param {string} options.packageDir - plugin package directory.
 * @param {(message: string) => void} [options.log] - diagnostic sink.
 * @param {() => number} [options.now] - clock (injectable for tests).
 * @param {(command: string, args: string[], options: object) => unknown} [options.spawn] - process spawner.
 * @param {number} [options.quietMs] - continuous idleness before arming.
 * @param {number} [options.tickMs] - idleness check cadence.
 * @returns {object} controller with schedule/cancel/pending/dispose/check.
 */
export function createRestartController(options) {
  const {
    ctx,
    packageDir,
    log = () => {},
    now = Date.now,
    spawn = nodeSpawn,
    quietMs = DEFAULT_QUIET_MS,
    tickMs = DEFAULT_TICK_MS,
    ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
    ackPollMs = DEFAULT_ACK_POLL_MS,
  } = options;
  const marker = markerPath(packageDir);
  const helper = helperPath(packageDir);
  const logPath = restartLogPath(packageDir);

  let pending = null;
  let timer = null;
  let armed = false;
  let disposed = false;

  function startTicker() {
    if (timer !== null || disposed) return;
    timer = setInterval(() => {
      void check();
    }, tickMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stopTicker() {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  /** @returns {Promise<number>} current log size (0 when the file does not exist). */
  async function logSize() {
    try {
      return (await stat(logPath)).size;
    } catch {
      return 0;
    }
  }

  /**
   * Wait for the detached helper to prove it started by appending its first
   * line to restart.log. WMI create success alone does not prove the script
   * ran, so a Host that survives this window unarms the request again.
   * @param {number} baseline - log size before the helper was launched.
   * @returns {Promise<boolean>} whether the helper's start line appeared.
   */
  async function waitForHelperAck(baseline) {
    const deadline = Date.now() + ackTimeoutMs;
    while (Date.now() < deadline) {
      await defaultSleep(ackPollMs);
      let text;
      try {
        text = await readFile(logPath, 'utf8');
      } catch {
        continue;
      }
      if (text.length > baseline && text.slice(baseline).includes('helper started')) return true;
    }
    return false;
  }

  /**
   * Replace the scheduled request (one pending restart at a time).
   * @param {{ sessionId: string, reason?: string, resumePrompt?: string }} request - restart request.
   * @returns {Promise<{ status: 'scheduled' | 'updated', sessionId: string }>} accepted request summary.
   */
  async function schedule(request) {
    if (disposed) throw new Error('restart controller is disposed');
    const previous = pending;
    pending = {
      sessionId: request.sessionId,
      reason: typeof request.reason === 'string' ? request.reason.trim().slice(0, 2000) : '',
      resumePrompt: typeof request.resumePrompt === 'string' ? request.resumePrompt.trim().slice(0, 4000) : '',
      requestedAt: now(),
      quietSince: 0,
    };
    armed = false;
    await writeJson(marker, { ...pending, armed: false });
    startTicker();
    log(`dsh-toolset: safe restart ${previous === null ? 'scheduled' : 'rescheduled'} for session ${pending.sessionId}`);
    return { status: previous === null ? 'scheduled' : 'updated', sessionId: pending.sessionId };
  }

  /** Cancel any scheduled restart and forget the request file. */
  async function cancel(reason = 'cancelled') {
    stopTicker();
    if (armed) {
      // The helper may already be reading the request; deleting it now would
      // turn an in-flight restart into a silent no-op. The restart is committed.
      log(`dsh-toolset: safe restart already armed (${reason})`);
      return;
    }
    if (pending !== null) log(`dsh-toolset: safe restart cancelled (${reason})`);
    pending = null;
    await removeFile(marker).catch(() => {});
  }

  /** Arm the restart and launch the detached helper; unarms again if it never starts. */
  async function armAndLaunch() {
    if (pending === null || armed) return;
    armed = true;
    const request = {
      ...pending,
      armed: true,
      appPid: process.ppid,
      appExe: process.execPath,
      appArgs: [],
      // The desktop shell hides its window on WM_CLOSE instead of quitting, so
      // a graceful close would only hide the app and still need the forced
      // path; the Host has verified global idleness instead.
      gracefulClose: false,
      hostPid: process.pid,
      logPath,
      // Helper-side timings (milliseconds); see restart-helper.ps1.
      startDelayMs: 700,
      graceTimeoutMs: 4000,
      forceTimeoutMs: 5000,
      settleMs: 800,
    };
    try {
      await writeJson(marker, request);
      const baseline = await logSize();
      const { psCommand } = helperLaunchCommand(helper, marker, logPath);
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand], {
        windowsHide: true,
        stdio: 'ignore',
      });
      log(`dsh-toolset: restart armed for app pid ${String(request.appPid)}; waiting for helper ack`);
      const acked = await waitForHelperAck(baseline);
      if (acked) {
        log('dsh-toolset: helper acknowledged; the app is about to restart');
        return;
      }
      // The helper never started: keep the app alive and forget the request so
      // a later unrelated restart cannot auto-resume this session by surprise.
      armed = false;
      pending = null;
      await removeFile(marker).catch(() => {});
      log(`dsh-toolset: helper did not acknowledge within ${String(ackTimeoutMs)} ms; restart aborted`);
    } catch (error) {
      armed = false;
      log(`dsh-toolset: could not arm restart: ${error instanceof Error ? error.message : String(error)}`);
      if (pending !== null) pending.quietSince = now();
    }
  }

  /** Run one idleness check (the ticker calls this; tests call it directly). */
  async function check() {
    if (disposed || pending === null || armed) return;
    if (!isIdleForRestart(ctx)) {
      pending.quietSince = 0;
      return;
    }
    if (pending.quietSince === 0) {
      pending.quietSince = now();
      return;
    }
    if (now() - pending.quietSince < quietMs) return;
    await armAndLaunch();
  }

  /** Remove timers; an armed request file stays for the detached helper. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    stopTicker();
  }

  return {
    schedule,
    cancel,
    check,
    dispose,
    get pending() {
      return pending;
    },
    get armed() {
      return armed;
    },
  };
}

/**
 * Read the persisted restart request written before the previous process died.
 * @param {string} packageDir - plugin package directory.
 * @returns {Promise<object | undefined>} parsed request, if present.
 */
export function readRestartMarker(packageDir) {
  return readJson(markerPath(packageDir));
}

/** Delete the persisted restart request (after it has been claimed). */
export function clearRestartMarker(packageDir) {
  return removeFile(markerPath(packageDir));
}

/** Default continuation text used when the tool caller supplies none. */
export const DEFAULT_CONTINUATION =
  '请先核对工作区与计划的当前状态，从中断处继续完成任务，不要重复已完成的工作；如果重启前的工作已全部完成，请向用户简要说明重启结果。';

/**
 * Build the model-visible continuation message injected after a restart.
 * @param {{ reason?: string, resumePrompt?: string, requestedAt?: number }} marker - restart request.
 * @returns {string} continuation text wrapped as a system notice.
 */
export function composeContinuation(marker) {
  const parts = ['（系统通知：DeepSeek Harness 已按 dsh_safe_restart 工具请求完成重启，当前会话已自动恢复。'];
  const reason = typeof marker?.reason === 'string' ? marker.reason.trim() : '';
  if (reason !== '') parts.push(`重启原因：${reason}。`);
  const resumePrompt = typeof marker?.resumePrompt === 'string' ? marker.resumePrompt.trim() : '';
  parts.push(resumePrompt !== '' ? resumePrompt : DEFAULT_CONTINUATION);
  parts.push('）');
  return parts.join('');
}

export { writeJson, readJson, defaultSleep };
