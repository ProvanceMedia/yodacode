// Engine selection. An "engine" is the thing that actually runs a turn: today
// the Claude Agent SDK, in future an alternative such as the Codex CLI.
//
// The seam is deliberately narrow. An engine yields the SAME message shapes the
// Anthropic SDK emits, so lib/stream-translator.js, lib/tool-tracker.js and the
// surfaces stay engine-agnostic without a translation layer of their own. An
// engine that speaks a different protocol converts INTO that shape internally —
// the rest of the supervisor never learns a second vocabulary.
//
// Capabilities are declared, not detected. A feature that only one engine can
// do (model fallback needs a throttle signal in the stream; `@`-imports need a
// root instruction file that honours them) is guarded on a cap flag, so the
// degraded path is explicit in the code rather than a silent no-op at runtime.

import { config } from './../config.js';
import { claudeEngine } from './claude.js';
import { codexEngine } from './codex.js';

/**
 * @typedef {object} EngineCaps
 * @property {boolean} spawnHook        Exposes a spawn interceptor (used for the de-root uid switch)
 * @property {boolean} subagents        Has a Task-tool equivalent
 * @property {boolean} throttleSignal   Stream carries an overload/retry event, so model fallback is possible
 * @property {boolean} atImports        Root instruction file honours `@./file.md` includes
 * @property {boolean} toolUseIds       Stream pairs each tool call with its result by id
 *                                      (false ⇒ the repeat/no-progress guardrails degrade)
 * @property {string}  rootInstructionFile  Filename the engine reads for standing instructions
 * @property {string}  shellToolName        What the shell tool is called in the stream
 * @property {string[]} effortLevels
 * @property {string[]} fallbackModels
 * @property {string}  authEnvVar       Credential env var, or '' when the credential is a file
 * @property {string[]} engineHosts     The engine's own API hosts — the broker refuses these so a
 *                                      turn can't replay the agent's credential through it
 */

/**
 * @typedef {object} Engine
 * @property {string} id
 * @property {EngineCaps} caps
 * @property {(args: object) => AsyncIterable<object>} run  Yields Anthropic stream-json messages
 * @property {(e: unknown) => boolean} isAbortError
 * @property {(text: string) => boolean} isResumeFailure
 * @property {() => Promise<{ok: boolean, detail: string}>} preflight
 */

const ENGINES = {
  claude: claudeEngine,
  codex: codexEngine,
};

/** Every engine id this build knows how to run. */
export const ENGINE_IDS = Object.keys(ENGINES);

/**
 * Resolve the configured engine.
 *
 * Throws on an unknown id rather than falling back to a default: an install
 * that asked for an engine this build doesn't have should fail loudly at boot,
 * not run a whole turn on the wrong model and bill it to the wrong account.
 *
 * @param {string} [id] Override — omit to use the configured engine.
 * @returns {Engine}
 */
export function selectEngine(id = config.engine.id) {
  const engine = ENGINES[id];
  if (!engine) {
    throw new Error(
      `unknown engine '${id}' — this build supports: ${ENGINE_IDS.join(', ')}`,
    );
  }
  return engine;
}
