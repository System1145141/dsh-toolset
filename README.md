# dsh-toolset

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that bundles several small
features, each with an independent switch under **Settings → Toolset**.

![Request status pill in the composer status line](docs/status-line.png)

## Features

| id | Feature | Default |
| --- | --- | --- |
| `request-status` | Live session status under the composer: 就绪 / 错误 / 进行中·请求 / 等待回复 / 思考 / 等待工具 / 输出 | on |
| `safe-restart` | The `dsh_safe_restart` tool: restarts the Desktop app after the Host is idle, then resumes the session and continues automatically | on |
| `rewind` | A rewind action beside Copy on every user message: continue from before that message in a new branch (workspace unchanged; the original session is archived and restorable) | on |
| `prompt-tuning` | Settings editor that starts from an existing Agent preset, edits its initial system prompt and saves the result as a new preset (live, no restart) | on |

## Layout

| File | Role |
| --- | --- |
| `index.js` | Host entry: feature API, feature-gated Host features, post-restart resume pass |
| `client.js` | Client entry: Settings → Toolset switch page + prompt-tuning editor, request-status pill, user-message rewind action |
| `lib/features.js` | Feature ids and defaults |
| `lib/prompt-tuning.js` | Agent-preset persona editing, profile-patch declaration, live HMR apply/rollback |
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

## Feature 3: rewind to a message

Every durable user message gets a **撤回 / Rewind** action beside the host's
Copy button. Clicking it:

1. cancels the running turn, if any;
2. forks the session at the end of the **previous** completed Turn (the event
   before this user message) through the official `sessions.fork` API, with an
   incremented title;
3. opens the new branch and archives the original session, so the branch reads
   as the rewound conversation while the original stays recoverable from the
   archived list;
4. leaves workspace files untouched — nothing on disk is reverted.

The user-message row is a shadowing renderer for the `conversation.chat.node`
`user` key: it reuses the host's own `conversation.chat.user.content` Factory
for the content stack and copies the host's action-row styling, so the row keeps
the native look. The rewind action is hidden when `session/fork` is not
authorized, and the whole feature is switchable under Settings → Toolset.

## Feature 4: system prompt tuning

![System prompt tuning in Settings → Toolset](docs/prompt-tuning.png)

**Settings → Toolset → System prompt tuning** starts from an existing Agent
preset, lets you edit its initial system prompt and saves the result as a new
preset:

1. the base-preset picker lists every preset the Host registry knows about
   (shipped `standard` / `ptc` / `minimal` / `cordis`, plus custom presets);
2. the editor loads that preset's `@deepseek-ai/dsh-persona` prefix — the
   persona paragraph at the very top of the system prompt — and lets you edit
   it; an optional switch makes the edited text the *complete* system prompt
   (DSH's fixed guidance and tool descriptions are then suppressed);
3. **Save as new preset** declares a new `@deepseek-ai/dsh-agent-preset` Loader
   row in the profile patch (`cordis.patch.yml`), reusing the base preset's
   whole child plugin list with only the persona row replaced, then asks HMR to
   recompose the profile. The new preset appears in **Settings → Agent presets**
   and can be chosen for new sessions — no restart;
4. presets created this way are listed under the editor and can be edited
   (updated in place) or deleted. The base preset is never modified, and
   sessions that already started keep the composition they were created with.

The Host half reads the base plugin list through the registry's own
`readDocument` YAML (so `!!js` conditions survive), performs only textual
surgery on the persona row, validates the resulting patch by recomposing, and
rolls the profile patch back if the new preset fails to activate. Without HMR
the preset is written and the result reports `restartRequired`.

## Install

The plugin is installed into a Harness profile as a local bundle. From the
directory that contains this package, run a Harness agent and call:

```text
plugin_manager install_bundle target = <absolute path to this directory>
```

Then open **Settings → Toolset** and switch each feature independently.
`state.json`, `restart-request.json`, `restart-resume-failed.json` and
`restart.log` are runtime state and are git-ignored.

System-prompt tuning writes the presets it creates into the profile's
`cordis.patch.yml` as `insert` entries marked
`# dsh-toolset preset: <id> (managed by Settings -> Toolset)`. Deleting such a
preset from the editor removes its block again; the profile patch is otherwise
left untouched.

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
