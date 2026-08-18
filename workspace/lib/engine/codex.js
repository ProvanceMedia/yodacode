// The Codex engine — the OpenAI Codex CLI driven as a child process.
//
// Unlike the Claude engine this is not a passthrough: Codex speaks its own
// protocol, so lib/engine/codex/ converts it into the message shapes the rest of
// the supervisor already understands. What Codex genuinely cannot do is declared
// in caps rather than discovered at runtime.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { runCodex, tokenExpiryMs } from './codex/adapter.js';

/** @type {import('./index.js').Engine} */
export const codexEngine = {
  id: 'codex',

  caps: {
    // No spawn interceptor: the child is spawned by lib/engine/codex/adapter.js,
    // which sets its own uid via the container's user rather than a hook.
    spawnHook: false,
    // Codex has a subagent tool, but the adapter does not translate its frames
    // yet, so nothing would render. Declared false until it does.
    subagents: false,
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
