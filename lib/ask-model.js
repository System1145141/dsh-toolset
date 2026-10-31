/**
 * dsh-toolset — `ask_model`: a plain chat completion against a user-configured
 * local or cloud model, plus the connection registry behind the Settings page.
 *
 * This is deliberately NOT an Agent: one HTTP call to an OpenAI-compatible
 * `/chat/completions` endpoint, no tools, no loop, no session. The model answers
 * once (text, optionally with image attachments) and the tool returns that text.
 *
 * Connections are stored in the plugin's `state.json` (never the API key); keys
 * live in the Host credential store under a per-connection reference name.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Default HTTP timeout for one chat call. */
export const DEFAULT_TIMEOUT_MS = 120000;
/** Hard bound on one attachment file. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Text attachments are truncated beyond this many bytes. */
export const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;
/** A tool call may carry at most this many attachments. */
export const MAX_ATTACHMENTS = 20;
/** Credential reference prefix (POSIX-shell identifier). */
export const SECRET_REF_PREFIX = 'DSH_TOOLSET_ASK_MODEL_';

/**
 * Reasoning-effort levels accepted by a connection and by one `ask_model` call.
 *
 * Values are forwarded as the OpenAI-compatible `reasoning_effort` field (the
 * wire name DeepSeek, Qwen/DashScope, vLLM, OpenRouter and OpenAI all use for
 * this setting). `off` omits the field entirely.
 */
export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high'];

/**
 * Minimum output budget this tool asks for on reasoning models.
 *
 * A thinking model spends `max_tokens` on its reasoning and its answer together,
 * so a small cap can be consumed entirely by the reasoning phase and return an
 * empty answer. 5000 keeps that from happening on ordinary requests.
 */
export const REASONING_MIN_MAX_TOKENS = 5000;

/** @returns {boolean} whether one value is an accepted reasoning level. */
export function isReasoningEffort(value) {
  return typeof value === 'string' && REASONING_EFFORTS.includes(value);
}

const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.csv', '.tsv',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.c',
  '.h', '.cpp', '.hpp', '.cs', '.sh', '.ps1', '.sql', '.html', '.css', '.xml', '.log',
  '.ini', '.cfg', '.env', '.srt', '.vtt',
]);

// Audio formats OpenAI-compatible endpoints accept as `input_audio`. Everything
// else is converted to mp3 with ffmpeg first (format + container matter more
// than the codec for speech models).
const AUDIO_TYPES = new Map([
  ['.wav', { format: 'wav', transcode: false }],
  ['.mp3', { format: 'mp3', transcode: false }],
  ['.m4a', { format: 'mp3', transcode: true }],
  ['.aac', { format: 'mp3', transcode: true }],
  ['.ogg', { format: 'mp3', transcode: true }],
  ['.oga', { format: 'mp3', transcode: true }],
  ['.opus', { format: 'mp3', transcode: true }],
  ['.flac', { format: 'mp3', transcode: true }],
  ['.amr', { format: 'mp3', transcode: true }],
  ['.wma', { format: 'mp3', transcode: true }],
  ['.weba', { format: 'mp3', transcode: true }],
]);

// `video_url` is the de-facto OpenAI-compatible convention (vLLM, Qwen/DashScope,
// MiniMax, OpenRouter). The URL may be a data URL carrying the bytes.
const VIDEO_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.mkv', 'video/x-matroska'],
  ['.avi', 'video/x-msvideo'],
  ['.flv', 'video/x-flv'],
  ['.wmv', 'video/x-ms-wmv'],
  ['.mpg', 'video/mpeg'],
  ['.mpeg', 'video/mpeg'],
  ['.3gp', 'video/3gpp'],
  ['.ogv', 'video/ogg'],
]);

/** Common ffmpeg locations on Windows; PATH is tried first. */
function ffmpegCandidates() {
  return [
    process.env.DSH_TOOLSET_FFMPEG,
    'ffmpeg',
    'C:\\1\\ffmpeg-master-latest-win64-gpl\\bin\\ffmpeg.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    join(process.env.ProgramFiles ?? '', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '');
}

let ffmpegCache;

/**
 * Locate a working ffmpeg binary once per process.
 * @param {object} [options] - `ffmpegPath` overrides discovery; `false` disables it.
 * @returns {Promise<string|undefined>} path or undefined.
 */
export async function resolveFfmpeg(options = {}) {
  if (options.ffmpegPath === false) return undefined;
  if (typeof options.ffmpegPath === 'string' && options.ffmpegPath !== '') return options.ffmpegPath;
  if (ffmpegCache !== undefined) return ffmpegCache ?? undefined;
  for (const candidate of ffmpegCandidates()) {
    try {
      await execFileAsync(candidate, ['-version'], { timeout: 5000, windowsHide: true });
      ffmpegCache = candidate;
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  ffmpegCache = null;
  return undefined;
}

/**
 * Convert an audio file to mono 16 kHz mp3 for `input_audio`.
 * @param {string} inputPath - source file.
 * @param {object} [options] - ffmpeg override.
 * @returns {Promise<Buffer>} mp3 bytes.
 */
export async function transcodeAudioToMp3(inputPath, options = {}) {
  const ffmpeg = await resolveFfmpeg(options);
  if (ffmpeg === undefined) {
    throw new Error('this audio format needs ffmpeg to convert to mp3; install ffmpeg, set DSH_TOOLSET_FFMPEG, or use a .mp3/.wav file');
  }
  const output = join(tmpdir(), `dsh-toolset-audio-${randomUUID()}.mp3`);
  try {
    await execFileAsync(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', output], {
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return await readFile(output);
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim().split(/\r?\n/u).slice(-2).join(' ') : '';
    throw new Error(`ffmpeg could not convert "${inputPath}"${stderr === '' ? '' : `: ${stderr}`}`);
  } finally {
    await rm(output, { force: true });
  }
}

/** @returns {string} the credential reference for one connection id. */
export function secretRefFor(id) {
  return `${SECRET_REF_PREFIX}${String(id).replace(/[^a-zA-Z0-9]+/gu, '_').toUpperCase()}`;
}

/** @returns {string} a URL-safe connection id derived from a display name. */
export function deriveConnectionId(name, taken = new Set()) {
  const base = String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32);
  let candidate = base === '' ? `conn-${Date.now().toString(36)}` : base;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base === '' ? 'conn' : base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** @returns {boolean} whether the endpoint points at this machine. */
export function isLocalEndpoint(baseURL) {
  try {
    const host = new URL(baseURL).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * Validate one connection definition.
 * @param {object} input - raw connection fields.
 * @param {object} [options] - id/taken context.
 * @returns {object} normalized connection (without any secret value).
 */
export function normalizeConnection(input, options = {}) {
  const name = String(input?.name ?? '').replace(/\s+/gu, ' ').trim();
  if (name === '') throw new Error('connection name must not be empty');
  if ([...name].length > 60) throw new Error('connection name must be at most 60 characters');
  const rawBase = String(input?.baseURL ?? '').trim();
  if (rawBase === '') throw new Error('baseURL must not be empty');
  let url;
  try {
    url = new URL(rawBase);
  } catch {
    throw new Error('baseURL must be a valid http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('baseURL must use http or https');
  url.pathname = url.pathname.replace(/\/+$/u, '');
  const model = String(input?.model ?? '').trim();
  if (model === '') throw new Error('model must not be empty');
  if ([...model].length > 120) throw new Error('model must be at most 120 characters');

  const id = String(options.existingId ?? input?.id ?? '').trim() || deriveConnectionId(name, options.taken);
  if (!/^[a-z0-9-]+$/u.test(id)) throw new Error('connection id must contain only lowercase letters, digits and hyphens');

  const vision = input?.vision === undefined ? true : input.vision === true;
  const audio = input?.audio === true;
  const video = input?.video === true;
  // Reasoning: `undefined` keeps the endpoint's own default; a declared level is
  // sent as `reasoning_effort` on every request of this connection.
  let reasoning;
  if (input?.reasoning !== undefined && input.reasoning !== null && input.reasoning !== '') {
    if (!isReasoningEffort(input.reasoning)) throw new Error(`reasoning must be one of ${REASONING_EFFORTS.join(', ')}`);
    reasoning = input.reasoning;
  }
  const timeoutMs = input?.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(input.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('timeoutMs must be an integer between 1000 and 600000');

  let maxTokens;
  if (input?.maxTokens !== undefined && input.maxTokens !== null && input.maxTokens !== '') {
    maxTokens = Number(input.maxTokens);
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 131072) throw new Error('maxTokens must be an integer between 1 and 131072');
  }

  let temperature;
  if (input?.temperature !== undefined && input.temperature !== null && input.temperature !== '') {
    temperature = Number(input.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error('temperature must be a number between 0 and 2');
  }

  let headers;
  if (input?.headers !== undefined) {
    if (input.headers === null || typeof input.headers !== 'object' || Array.isArray(input.headers)) throw new Error('headers must be an object');
    const entries = Object.entries(input.headers).slice(0, 20);
    headers = {};
    for (const [key, value] of entries) {
      if (typeof value !== 'string') throw new Error('header values must be strings');
      if (!/^[A-Za-z0-9-]+$/u.test(key)) throw new Error(`invalid header name "${key}"`);
      headers[key] = value;
    }
  }

  return {
    id,
    name,
    baseURL: url.href.replace(/\/+$/u, ''),
    model,
    vision,
    audio,
    video,
    ...(reasoning === undefined ? {} : { reasoning }),
    timeoutMs,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(headers === undefined ? {} : { headers }),
  };
}

/** @returns {string} the `/chat/completions` endpoint for one base URL. */
export function endpointFor(baseURL) {
  const url = new URL(baseURL);
  const path = url.pathname.replace(/\/+$/u, '');
  if (path.endsWith('/chat/completions')) return url.href;
  url.pathname = `${path}/chat/completions`;
  return url.href;
}

/**
 * @param {string} name - file name or URL path.
 * @returns {{kind: 'image'|'text'|'audio'|'video'|undefined, mime?: string, format?: 'wav'|'mp3', transcode?: boolean}} what an extension denotes.
 */
export function attachmentKind(name) {
  const extension = extname(String(name ?? '')).toLowerCase();
  const mime = IMAGE_TYPES.get(extension);
  if (mime !== undefined) return { kind: 'image', mime };
  if (TEXT_EXTENSIONS.has(extension)) return { kind: 'text' };
  const audio = AUDIO_TYPES.get(extension);
  if (audio !== undefined) {
    return { kind: 'audio', format: audio.format, transcode: audio.transcode };
  }
  const videoMime = VIDEO_TYPES.get(extension);
  if (videoMime !== undefined) return { kind: 'video', mime: videoMime };
  return { kind: undefined };
}

const EXPLICIT_KINDS = new Set(['image', 'text', 'audio', 'video']);

/** @returns {boolean} whether a string is an accepted explicit attachment kind. */
function isExplicitKind(value) {
  return typeof value === 'string' && EXPLICIT_KINDS.has(value);
}

/** @returns {boolean} whether a media kind is enabled on the connection. */
function capabilityAllows(kind, capabilities) {
  if (capabilities === undefined) return true;
  if (kind === 'image') return capabilities.vision !== false;
  if (kind === 'audio') return capabilities.audio === true;
  if (kind === 'video') return capabilities.video === true;
  return true;
}

/** @returns {string} a clear error naming the connection capability to enable. */
function capabilityError(kind, connectionName) {
  const label = kind === 'image' ? 'images' : kind === 'audio' ? 'audio' : 'video';
  const setting = kind === 'image' ? 'The model accepts images' : kind === 'audio' ? 'The model accepts audio' : 'The model accepts video';
  const who = connectionName === undefined ? 'this connection' : `connection "${connectionName}"`;
  return `${who} does not accept ${label}; enable "${setting}" for it in Settings → Toolset → Ask a model`;
}

/**
 * Load attachments into model-ready parts.
 * @param {Array<{path?: string, url?: string, name?: string, kind?: string}>} attachments - tool input.
 * @param {object} [options] - cwd, connection capabilities, injectable fs/ffmpeg.
 * @returns {Promise<{images: Array<{url: string, name: string}>, audios: Array<{data: string, format: 'wav'|'mp3', name: string}>, videos: Array<{url: string, name: string, mime?: string}>, texts: Array<{name: string, text: string}>, summary: Array<{name: string, kind: string, bytes: number}>}>} loaded parts.
 */
export async function loadAttachments(attachments, options = {}) {
  if (attachments === undefined) return { images: [], audios: [], videos: [], texts: [], summary: [] };
  if (!Array.isArray(attachments)) throw new Error('attachments must be an array');
  if (attachments.length > MAX_ATTACHMENTS) throw new Error(`at most ${String(MAX_ATTACHMENTS)} attachments are allowed`);
  const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd();
  const read = options.readFileImpl ?? readFile;
  const statFile = options.statImpl ?? stat;
  const capabilities = options.capabilities;
  const connectionName = typeof options.connectionName === 'string' ? options.connectionName : undefined;
  const images = [];
  const audios = [];
  const videos = [];
  const texts = [];
  const summary = [];
  for (const [index, entry] of attachments.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`attachment ${String(index + 1)} must be an object`);
    const label = typeof entry.name === 'string' && entry.name !== '' ? entry.name : undefined;
    const explicitKind = isExplicitKind(entry.kind) ? entry.kind : undefined;
    if (typeof entry.path === 'string' && entry.path !== '') {
      const path = isAbsolute(entry.path) ? entry.path : join(cwd, entry.path);
      const name = label ?? path.split(/[\\/]/u).pop() ?? path;
      const detected = attachmentKind(name);
      const kind = explicitKind ?? detected.kind;
      if (kind === undefined) throw new Error(`attachment "${name}" is not a supported image, audio, video or text file`);
      if (!capabilityAllows(kind, capabilities)) throw new Error(capabilityError(kind, connectionName));
      const info = await statFile(path);
      if (!info.isFile()) throw new Error(`attachment "${name}" is not a file`);
      if (info.size > MAX_ATTACHMENT_BYTES) throw new Error(`attachment "${name}" exceeds ${String(MAX_ATTACHMENT_BYTES)} bytes`);
      if (kind === 'image') {
        if (detected.kind !== 'image') throw new Error(`attachment "${name}" needs a .png/.jpg/.webp/.gif extension to be sent as an image`);
        const bytes = await read(path);
        images.push({ url: `data:${detected.mime};base64,${Buffer.from(bytes).toString('base64')}`, name });
        summary.push({ name, kind: 'image', bytes: info.size });
      } else if (kind === 'text') {
        const buffer = await read(path);
        const truncated = buffer.byteLength > MAX_TEXT_ATTACHMENT_BYTES;
        const text = buffer.subarray(0, MAX_TEXT_ATTACHMENT_BYTES).toString('utf8');
        texts.push({ name, text: truncated ? `${text}\n…(truncated)` : text });
        summary.push({ name, kind: 'text', bytes: info.size });
      } else if (kind === 'audio') {
        const format = detected.kind === 'audio' ? detected.format : 'mp3';
        const transcode = detected.kind === 'audio' ? detected.transcode === true : true;
        const data = transcode
          ? Buffer.from(await transcodeAudioToMp3(path, options)).toString('base64')
          : Buffer.from(await read(path)).toString('base64');
        audios.push({ name, format, data });
        summary.push({ name, kind: 'audio', bytes: info.size, format });
      } else {
        const mime = detected.kind === 'video' ? detected.mime : 'video/mp4';
        const bytes = await read(path);
        videos.push({ name, url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`, mime });
        summary.push({ name, kind: 'video', bytes: info.size, mime });
      }
      continue;
    }
    if (typeof entry.url === 'string' && entry.url !== '') {
      let url;
      try {
        url = new URL(entry.url);
      } catch {
        throw new Error(`attachment ${String(index + 1)} is not a valid URL`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('attachment URLs must use http or https');
      const name = label ?? url.pathname.split('/').pop() ?? url.href;
      const kind = explicitKind ?? attachmentKind(name).kind;
      if (kind === undefined) throw new Error(`attachment URL "${name}" must point at an image or video`);
      if (!capabilityAllows(kind, capabilities)) throw new Error(capabilityError(kind, connectionName));
      if (kind === 'audio') throw new Error('audio attachments must be local files (audio URLs are not supported)');
      if (kind === 'text') throw new Error('text attachments must be local files');
      if (kind === 'video') {
        videos.push({ url: url.href, name });
        summary.push({ name, kind: 'video', bytes: 0 });
      } else {
        images.push({ url: url.href, name });
        summary.push({ name, kind: 'image', bytes: 0 });
      }
      continue;
    }
    throw new Error(`attachment ${String(index + 1)} needs a "path" or "url"`);
  }
  return { images, audios, videos, texts, summary };
}

/** @returns {Array<object>} OpenAI-compatible chat messages. */
export function buildMessages({ prompt, system, attachments }) {
  const textParts = [String(prompt ?? '')];
  for (const file of attachments?.texts ?? []) {
    textParts.push(`<attachment name="${file.name}">\n${file.text}\n</attachment>`);
  }
  const text = textParts.join('\n\n');
  const mediaParts = [
    ...(attachments?.images ?? []).map((image) => ({ type: 'image_url', image_url: { url: image.url } })),
    ...(attachments?.audios ?? []).map((audio) => ({ type: 'input_audio', input_audio: { data: audio.data, format: audio.format } })),
    ...(attachments?.videos ?? []).map((video) => ({ type: 'video_url', video_url: { url: video.url } })),
  ];
  const userContent = mediaParts.length === 0 ? text : [{ type: 'text', text }, ...mediaParts];
  return [
    ...(typeof system === 'string' && system.trim() !== '' ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: userContent },
  ];
}

/**
 * Effective `max_tokens` for one connection when the caller names none.
 *
 * A thinking model shares the output budget between reasoning and answer, so a
 * connection without an explicit cap gets `REASONING_MIN_MAX_TOKENS`; a
 * non-reasoning one keeps sending no cap at all.
 * @param {object} [connection] - connection definition.
 * @returns {number|undefined} token cap, or undefined to send none.
 */
export function defaultMaxTokens(connection) {
  if (connection?.maxTokens !== undefined) return connection.maxTokens;
  return connection?.reasoning !== undefined && connection.reasoning !== 'off' ? REASONING_MIN_MAX_TOKENS : undefined;
}

/**
 * Perform one chat completion.
 * @param {object} options - request options.
 * @returns {Promise<{text: string, model?: string, usage?: object, finishReason?: string}>} answer.
 */
export async function chatCompletion(options) {
  const {
    connection,
    apiKey,
    messages,
    signal,
    timeoutMs = connection?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    maxTokens = defaultMaxTokens(connection),
    temperature = connection?.temperature,
    reasoning = connection?.reasoning,
  } = options;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable in this Host');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('request timed out')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('request aborted'));
  if (signal !== undefined) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const headers = {
    'content-type': 'application/json',
    ...(typeof apiKey === 'string' && apiKey !== '' ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(connection?.headers ?? {}),
  };
  const body = {
    model: connection.model,
    messages,
    stream: false,
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    ...(temperature === undefined ? {} : { temperature }),
    // OpenAI-compatible reasoning control. `off` (or no level at all) omits the
    // field so the endpoint applies its own default.
    ...(isReasoningEffort(reasoning) && reasoning !== 'off' ? { reasoning_effort: reasoning } : {}),
  };
  let response;
  try {
    response = await fetchImpl(endpointFor(connection.baseURL), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`request aborted: ${controller.signal.reason instanceof Error ? controller.signal.reason.message : 'timeout or cancellation'}`);
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) signal.removeEventListener('abort', onAbort);
  }
  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = undefined;
  }
  if (response.ok !== true) {
    const message = payload?.error?.message ?? payload?.message ?? raw.slice(0, 500);
    throw new Error(`HTTP ${String(response.status)}: ${typeof message === 'string' && message !== '' ? message : 'request failed'}`);
  }
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined;
  let content = choice?.message?.content;
  if (Array.isArray(content)) {
    content = content.map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('');
  }
  if (typeof content !== 'string' || content === '') throw new Error('the endpoint returned no message content');
  return {
    text: content,
    ...(typeof payload?.model === 'string' ? { model: payload.model } : {}),
    ...(payload?.usage !== undefined && payload.usage !== null ? { usage: payload.usage } : {}),
    ...(typeof choice?.finish_reason === 'string' ? { finishReason: choice.finish_reason } : {}),
  };
}

/** @returns {object|undefined} the connection a tool call asked for (default when omitted). */
export function resolveConnection(config, wanted) {
  const connections = Array.isArray(config?.connections) ? config.connections : [];
  const key = String(wanted ?? '').trim();
  if (key === '') {
    return connections.find((connection) => connection.id === config?.defaultId) ?? connections[0];
  }
  return connections.find((connection) => connection.id === key)
    ?? connections.find((connection) => connection.name === key)
    ?? connections.find((connection) => connection.name.toLowerCase() === key.toLowerCase());
}

/** @returns {string} the model-facing tool description for the current registry. */
export function buildAskModelDescription(config) {
  const connections = Array.isArray(config?.connections) ? config.connections : [];
  const parts = [
    'Ask a separate chat model a question. This is a plain chat completion, not an Agent: the model has no tools, cannot act, and only answers once.',
    'Use it for a cheap second opinion, classification, extraction, translation, summarization, a vision question about images, or a question about an audio or video file.',
  ];
  if (connections.length === 0) {
    parts.push('No model connection is configured yet; the user must add one in Settings → Toolset → Ask a model.');
  } else {
    const defaultId = config?.defaultId ?? connections[0].id;
    const rows = connections.map((connection) => {
      const capabilities = [
        connection.vision === false ? '' : 'images',
        connection.audio === true ? 'audio' : '',
        connection.video === true ? 'video' : '',
      ].filter((label) => label !== '');
      const reasoningLabel = typeof connection.reasoning === 'string' && connection.reasoning !== '' ? ` · reasoning ${connection.reasoning}` : '';
      return `"${connection.id}" (${connection.name} · ${connection.model}${connection.id === defaultId ? ' · default' : ''}${capabilities.length === 0 ? '' : ` · ${capabilities.join('+')}`}${reasoningLabel})`;
    });
    parts.push(`Available connections: ${rows.join(', ')}. Omit "connection" to use the default.`);
  }
  const reasoningRows = connections
    .filter((connection) => typeof connection.reasoning === 'string' && connection.reasoning !== '')
    .map((connection) => `"${connection.id}" ${connection.reasoning}`);
  if (reasoningRows.length > 0) {
    parts.push(`Configured reasoning effort: ${reasoningRows.join(', ')}. Override one call with "reasoning": ${REASONING_EFFORTS.map((level) => `"${level}"`).join(' / ')} ("off" disables extended thinking).`);
  } else {
    parts.push(`This tool can request reasoning effort with "reasoning": ${REASONING_EFFORTS.map((level) => `"${level}"`).join(' / ')}. It is sent as the OpenAI-compatible reasoning_effort field; "off" omits it and leaves the endpoint's own default.`);
  }
  parts.push(`When a call uses any reasoning level other than "off", set "max_tokens" to at least ${String(REASONING_MIN_MAX_TOKENS)}: a thinking model spends that budget on its reasoning and its answer together, so a smaller cap can be eaten entirely by the reasoning phase and return an empty answer. This tool raises anything below ${String(REASONING_MIN_MAX_TOKENS)} to ${String(REASONING_MIN_MAX_TOKENS)} for such calls and defaults to ${String(REASONING_MIN_MAX_TOKENS)} when no cap is given; non-reasoning calls keep the cap you pass.`);
  parts.push('Attachments: workspace file paths or http(s) URLs. Images are sent as image parts, audio as input_audio (wav/mp3; other formats are converted with ffmpeg), video as video_url, and text files are inlined. The chosen connection must have the matching capability enabled (images/audio/video) in Settings → Toolset → Ask a model.');
  return parts.join(' ');
}

/**
 * Resolve the `max_tokens` a call actually sends.
 *
 * Reasoning models need room for their reasoning phase: an explicit cap below
 * `REASONING_MIN_MAX_TOKENS` is raised to that floor, and a call with no cap at
 * all gets the floor. Non-reasoning calls keep exactly what the caller asked for.
 * @param {object} options - decision inputs.
 * @param {number|undefined} options.requested - the caller's explicit cap.
 * @param {string|undefined} options.reasoning - effective reasoning level.
 * @param {object} options.connection - connection definition.
 * @returns {{ maxTokens: number|undefined, raisedFrom?: number }} effective cap.
 */
export function resolveMaxTokens({ requested, reasoning, connection }) {
  const thinks = typeof reasoning === 'string' && reasoning !== 'off';
  if (!thinks) {
    return { maxTokens: requested === undefined ? connection?.maxTokens : requested };
  }
  const base = requested === undefined ? (connection?.maxTokens ?? REASONING_MIN_MAX_TOKENS) : requested;
  if (base < REASONING_MIN_MAX_TOKENS) return { maxTokens: REASONING_MIN_MAX_TOKENS, raisedFrom: base };
  return { maxTokens: base };
}

/**
 * Build the `ask_model` tool definition.
 * @param {object} options - dependencies.
 * @param {() => object} options.getConfig - current `{connections, defaultId}`.
 * @param {(connection: object) => Promise<string|undefined>} options.resolveApiKey - read the stored key.
 * @returns {object} tool definition for `ctx.tools.register`.
 */
export function createAskModelTool({ getConfig, resolveApiKey, log = () => {}, fetchImpl }) {
  return {
    name: 'ask_model',
    description: buildAskModelDescription(getConfig()),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'The question or instruction for the model.' },
        system: { type: 'string', description: 'Optional system instruction for this one request.' },
        connection: { type: 'string', description: 'Configured connection id or display name; omit to use the default connection.' },
        attachments: {
          type: 'array',
          description: 'Files to include: a workspace-relative or absolute "path" (images, audio, video, text), or an http(s) image/video "url".',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string' },
              url: { type: 'string' },
              name: { type: 'string' },
              kind: { type: 'string', enum: ['image', 'text', 'audio', 'video'], description: 'Optional media kind; normally inferred from the file extension.' },
            },
          },
        },
        max_tokens: { type: 'integer', description: `Optional output token cap. Reasoning models share this budget between thinking and the answer, so this tool raises any value below ${String(REASONING_MIN_MAX_TOKENS)} to ${String(REASONING_MIN_MAX_TOKENS)} for them (and defaults to ${String(REASONING_MIN_MAX_TOKENS)} when omitted).` },
        temperature: { type: 'number', description: 'Optional sampling temperature for this request.' },
        reasoning: { type: 'string', enum: REASONING_EFFORTS, description: 'Optional reasoning effort for this request: "off" disables extended thinking, otherwise low/medium/high. Overrides the connection default; omit to use the connection setting.' },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string' },
          connection: { type: 'string' },
          model: { type: 'string' },
          reasoning: { type: 'string' },
          maxTokens: { type: 'integer' },
          raisedFrom: { type: 'integer' },
          usage: { type: 'object' },
          elapsedMs: { type: 'number' },
          attachments: { type: 'array', items: { type: 'object' } },
        },
        required: ['answer', 'connection', 'model', 'elapsedMs'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            value.answer,
            '',
            `(${[
              value.connection,
              value.model,
              typeof value.reasoning === 'string' ? `reasoning ${value.reasoning}` : '',
              typeof value.maxTokens === 'number'
                ? `max_tokens ${String(value.maxTokens)}${typeof value.raisedFrom === 'number' ? ` (raised from ${String(value.raisedFrom)})` : ''}`
                : '',
              `${String(value.elapsedMs)} ms`,
            ].filter((part) => part !== '').join(' · ')})`,
          ].join('\n'),
        },
      ],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Ask a model',
      kind: 'other',
      rawInput: args,
    }),
    async execute(args, exec) {
      const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
      if (prompt.trim() === '') throw new Error('ask_model requires a non-empty prompt');
      const config = getConfig();
      const connection = resolveConnection(config, args?.connection);
      if (connection === undefined) {
        const names = (config?.connections ?? []).map((row) => `"${row.id}"`).join(', ');
        throw new Error(names === '' ? 'no model connection is configured; add one in Settings → Toolset → Ask a model' : `unknown connection "${String(args?.connection)}"; available: ${names}`);
      }
      if (args?.attachments !== undefined && args.attachments !== null && !Array.isArray(args.attachments)) throw new Error('attachments must be an array');
      if (args?.max_tokens !== undefined && (!Number.isInteger(args.max_tokens) || args.max_tokens < 1 || args.max_tokens > 131072)) throw new Error('max_tokens must be an integer between 1 and 131072');
      if (args?.temperature !== undefined && (typeof args.temperature !== 'number' || args.temperature < 0 || args.temperature > 2)) throw new Error('temperature must be a number between 0 and 2');
      if (args?.reasoning !== undefined && !isReasoningEffort(args.reasoning)) throw new Error(`reasoning must be one of ${REASONING_EFFORTS.join(', ')}`);
      // A per-call level wins over the connection's own setting.
      const reasoning = typeof args?.reasoning === 'string' ? args.reasoning : connection.reasoning;
      const budget = resolveMaxTokens({ requested: args?.max_tokens, reasoning, connection });
      const cwd = exec?.agent?.session?.header?.cwd ?? exec?.agent?.session?.cwd ?? process.cwd();
      const loaded = await loadAttachments(args?.attachments, {
        cwd,
        connectionName: connection.name,
        capabilities: { vision: connection.vision !== false, audio: connection.audio === true, video: connection.video === true },
      });
      const messages = buildMessages({ prompt, system: args?.system, attachments: loaded });
      const apiKey = await resolveApiKey(connection);
      const started = Date.now();
      const result = await chatCompletion({
        connection,
        apiKey,
        messages,
        signal: exec?.signal,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens }),
        ...(args?.temperature === undefined ? {} : { temperature: args.temperature }),
        ...(reasoning === undefined ? {} : { reasoning }),
      });
      const elapsedMs = Date.now() - started;
      log(`ask_model: ${connection.id} answered in ${String(elapsedMs)} ms${reasoning === undefined ? '' : ` (reasoning ${reasoning})`}`);
      return {
        answer: result.text,
        connection: connection.id,
        model: result.model ?? connection.model,
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens }),
        ...(budget.raisedFrom === undefined ? {} : { raisedFrom: budget.raisedFrom }),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        elapsedMs,
        attachments: loaded.summary,
      };
    },
  };
}

/** @returns {object} a normalized `askModel` state slice. */
export function normalizeAskModelState(value) {
  const input = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const connections = [];
  for (const raw of Array.isArray(input.connections) ? input.connections : []) {
    try {
      const connection = normalizeConnection(raw, { existingId: raw?.id });
      connections.push(connection);
    } catch {
      // A hand-edited or outdated entry must not break the whole registry.
    }
  }
  const defaultId = typeof input.defaultId === 'string' && connections.some((connection) => connection.id === input.defaultId)
    ? input.defaultId
    : connections[0]?.id ?? '';
  return { connections, defaultId };
}
