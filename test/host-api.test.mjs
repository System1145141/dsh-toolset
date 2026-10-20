import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE_PATH = join(PACKAGE_DIR, 'state.json');

// The Host half registers the safe-restart tool only for a Windows Electron
// environment; pretend to be one for this API-level test.
const originalElectron = Object.getOwnPropertyDescriptor(process.versions, 'electron');
Object.defineProperty(process.versions, 'electron', { value: '99.0.0-test', configurable: true, writable: true });

const routes = [];
const tools = new Map();
const effects = [];

function fakeCtx() {
  const services = {
    agents: { list: () => [] },
    sessionController: { resolveAgent: async () => ({ agent: { followup() {} } }) },
  };
  function make() {
    return {
      effect(fn) {
        const disposer = fn();
        if (typeof disposer === 'function') effects.push(disposer);
        return disposer;
      },
      get: (name) => services[name],
      inject(names, callback) {
        const child = make();
        const provided = {
          webServer: {
            register(route) {
              routes.push(route);
              return () => {};
            },
          },
          tools: {
            register(definition) {
              tools.set(definition.name, definition);
              return () => tools.delete(definition.name);
            },
          },
          sessionController: services.sessionController,
        };
        for (const name of names) child[name] = provided[name];
        callback(child);
      },
    };
  }
  return make();
}

function post(route, body, contentType = 'application/json', methodName = 'features.get') {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = `/plugins/dsh-toolset/api/${methodName}`;
    req.headers = contentType === undefined ? {} : { 'content-type': contentType };
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        this.headersSent = true;
        this.status = status;
        this.headers = headers;
        return this;
      },
      end(payload) {
        resolve({ status: this.status, headers: this.headers, body: payload });
      },
      destroy() {},
    };
    route.handler(req, res);
    if (body !== undefined) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
}

let route;
let stateBackup;

before(async () => {
  stateBackup = await readFile(STATE_PATH, 'utf8').catch(() => undefined);
  const { apply } = await import('../index.js');
  apply(fakeCtx());
  route = routes.find((candidate) => candidate.path === '/plugins/dsh-toolset/api');
  await new Promise((resolve) => setTimeout(resolve, 50));
});

after(async () => {
  for (const disposer of effects.reverse()) {
    try {
      await disposer();
    } catch {
      // Best effort teardown.
    }
  }
  if (stateBackup !== undefined) await writeFile(STATE_PATH, stateBackup, 'utf8');
  if (originalElectron === undefined) delete process.versions.electron;
  else Object.defineProperty(process.versions, 'electron', originalElectron);
});

test('API route and feature-gated tool are registered', () => {
  assert.ok(route, 'API route registered');
  assert.equal(route.kind, 'prefix');
  assert.ok(tools.has('dsh_safe_restart'), 'safe restart tool registered');
  assert.equal(tools.get('dsh_safe_restart').parameters.type, 'object');
});

test('features.get reports both features and the Host capability', async () => {
  const response = await post(route, '{}');
  assert.equal(response.status, 200);
  const envelope = JSON.parse(response.body);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.features['request-status'], true);
  assert.equal(envelope.value.features['safe-restart'], true);
  assert.equal(envelope.value.capabilities.safeRestart, true);
  assert.equal(envelope.value.capabilities.promptTuning, false, 'no agent-preset registry in this fake Host');
});

test('prompt-tuning methods explain why they are unavailable without a registry', async () => {
  const response = await post(route, '{}', 'application/json', 'prompt-tuning.get');
  assert.equal(response.status, 400);
  const envelope = JSON.parse(response.body);
  assert.equal(envelope.ok, false);
  assert.match(envelope.error.message, /agent-preset registry|profile patch/u);
});

test('disabling and re-enabling safe-restart reconciles the tool registration', async () => {
  let response = await post(route, JSON.stringify({ id: 'safe-restart', enabled: false }), 'application/json', 'features.set');
  assert.equal(response.status, 200);
  assert.equal(tools.has('dsh_safe_restart'), false, 'tool removed when the feature is off');

  response = await post(route, JSON.stringify({ id: 'safe-restart', enabled: true }), 'application/json', 'features.set');
  assert.equal(response.status, 200);
  assert.equal(tools.has('dsh_safe_restart'), true, 'tool restored when the feature is on');
});

test('invalid writes are rejected', async () => {
  assert.equal((await post(route, JSON.stringify({ id: 'nope', enabled: true }), 'application/json', 'features.set')).status, 400);
  assert.equal((await post(route, JSON.stringify({ id: 'safe-restart', enabled: 'yes' }), 'application/json', 'features.set')).status, 400);
  assert.equal((await post(route, '{}', 'text/plain')).status, 415);
});
