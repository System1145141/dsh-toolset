# dsh-toolset

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that bundles several small
features, each with an independent switch under **Settings → Toolset**.

![Request status pill in the composer status line](docs/status-line.png)

## Features

| id | Feature | Default |
| --- | --- | --- |
| `request-status` | Live session status under the composer: 就绪 / 错误 / 进行中·请求 / 等待回复 / 思考 / 等待工具 / 输出 | on |
| `safe-restart` | The `dsh_safe_restart` tool: restarts the Desktop app after the Host is idle, then resumes the session and continues automatically | on |

## Layout

| File | Role |
| --- | --- |
| `index.js` | Host entry: feature API, feature-gated Host features, post-restart resume pass |
| `client.js` | Client entry: Settings → Toolset switch page, request-status pill |
| `lib/features.js` | Feature ids and defaults |
| `lib/tool.js` | `dsh_safe_restart` tool definition |
| `lib/restart.js` | Idle-gated restart scheduler, armed request marker, detached helper launch |
| `lib/resume.js` | Post-restart session resume + continuation message |
| `restart-helper.ps1` | Detached PowerShell helper that terminates the Electron tree and relaunches the app |
| `test/` | Dependency-free unit tests (`node --test`) |

## Feature 1: request status

The status widget derives its phase only from data the Web client already
holds: the Session snapshot (`running`, `lastAgentError`, `promptError`) and
the Chat snapshot (live assistant blocks, running tool calls, and the durable
Turn/Step timeline). It never polls the Host.

| Phase | Signal |
| --- | --- |
| 就绪 (ready) | not running, no live/turn error |
| 错误 (error) | not running and either a live agent/prompt error or the last Turn ended with `reason.kind === "error"` |
| 进行中·请求 (requesting) | running, no open Step yet (the next request is being prepared or sent) |
| 进行中·等待回复 (waiting for reply) | running, open Step, no live token yet |
| 进行中·思考 (thinking) | the running assistant step streams reasoning text |
| 进行中·等待工具 (waiting for tools) | a tool call is being emitted or executed |
| 进行中·输出 (output) | the running assistant step streams answer text |

## Feature 2: safe restart

`dsh_safe_restart` is a Host tool available to the model. It exists only in
the packaged Windows Desktop profile (a plain `dsh web` process cannot relaunch
itself).

Flow:

1. The model calls `dsh_safe_restart` (optional `reason` and `resume_prompt`)
   near the end of a turn.
2. The Host writes `restart-request.json` (unarmed) and waits until **every**
   Agent, queued inbox message, and background job is idle for a quiet window.
3. The Host arms the request (`armed: true`, plus the Electron main PID and
   executable path) and creates `restart-helper.ps1` through WMI
   `Win32_Process.Create`, so the helper is parented by WmiPrvSE and survives
   the Electron tree teardown. The Host waits for the helper's first log line
   and unarms the request again if the helper never starts.
4. The helper terminates the idle Electron tree and relaunches the app.
5. The new Host process claims the armed request, resumes the recorded Session
   through the Host's own `sessionController` (so Agent-preset composition and
   writer ownership stay authoritative), queues one continuation user message,
   and deletes the request.

`restart.log` in the plugin directory records both halves of the flow.

The helper uses `taskkill /PID <electron-main> /T /F` after the Host has
confirmed idleness; the desktop shell hides its window on `WM_CLOSE` instead of
quitting, so a "graceful" `taskkill` would merely hide the app.

## Install

The plugin is installed into a Harness profile as a local bundle. From the
directory that contains this package, run a Harness agent and call:

```text
plugin_manager install_bundle target = <absolute path to this directory>
```

Then open **Settings → Toolset** and switch each feature independently.
`state.json`, `restart-request.json`, `restart-resume-failed.json` and
`restart.log` are runtime state and are git-ignored.

## Development

Requirements: Node.js 22+ (tests only), DeepSeek Harness Desktop on Windows for
the safe-restart feature.

```text
node --test test/*.test.mjs
```

The Host half is dependency-free (standard Node built-ins only), so it can be
installed as a linked local directory.

## License

[MIT](LICENSE)
