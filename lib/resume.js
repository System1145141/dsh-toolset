/**
 * dsh-toolset — post-restart session resume (Host side).
 *
 * On the first boot after a safe restart, the previous process left an armed
 * `restart-request.json` behind. This module resumes the recorded Session
 * through the Host's own session controller (so the Agent preset composition
 * and writer ownership rules stay authoritative) and then queues one
 * continuation message with `agent.followup()`.
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { composeContinuation, markerPath } from './restart.js';

/** A marker older than this is not honored (avoids a stale auto-resume). */
export const RESUME_MAX_AGE_MS = 30 * 60 * 1000;

/** Delay before the first resume attempt, letting Host services finish booting. */
export const DEFAULT_RESUME_DELAY_MS = 1500;
/** Bound on resume attempts. */
export const DEFAULT_RESUME_ATTEMPTS = 40;

/**
 * Create one identified, frozen user-role message for `agent.followup()`.
 * Mirrors `createUserMessage` from the shipped LLM package without importing
 * it (a linked local plugin cannot resolve the installation's packages).
 * @param {string} text - message text.
 * @returns {object} user message accepted by the Agent inbox.
 */
export function createUserMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Read an armed marker from the package directory.
 * @param {string} packageDir - plugin package directory.
 * @returns {Promise<object | undefined>} marker when armed and structurally usable.
 */
export async function readArmedMarker(packageDir) {
  let raw;
  try {
    raw = JSON.parse(await readFile(markerPath(packageDir), 'utf8'));
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object' || raw.armed !== true) return undefined;
  if (typeof raw.sessionId !== 'string' || raw.sessionId === '') return undefined;
  return raw;
}

/**
 * Resume the Session recorded in the restart marker and queue the continuation.
 * @param {object} options - resume dependencies.
 * @param {string} options.packageDir - plugin package directory.
 * @param {{ resolveAgent: (sessionId: string) => Promise<object> }} options.sessionController - Host session controller.
 * @param {(message: string) => void} [options.log] - diagnostic sink.
 * @param {() => number} [options.now] - clock (injectable for tests).
 * @param {(ms: number) => Promise<void>} [options.sleep] - delay helper (injectable for tests).
 * @param {number} [options.retryDelayMs] - delay between attempts.
 * @param {number} [options.maxAttempts] - attempt bound.
 * @returns {Promise<{ status: 'skipped' | 'resumed' | 'failed', reason?: string }>} outcome.
 */
export async function resumeAfterRestart(options) {
  const {
    packageDir,
    sessionController,
    log = () => {},
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    retryDelayMs = 1000,
    maxAttempts = DEFAULT_RESUME_ATTEMPTS,
  } = options;

  const marker = await readArmedMarker(packageDir);
  if (marker === undefined) return { status: 'skipped', reason: 'no armed restart request' };
  if (now() - Number(marker.requestedAt ?? 0) > RESUME_MAX_AGE_MS) {
    await removeQuietly(markerPath(packageDir));
    return { status: 'skipped', reason: 'stale restart request' };
  }
  // Claim the request once: a later reboot must not resume this session again.
  await removeQuietly(markerPath(packageDir));

  const continuation = composeContinuation(marker);
  let lastError = 'unknown resume failure';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await sessionController.resolveAgent(marker.sessionId);
      if (result !== null && typeof result === 'object' && result.error !== undefined) {
        throw new Error(`session controller rejected resume: ${String(result.error?.message ?? result.error)}`);
      }
      const agent = result?.agent;
      if (agent === undefined || typeof agent.followup !== 'function') throw new Error('session controller returned no resumable Agent');
      agent.followup(createUserMessage(continuation));
      log(`dsh-toolset: session ${marker.sessionId} resumed after restart (attempt ${String(attempt)})`);
      return { status: 'resumed' };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log(`dsh-toolset: post-restart resume attempt ${String(attempt)} failed: ${lastError}`);
      if (attempt < maxAttempts) await sleep(retryDelayMs);
    }
  }

  await writeJson(join(packageDir, 'restart-resume-failed.json'), {
    failedAt: now(),
    sessionId: marker.sessionId,
    error: lastError,
  }).catch(() => {});
  return { status: 'failed', reason: lastError };
}

/** Resolve the continuation that would be injected (diagnostics only). */
export function continuationFor(marker) {
  return composeContinuation(marker);
}

async function removeQuietly(path) {
  try {
    await unlink(path);
  } catch {
    // Already gone or unlinkable; the caller continues either way.
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
