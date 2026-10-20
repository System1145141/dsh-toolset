/**
 * dsh-toolset — the `dsh_safe_restart` tool definition.
 *
 * The tool only schedules; the controller waits for global idleness and then
 * asks the detached helper to relaunch the app. The session resumes itself on
 * the next boot (see lib/resume.js), so the model never waits for the restart.
 *
 * Definitions registered directly with `ctx.tools.register` carry raw JSON
 * Schema, so this file validates the (few) arguments itself.
 */

/**
 * Build the safe-restart tool definition.
 * @param {object} options - tool dependencies.
 * @param {{ schedule: (request: object) => Promise<object> }} options.controller - restart controller.
 * @returns {object} tool definition for `ctx.tools.register`.
 */
export function createSafeRestartTool({ controller }) {
  return {
    name: 'dsh_safe_restart',
    description: [
      'Safely restart DeepSeek Harness (the desktop application and its Host) and automatically continue this session after it comes back.',
      'Use this only when a change needs a Host restart (for example after installing or updating a plugin that must load at startup).',
      'The restart waits until every agent, queued message, and background job is idle, so call it near the end of your turn, finish the turn normally, and do not start new long work.',
      'After the restart the application relaunches, this session is resumed, and a system continuation message tells you what to do next.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: {
          type: 'string',
          description: 'Short reason the restart is needed; shown to the user and in the continuation message.',
        },
        resume_prompt: {
          type: 'string',
          description:
            'Optional instruction to give yourself after the restart. Omit to continue the interrupted task from where it stopped.',
        },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', description: 'scheduled or updated.' },
          sessionId: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['status', 'sessionId', 'note'],
      },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Safely restart DeepSeek Harness',
      kind: 'other',
      rawInput: args,
    }),
    async execute(args, exec) {
      const agent = exec?.agent;
      const sessionId = agent?.session?.id ?? agent?.id;
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error('dsh_safe_restart requires an owning agent session');
      }
      const reason = args?.reason;
      const resumePrompt = args?.resume_prompt;
      if (reason !== undefined && typeof reason !== 'string') throw new Error('reason must be a string');
      if (resumePrompt !== undefined && typeof resumePrompt !== 'string') throw new Error('resume_prompt must be a string');
      const scheduled = await controller.schedule({
        sessionId,
        reason: reason ?? '',
        resumePrompt: resumePrompt ?? '',
      });
      return {
        status: scheduled.status,
        sessionId,
        note: [
          'Safe restart scheduled.',
          'It runs automatically once every agent, queued message, and background job is idle; this current turn may finish normally.',
          'The application will relaunch itself, resume this session, and continue from a system continuation message.',
        ].join(' '),
      };
    },
  };
}
