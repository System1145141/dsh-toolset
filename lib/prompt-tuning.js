/**
 * dsh-toolset — system-prompt tuning (Host side).
 *
 * One feature of the toolset: start from an existing Agent preset, edit the
 * preset's initial system prompt (its `@deepseek-ai/dsh-persona` prefix), and
 * save the result as a new Agent preset.
 *
 * A DSH preset is a `@deepseek-ai/dsh-agent-preset` Loader row; new presets are
 * declared by inserting such a row into the profile patch (`cordis.patch.yml`),
 * exactly like a bundle patch would. This module therefore works on the two
 * documents DSH already owns:
 *
 *  1. the preset's declared child plugin list, read as YAML through the
 *     `agentPresets.readDocument()` Host API (the `!!js` dialect round-trips);
 *  2. the profile patch, a YAML sequence of Loader patch entries.
 *
 * It edits the persona row inside (1) and appends one `insert` entry to (2),
 * then asks HMR to recompose the profile so the new preset is live without a
 * restart. The functions are pure string transforms so they are unit-testable
 * without a DSH runtime; `createPromptTuning()` wires them to Host services.
 */

import { readFile, writeFile, rename } from 'node:fs/promises';

/** Roster order used for presets created by this feature (shipped ones are 1-4). */
export const MANAGED_PRESET_ORDER = 50;
/** Marker line prefix identifying a patch block owned by this feature. */
export const MANAGED_MARKER = '# dsh-toolset preset:';
/** Upper bounds for user-supplied values (the API body is capped at 64 KiB). */
export const MAX_PRESET_NAME_CHARS = 80;
export const MAX_PROMPT_CHARS = 60000;
/** Persona row identity used by every shipped preset. */
export const PERSONA_PLUGIN = '@deepseek-ai/dsh-persona';
/** Row that shadows the deployment's fixed opening line for one preset. */
export const IDENTITY_PLUGIN = '@local/dsh-toolset/preset-identity';
/** The line `@deepseek-ai/dsh-system-prompt` registers by default. */
export const DEFAULT_IDENTITY = 'You are an AI agent powered by DeepSeek Harness.';

/** @returns {string} the marker comment written above a managed patch block. */
export function managedMarker(presetId) {
  return `${MANAGED_MARKER} ${presetId} (managed by Settings -> Toolset)`;
}

/** @returns {boolean} whether one top-level YAML row starts at this line. */
function isTopLevelRow(line) {
  return line.startsWith('- ');
}

/**
 * Locate the top-level persona row inside a dumped preset plugin list.
 * @param {string[]} lines - YAML lines of the plugin list.
 * @returns {{ start: number, end: number, block: string[] } | undefined} row bounds.
 */
export function findPersonaRow(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!isTopLevelRow(lines[index])) continue;
    let end = index + 1;
    while (end < lines.length && !isTopLevelRow(lines[end])) end += 1;
    const block = lines.slice(index, end);
    const isPersona = block.some((line) => /^\s+name:\s*(['"]?)@deepseek-ai\/dsh-persona\1\s*$/u.test(line));
    if (isPersona) return { start: index, end, block };
    index = end - 1;
  }
  return undefined;
}

/** Unquote one inline YAML scalar (single or double quoted) or trim a plain one. */
function parseInlineScalar(value) {
  const text = value.trim();
  if (text === '') return '';
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/gu, "'");
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}

/** Fold the lines of a YAML `>` block scalar back into text. */
function foldLines(lines) {
  let out = '';
  let afterText = false;
  for (const line of lines) {
    if (line === '') {
      out += '\n';
      afterText = false;
      continue;
    }
    out += afterText ? ` ${line}` : line;
    afterText = true;
  }
  return out;
}

/**
 * Read the persona configuration out of one preset's plugin-list YAML.
 * @param {string} yaml - child plugin list as dumped by `agentPresets.readDocument()`.
 * @returns {{ found: boolean, prefix: string, complete: boolean, includeRuntimeContext: boolean }} persona values.
 */
export function parsePersona(yaml) {
  const lines = String(yaml ?? '').replace(/\r\n/gu, '\n').split('\n');
  const row = findPersonaRow(lines);
  if (row === undefined) return { found: false, prefix: '', complete: false, includeRuntimeContext: true };
  const block = row.block;
  let prefix = '';
  let complete = false;
  let includeRuntimeContext = true;
  for (let index = 0; index < block.length; index += 1) {
    const line = block[index];
    if (/^\s*complete:\s*true\s*$/u.test(line)) complete = true;
    if (/^\s*includeRuntimeContext:\s*false\s*$/u.test(line)) includeRuntimeContext = false;
    const match = /^(\s*)prefix:\s*(.*)$/u.exec(line);
    if (match === null) continue;
    const indent = match[1].length;
    const rest = match[2].trim();
    if (/^[|>][+-]?$/u.test(rest)) {
      const folded = rest[0] === '>';
      const content = [];
      let blockIndent = null;
      let cursor = index + 1;
      while (cursor < block.length) {
        const candidate = block[cursor];
        if (candidate.trim() === '') {
          content.push('');
          cursor += 1;
          continue;
        }
        const candidateIndent = /^ */u.exec(candidate)[0].length;
        if (blockIndent === null) {
          if (candidateIndent <= indent) break;
          blockIndent = candidateIndent;
        }
        if (candidateIndent < blockIndent) break;
        content.push(candidate.slice(blockIndent));
        cursor += 1;
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      prefix = folded ? foldLines(content) : content.join('\n');
      index = cursor - 1;
      continue;
    }
    prefix = parseInlineScalar(rest);
  }
  return { found: true, prefix, complete, includeRuntimeContext };
}

/**
 * Remove the top-level persona row from a preset plugin list.
 * @param {string} yaml - plugin-list YAML.
 * @returns {string} the list without its persona row.
 */
export function stripPersonaRow(yaml) {
  const lines = String(yaml ?? '').replace(/\r\n/gu, '\n').split('\n');
  const row = findPersonaRow(lines);
  if (row === undefined) return String(yaml ?? '').replace(/\r\n/gu, '\n');
  return [...lines.slice(0, row.start), ...lines.slice(row.end)].join('\n');
}

/**
 * Locate the top-level identity row this feature manages.
 * @param {string[]} lines - YAML lines of the plugin list.
 * @returns {{ start: number, end: number, block: string[] } | undefined} row bounds.
 */
export function findIdentityRow(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!isTopLevelRow(lines[index])) continue;
    let end = index + 1;
    while (end < lines.length && !isTopLevelRow(lines[end])) end += 1;
    const block = lines.slice(index, end);
    const isIdentity = block.some((line) => /^\s+name:\s*(['"]?)@local\/dsh-toolset\/preset-identity\1\s*$/u.test(line));
    if (isIdentity) return { start: index, end, block };
    index = end - 1;
  }
  return undefined;
}

/**
 * Read the preset's identity override (absent = deployment default).
 * @param {string} yaml - child plugin list as dumped by `agentPresets.readDocument()`.
 * @returns {{ found: boolean, text: string }} override state.
 */
export function parseIdentity(yaml) {
  const lines = String(yaml ?? '').replace(/\r\n/gu, '\n').split('\n');
  const row = findIdentityRow(lines);
  if (row === undefined) return { found: false, text: '' };
  const block = row.block;
  for (let index = 0; index < block.length; index += 1) {
    const match = /^(\s*)text:\s*(.*)$/u.exec(block[index]);
    if (match === null) continue;
    const indent = match[1].length;
    const rest = match[2].trim();
    if (/^[|>][+-]?$/u.test(rest)) {
      const content = [];
      let blockIndent = null;
      let cursor = index + 1;
      while (cursor < block.length) {
        const candidate = block[cursor];
        if (candidate.trim() === '') {
          content.push('');
          cursor += 1;
          continue;
        }
        const candidateIndent = /^ */u.exec(candidate)[0].length;
        if (blockIndent === null) {
          if (candidateIndent <= indent) break;
          blockIndent = candidateIndent;
        }
        if (candidateIndent < blockIndent) break;
        content.push(candidate.slice(blockIndent));
        cursor += 1;
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      return { found: true, text: rest[0] === '>' ? foldLines(content) : content.join('\n') };
    }
    return { found: true, text: parseInlineScalar(rest) };
  }
  return { found: true, text: '' };
}

/** @returns {string} YAML row overriding the identity line (newline-terminated). */
export function buildIdentityRow(text) {
  const value = String(text ?? '').replace(/\r\n/gu, '\n');
  const lines = ['- id: preset-identity', `  name: '${IDENTITY_PLUGIN}'`, '  config:'];
  if (value === '') {
    lines.push("    text: ''");
  } else {
    lines.push('    text: |-');
    for (const line of value.split('\n')) lines.push(line === '' ? '' : `      ${line}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Remove the identity row, when present. @returns {string} the list without it. */
export function stripIdentityRow(yaml) {
  const lines = String(yaml ?? '').replace(/\r\n/gu, '\n').split('\n');
  const row = findIdentityRow(lines);
  if (row === undefined) return lines.join('\n');
  return [...lines.slice(0, row.start), ...lines.slice(row.end)].join('\n');
}

/**
 * Build one `@deepseek-ai/dsh-persona` row from the edited prompt.
 * @param {{ prefix: string, complete?: boolean, includeRuntimeContext?: boolean }} options - persona values.
 * @returns {string} YAML row ending with a newline.
 */
export function buildPersonaRow(options) {
  const text = String(options?.prefix ?? '');
  const lines = ['- id: persona', `  name: '${PERSONA_PLUGIN}'`, '  config:'];
  if (text === '') {
    lines.push("    prefix: ''");
  } else {
    lines.push('    prefix: |-');
    for (const line of text.replace(/\r\n/gu, '\n').split('\n')) lines.push(line === '' ? '' : `      ${line}`);
  }
  if (options?.complete === true) lines.push('    complete: true');
  if (options?.includeRuntimeContext === false) lines.push('    includeRuntimeContext: false');
  return `${lines.join('\n')}\n`;
}

/**
 * Replace the persona row (and optionally the identity row) of a preset plugin
 * list.
 * @param {string} baseYaml - the base preset's plugin-list YAML.
 * @param {{ prefix: string, complete?: boolean, includeRuntimeContext?: boolean }} persona - edited persona.
 * @param {{ text: string } | undefined} [identity] - identity override; omit to keep the base preset's own state.
 * @returns {string} the new plugin list (identity, persona, then everything else).
 */
export function composePluginsYaml(baseYaml, persona, identity) {
  let stripped = stripIdentityRow(stripPersonaRow(baseYaml))
    .replace(/\r\n/gu, '\n')
    .replace(/^\n+/u, '')
    .replace(/\n+$/u, '');
  const head = [
    ...(identity === undefined ? [] : [buildIdentityRow(identity.text).replace(/\n$/u, '')]),
    buildPersonaRow(persona).replace(/\n$/u, ''),
  ].join('\n');
  return stripped === '' ? `${head}\n` : `${head}\n${stripped}\n`;
}

/**
 * Sanitize a display name into a preset id.
 *
 * The id must be a NON-EMPTY STRING that survives YAML parsing: a bare `1` written
 * unquoted into the patch parses as a number and fails `$.id expected string`,
 * and YAML's `yes`/`no`/`on`/`off`/`null` words would become booleans or null.
 * Non-Latin names keep a readable but deterministic fallback instead of a
 * timestamp, and a purely numeric residue is always prefixed.
 * @param {string} name - display name.
 * @param {Set<string>} taken - ids already used.
 * @returns {string} unique lowercase id (letters, digits, hyphens).
 */
export function derivePresetId(name, taken = new Set()) {
  const source = String(name ?? '').toLowerCase().normalize('NFKD');
  const latin = source
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32);
  // "极简模式1" → "1" would be a number in YAML; "123" likewise. Prefix it so the
  // row id stays readable (`preset-custom-1`) and the value stays a string.
  let base = /^[0-9]+$/u.test(latin) ? `custom-${latin}` : latin;
  if (base === '') {
    // No Latin at all (CJK, Cyrillic, emoji…): hash the original name so the id is
    // stable across saves instead of depending on the clock.
    let hash = 2166136261;
    for (const character of String(name ?? '')) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619);
    }
    base = `custom-${(hash >>> 0).toString(36)}`;
  }
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Render one YAML scalar that always parses back as a string.
 *
 * JSON string syntax is valid YAML, so quoting every identifier and label removes
 * a whole class of failure: `1` would parse as a number, `yes`/`on`/`null` as a
 * boolean or null, and a leading `*`/`&`/`!`/`%`/`@` or `: ` inside the text
 * would change the document structure.
 * @param {string} value - literal text.
 * @returns {string} quoted scalar.
 */
function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

/**
 * Render the profile-patch entry that declares one managed preset.
 * @param {object} options - preset values.
 * @param {string} options.presetId - preset identity.
 * @param {string} options.rowId - Loader row id (`preset-<presetId>`).
 * @param {string} options.name - display name.
 * @param {string} [options.description] - roster description.
 * @param {number} [options.order] - roster order.
 * @param {string} options.pluginsYaml - child plugin list YAML.
 * @returns {string} one patch entry (marker comment included), newline-terminated.
 */
export function buildPresetPatchBlock(options) {
  const order = Number.isFinite(options?.order) ? options.order : MANAGED_PRESET_ORDER;
  const lines = [
    managedMarker(options.presetId),
    '- insert:',
    `    - id: ${yamlString(options.rowId)}`,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    // Quoted: the value is a string even when it looks numeric or boolean.
    `        id: ${yamlString(options.presetId)}`,
    `        name: ${yamlString(options.name)}`,
  ];
  if (typeof options.description === 'string' && options.description !== '') {
    lines.push(`        description: ${yamlString(options.description)}`);
  }
  lines.push(`        order: ${String(order)}`);
  lines.push('        plugins:');
  const body = String(options.pluginsYaml ?? '').replace(/\r\n/gu, '\n').replace(/\n+$/u, '');
  for (const line of body.split('\n')) lines.push(line === '' ? '' : `          ${line}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Append one managed block to a profile patch text.
 * @param {string} text - current patch text.
 * @param {string} block - block produced by {@link buildPresetPatchBlock}.
 * @returns {string} new patch text.
 */
export function appendManagedBlock(text, block) {
  const base = String(text ?? '');
  if (base.trim() === '') return block;
  return `${base.endsWith('\n') ? base : `${base}\n`}\n${block}`;
}

/**
 * Remove one managed block from a profile patch text.
 * @param {string} text - current patch text.
 * @param {string} presetId - preset whose block to remove.
 * @returns {{ text: string, removed: boolean }} new text and whether a block was found.
 */
export function removeManagedBlock(text, presetId) {
  const lines = String(text ?? '').split('\n');
  const marker = managedMarker(presetId);
  const start = lines.indexOf(marker);
  if (start < 0) return { text: String(text ?? ''), removed: false };
  // The block is the marker comment, its own top-level "- insert:" line, and
  // the rows below it. Blank lines can occur inside a literal block scalar, so
  // they belong to the block; it ends at the next non-empty unindented line
  // (the next patch entry or another managed block) or at EOF.
  let end = start + 1;
  if (end < lines.length && isTopLevelRow(lines[end])) end += 1;
  while (end < lines.length && (lines[end] === '' || lines[end].startsWith(' '))) end += 1;
  const from = start > 0 && lines[start - 1].trim() === '' ? start - 1 : start;
  lines.splice(from, end - from);
  return { text: lines.join('\n'), removed: true };
}

/**
 * List preset ids whose patch blocks are owned by this feature.
 * @param {string} text - profile patch text.
 * @returns {string[]} managed preset ids, in file order.
 */
export function listManagedPresets(text) {
  const ids = [];
  const pattern = /^# dsh-toolset preset: ([a-z0-9-]+) \(managed by Settings -> Toolset\)$/gmu;
  for (const match of String(text ?? '').matchAll(pattern)) ids.push(match[1]);
  return ids;
}

/** Validate and trim the user-supplied preset name. */
export function normalizePresetName(value) {
  const name = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (name === '') throw new Error('preset name must not be empty');
  if ([...name].length > MAX_PRESET_NAME_CHARS) throw new Error(`preset name must be at most ${String(MAX_PRESET_NAME_CHARS)} characters`);
  return name;
}

/** Validate the edited prompt text. */
export function normalizePrompt(value) {
  const prompt = String(value ?? '').replace(/\r\n/gu, '\n');
  if ([...prompt].length > MAX_PROMPT_CHARS) throw new Error(`prompt must be at most ${String(MAX_PROMPT_CHARS)} characters`);
  return prompt;
}

/**
 * Validate the edited opening line. An empty value is legal: it hides the line.
 * @param {unknown} value - raw identity text.
 * @returns {string} trimmed text.
 */
export function normalizeIdentity(value) {
  const text = String(value ?? '').replace(/\r\n/gu, '\n').trim();
  if ([...text].length > 2000) throw new Error('the identity line must be at most 2000 characters');
  return text;
}

/** Atomically replace one text file (temp file + rename in the same directory). */
export async function writeTextAtomic(path, text) {
  const temp = `${path}.dsh-toolset.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, path);
}

/**
 * Create the Host-side controller for the prompt-tuning feature.
 *
 * Every service is injectable so the controller is testable without DSH:
 * `agentPresets` (list/readDocument), `patchPath` (profile patch file),
 * `hmr` ({ runExclusive, reconcileProfile }), `readFile`/`writeFile`, `log`.
 *
 * @param {object} options - controller dependencies.
 * @returns {{ list: Function, base: Function, save: Function, remove: Function }} controller.
 */
export function createPromptTuning(options) {
  const {
    agentPresets,
    patchPath,
    hmr,
    readTextFile = (path) => readFile(path, 'utf8'),
    writeTextFile = writeTextAtomic,
    log = () => {},
  } = options;

  async function readPatch() {
    try {
      return await readTextFile(patchPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return '';
      throw error;
    }
  }

  /** Apply a patch text: write, then recompose through HMR (or report restart-required). */
  async function applyPatch(beforeText, nextText, requiredIds) {
    if (hmr === undefined) {
      await writeTextFile(patchPath, nextText);
      return { applied: false, restartRequired: true, warnings: [] };
    }
    const operation = async () => {
      await writeTextFile(patchPath, nextText);
      return hmr.reconcileProfile(requiredIds);
    };
    try {
      const result = await hmr.runExclusive(operation);
      const restart = result?.restartReason ?? result?.pending?.[0]?.reason;
      return {
        applied: restart === undefined,
        restartRequired: restart !== undefined,
        warnings: Array.isArray(result?.warnings) ? result.warnings : [],
      };
    } catch (error) {
      // A failed composition must not leave an unusable patch on disk: put the
      // previous document back and recompose it.
      await writeTextFile(patchPath, beforeText).catch(() => {});
      try {
        await hmr.runExclusive(() => hmr.reconcileProfile([]));
      } catch (restoreError) {
        log(`prompt-tuning: could not restore the profile patch: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
      }
      throw error;
    }
  }

  /** Read the roster and the feature-owned presets. */
  async function list() {
    const [presets, patch] = await Promise.all([agentPresets.list(), readPatch()]);
    const managedIds = listManagedPresets(patch);
    const managed = managedIds.map((id) => {
      const row = presets.find((candidate) => candidate.id === id);
      return { id, name: row?.name ?? id, broken: row?.broken };
    });
    return { presets, managed };
  }

  /** Read the editable persona of one preset. */
  async function base(presetId) {
    const id = String(presetId ?? '').trim();
    if (id === '') throw new Error('basePreset must not be empty');
    const document = await agentPresets.readDocument(id);
    const persona = parsePersona(document.content);
    const identity = parseIdentity(document.content);
    return {
      presetId: id,
      name: document.name ?? id,
      prompt: persona.prefix,
      complete: persona.complete,
      includeRuntimeContext: persona.includeRuntimeContext,
      hasPersona: persona.found,
      // Absent override means the deployment default is still in force.
      identity: identity.found ? identity.text : DEFAULT_IDENTITY,
      overridesIdentity: identity.found,
      defaultIdentity: DEFAULT_IDENTITY,
    };
  }

  /** Save the edited prompt as a new preset, or update one managed preset. */
  async function save(input) {
    const basePreset = String(input?.basePreset ?? '').trim();
    if (basePreset === '') throw new Error('basePreset must not be empty');
    const name = normalizePresetName(input?.name);
    const prompt = normalizePrompt(input?.prompt);
    const editingId = typeof input?.presetId === 'string' ? input.presetId.trim() : '';

    const before = await readPatch();
    const roster = await agentPresets.list();
    const baseRow = roster.find((row) => row.id === basePreset);
    if (baseRow === undefined) throw new Error(`unknown preset "${basePreset}"`);
    if (typeof baseRow.broken === 'string' && baseRow.broken !== '') {
      throw new Error(`preset "${basePreset}" cannot be used as a base: ${baseRow.broken}`);
    }
    const document = await agentPresets.readDocument(basePreset);
    const persona = parsePersona(document.content);
    const baseIdentity = parseIdentity(document.content);
    const complete = typeof input?.complete === 'boolean' ? input.complete : persona.complete;
    // `identity` is optional: when supplied, a value equal to the deployment
    // default removes the override row again (the default line reappears), and
    // any other value (including '') shadows it for this preset only. When the
    // caller omits it, whatever the base preset already declared is preserved.
    let identityOverride;
    if (input?.identity === undefined) {
      identityOverride = baseIdentity.found ? { text: baseIdentity.text } : undefined;
    } else {
      const identity = normalizeIdentity(input.identity);
      identityOverride = identity === DEFAULT_IDENTITY ? undefined : { text: identity };
    }
    const pluginsYaml = composePluginsYaml(
      document.content,
      {
        prefix: prompt,
        complete,
        includeRuntimeContext: persona.includeRuntimeContext,
      },
      identityOverride,
    );

    const managedIds = listManagedPresets(before);
    let presetId = editingId;
    if (presetId !== '') {
      if (!managedIds.includes(presetId)) throw new Error(`preset "${presetId}" is not managed by dsh-toolset`);
    } else {
      presetId = derivePresetId(name, new Set([...roster.map((row) => row.id), ...managedIds]));
    }
    const rowId = `preset-${presetId}`;
    const block = buildPresetPatchBlock({
      presetId,
      rowId,
      name,
      description: `Created by dsh-toolset from the "${basePreset}" preset (system-prompt tuning).`,
      order: MANAGED_PRESET_ORDER,
      pluginsYaml,
    });
    const next = appendManagedBlock(removeManagedBlock(before, presetId).text, block);

    const outcome = await applyPatch(before, next, [rowId]);
    if (outcome.restartRequired) {
      // The patch is written and parses, but HMR could not publish it (no HMR at
      // all, or a recomposition that waits for a restart). The registry cannot
      // show the row yet, so verifying here would roll back a perfectly good
      // preset; report the restart instead.
      log(`prompt-tuning: preset ${presetId} written; restart required to load it`);
      return { id: presetId, name, applied: false, restartRequired: true, warnings: outcome.warnings };
    }
    const after = await agentPresets.list();
    const created = after.find((row) => row.id === presetId);
    if (created === undefined) {
      await applyPatch(next, before, []).catch((error) => {
        log(`prompt-tuning: could not roll back a missing preset: ${error instanceof Error ? error.message : String(error)}`);
      });
      throw new Error('the preset row did not appear after the profile reload');
    }
    if (typeof created.broken === 'string' && created.broken !== '') {
      await applyPatch(next, before, []).catch((error) => {
        log(`prompt-tuning: could not roll back a broken preset: ${error instanceof Error ? error.message : String(error)}`);
      });
      throw new Error(`the preset failed to activate: ${created.broken}`);
    }
    log(`prompt-tuning: preset ${presetId} ${editingId === '' ? 'created' : 'updated'} from ${basePreset}`);
    return { id: presetId, name: created.name ?? name, applied: outcome.applied, restartRequired: outcome.restartRequired, warnings: outcome.warnings };
  }

  /** Delete one managed preset and its patch block. */
  async function remove(presetId) {
    const id = String(presetId ?? '').trim();
    if (id === '') throw new Error('presetId must not be empty');
    const before = await readPatch();
    const removed = removeManagedBlock(before, id);
    if (!removed.removed) throw new Error(`preset "${id}" is not managed by dsh-toolset`);
    const outcome = await applyPatch(before, removed.text, []);
    if (outcome.restartRequired) {
      log(`prompt-tuning: preset ${id} removed; restart required to unload it`);
      return { id, removed: true, applied: false, restartRequired: true };
    }
    const after = await agentPresets.list();
    if (after.some((row) => row.id === id)) {
      await applyPatch(removed.text, before, []).catch((error) => {
        log(`prompt-tuning: could not roll back a failed removal: ${error instanceof Error ? error.message : String(error)}`);
      });
      throw new Error(`preset "${id}" is still registered after the profile reload`);
    }
    log(`prompt-tuning: preset ${id} removed`);
    return { id, removed: true, applied: outcome.applied, restartRequired: outcome.restartRequired };
  }

  return { list, base, save, remove };
}
