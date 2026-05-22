// Surface-agnostic Claude runner. Spawns `claude -p` with stream-json output
// and pipes its stdout into the Node stream-translator, which calls back into
// the caller with throttled status updates and a final reply text.
//
// Tracks active runs in `state/current-ticks.json` so the stop handler can
// kill the right process when "stop" comes in for a given conversation.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { translateStream } from './stream-translator.js';

const TICKS_FILE = path.join(config.stateDir, 'current-ticks.json');
const TOOL_RUNS_FILE = path.join(config.stateDir, 'tool-runs.json');
const TOOL_RUNS_MAX_ENTRIES = 100;
const USAGE_FILE = path.join(config.stateDir, 'usage.jsonl');

mkdirSync(config.stateDir, { recursive: true });
if (!existsSync(TICKS_FILE)) writeFileSync(TICKS_FILE, '{}');

function loadTicks() {
  try {
    return JSON.parse(readFileSync(TICKS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveTicks(t) {
  writeFileSync(TICKS_FILE, JSON.stringify(t, null, 2));
}

function appendUsage(surface, model, usage) {
  if (!usage) return;
  try {
    const entry = {
      ts: new Date().toISOString(),
      surface,
      model: model || usage.model || 'default',
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    };
    // JSONL append (cheap, no need to load + rewrite the file)
    fs.appendFileSync(USAGE_FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    logger.warn('usage persist failed', { err: e.message });
  }
}

function appendToolRuns(conversationId, surface, summary) {
  let data = {};
  try {
    if (existsSync(TOOL_RUNS_FILE)) data = JSON.parse(readFileSync(TOOL_RUNS_FILE, 'utf8'));
  } catch (_) { data = {}; }
  const key = `${conversationId}@${Date.now()}`;
  data[key] = { surface, ts: Date.now(), ...summary };
  const keys = Object.keys(data);
  if (keys.length > TOOL_RUNS_MAX_ENTRIES) {
    const drop = keys.length - TOOL_RUNS_MAX_ENTRIES;
    for (let i = 0; i < drop; i++) delete data[keys[i]];
  }
  try {
    writeFileSync(TOOL_RUNS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.warn('tool-runs persist failed', { err: e.message });
  }
}

/**
 * Run a single Claude reply for a conversation.
 *
 * @param {object}   args
 * @param {string}   args.surface         Surface name (for logging + tick tracking)
 * @param {string}   args.conversationId  Stable lane key (used by stop-handler)
 * @param {any}      args.placeholder     Opaque handle from surface.postPlaceholder
 * @param {string}   args.prompt          The full prompt to send to claude -p
 * @param {string}   [args.model]         Optional model override (e.g. claude-haiku-4-5)
 * @param {(text: string) => Promise<void>} args.onStatus  Live update callback
 * @param {(text: string) => Promise<void>} args.onFinal   Final text callback
 * @returns {Promise<{ ok: boolean, finalText?: string, error?: string, killed?: boolean, throttled?: boolean }>}
 */
export async function runClaude({
  surface,
  conversationId,
  placeholder,
  prompt,
  model,
  onStatus,
  onFinal,
}) {
  return new Promise((resolve) => {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', config.claude.permissionMode,
      '--allowed-tools', config.claude.allowedTools,
      '--thinking', 'enabled',
    ];
    if (model) args.push('--model', model);
    // Sandbox is configured via .claude/settings.json (written by yoda.js
    // at startup based on YODA_SANDBOX). Newer claude CLI no longer accepts
    // a --sandbox flag.

    const claude = spawn(
      config.claude.bin,
      args,
      {
        cwd: config.workspace,
        // Force OAuth/sub auth — never let an API key sneak in via env inheritance
        env: { ...process.env, ANTHROPIC_API_KEY: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // own process group so we can SIGTERM the whole tree on stop
      },
    );

    // Register tick state for stop-handler
    const ticks = loadTicks();
    ticks[conversationId] = {
      surface,
      pid: claude.pid,
      placeholder,
      startedAt: Date.now(),
    };
    saveTicks(ticks);

    let killed = false;
    let timedOut = false;
    let finalResult = null;
    let iterationCap = null;  // populated when guardrail trips

    const timeout = setTimeout(() => {
      timedOut = true;
      logger.warn('claude timeout, killing', {
        surface, conversationId, ms: config.claude.timeoutMs,
      });
      try { process.kill(-claude.pid, 'SIGTERM'); } catch (_) {}
    }, config.claude.timeoutMs);

    // Buffer stderr — emit at debug for normal runs, escalate to warn on
    // non-zero exit so the user actually sees why claude died (auth errors,
    // missing OAuth token, etc.) without needing to flip YODA_LOG_LEVEL=debug.
    const stderrBuf = [];
    const STDERR_BUF_MAX = 8192;
    claude.stderr.on('data', (chunk) => {
      const line = chunk.toString();
      logger.debug('claude stderr', { surface, line: line.trim() });
      if (stderrBuf.join('').length < STDERR_BUF_MAX) stderrBuf.push(line);
    });

    // Run the translator over claude's stdout. Status updates and the final
    // text both go through the surface-supplied callbacks. If Claude hits
    // too many api_retry events (Anthropic 529 throttling), the translator
    // calls onMaxRetries → we kill claude to fail fast and avoid deepening
    // the cooldown by sustaining concurrent load.
    translateStream(claude.stdout, {
      onStatus: async (text) => {
        if (killed || timedOut) return;
        try { await onStatus(text); }
        catch (e) { logger.debug('onStatus failed', { err: e.message }); }
      },
      onFinal: async (text) => {
        if (killed || timedOut) return;
        try { await onFinal(text); }
        catch (e) { logger.warn('onFinal failed', { err: e.message }); }
      },
      maxRetries: config.claude.maxRetries,
      onMaxRetries: () => {
        logger.warn('claude api retries exceeded, killing fast', {
          surface, conversationId, maxRetries: config.claude.maxRetries,
        });
        killed = true;
        try { process.kill(-claude.pid, 'SIGTERM'); } catch (_) {}
      },
      maxIterations: config.claude.maxIterations,
      guardrails: {
        enabled: config.claude.guardrailEnabled,
        repeatFailureThreshold: config.claude.guardrailRepeatThreshold,
        noProgressThreshold: config.claude.guardrailNoProgressThreshold,
      },
      onGuardrail: (g) => {
        if (g.type === 'iteration_cap') {
          iterationCap = g;
          logger.warn('iteration cap hit, killing', {
            surface, conversationId, count: g.count, max: g.max,
          });
          killed = true;
          try { process.kill(-claude.pid, 'SIGTERM'); } catch (_) {}
        } else {
          logger.info('guardrail tripped', { surface, conversationId, ...g });
        }
      },
    }).then((res) => {
      finalResult = res;
      if (res?.tracker) appendToolRuns(conversationId, surface, res.tracker);
      if (res?.usage) appendUsage(surface, model, res.usage);
    }).catch((e) => {
      logger.error('translator error', { err: e.message });
      finalResult = { ok: false, error: e.message };
    });

    claude.on('exit', (code, signal) => {
      clearTimeout(timeout);
      // SIGTERM/SIGKILL via process.kill on a pgid sometimes lands as
      // {code: 143|137, signal: null} rather than {code: null, signal: 'SIGTERM'}
      // depending on how the syscall propagated. Treat both as "killed".
      if (signal === 'SIGTERM' || signal === 'SIGKILL' || code === 143 || code === 137) {
        killed = true;
      }

      // Remove tick state
      const t = loadTicks();
      delete t[conversationId];
      saveTicks(t);

      // Wait a tiny moment for the translator to finish processing buffered
      // output, then resolve.
      setTimeout(() => {
        if (iterationCap) {
          resolve({
            ok: false,
            error: 'iteration_cap',
            killed: true,
            guardrailMessage: `🛑 Iteration cap hit (${iterationCap.count}/${iterationCap.max}) — claude was looping. See logs/yoda.log and state/tool-runs.json.`,
          });
        } else if (timedOut) {
          resolve({ ok: false, error: 'timeout', killed: true });
        } else if (killed) {
          // killed could be either user-stop OR fail-fast on throttle.
          // If the translator already produced a result (throttled === true),
          // surface that so dispatcher can fall back to a different model.
          if (finalResult && finalResult.throttled) {
            resolve({ ...finalResult, killed: true });
          } else {
            resolve({ ok: false, error: 'killed', killed: true });
          }
        } else if (finalResult) {
          resolve(finalResult);
        } else {
          // Non-zero exit with no result from the translator — surface the
          // buffered stderr at warn level so the user can see WHY claude died.
          if (code !== 0) {
            const stderr = stderrBuf.join('').trim();
            logger.warn('claude exited non-zero', {
              surface, conversationId, code, stderr: stderr || '(empty)',
            });
            const detail = stderr ? `: ${stderr.split('\n').slice(-3).join(' / ')}` : '';
            resolve({ ok: false, error: `claude exit ${code}${detail}` });
          } else {
            resolve({ ok: true });
          }
        }
      }, 100);
    });

    claude.on('error', (err) => {
      logger.error('claude spawn error', { err: err.message });
      clearTimeout(timeout);
      const t = loadTicks();
      delete t[conversationId];
      saveTicks(t);
      resolve({ ok: false, error: err.message });
    });
  });
}

/**
 * Look up a tick by conversationId. Returns the stored tick record or null.
 */
export function findTick(conversationId) {
  const ticks = loadTicks();
  return ticks[conversationId] || null;
}

/**
 * Look up any tick that matches a predicate. Used by the stop-handler when
 * the user types "stop" outside the original conversation.
 */
export function findTickWhere(predicate) {
  const ticks = loadTicks();
  for (const [id, tick] of Object.entries(ticks)) {
    if (predicate(id, tick)) return { conversationId: id, ...tick };
  }
  return null;
}

/**
 * Kill an in-flight tick. Sends SIGTERM to the claude process group.
 */
export function killTick(tick) {
  if (!tick || !tick.pid) return false;
  try {
    process.kill(-tick.pid, 'SIGTERM');
    logger.info('killed tick', { surface: tick.surface, pid: tick.pid });
    return true;
  } catch (e) {
    logger.warn('killTick failed', { err: e.message, pid: tick.pid });
    return false;
  }
}

/**
 * Kill ALL in-flight claudes recorded in current-ticks.json. Used on
 * shutdown so claude children don't outlive the yoda parent (because
 * they're spawned with detached:true and would otherwise leak).
 *
 * Also cleans up the ticks file.
 */
export function killAllTicks() {
  const ticks = loadTicks();
  let killed = 0;
  for (const tick of Object.values(ticks)) {
    if (killTick(tick)) killed++;
  }
  saveTicks({});
  return killed;
}
