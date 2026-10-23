/**
 * dsh-toolset — preset identity section.
 *
 * A preset-mountable Cordis plugin that shadows the deployment's fixed
 * `harness:identity` system-prompt section ("You are an AI agent powered by
 * DeepSeek Harness.") for the agent that mounts it.
 *
 * Shadowing works exactly like `@deepseek-ai/dsh-persona` does for the persona
 * section: the prompt registry merges sections by NAME across the scope chain,
 * and the nearest scope wins, so a preset registering `harness:identity`
 * replaces the global line instead of adding a second one. Registering it here
 * (an agent scope) is legal; registering it globally would collide with
 * `dsh-system-prompt`'s own registration and fail loud — which is why this is a
 * separate, preset-only row.
 *
 * Mounted with `text: ''` the section still shadows its global default and then
 * renders nothing, so the opening line disappears entirely.
 *
 * @module ../../lib/preset-identity.js
 */

/** Cordis plugin name. */
export const name = 'preset-identity';

/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt'];

/** Fixed section name owned by `@deepseek-ai/dsh-system-prompt`. */
export const IDENTITY_SECTION = 'harness:identity';

/**
 * Register the edited identity section in the mounting (agent) scope.
 * @param {object} ctx - agent-scoped Cordis context.
 * @param {{ text?: string }} config - replacement text; empty hides the line.
 */
export function apply(ctx, config) {
  const text = typeof config?.text === 'string' ? config.text : '';
  ctx.effect(() => ctx.systemPrompt.section({
    name: IDENTITY_SECTION,
    order: ctx.systemPrompt.getSectionOrder('HARNESS_IDENTITY'),
    text,
    // The stock identity line is literal prose. Keep user text literal too, so
    // a stray "{{...}}" cannot fail prompt assembly for the whole session.
    interpolate: false,
  }), 'preset-identity: section');
}
