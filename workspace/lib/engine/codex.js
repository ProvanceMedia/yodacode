// The Codex engine — the OpenAI Codex CLI driven as a child process.
//
// Unlike the Claude engine this is not a passthrough: Codex speaks its own
// protocol, so lib/engine/codex/ converts it into the message shapes the rest of
// the supervisor already understands. What Codex genuinely cannot do is declared
// in caps rather than discovered at runtime.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { runCodex, tokenExpiryMs } from './codex/adapter.js';
import { modelEngine } from './model-tiers.js';

/** @type {import('./index.js').Engine} */
export const codexEngine = {
  id: 'codex',

  caps: {
    // No spawn interceptor: the child is spawned by lib/engine/codex/adapter.js,
    // which sets its own uid via the container's user rather than a hook.
    spawnHook: false,
    // Delegation works, but differently from the Claude engine: the subagent
    // runs in its own thread and none of its frames reach this stream. So there
    // is no child chatter to keep out of the reply — and no sign of life while
    // it works either, which is why the adapter heartbeats an open delegation.
    subagents: true,
    // No api_retry equivalent on the stream, so an overload cannot be detected
    // and model fallback is impossible — an overload is simply a failed turn.
    throttleSignal: false,
    // Codex does not honour Claude Code's `@./file.md` includes. The persona has
    // to be assembled into the instruction file instead of referenced from it.
    atImports: false,
    // Item ids ARE stable across item.started/item.completed, so tool calls and
    // results pair up and the repeat-failure guardrails keep working. (Verified
    // against recorded turns — earlier design work assumed otherwise.)
    toolUseIds: true,
    rootInstructionFile: 'AGENTS.md',
    shellToolName: 'Bash',
    // 'max' is advertised by the API but rejected by older CLIs; left out until
    // the pinned version is known to accept it.
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    fallbackModels: [],
    // File-based credential in $CODEX_HOME/auth.json, not an env var.
    authEnvVar: '',
    engineHosts: ['api.openai.com', 'chatgpt.com', 'auth.openai.com'],
  },

  run: (args) => runCodex(args),

  // YODA_CLAUDE_MODEL, the /opus and /sonnet shortcuts and any thread-sticky
  // override all name Claude models, and they do not disappear when the engine
  // changes. Sending one here is rejected outright by the API — the turn fails
  // with a raw provider error, which is a poor way to learn that a setting from
  // the other engine is still set. Fall back to this engine's own default
  // instead; a model this engine does not recognise is not a reason to refuse
  // to answer.
  mapModel: (m) => (modelEngine(m) === 'codex' ? m : undefined),

  // Same reasoning for effort: 'max' is a valid Claude level and is not one
  // here, and YODA_CLAUDE_EFFORT does not change when the engine does.
  mapEffort: (e) => (['low', 'medium', 'high', 'xhigh'].includes(String(e || '')) ? e : undefined),

  isAbortError: (e) => !!e && e.name === 'AbortError',

  // A resume fails when the recorded thread is gone. Codex reports this as a
  // missing session rather than with a stable error code, so match on the
  // wording and on the adapter's own synthesised message.
  isResumeFailure: (text) =>
    /no (?:such )?(?:thread|session|conversation)|session not found|rollout .* not found/i
      .test(String(text || '')),

  async preflight() {
    const home = process.env.CODEX_HOME || path.join(process.env.HOME || '/root', '.codex');
    if (!existsSync(path.join(home, 'auth.json'))) {
      return { ok: false, detail: `no credential at ${home}/auth.json — run: codex login --device-auth` };
    }
    // Decoded locally from the token payload. Deliberately not `codex login
    // status`, which reports a healthy login for a credential that is already
    // dead, and which can itself consume the single-use refresh token.
    const remaining = tokenExpiryMs(home);
    if (remaining <= 0) {
      return { ok: false, detail: 'credential expired — run: codex login --device-auth' };
    }
    const days = Math.floor(remaining / 86_400_000);
    return { ok: true, detail: `codex engine (credential valid ~${days}d)` };
  },
};
