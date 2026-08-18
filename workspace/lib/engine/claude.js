// The Claude engine — a passthrough over the Agent SDK.
//
// This adapter exists to give the Claude path the same shape every other engine
// has to implement. It adds no behaviour: run() is the exact query() call the
// runner used to make, and buildAgentOptions() is untouched in lib/agent-query.js.
// If this file ever grows logic of its own, that logic belongs in the runner
// instead — the point of the adapter is that swapping engines is the ONLY thing
// that changes when you swap engines.

import { query, AbortError } from '@anthropic-ai/claude-agent-sdk';
import { buildAgentOptions } from '../agent-query.js';

/** @type {import('./index.js').Engine} */
export const claudeEngine = {
  id: 'claude',

  caps: {
    spawnHook: true,
    subagents: true,
    throttleSignal: true,
    atImports: true,
    toolUseIds: true,
    rootInstructionFile: 'CLAUDE.md',
    shellToolName: 'Bash',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    fallbackModels: ['claude-haiku-4-5'],
    authEnvVar: 'CLAUDE_CODE_OAUTH_TOKEN',
    engineHosts: ['api.anthropic.com', 'statsig.anthropic.com', 'console.anthropic.com'],
  },

  run: ({ prompt, ...options }) => query({ prompt, options: buildAgentOptions(options) }),

  // The SDK's AbortError doesn't set .name; the name check additionally catches
  // Node/DOMException-style aborts. No message matching — a real failure whose
  // text mentions "abort" must not read as a clean stop.
  isAbortError: (e) => e instanceof AbortError || (!!e && e.name === 'AbortError'),

  isResumeFailure: (text) => /no conversation found with session id/i.test(String(text || '')),

  // Nothing to probe: the SDK spawns its own bundled runtime in-process, so a
  // missing credential surfaces on the first turn as an auth error, not as a
  // startup condition this could detect any earlier.
  preflight: async () => ({ ok: true, detail: 'claude engine (in-process Agent SDK)' }),
};
