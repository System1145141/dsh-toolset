import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendManagedBlock,
  buildPersonaRow,
  buildPresetPatchBlock,
  composePluginsYaml,
  createPromptTuning,
  derivePresetId,
  listManagedPresets,
  managedMarker,
  parsePersona,
  removeManagedBlock,
  stripPersonaRow,
} from '../lib/prompt-tuning.js';

const STANDARD_PLUGINS = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a coding agent powered by the {{model}} model.
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
`;

const MINIMAL_PLUGINS = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a helpful software engineer assistant.
    complete: true
    includeRuntimeContext: false
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
`;

test('derivePresetId sanitizes names and avoids collisions', () => {
  assert.equal(derivePresetId('My Preset'), 'my-preset');
  assert.equal(derivePresetId('  Code   Reviewer  '), 'code-reviewer');
  assert.equal(derivePresetId('中文名字'), derivePresetId('中文名字'), 'stable fallback for non-latin names');
  assert.match(derivePresetId('中文名字'), /^custom-[a-z0-9]+$/u);
  assert.equal(derivePresetId('standard', new Set(['standard'])), 'standard-2');
  assert.equal(derivePresetId('standard', new Set(['standard', 'standard-2'])), 'standard-3');
  assert.match(derivePresetId(''), /^custom-[a-z0-9]+$/u);
});

test('parsePersona reads plain, quoted, block and folded prefixes', () => {
  assert.deepEqual(parsePersona(STANDARD_PLUGINS), {
    found: true,
    prefix: 'You are a coding agent powered by the {{model}} model.',
    complete: false,
    includeRuntimeContext: true,
  });
  assert.deepEqual(parsePersona(MINIMAL_PLUGINS), {
    found: true,
    prefix: 'You are a helpful software engineer assistant.',
    complete: true,
    includeRuntimeContext: false,
  });

  const quoted = `- id: persona
  name: "@deepseek-ai/dsh-persona"
  config:
    prefix: 'It''s a terse assistant.'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
`;
  assert.equal(parsePersona(quoted).prefix, "It's a terse assistant.");

  const block = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: |-
      line one
      line two
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
`;
  assert.equal(parsePersona(block).prefix, 'line one\nline two');

  const folded = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: >-
      folded one
      folded two
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
`;
  assert.equal(parsePersona(folded).prefix, 'folded one folded two');

  const missing = '- id: tool-fs\n  name: \'@deepseek-ai/dsh-tool-fs\'\n';
  assert.deepEqual(parsePersona(missing), { found: false, prefix: '', complete: false, includeRuntimeContext: true });
});

test('a prompt containing YAML-looking lines does not confuse the persona scan', () => {
  const yaml = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: |-
      complete: true
      includeRuntimeContext: false
      prefix: nested
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
`;
  const persona = parsePersona(yaml);
  assert.equal(persona.complete, false);
  assert.equal(persona.includeRuntimeContext, true);
  assert.equal(persona.prefix, 'complete: true\nincludeRuntimeContext: false\nprefix: nested');
});

test('buildPersonaRow and composePluginsYaml replace only the persona row', () => {
  const row = buildPersonaRow({ prefix: 'Line A\nLine B', complete: false, includeRuntimeContext: true });
  assert.match(row, /^- id: persona\n  name: '@deepseek-ai\/dsh-persona'\n  config:\n    prefix: \|-\n      Line A\n      Line B\n$/u);

  const composed = composePluginsYaml(STANDARD_PLUGINS, { prefix: 'Be terse.', complete: false, includeRuntimeContext: true });
  assert.match(composed, /prefix: \|-\n      Be terse\./u);
  assert.doesNotMatch(composed, /\{\{model\}\}/u);
  assert.match(composed, /- id: tool-fs\n  name: '@deepseek-ai\/dsh-tool-fs'\n$/u);
  assert.match(composed, /!!js process\.platform === 'win32'/u, 'other rows keep their !!js expressions');

  const complete = composePluginsYaml(MINIMAL_PLUGINS, { prefix: 'Only me.', complete: true, includeRuntimeContext: false });
  assert.match(complete, /prefix: \|-\n      Only me\.\n    complete: true\n    includeRuntimeContext: false/u);

  const noPersona = composePluginsYaml('- id: tool-fs\n  name: \'@deepseek-ai/dsh-tool-fs\'\n', { prefix: 'X' });
  assert.match(noPersona, /^- id: persona/u);
  assert.match(noPersona, /- id: tool-fs/u);
});

test('stripPersonaRow keeps the rest of the list byte-identical', () => {
  const stripped = stripPersonaRow(STANDARD_PLUGINS);
  assert.doesNotMatch(stripped, /dsh-persona/u);
  assert.match(stripped, /^- id: agent-instructions/u);
  assert.equal(stripPersonaRow('- id: tool-fs\n  name: \'x\'\n'), '- id: tool-fs\n  name: \'x\'\n');
});

test('patch blocks round-trip through append/remove/list', () => {
  const blockA = buildPresetPatchBlock({
    presetId: 'alpha',
    rowId: 'preset-alpha',
    name: 'Alpha "quoted"',
    description: 'Created by dsh-toolset.',
    order: 50,
    pluginsYaml: STANDARD_PLUGINS,
  });
  assert.match(blockA, /^# dsh-toolset preset: alpha \(managed by Settings -> Toolset\)\n- insert:\n    - id: preset-alpha\n      name: '@deepseek-ai\/dsh-agent-preset'\n      config:\n        id: alpha\n        name: "Alpha \\"quoted\\""\n        description: "Created by dsh-toolset\."\n        order: 50\n        plugins:\n          - id: persona\n            name: '@deepseek-ai\/dsh-persona'/u);

  const base = '- id: web\n  name: \'@deepseek-ai/dsh-web\'\n';
  let text = appendManagedBlock(base, blockA);
  assert.deepEqual(listManagedPresets(text), ['alpha']);
  assert.match(text, /- id: web/u);

  const blockB = buildPresetPatchBlock({ presetId: 'beta', rowId: 'preset-beta', name: 'Beta', order: 50, pluginsYaml: STANDARD_PLUGINS });
  text = appendManagedBlock(text, blockB);
  assert.deepEqual(listManagedPresets(text), ['alpha', 'beta']);

  const removed = removeManagedBlock(text, 'alpha');
  assert.equal(removed.removed, true);
  assert.deepEqual(listManagedPresets(removed.text), ['beta']);
  assert.match(removed.text, /- id: web/u);
  assert.doesNotMatch(removed.text, /preset-alpha/u);

  assert.equal(removeManagedBlock(removed.text, 'missing').removed, false);
  assert.equal(managedMarker('alpha'), '# dsh-toolset preset: alpha (managed by Settings -> Toolset)');
});

test('managed blocks keep blank lines inside block scalars when removed', () => {
  const plugins = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: Hi.
- id: planning
  name: cordis:group
  group: true
  config:
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'
      config:
        section: |
          first paragraph

          second paragraph
`;
  const block = buildPresetPatchBlock({ presetId: 'gamma', rowId: 'preset-gamma', name: 'Gamma', order: 50, pluginsYaml: plugins });
  assert.match(block, /\n {20}first paragraph\n\n {20}second paragraph\n/u, 'blank lines inside the block scalar are preserved');
  const base = "- id: web\n  name: '@deepseek-ai/dsh-web'\n";
  const removed = removeManagedBlock(appendManagedBlock(base, block), 'gamma');
  assert.equal(removed.removed, true);
  assert.equal(removed.text.trimEnd(), base.trimEnd());
  assert.doesNotMatch(removed.text, /second paragraph/u);
});

test('controller lists, reads, creates, updates and deletes a managed preset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-toolset-pt-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  await writeFile(patchPath, "- id: web\n  name: '@deepseek-ai/dsh-web'\n", 'utf8');

  const definitions = new Map([
    ['standard', { id: 'standard', name: 'Standard', plugins: STANDARD_PLUGINS }],
    ['minimal', { id: 'minimal', name: 'Minimal', plugins: MINIMAL_PLUGINS }],
  ]);
  const managedIds = new Set();

  /** Read the managed preset's child plugin list back out of the patch text. */
  function managedPlugins(text, id) {
    const lines = text.split('\n');
    const start = lines.indexOf(managedMarker(id));
    if (start < 0) return undefined;
    let cursor = start + 1;
    while (cursor < lines.length && !/^ {8}plugins:\s*$/u.test(lines[cursor])) cursor += 1;
    if (cursor >= lines.length) return undefined;
    const plugins = [];
    for (let index = cursor + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === '') {
        plugins.push('');
        continue;
      }
      if (!line.startsWith('          ')) break;
      plugins.push(line.slice(10));
    }
    return plugins.join('\n');
  }

  /** Read the managed preset's display name back out of the patch text. */
  function managedName(text, id) {
    const lines = text.split('\n');
    const start = lines.indexOf(managedMarker(id));
    for (let index = start + 1; index < lines.length; index += 1) {
      const match = /^ {8}name: (.*)$/u.exec(lines[index]);
      if (match !== null) {
        try {
          return JSON.parse(match[1]);
        } catch {
          return id;
        }
      }
    }
    return id;
  }

  const agentPresets = {
    async list() {
      return [...definitions.values()].map((definition) => ({
        id: definition.id,
        name: definition.name,
        ...(definition.broken === undefined ? {} : { broken: definition.broken }),
      }));
    },
    async readDocument(id) {
      const definition = definitions.get(id);
      if (definition === undefined) throw new Error(`unknown preset ${id}`);
      return { agentPreset: id, content: definition.plugins, ...(definition.name === undefined ? {} : { name: definition.name }) };
    },
  };

  const hmr = {
    runExclusive: (operation) => operation(),
    async reconcileProfile() {
      const text = await readFile(patchPath, 'utf8');
      const ids = listManagedPresets(text);
      for (const id of ids) definitions.set(id, { id, name: managedName(text, id), plugins: managedPlugins(text, id) ?? STANDARD_PLUGINS });
      for (const id of [...managedIds]) {
        if (!ids.includes(id)) {
          definitions.delete(id);
          managedIds.delete(id);
        }
      }
      for (const id of ids) managedIds.add(id);
      return { warnings: [] };
    },
  };

  const tuning = createPromptTuning({ agentPresets, patchPath, hmr });
  try {
    const listed = await tuning.list();
    assert.deepEqual(listed.presets.map((row) => row.id).sort(), ['minimal', 'standard']);
    assert.deepEqual(listed.managed, []);

    const base = await tuning.base('minimal');
    assert.equal(base.prompt, 'You are a helpful software engineer assistant.');
    assert.equal(base.complete, true);
    assert.equal(base.includeRuntimeContext, false);

    const saved = await tuning.save({ basePreset: 'minimal', name: 'Terse Helper', prompt: 'Answer in one sentence.', complete: false });
    assert.equal(saved.id, 'terse-helper');
    assert.equal(saved.applied, true);
    assert.equal(saved.restartRequired, false);
    const text = await readFile(patchPath, 'utf8');
    assert.deepEqual(listManagedPresets(text), ['terse-helper']);
    assert.match(text, /- id: web/u, 'existing patches are preserved');
    const created = definitions.get('terse-helper');
    assert.ok(created, 'reconcile registered the preset');
    assert.match(created.plugins, /prefix: \|-\n      Answer in one sentence\./u);
    assert.doesNotMatch(created.plugins, /complete: true/u);
    assert.match(created.plugins, /- id: tool-fs/u);

    const updated = await tuning.save({ basePreset: 'terse-helper', presetId: 'terse-helper', name: 'Terse Helper', prompt: 'Answer in two sentences.' });
    assert.equal(updated.id, 'terse-helper');
    assert.deepEqual(listManagedPresets(await readFile(patchPath, 'utf8')), ['terse-helper'], 'update replaces the block');
    assert.match(definitions.get('terse-helper').plugins, /Answer in two sentences\./u);

    const second = await tuning.save({ basePreset: 'standard', name: 'Terse Helper', prompt: 'Another.' });
    assert.equal(second.id, 'terse-helper-2', 'id collision gets a suffix');

    const listedAfter = await tuning.list();
    assert.deepEqual(listedAfter.managed.map((row) => row.id), ['terse-helper', 'terse-helper-2']);

    const removed = await tuning.remove('terse-helper');
    assert.equal(removed.removed, true);
    assert.equal(definitions.has('terse-helper'), false);
    assert.deepEqual(listManagedPresets(await readFile(patchPath, 'utf8')), ['terse-helper-2']);

    await assert.rejects(tuning.remove('standard'), /not managed/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('controller rejects a broken base preset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-toolset-pt-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  await writeFile(patchPath, '[]\n', 'utf8');
  const agentPresets = {
    async list() {
      return [{ id: 'broken', name: 'Broken', broken: 'mount failed' }];
    },
    async readDocument() {
      throw new Error('should not be called');
    },
  };
  const tuning = createPromptTuning({ agentPresets, patchPath, hmr: { runExclusive: (operation) => operation(), reconcileProfile: async () => ({ warnings: [] }) } });
  try {
    await assert.rejects(tuning.save({ basePreset: 'broken', name: 'X', prompt: 'Y' }), /cannot be used as a base/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('controller rolls the patch back when the new preset fails to activate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-toolset-pt-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  const before = "- id: web\n  name: '@deepseek-ai/dsh-web'\n";
  await writeFile(patchPath, before, 'utf8');
  let calls = 0;
  const agentPresets = {
    async list() {
      calls += 1;
      if (calls === 1) return [{ id: 'standard', name: 'Standard' }];
      return [
        { id: 'standard', name: 'Standard' },
        { id: 'bad', name: 'Bad', broken: 'plugin failed to mount' },
      ];
    },
    async readDocument() {
      return { agentPreset: 'standard', content: STANDARD_PLUGINS };
    },
  };
  const hmr = {
    runExclusive: (operation) => operation(),
    async reconcileProfile() {
      return { warnings: [] };
    },
  };
  const tuning = createPromptTuning({ agentPresets, patchPath, hmr });
  try {
    await assert.rejects(tuning.save({ basePreset: 'standard', name: 'Bad', prompt: 'Nope.' }), /failed to activate/u);
    assert.equal(await readFile(patchPath, 'utf8'), before, 'the previous patch document is restored');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('controller reports restart-required when HMR is unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-toolset-pt-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  await writeFile(patchPath, '[]\n', 'utf8');
  const agentPresets = {
    async list() {
      return [{ id: 'standard', name: 'Standard' }];
    },
    async readDocument() {
      return { agentPreset: 'standard', content: STANDARD_PLUGINS };
    },
  };
  const tuning = createPromptTuning({ agentPresets, patchPath });
  try {
    const saved = await tuning.save({ basePreset: 'standard', name: 'Offline', prompt: 'Hi.' });
    assert.equal(saved.applied, false);
    assert.equal(saved.restartRequired, true);
    assert.deepEqual(listManagedPresets(await readFile(patchPath, 'utf8')), ['offline']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
