import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  attachmentKind,
  buildAskModelDescription,
  buildMessages,
  chatCompletion,
  createAskModelTool,
  deriveConnectionId,
  endpointFor,
  isLocalEndpoint,
  loadAttachments,
  normalizeAskModelState,
  normalizeConnection,
  resolveConnection,
  resolveFfmpeg,
  secretRefFor,
  transcodeAudioToMp3,
} from '../lib/ask-model.js';

test('normalizeConnection validates fields and derives ids', () => {
  const connection = normalizeConnection({ name: 'Local Ollama', baseURL: 'http://127.0.0.1:11434/v1/', model: 'qwen2.5:3b' });
  assert.deepEqual(connection, {
    id: 'local-ollama',
    name: 'Local Ollama',
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:3b',
    vision: true,
    audio: false,
    video: false,
    timeoutMs: 120000,
  });
  assert.equal(connection.id, 'local-ollama');
  assert.equal(normalizeConnection({ name: 'Local Ollama', baseURL: 'http://x/v1', model: 'm' }, { taken: new Set(['local-ollama']) }).id, 'local-ollama-2');
  assert.equal(deriveConnectionId('中文名字'), deriveConnectionId('中文名字'));
  assert.match(deriveConnectionId('中文名字'), /^conn-[a-z0-9]+$/u);
  assert.equal(secretRefFor('local-ollama'), 'DSH_TOOLSET_ASK_MODEL_LOCAL_OLLAMA');

  assert.throws(() => normalizeConnection({ name: '', baseURL: 'http://x', model: 'm' }), /name/u);
  assert.throws(() => normalizeConnection({ name: 'x', baseURL: 'ftp://x', model: 'm' }), /http/u);
  assert.throws(() => normalizeConnection({ name: 'x', baseURL: 'http://x', model: '' }), /model/u);
  assert.throws(() => normalizeConnection({ name: 'x', baseURL: 'http://x', model: 'm', timeoutMs: 5 }), /timeoutMs/u);
  assert.throws(() => normalizeConnection({ name: 'x', baseURL: 'http://x', model: 'm', temperature: 3 }), /temperature/u);
  assert.throws(() => normalizeConnection({ name: 'x', baseURL: 'http://x', model: 'm', headers: { 'bad header': 'x' } }), /header/u);

  const full = normalizeConnection({ name: 'Cloud', baseURL: 'https://api.example.com/v1', model: 'm', vision: false, audio: true, video: true, maxTokens: 256, temperature: 0.2, headers: { 'x-extra': '1' } });
  assert.equal(full.vision, false);
  assert.equal(full.audio, true);
  assert.equal(full.video, true);
  assert.equal(full.maxTokens, 256);
  assert.equal(full.temperature, 0.2);
  assert.deepEqual(full.headers, { 'x-extra': '1' });
});

test('endpointFor appends /chat/completions once', () => {
  assert.equal(endpointFor('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(endpointFor('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(endpointFor('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/chat/completions');
  assert.equal(isLocalEndpoint('http://127.0.0.1:11434/v1'), true);
  assert.equal(isLocalEndpoint('https://api.example.com/v1'), false);
});

test('attachment kinds are detected from extensions', () => {
  assert.deepEqual(attachmentKind('a.PNG'), { kind: 'image', mime: 'image/png' });
  assert.deepEqual(attachmentKind('notes.md'), { kind: 'text' });
  assert.deepEqual(attachmentKind('voice.wav'), { kind: 'audio', format: 'wav', transcode: false });
  assert.deepEqual(attachmentKind('voice.mp3'), { kind: 'audio', format: 'mp3', transcode: false });
  assert.deepEqual(attachmentKind('voice.m4a'), { kind: 'audio', format: 'mp3', transcode: true });
  assert.deepEqual(attachmentKind('clip.mp4'), { kind: 'video', mime: 'video/mp4' });
  assert.deepEqual(attachmentKind('clip.webm'), { kind: 'video', mime: 'video/webm' });
  assert.deepEqual(attachmentKind('archive.zip'), { kind: undefined });
});

test('loadAttachments inlines images and text files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-toolset-ask-'));
  try {
    await writeFile(join(dir, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(dir, 'notes.md'), '# Notes\nhello\n');
    const loaded = await loadAttachments(
      [{ path: 'pixel.png', name: 'pixel.png' }, { path: join(dir, 'notes.md') }, { url: 'https://example.com/a.jpg' }],
      { cwd: dir },
    );
    assert.equal(loaded.images.length, 2);
    assert.match(loaded.images[0].url, /^data:image\/png;base64,/u);
    assert.equal(loaded.images[1].url, 'https://example.com/a.jpg');
    assert.equal(loaded.texts.length, 1);
    assert.match(loaded.texts[0].text, /hello/u);
    assert.deepEqual(loaded.summary.map((row) => row.kind), ['image', 'text', 'image']);

    await assert.rejects(loadAttachments([{ path: 'missing.png' }], { cwd: dir }), /ENOENT/u);
    await assert.rejects(loadAttachments([{ path: 'archive.zip' }], { cwd: dir }), /not a supported/u);
    await assert.rejects(loadAttachments([{ url: 'ftp://x/a.png' }]), /http/u);
    await assert.rejects(loadAttachments([{}]), /needs a "path" or "url"/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadAttachments carries audio and video and enforces capabilities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-toolset-ask-'));
  try {
    const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
    await writeFile(join(dir, 'voice.mp3'), mp3);
    await writeFile(join(dir, 'clip.mp4'), Buffer.from([0x00, 0x00, 0x00, 0x18]));
    await writeFile(join(dir, 'recording'), Buffer.from([1, 2, 3]));
    const loaded = await loadAttachments(
      [{ path: 'voice.mp3' }, { path: 'clip.mp4' }, { path: 'recording', kind: 'video' }],
      { cwd: dir, capabilities: { vision: true, audio: true, video: true } },
    );
    assert.equal(loaded.audios.length, 1);
    assert.equal(loaded.audios[0].format, 'mp3');
    assert.equal(loaded.audios[0].data, mp3.toString('base64'));
    assert.equal(loaded.videos.length, 2);
    assert.match(loaded.videos[0].url, /^data:video\/mp4;base64,/u);
    assert.match(loaded.videos[1].url, /^data:video\/mp4;base64,/u);
    assert.deepEqual(loaded.summary.map((row) => row.kind), ['audio', 'video', 'video']);

    const remote = await loadAttachments([{ url: 'https://example.com/clip.mp4' }], { capabilities: { vision: true, audio: true, video: true } });
    assert.equal(remote.videos[0].url, 'https://example.com/clip.mp4');

    await assert.rejects(
      loadAttachments([{ path: 'voice.mp3' }], { cwd: dir, connectionName: 'Local', capabilities: { vision: true, audio: false, video: false } }),
      /connection "Local" does not accept audio/u,
    );
    await assert.rejects(
      loadAttachments([{ path: 'clip.mp4' }], { cwd: dir, connectionName: 'Local', capabilities: { vision: true, audio: true, video: false } }),
      /does not accept video/u,
    );
    await assert.rejects(loadAttachments([{ url: 'https://example.com/a.mp3' }], { capabilities: { vision: true, audio: true, video: true } }), /local files/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('transcodeAudioToMp3 converts with ffmpeg when available', async (t) => {
  const ffmpeg = await resolveFfmpeg();
  if (ffmpeg === undefined) {
    t.skip('ffmpeg is not available');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'dsh-toolset-ffmpeg-'));
  try {
    const { execFile } = await import('node:child_process');
    const source = join(dir, 'tone.wav');
    await new Promise((resolve, reject) => {
      execFile(ffmpeg, ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-ac', '1', '-ar', '16000', source], (error) => (error === null ? resolve() : reject(error)));
    });
    const mp3 = await transcodeAudioToMp3(source);
    assert.ok(mp3.length > 100);
    assert.ok(mp3[0] === 0xff || mp3.subarray(0, 3).toString() === 'ID3');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildMessages emits text, vision, audio and video parts', () => {
  const textOnly = buildMessages({ prompt: 'Hello', attachments: { images: [], texts: [{ name: 'a.md', text: 'body' }] } });
  assert.equal(textOnly.length, 1);
  assert.equal(textOnly[0].role, 'user');
  assert.match(textOnly[0].content, /Hello/u);
  assert.match(textOnly[0].content, /<attachment name="a.md">/u);

  const vision = buildMessages({
    prompt: 'What is this?',
    system: 'Be brief.',
    attachments: { images: [{ url: 'data:image/png;base64,AA==', name: 'a.png' }], texts: [] },
  });
  assert.equal(vision.length, 2);
  assert.equal(vision[0].role, 'system');
  assert.equal(vision[1].content[0].type, 'text');
  assert.equal(vision[1].content[1].type, 'image_url');
  assert.equal(vision[1].content[1].image_url.url, 'data:image/png;base64,AA==');

  const media = buildMessages({
    prompt: 'What happens?',
    attachments: {
      images: [],
      audios: [{ name: 'a.mp3', format: 'mp3', data: 'QUJD' }],
      videos: [{ name: 'v.mp4', url: 'data:video/mp4;base64,QQ==' }],
      texts: [],
    },
  });
  assert.equal(media[0].content[0].type, 'text');
  assert.deepEqual(media[0].content[1], { type: 'input_audio', input_audio: { data: 'QUJD', format: 'mp3' } });
  assert.deepEqual(media[0].content[2], { type: 'video_url', video_url: { url: 'data:video/mp4;base64,QQ==' } });
});

test('chatCompletion parses text, usage and errors', async () => {
  const connection = normalizeConnection({ name: 'Local', baseURL: 'http://127.0.0.1:11434/v1', model: 'm' });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ model: 'm2', choices: [{ message: { content: 'hi there' }, finish_reason: 'stop' }], usage: { total_tokens: 7 } }), { status: 200 });
  };
  const result = await chatCompletion({ connection, apiKey: 'secret', messages: [{ role: 'user', content: 'hi' }], fetchImpl });
  assert.equal(result.text, 'hi there');
  assert.equal(result.model, 'm2');
  assert.deepEqual(result.usage, { total_tokens: 7 });
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret');
  assert.equal(JSON.parse(calls[0].init.body).stream, false);

  const arrayContent = await chatCompletion({
    connection,
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }), { status: 200 }),
  });
  assert.equal(arrayContent.text, 'ab');

  await assert.rejects(
    chatCompletion({ connection, messages: [], fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }) }),
    /HTTP 401: bad key/u,
  );

  await assert.rejects(
    chatCompletion({
      connection,
      messages: [],
      timeoutMs: 30,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    }),
    /request aborted/u,
  );
});

test('resolveConnection prefers the default and matches names case-insensitively', () => {
  const config = {
    connections: [
      normalizeConnection({ name: 'Local', baseURL: 'http://127.0.0.1:11434/v1', model: 'a' }),
      normalizeConnection({ name: 'Cloud', baseURL: 'https://api.example.com/v1', model: 'b' }),
    ],
    defaultId: 'cloud',
  };
  assert.equal(resolveConnection(config).id, 'cloud');
  assert.equal(resolveConnection(config, 'local').id, 'local');
  assert.equal(resolveConnection(config, 'CLOUD').id, 'cloud');
  assert.equal(resolveConnection(config, 'nope'), undefined);
  assert.match(buildAskModelDescription(config), /"local".*"cloud".*default/u);
  assert.match(buildAskModelDescription({ connections: [] }), /No model connection/u);
});

test('the ask_model tool runs one chat call with attachments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-toolset-ask-'));
  try {
    await writeFile(join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(dir, 'doc.txt'), 'some text');
    await writeFile(join(dir, 'voice.mp3'), Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    await writeFile(join(dir, 'clip.mp4'), Buffer.from([0x00, 0x00, 0x00, 0x18]));
    const config = {
      connections: [normalizeConnection({ name: 'Local', baseURL: 'http://127.0.0.1:11434/v1', model: 'm', audio: true, video: true })],
      defaultId: 'local',
    };
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: 'the answer' } }], usage: { total_tokens: 9 } }), { status: 200 });
    };
    const tool = createAskModelTool({
      getConfig: () => config,
      resolveApiKey: async () => 'k',
      fetchImpl,
    });
    assert.equal(tool.name, 'ask_model');
    assert.match(tool.description, /audio/u);
    const value = await tool.execute(
      {
        prompt: 'What is in the image?',
        attachments: [{ path: 'shot.png' }, { path: 'doc.txt' }, { path: 'voice.mp3' }, { path: 'clip.mp4' }],
        max_tokens: 64,
        temperature: 0.1,
      },
      { agent: { session: { header: { cwd: dir } } } },
    );
    assert.equal(value.answer, 'the answer');
    assert.equal(value.connection, 'local');
    assert.equal(value.model, 'm');
    assert.deepEqual(value.attachments.map((row) => row.kind), ['image', 'text', 'audio', 'video']);
    assert.equal(captured.init.headers.authorization, 'Bearer k');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.max_tokens, 64);
    assert.equal(body.temperature, 0.1);
    assert.equal(body.messages[0].content[0].type, 'text');
    assert.match(body.messages[0].content[0].text, /What is in the image\?/u);
    assert.match(body.messages[0].content[0].text, /some text/u);
    assert.equal(body.messages[0].content[1].type, 'image_url');
    assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/u);
    assert.equal(body.messages[0].content[2].type, 'input_audio');
    assert.equal(body.messages[0].content[2].input_audio.format, 'mp3');
    assert.equal(body.messages[0].content[3].type, 'video_url');
    assert.match(body.messages[0].content[3].video_url.url, /^data:video\/mp4;base64,/u);
    assert.match(tool.output.render({}, value)[0].text, /^the answer\n\n\(local · m · \d+ ms\)$/u);

    await assert.rejects(tool.execute({ prompt: '  ' }, {}), /non-empty prompt/u);
    await assert.rejects(tool.execute({ prompt: 'x', connection: 'missing' }, {}), /unknown connection/u);

    const noMedia = createAskModelTool({
      getConfig: () => ({ connections: [normalizeConnection({ name: 'Text only', baseURL: 'http://127.0.0.1:11434/v1', model: 'm' })], defaultId: 'text-only' }),
      resolveApiKey: async () => undefined,
      fetchImpl,
    });
    await assert.rejects(
      noMedia.execute({ prompt: 'listen', attachments: [{ path: 'voice.mp3' }] }, { agent: { session: { header: { cwd: dir } } } }),
      /does not accept audio/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('normalizeAskModelState keeps valid entries and repairs the default', () => {
  const valid = normalizeConnection({ name: 'Local', baseURL: 'http://127.0.0.1:11434/v1', model: 'm' });
  const state = normalizeAskModelState({
    connections: [valid, { name: '', baseURL: 'nope', model: '' }],
    defaultId: 'missing',
  });
  assert.equal(state.connections.length, 1);
  assert.equal(state.connections[0].id, 'local');
  assert.equal(state.defaultId, 'local');
  assert.deepEqual(normalizeAskModelState(undefined), { connections: [], defaultId: '' });
});
