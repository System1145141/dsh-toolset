/**
 * dsh-toolset — Host half.
 *
 * Owns the per-feature switches for the toolset bundle and persists them in
 * `state.json` beside this file. The Client half reads and writes them through
 * a small same-origin JSON API; the switches themselves are intentionally NOT
 * a Loader `Config` object, because this package is installed as a linked
 * local directory and therefore cannot depend on `@deepseek-ai/schemastery`
 * at runtime (a linked package's dependencies are not installed by the
 * profile). Keeping the state in a plain JSON file keeps the Host half
 * dependency-free and works for every number of features a later version adds.
 *
 * Feature 1 (`request-status`) is Client-only. Feature 2 (`safe-restart`) adds
 * the `dsh_safe_restart` tool here on the Host: it waits for global idleness,
 * leaves an armed request file, and a WMI-detached PowerShell helper relaunches
 * the desktop app; on the next boot the new process resumes the session and
 * queues a continuation message (see lib/restart.js and lib/resume.js).
 *
 * Security posture: the route only accepts JSON POST bodies. A browser sends
 * a CORS preflight for a cross-origin JSON POST and this route never answers
 * one, so a hosted page cannot flip switches; GET is not served at all.
 */

import { readFile, writeFile, mkdir, rename, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_FEATURES, FEATURE_IDS, normalizeFeatures } from './lib/features.js';
import {
  buildMessages,
  chatCompletion,
  createAskModelTool,
  isLocalEndpoint,
  normalizeAskModelState,
  normalizeConnection,
  secretRefFor,
} from './lib/ask-model.js';
import { createPromptTuning } from './lib/prompt-tuning.js';
import { createRestartController, isRestartSupported } from './lib/restart.js';
import { readArmedMarker, resumeAfterRestart } from './lib/resume.js';
import { createSafeRestartTool } from './lib/tool.js';

/** Same-origin JSON API surface. */
const API_PREFIX = '/plugins/dsh-toolset/api';
/** Upper bound for one request body. */
const MAX_BODY_BYTES = 64 * 1024;
/** Delay before the first post-restart resume attempt (Host services and the Web shell still boot). */
const STARTUP_RESUME_DELAY_MS = 5000;

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(PACKAGE_DIR, 'state.json');

/** Plugin state; loaded once and rewritten after every accepted change. */
let state;
let loadTask;
/** Host-side feature listeners (tool gating). */
const featureListeners = new Set();
/** Host-side ask-model connection listeners (tool description refresh). */
const askModelListeners = new Set();
/** Empty ask-model registry. */
const EMPTY_ASK_MODEL = { connections: [], defaultId: '' };

/** @returns {boolean} whether the safe-restart capability exists in this environment. */
function restartSupported() {
  return isRestartSupported();
}

/** @returns {boolean} whether one feature is currently enabled. */
function featureEnabled(id) {
  return state?.features?.[id] !== false;
}

/** Notify Host-side consumers after the feature map changed. */
function publishFeatureChange() {
  for (const listener of [...featureListeners]) {
    try {
      listener();
    } catch {
      // A broken listener must not break the others.
    }
  }
}

/** Subscribe to Host-side feature changes. @returns {() => void} unsubscribe. */
function subscribeFeatureChange(listener) {
  featureListeners.add(listener);
  return () => featureListeners.delete(listener);
}

/** Notify Host-side consumers after the ask-model registry changed. */
function publishAskModelChange() {
  for (const listener of [...askModelListeners]) {
    try {
      listener();
    } catch {
      // A broken listener must not break the others.
    }
  }
}

/** Subscribe to ask-model registry changes. @returns {() => void} unsubscribe. */
function subscribeAskModelChange(listener) {
  askModelListeners.add(listener);
  return () => askModelListeners.delete(listener);
}

function log(message) {
  const line = `[${new Date().toISOString()}] [host] ${message}\n`;
  try {
    console.log(`[dsh-toolset] ${message}`);
  } catch {
    // Console unavailable during teardown.
  }
  // A file log survives the process restart, so the resumed session and the
  // user can diagnose a failed restart. Best effort only.
  void appendFile(join(PACKAGE_DIR, 'restart.log'), line, 'utf8').catch(() => {});
}

async function loadState() {
  state ??= { features: { ...DEFAULT_FEATURES }, askModel: { ...EMPTY_ASK_MODEL } };
  if (loadTask !== undefined) return loadTask;
  loadTask = (async () => {
    try {
      const parsed = JSON.parse(await readFile(STATE_PATH, 'utf8'));
      state = {
        features: normalizeFeatures(parsed?.features),
        askModel: normalizeAskModelState(parsed?.askModel),
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // A corrupt state file must not disable the plugin: fall back to defaults.
        state = { features: { ...DEFAULT_FEATURES }, askModel: { ...EMPTY_ASK_MODEL } };
      }
    }
    return state;
  })();
  return loadTask;
}

async function persistState() {
  try {
    await mkdir(PACKAGE_DIR, { recursive: true });
    const tempPath = `${STATE_PATH}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tempPath, STATE_PATH);
  } catch {
    // Read-only package directory: keep the in-memory value for this process.
  }
}

/** Reply with one JSON envelope. */
function replyJson(res, statusCode, body) {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** Read and parse one bounded JSON request body. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering but drain the request so the caller can still answer
        // with a JSON error instead of tearing the socket down mid-upload.
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) {
        reject(new Error('request body too large'));
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** The Host capability block shared by both API methods. */
function capabilities(ctx) {
  return {
    safeRestart: restartSupported(),
    // Prompt tuning writes Agent presets through the registry and the profile
    // patch; deployments without either surface cannot use it.
    promptTuning: Boolean(ctx?.get?.('agentPresets') && ctx?.get?.('profileContext')),
    // Ask-model itself needs no Host service; API keys use the credential store
    // when the deployment has one.
    askModel: true,
    askModelSecureStorage: ctx?.get?.('credentials') !== undefined,
  };
}

/** `features.get` — read the accepted switch values and Host capabilities. */
async function featuresGet(payload, ctx) {
  await loadState();
  return { features: state.features, capabilities: capabilities(ctx) };
}

/** `features.set` — flip one switch, persist it, and reconcile Host features. */
async function featuresSet(payload, ctx) {
  const id = typeof payload?.id === 'string' ? payload.id : '';
  if (!FEATURE_IDS.includes(id)) throw new Error(`unknown feature "${id}"`);
  if (typeof payload?.enabled !== 'boolean') throw new Error('"enabled" must be a boolean');
  await loadState();
  state = { features: { ...state.features, [id]: payload.enabled } };
  await persistState();
  publishFeatureChange();
  return { features: state.features, capabilities: capabilities(ctx) };
}

/** Resolve the Host services prompt tuning needs, or explain why it cannot run. */
function promptTuningController(ctx) {
  const agentPresets = ctx?.get?.('agentPresets');
  const profileContext = ctx?.get?.('profileContext');
  if (agentPresets === undefined || profileContext === undefined || typeof profileContext.patchPath !== 'string') {
    throw new Error('this deployment has no agent-preset registry or profile patch');
  }
  const hmr = ctx?.get?.('hmr');
  return createPromptTuning({
    agentPresets,
    patchPath: profileContext.patchPath,
    hmr: hmr !== undefined && typeof hmr.reconcileProfile === 'function' && typeof hmr.runExclusive === 'function' ? hmr : undefined,
    log,
  });
}

/** Refuse prompt-tuning calls while the feature switch is off. */
function requirePromptTuning() {
  if (!featureEnabled('prompt-tuning')) throw new Error('the prompt-tuning feature is disabled');
}

/** `prompt-tuning.get` — roster plus the presets this feature manages. */
async function promptTuningGet(payload, ctx) {
  requirePromptTuning();
  return promptTuningController(ctx).list();
}

/** `prompt-tuning.base` — the editable persona of one base preset. */
async function promptTuningBase(payload, ctx) {
  requirePromptTuning();
  return promptTuningController(ctx).base(payload?.presetId);
}

/** `prompt-tuning.save` — create or update one managed preset. */
async function promptTuningSave(payload, ctx) {
  requirePromptTuning();
  return promptTuningController(ctx).save(payload ?? {});
}

/** `prompt-tuning.delete` — remove one managed preset. */
async function promptTuningDelete(payload, ctx) {
  requirePromptTuning();
  return promptTuningController(ctx).remove(payload?.presetId);
}

/** @returns {object} the current ask-model registry. */
function askModelState() {
  return state?.askModel ?? EMPTY_ASK_MODEL;
}

/** Refuse ask-model calls while the feature switch is off. */
function requireAskModel() {
  if (!featureEnabled('ask-model')) throw new Error('the ask-model feature is disabled');
}

/** @returns {Promise<boolean>} whether one connection has a stored API key. */
async function askModelKeySet(ctx, id) {
  const credentials = ctx?.get?.('credentials');
  if (credentials === undefined) return false;
  try {
    const info = await credentials.describe(secretRefFor(id));
    return info?.configured === true;
  } catch {
    return false;
  }
}

/** Build the settings view: connections without secret values. */
async function askModelView(ctx) {
  const current = askModelState();
  const connections = [];
  for (const connection of current.connections) {
    connections.push({
      ...connection,
      local: isLocalEndpoint(connection.baseURL),
      apiKeySet: await askModelKeySet(ctx, connection.id),
    });
  }
  return { connections, defaultId: current.defaultId, secureStorage: ctx?.get?.('credentials') !== undefined };
}

/** `ask-model.get` — configured connections (never the API key). */
async function askModelGet(payload, ctx) {
  requireAskModel();
  await loadState();
  return askModelView(ctx);
}

/** `ask-model.save` — create or update one connection, optionally storing its key. */
async function askModelSave(payload, ctx) {
  requireAskModel();
  await loadState();
  const input = payload ?? {};
  const credentials = ctx?.get?.('credentials');
  const current = askModelState();
  const existingId = typeof input.id === 'string' ? input.id.trim() : '';
  const existing = current.connections.find((connection) => connection.id === existingId);
  const taken = new Set(current.connections.map((connection) => connection.id).filter((id) => id !== existingId));
  const connection = normalizeConnection({ ...input, id: undefined }, { existingId: existing?.id, taken });
  if (typeof input.apiKey === 'string' && input.apiKey !== '') {
    if (credentials === undefined) throw new Error('the credential store is unavailable; this deployment cannot store an API key');
    await credentials.set(secretRefFor(connection.id), input.apiKey);
  } else if (input.clearApiKey === true && credentials !== undefined) {
    await credentials.unset(secretRefFor(connection.id));
  }
  const connections = existing === undefined
    ? [...current.connections, connection]
    : current.connections.map((row) => (row.id === connection.id ? connection : row));
  state = {
    ...state,
    askModel: {
      connections,
      defaultId: current.defaultId === '' ? connection.id : current.defaultId,
    },
  };
  await persistState();
  publishAskModelChange();
  return askModelView(ctx);
}

/** `ask-model.delete` — remove one connection and its stored key. */
async function askModelDelete(payload, ctx) {
  requireAskModel();
  await loadState();
  const id = String(payload?.id ?? '').trim();
  const current = askModelState();
  if (!current.connections.some((connection) => connection.id === id)) throw new Error(`unknown connection "${id}"`);
  const connections = current.connections.filter((connection) => connection.id !== id);
  state = {
    ...state,
    askModel: {
      connections,
      defaultId: current.defaultId === id ? (connections[0]?.id ?? '') : current.defaultId,
    },
  };
  await persistState();
  const credentials = ctx?.get?.('credentials');
  if (credentials !== undefined) {
    try {
      await credentials.unset(secretRefFor(id));
    } catch {
      // The registry entry is gone; an orphaned secret is harmless.
    }
  }
  publishAskModelChange();
  return askModelView(ctx);
}

/** `ask-model.default` — choose the connection used when the tool omits one. */
async function askModelDefault(payload, ctx) {
  requireAskModel();
  await loadState();
  const id = String(payload?.id ?? '').trim();
  const current = askModelState();
  if (!current.connections.some((connection) => connection.id === id)) throw new Error(`unknown connection "${id}"`);
  state = { ...state, askModel: { ...current, defaultId: id } };
  await persistState();
  publishAskModelChange();
  return askModelView(ctx);
}

/** `ask-model.test` — send one tiny chat request and report the reply. */
async function askModelTest(payload, ctx) {
  requireAskModel();
  await loadState();
  const id = String(payload?.id ?? '').trim();
  const connection = askModelState().connections.find((row) => row.id === id);
  if (connection === undefined) throw new Error(`unknown connection "${id}"`);
  const credentials = ctx?.get?.('credentials');
  const hit = credentials === undefined ? undefined : await credentials.resolve(secretRefFor(id));
  const started = Date.now();
  const result = await chatCompletion({
    connection,
    apiKey: hit?.value,
    messages: buildMessages({ prompt: 'Reply with exactly: OK' }),
    timeoutMs: Math.min(connection.timeoutMs, 60000),
  });
  return {
    ok: true,
    reply: result.text,
    model: result.model ?? connection.model,
    elapsedMs: Date.now() - started,
  };
}

const METHODS = {
  'features.get': featuresGet,
  'features.set': featuresSet,
  'prompt-tuning.get': promptTuningGet,
  'prompt-tuning.base': promptTuningBase,
  'prompt-tuning.save': promptTuningSave,
  'prompt-tuning.delete': promptTuningDelete,
  'ask-model.get': askModelGet,
  'ask-model.save': askModelSave,
  'ask-model.delete': askModelDelete,
  'ask-model.default': askModelDefault,
  'ask-model.test': askModelTest,
};

/** Serve one `/plugins/dsh-toolset/api/<method>` request. */
async function handleRequest(req, res, ctx) {
  if (req.method !== 'POST') {
    replyJson(res, 405, { ok: false, error: { code: 'method', message: 'POST required' } });
    return;
  }
  // A cross-site <form> can only send simple content types without a CORS
  // preflight; requiring JSON keeps hosted pages from flipping switches.
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    replyJson(res, 415, { ok: false, error: { code: 'content-type', message: 'application/json required' } });
    return;
  }
  const pathname = new URL(req.url ?? '/', 'http://dsh.invalid').pathname;
  const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length + 1) : undefined;
  const handler = method === undefined || method.includes('/') ? undefined : METHODS[method];
  if (handler === undefined) {
    replyJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown toolset API method' } });
    return;
  }
  try {
    const payload = await readJsonBody(req);
    replyJson(res, 200, { ok: true, value: await handler(payload, ctx) });
  } catch (error) {
    replyJson(res, 400, {
      ok: false,
      error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * Register the feature-switch API when the Web carrier is composed.
 * @param ctx - Host plugin context.
 */
function installApi(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: (req, res) => handleRequest(req, res, webCtx) }),
      'dsh-toolset: feature API route',
    );
  });
}

/**
 * Register the `dsh_safe_restart` tool while the feature is enabled and the
 * Desktop environment supports a relaunch.
 * @param ctx - Host plugin context.
 */
function installSafeRestartTool(ctx) {
  if (!restartSupported()) {
    log('safe-restart unavailable: not a Windows Desktop Host');
    return;
  }
  ctx.inject(['tools'], (toolCtx) => {
    const controller = createRestartController({ ctx: toolCtx, packageDir: PACKAGE_DIR, log });
    const tool = createSafeRestartTool({ controller });
    let disposeTool = null;
    let disposed = false;
    const sync = () => {
      if (disposed) return;
      const wanted = featureEnabled('safe-restart');
      if (wanted && disposeTool === null) disposeTool = toolCtx.tools.register(tool);
      else if (!wanted && disposeTool !== null) {
        disposeTool();
        disposeTool = null;
        void controller.cancel('feature disabled');
      }
    };
    toolCtx.effect(() => {
      sync();
      const unsubscribe = subscribeFeatureChange(sync);
      return () => {
        disposed = true;
        unsubscribe();
        if (disposeTool !== null) {
          disposeTool();
          disposeTool = null;
        }
        controller.dispose();
      };
    }, 'dsh-toolset: safe restart tool');
  });
}

/**
 * Register the `ask_model` tool while the feature is enabled. The tool
 * description names the configured connections, so a registry change
 * re-registers it.
 * @param ctx - Host plugin context.
 */
function installAskModelTool(ctx) {
  ctx.inject(['tools'], (toolCtx) => {
    let disposeTool = null;
    let disposed = false;
    const resolveApiKey = async (connection) => {
      const credentials = ctx.get('credentials');
      if (credentials === undefined) return undefined;
      const hit = await credentials.resolve(secretRefFor(connection.id));
      return hit?.value;
    };
    const sync = () => {
      if (disposed) return;
      if (!featureEnabled('ask-model')) {
        if (disposeTool !== null) {
          disposeTool();
          disposeTool = null;
        }
        return;
      }
      if (disposeTool !== null) disposeTool();
      disposeTool = toolCtx.tools.register(createAskModelTool({ getConfig: askModelState, resolveApiKey, log }));
    };
    toolCtx.effect(() => {
      sync();
      const unsubscribeFeature = subscribeFeatureChange(sync);
      const unsubscribeAskModel = subscribeAskModelChange(sync);
      return () => {
        disposed = true;
        unsubscribeFeature();
        unsubscribeAskModel();
        if (disposeTool !== null) {
          disposeTool();
          disposeTool = null;
        }
      };
    }, 'dsh-toolset: ask model tool');
  });
}

/**
 * After an armed safe restart, resume the recorded Session and queue the
 * continuation message once Host services are available.
 * @param ctx - Host plugin context.
 */
function installStartupResume(ctx) {
  ctx.inject(['sessionController'], (resumeCtx) => {
    resumeCtx.effect(() => {
      let cancelled = false;
      const run = async () => {
        // Cheap gate: an ordinary boot has no restart request and must not pay
        // the resume delay or touch the session controller at all.
        if ((await readArmedMarker(PACKAGE_DIR)) === undefined) return;
        await new Promise((resolve) => setTimeout(resolve, STARTUP_RESUME_DELAY_MS));
        if (cancelled) return;
        const outcome = await resumeAfterRestart({
          packageDir: PACKAGE_DIR,
          sessionController: resumeCtx.sessionController,
          log,
        });
        if (outcome.status !== 'skipped') log(`post-restart resume: ${outcome.status}${outcome.reason === undefined ? '' : ` (${outcome.reason})`}`);
      };
      run().catch((error) => log(`post-restart resume crashed: ${error instanceof Error ? error.message : String(error)}`));
      return () => {
        cancelled = true;
      };
    }, 'dsh-toolset: post-restart resume');
  });
}

/**
 * Register the Host half: feature API, feature-gated Host features, and the
 * post-restart resume pass.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  // Load persisted switches before anything gates on them; defaults stay live
  // if the file is missing.
  void loadState().then(publishFeatureChange);

  installApi(ctx);
  installSafeRestartTool(ctx);
  installAskModelTool(ctx);
  installStartupResume(ctx);
}

export { FEATURE_IDS };
