/**
 * dsh-toolset — Client half.
 *
 * Two contributions:
 *  1. `settings.section` — one switch per feature (persisted by the Host half).
 *  2. `conversation.composer.dock` — the enabled features' entries. The first
 *     feature is the live request-status pill.
 *
 * The status pill derives its phase ONLY from data the Web client already
 * holds (Session snapshot + Chat snapshot), so it needs no polling.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-toolset',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-toolset';
    const API_BASE = '/plugins/dsh-toolset/api';
    const FEATURE_REQUEST_STATUS = 'request-status';
    const FEATURE_SAFE_RESTART = 'safe-restart';
    const DEFAULT_FEATURES = { [FEATURE_REQUEST_STATUS]: true, [FEATURE_SAFE_RESTART]: true };
    const FEATURES = [
      {
        id: FEATURE_REQUEST_STATUS,
        titleKey: 'feature.requestStatus.title',
        descriptionKey: 'feature.requestStatus.description',
      },
      {
        id: FEATURE_SAFE_RESTART,
        titleKey: 'feature.safeRestart.title',
        descriptionKey: 'feature.safeRestart.description',
      },
    ];

    // ── locale ───────────────────────────────────────────────────────────────
    const en = {
      'nav': 'Toolset',
      'settings.intro': 'Turn on the small features you want. Every switch applies immediately and never changes conversation content.',
      'settings.group': 'Features',
      'settings.error': 'Could not save the switch: {message}',
      'feature.requestStatus.title': 'Request status',
      'feature.requestStatus.description': 'Shows the live session phase in the status line under the composer: ready, requesting, waiting for reply, thinking, waiting for tools, writing, or error.',
      'feature.safeRestart.title': 'Safe restart',
      'feature.safeRestart.description': 'Adds the dsh_safe_restart tool: restarts DeepSeek Harness after every agent, queued message and background job is idle, then resumes the session and continues automatically.',
      'feature.safeRestart.unavailable': 'Only the packaged Windows desktop app can restart itself; this deployment cannot use the feature.',
      'status.ready': 'Ready',
      'status.error': 'Error',
      'status.request': 'Running · Requesting',
      'status.waiting-reply': 'Running · Waiting for reply',
      'status.thinking': 'Running · Thinking',
      'status.waiting-tool': 'Running · Waiting for tools',
      'status.output': 'Running · Writing',
      'status.hint.ready': 'The session is waiting for your next message.',
      'status.hint.error': 'The last run failed. Send a new message to try again.',
      'status.hint.request': 'The request is being prepared and sent to the server.',
      'status.hint.waiting-reply': 'The request reached the server; waiting for the model reply.',
      'status.hint.thinking': 'The model is reasoning about the request.',
      'status.hint.waiting-tool': 'The model is calling tools, or a tool call is running.',
      'status.hint.output': 'The model is writing its answer.',
      'status.aria': 'Session status: {status}',
    };
    const zh = {
      'nav': '工具集',
      'settings.intro': '按需开启各项小功能。开关立即生效，不会改动会话内容。',
      'settings.group': '功能',
      'settings.error': '开关保存失败：{message}',
      'feature.requestStatus.title': '请求状态',
      'feature.requestStatus.description': '在输入框下方的状态行中显示会话当前阶段：就绪、请求、等待回复、思考、等待工具、输出或错误。',
      'feature.safeRestart.title': '安全重启',
      'feature.safeRestart.description': '提供 dsh_safe_restart 工具：等所有智能体、排队消息与后台任务都空闲后重启 DeepSeek Harness，重启后自动恢复会话并继续执行。',
      'feature.safeRestart.unavailable': '只有 Windows 桌面版可以自重启；当前部署无法使用此功能。',
      'status.ready': '就绪',
      'status.error': '错误',
      'status.request': '进行中·请求',
      'status.waiting-reply': '进行中·等待回复',
      'status.thinking': '进行中·思考',
      'status.waiting-tool': '进行中·等待工具',
      'status.output': '进行中·输出',
      'status.hint.ready': '会话正在等待你的下一条输入。',
      'status.hint.error': '本轮运行失败，发送新消息即可重试。',
      'status.hint.request': '正在把请求发送给服务端。',
      'status.hint.waiting-reply': '请求已送达，正在等待模型的回复。',
      'status.hint.thinking': '模型正在思考。',
      'status.hint.waiting-tool': '模型正在调用工具，或工具正在执行。',
      'status.hint.output': '模型正在输出正文。',
      'status.aria': '会话状态：{status}',
    };

    // ── feature store (Host-backed; defaults keep the UI usable offline) ──────
    let features = { ...DEFAULT_FEATURES };
    let capabilities = { safeRestart: true };
    let loaded = false;
    const listeners = new Set();

    function normalizeFeatures(value) {
      const input = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const next = { ...DEFAULT_FEATURES };
      for (const feature of FEATURES) {
        if (typeof input[feature.id] === 'boolean') next[feature.id] = input[feature.id];
      }
      return next;
    }

    function normalizeCapabilities(value) {
      return {
        safeRestart: value?.safeRestart !== false,
      };
    }

    function publish() {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // A broken subscriber must not stop the others.
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function getFeatures() {
      return features;
    }

    function getCapabilities() {
      return capabilities;
    }

    function useFeatures() {
      return React.useSyncExternalStore(subscribe, getFeatures, getFeatures);
    }

    function useCapabilities() {
      return React.useSyncExternalStore(subscribe, getCapabilities, getCapabilities);
    }

    async function callApi(method, payload, signal) {
      const response = await fetch(`${API_BASE}/${method}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal,
      });
      let envelope;
      try {
        envelope = await response.json();
      } catch {
        throw new Error(`HTTP ${String(response.status)}`);
      }
      if (envelope === null || typeof envelope !== 'object' || envelope.ok !== true) {
        const message = envelope?.error?.message;
        throw new Error(typeof message === 'string' && message !== '' ? message : `HTTP ${String(response.status)}`);
      }
      return envelope.value;
    }

    async function refreshFeatures() {
      try {
        const value = await callApi('features.get', {});
        features = normalizeFeatures(value?.features);
        capabilities = normalizeCapabilities(value?.capabilities);
        loaded = true;
        publish();
        return true;
      } catch {
        return false;
      }
    }

    async function setFeature(id, enabled) {
      const previous = features;
      features = { ...features, [id]: enabled };
      publish();
      try {
        const value = await callApi('features.set', { id, enabled });
        features = normalizeFeatures(value?.features);
        capabilities = normalizeCapabilities(value?.capabilities);
        loaded = true;
        publish();
        return { ok: true };
      } catch (error) {
        features = previous;
        publish();
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    // ── phase derivation ─────────────────────────────────────────────────────
    /** The last loaded Turn of the Chat timeline, if any. */
    function lastTurn(timeline) {
      if (!timeline || !Array.isArray(timeline.turnOrder) || timeline.turnOrder.length === 0) return undefined;
      const number = timeline.turnOrder[timeline.turnOrder.length - 1];
      return timeline.turns && typeof timeline.turns.get === 'function' ? timeline.turns.get(number) : undefined;
    }

    function selectRunning(session) {
      return session?.running === true;
    }

    function selectSessionError(session) {
      return Boolean(session?.lastAgentError) || session?.promptError != null;
    }

    /** Live phase evidence from the assistant stream and executed tool calls. */
    function selectLiveSignal(chat) {
      const legacy = chat?.legacy;
      if (!legacy) return null;
      if (Array.isArray(legacy.runningCalls) && legacy.runningCalls.length > 0) return 'waiting-tool';
      const blocks = legacy.partial?.blocks;
      if (!Array.isArray(blocks)) return null;
      let signal = null;
      let hasText = false;
      for (const block of blocks) {
        if (block === null || typeof block !== 'object') continue;
        if (block.kind === 'reasoning') {
          // Once answer text has appeared, later reasoning must not regress the
          // pill from "output" back to "thinking".
          if (typeof block.text === 'string' && block.text.trim() !== '') signal = hasText ? 'output' : 'thinking';
        } else if (block.kind === 'text') {
          if (typeof block.text === 'string' && block.text.trim() !== '') {
            hasText = true;
            signal = 'output';
          }
        } else if (block.kind === 'tool-call') {
          signal = 'waiting-tool';
        }
      }
      return signal;
    }

    function selectStepOpen(chat) {
      const timeline = chat?.timeline;
      const turn = lastTurn(timeline);
      if (!turn || turn.status !== 'open' || !Array.isArray(turn.steps) || turn.steps.length === 0) return false;
      return turn.steps[turn.steps.length - 1]?.status === 'open';
    }

    function selectTurnFailed(chat) {
      const turn = lastTurn(chat?.timeline);
      if (!turn || turn.status !== 'closed') return false;
      const reason = turn.end?.data?.reason;
      return reason?.kind === 'error';
    }

    /**
     * Map the observed signals onto the documented phases.
     * @returns {'ready'|'error'|'request'|'waiting-reply'|'thinking'|'waiting-tool'|'output'}
     */
    function derivePhase({ running, sessionError, live, stepOpen, turnFailed }) {
      if (running) {
        if (live === 'waiting-tool') return 'waiting-tool';
        if (live === 'thinking') return 'thinking';
        if (live === 'output') return 'output';
        // The host has not opened a model Step yet: the request is being sent.
        if (stepOpen) return 'waiting-reply';
        return 'request';
      }
      if (sessionError || turnFailed) return 'error';
      return 'ready';
    }

    // ── styles (theme tokens only; component-local <style> elements) ─────────
    const PREFIX = 'dsh-toolset';
    const CSS = `
.${PREFIX}-status{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;min-width:0;max-width:100%;padding:1px 8px;border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));font-variant-numeric:tabular-nums;white-space:nowrap;user-select:none}
.${PREFIX}-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.${PREFIX}-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsh-toolset-dot,var(--dsw-alias-state-idle-primary))}
.${PREFIX}-status[data-phase="error"]{--dsh-toolset-dot:var(--dsw-alias-state-error-primary)}
.${PREFIX}-status[data-phase="request"],.${PREFIX}-status[data-phase="waiting-reply"],.${PREFIX}-status[data-phase="thinking"]{--dsh-toolset-dot:var(--dsw-alias-brand-primary)}
.${PREFIX}-status[data-phase="waiting-tool"]{--dsh-toolset-dot:var(--dsw-alias-state-warn-primary)}
.${PREFIX}-status[data-phase="output"]{--dsh-toolset-dot:var(--dsw-alias-state-success-primary)}
.${PREFIX}-status[data-running="true"] .${PREFIX}-dot{animation:${PREFIX}-pulse 1.4s ease-in-out infinite}
@keyframes ${PREFIX}-pulse{0%,100%{opacity:1}50%{opacity:.3}}
.${PREFIX}-section{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px}
.${PREFIX}-intro{margin:0;padding:0 2px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.${PREFIX}-card{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.${PREFIX}-row{display:flex;align-items:center;gap:16px;padding:14px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.${PREFIX}-row:first-child{border-top:0}
.${PREFIX}-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.${PREFIX}-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}
.${PREFIX}-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.${PREFIX}-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));cursor:pointer;transition:background-color .12s ease}
.${PREFIX}-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
.${PREFIX}-switch:disabled{cursor:default;opacity:.5}
.${PREFIX}-switch:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.${PREFIX}-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);transition:transform .12s ease}
.${PREFIX}-switch[aria-checked="true"] .${PREFIX}-thumb{transform:translateX(16px)}
.${PREFIX}-error{margin:0;padding:0 2px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.${PREFIX}-unavailable{margin-top:2px;color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}
@media (prefers-reduced-motion:reduce){.${PREFIX}-switch,.${PREFIX}-thumb{transition:none}.${PREFIX}-status[data-running="true"] .${PREFIX}-dot{animation:none}}
`;

    // ── components ───────────────────────────────────────────────────────────
    /** Settings → Toolset: one independent switch per feature. */
    function ToolsetSection({ t }) {
      const current = useFeatures();
      const caps = useCapabilities();
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(null);

      React.useEffect(() => {
        if (!loaded) void refreshFeatures();
      }, []);

      const toggle = (id, next) => {
        setBusy(id);
        setError(null);
        void setFeature(id, next).then((result) => {
          setBusy(null);
          if (!result.ok) setError(result.error);
        });
      };

      return h(
        'div',
        { className: `${PREFIX}-section` },
        h('style', { key: 'css' }, CSS),
        h('p', { className: `${PREFIX}-intro` }, t('settings.intro')),
        h(
          'div',
          { className: `${PREFIX}-card`, role: 'group', 'aria-label': t('settings.group') },
          FEATURES.map((feature) => {
            const enabled = current[feature.id] !== false;
            const unavailable = feature.id === FEATURE_SAFE_RESTART && !caps.safeRestart;
            return h(
              'div',
              { key: feature.id, className: `${PREFIX}-row`, 'data-toolset-feature': feature.id },
              h(
                'div',
                { className: `${PREFIX}-text` },
                h('div', { className: `${PREFIX}-title` }, t(feature.titleKey)),
                h('div', { className: `${PREFIX}-desc` }, t(feature.descriptionKey)),
                unavailable ? h('div', { className: `${PREFIX}-unavailable` }, t('feature.safeRestart.unavailable')) : null,
              ),
              h(
                'button',
                {
                  type: 'button',
                  role: 'switch',
                  'aria-checked': enabled,
                  'aria-label': t(feature.titleKey),
                  disabled: busy === feature.id || unavailable,
                  className: `${PREFIX}-switch`,
                  onClick: () => toggle(feature.id, !enabled),
                },
                h('span', { className: `${PREFIX}-thumb`, 'aria-hidden': 'true' }),
              ),
            );
          }),
        ),
        error === null ? null : h('p', { className: `${PREFIX}-error`, role: 'alert' }, t('settings.error', { message: error })),
      );
    }

    /** Composer status line: the current session phase. */
    function RequestStatusPill({ t, useSession, useChat }) {
      const current = useFeatures();
      const running = useSession(selectRunning);
      const sessionError = useSession(selectSessionError);
      const live = useChat(selectLiveSignal);
      const stepOpen = useChat(selectStepOpen);
      const turnFailed = useChat(selectTurnFailed);

      if (current[FEATURE_REQUEST_STATUS] === false) return null;

      const phase = derivePhase({ running, sessionError, live, stepOpen, turnFailed });
      const label = t(`status.${phase}`);
      return h(
        React.Fragment,
        null,
        h('style', { key: 'css' }, CSS),
        h(
          'span',
          {
            key: 'status',
            className: `${PREFIX}-status`,
            'data-phase': phase,
            'data-running': running ? 'true' : 'false',
            title: t(`status.hint.${phase}`),
            'aria-label': t('status.aria', { status: label }),
          },
          h('span', { className: `${PREFIX}-dot`, 'aria-hidden': 'true' }),
          h('span', { className: `${PREFIX}-label` }, label),
        ),
      );
    }

    // ── plugin ───────────────────────────────────────────────────────────────
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-toolset: locale');
      const t = ctx.locale.bind(NS);

      ctx.effect(() => {
        void refreshFeatures();
        const retry = setTimeout(() => {
          if (!loaded) void refreshFeatures();
        }, 2500);
        return () => clearTimeout(retry);
      }, 'dsh-toolset: feature flags');
      ctx.on('connection/reset', () => {
        void refreshFeatures();
      });

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-toolset',
            order: 40,
            label: () => t('nav'),
            locale: NS,
          },
          ToolsetSection,
        ),
      );

      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'dsh-toolset-request-status',
            order: 2,
            locale: NS,
          },
          RequestStatusPill,
        ),
      );
    }

    return { inject, apply };
  },
});
