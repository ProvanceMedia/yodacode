// Surface-agnostic Claude runner. Runs each reply turn through the Claude
// Agent SDK (query()) and pipes the SDK's message stream into the
// stream-translator, which calls back into the caller with throttled status
// updates and a final reply text.
//
// Active runs are tracked in-memory (conversationId → AbortController) so the
// stop handler can abort the right run when "stop" comes in; a JSON mirror in
// `state/current-ticks.json` feeds the dashboard. SDK children die with their
// AbortController, so unlike the old detached `claude -p` processes nothing
// can leak across restarts.

import * as fs from 'node:fs';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { translateMessages } from './stream-translator.js';
import { isAbortError } from './agent-query.js';
import { selectEngine } from './engine/index.js';

const TICKS_FILE = path.join(config.stateDir, 'current-ticks.json');
const ORPHANS_FILE = path.join(config.stateDir, 'orphaned-ticks.json');
const TOOL_RUNS_FILE = path.join(config.stateDir, 'tool-runs.json');
const TOOL_RUNS_MAX_ENTRIES = 100;
const USAGE_FILE = path.join(config.stateDir, 'usage.jsonl');
const STDERR_BUF_MAX = 8192;
const TICK_EXCERPT_CHARS = 300;

// conversationId → { conversationId, surface, placeholder, startedAt,
//                    userId, replyTarget, textExcerpt,
//                    controller, userStopped, killed, timedOut, timeoutKind }
const activeTicks = new Map();

// Runs live and die with this process (the SDK child is aborted, never
// detached), so anything left in the mirror file belongs to a previous process
// whose runs were killed mid-task — a hard kill (OOM, docker rm) leaves them
// in TICKS_FILE, a graceful shutdown moves them to ORPHANS_FILE (killAllTicks).
// Collect both BEFORE resetting so the supervisor can offer restart recovery
// (lib/orphan-recovery.js); the reset keeps the dashboard mirror truthful.
mkdirSync(config.stateDir, { recursive: true });

// Atomic write: the host-side drain gate (yodacode update) greps these files
// while we write them; a torn read must never show a half-written file (a
// false "idle" would let the rebuild kill a live run). Same-filesystem rename
// is atomic, so readers always see a complete old or new version.
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

let bootOrphans = {};
for (const f of [TICKS_FILE, ORPHANS_FILE]) {
  try {
    if (existsSync(f)) Object.assign(bootOrphans, JSON.parse(readFileSync(f, 'utf8')));
  } catch (_) { /* unparseable = no orphans to recover from that file */ }
}
// Custody rules: keep the orphan records ON DISK (merged into ORPHANS_FILE)
// until the recovery sweep actually takes them — if boot dies before the
// sweep runs (bad token, no surfaces, crash), the records survive for the
// next boot instead of being wiped by this one. Only the dashboard mirror is
// reset here.
try { if (Object.keys(bootOrphans).length) writeJsonAtomic(ORPHANS_FILE, bootOrphans); } catch (_) {}
try { writeJsonAtomic(TICKS_FILE, '{}'); } catch (_) {}

/**
 * Hand over the ticks a previous process left behind. Called once by the
 * orphan-recovery sweep after surfaces are up — which is when the on-disk
 * record is cleared: from here custody is the sweep's.
 */
export function takeOrphanTicks() {
  const out = bootOrphans;
  bootOrphans = {};
  try { writeJsonAtomic(ORPHANS_FILE, '{}'); } catch (_) {}
  return out;
}

function tickRecord(t, extra) {
  return {
    surface: t.surface,
    startedAt: t.startedAt,
    userId: t.userId || null,
    replyTarget: t.replyTarget || null,
    textExcerpt: t.textExcerpt || null,
    recoveryAttempt: t.recoveryAttempt || 0,
    ...extra,
  };
}

function persistTicks() {
  const out = {};
  for (const [id, t] of activeTicks) {
    out[id] = tickRecord(t, { placeholder: t.placeholder });
  }
  try {
    writeJsonAtomic(TICKS_FILE, out);
  } catch (e) {
    logger.warn('ticks persist failed', { err: e.message });
  }
}

function appendUsage(surface, model, usage, engineId) {
  if (!usage) return;
  try {
    const entry = {
      ts: new Date().toISOString(),
      surface,
      // Which engine produced these tokens. Model names alone don't identify it
      // and they churn, so a usage log spanning an engine change would otherwise
      // be impossible to read back.
      engine: engineId || 'claude',
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
 * @param {string}   args.prompt          The full prompt for this turn
 * @param {string}   [args.model]         Optional model override (e.g. claude-haiku-4-5)
 * @param {string}   [args.effort]        Optional effort level (low|medium|high|xhigh|max)
 * @param {string}   [args.resume]        SDK session id to resume (persistent thread sessions)
 * @param {string}   [args.userId]        Triggering user id — injected so a background
 *   watch the agent sets can record who to wake later.
 * @param {any}      [args.replyTarget]   Surface reply target — injected (JSON) for the same reason.
 * @param {(text: string, opts?: { important?: boolean }) => Promise<void>} args.onStatus  Live update callback
 * @param {(text: string) => Promise<void>} args.onFinal   Final text callback
 * @returns {Promise<{ ok: boolean, finalText?: string, error?: string, killed?: boolean, throttled?: boolean, tracker?: object, usage?: object, sessionId?: string|null, guardrailMessage?: string }>}
 */
export async function runClaude({
  surface,
  conversationId,
  placeholder,
  prompt,
  model,
  effort,
  resume,
  userId,
  replyTarget,
  originText,
  recoveryAttempt = 0,
  onStatus,
  onFinal,
}) {
  const engine = selectEngine();
  const controller = new AbortController();
  const tick = {
    conversationId,
    surface,
    placeholder,
    startedAt: Date.now(),
    userId: userId || null,
    replyTarget: replyTarget || null,
    // What the user asked for, for the restart-recovery prompt — the built
    // prompt itself is too long and too internal to persist.
    textExcerpt: originText ? String(originText).slice(0, TICK_EXCERPT_CHARS) : null,
    // How many times restart recovery has already resurrected this work —
    // caps crash-loop resurrection (see lib/orphan-plan.js).
    recoveryAttempt,
    controller,
    userStopped: false, // explicit user "stop" via killTick
    killed: false,      // internal abort: throttle fail-fast, guardrail, shutdown
    timedOut: false,
    timeoutKind: null,  // 'idle' | 'hard'
    delivering: false,  // onFinal delivery in flight
    delivered: false,   // onFinal delivery completed — reply is on the surface
  };
  activeTicks.set(conversationId, tick);
  persistTicks();

  let settled = false;
  let iterationCap = null; // populated when the guardrail trips

  // Idle watchdog. Reset on every SDK message (bumpIdle, wired to the
  // translator's onActivity below), so it only fires when the run has gone
  // genuinely SILENT for timeoutMs — i.e. stuck on a hung API call or tool.
  // Caveat: a SINGLE long tool call (a slow curl, a long build) emits nothing
  // between its tool_use and tool_result, so its whole runtime reads as
  // silence; one tool that runs longer than timeoutMs will still be aborted.
  // (Task subagents are fine — the SDK streams their tool frames, which keep
  // the watchdog fed.) Raise YODA_CLAUDE_TIMEOUT_MS if you legitimately need
  // longer single operations. Runaway fast tool-loops are bounded separately
  // by maxIterations.
  let idleTimer = null;
  let hardTimer = null;

  const disarm = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
  };

  // Single-fire: whichever watchdog trips first wins, disarms its sibling, and
  // a user-stop / fail-fast that already aborted pre-empts both.
  const fireTimeout = (kind) => {
    if (settled || tick.userStopped || tick.killed || tick.timedOut) return;
    tick.timedOut = true;
    tick.timeoutKind = kind;
    disarm();
    logger.warn('claude watchdog timeout, aborting', {
      surface, conversationId, kind,
      ms: kind === 'hard' ? config.claude.hardTimeoutMs : config.claude.timeoutMs,
    });
    controller.abort();
  };

  idleTimer = setTimeout(() => fireTimeout('idle'), config.claude.timeoutMs);
  idleTimer.unref();
  const bumpIdle = () => {
    // Reset the silence timer on any stream activity. Don't re-arm once the
    // run has settled/timed-out/been-stopped.
    if (settled || tick.timedOut || tick.userStopped || tick.killed || !idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fireTimeout('idle'), config.claude.timeoutMs);
    idleTimer.unref();
  };

  // Optional absolute ceiling — disabled by default (hardTimeoutMs === 0).
  // Guards against a run that keeps emitting activity forever (never idle)
  // from burning unbounded quota.
  if (config.claude.hardTimeoutMs > 0) {
    hardTimer = setTimeout(() => fireTimeout('hard'), config.claude.hardTimeoutMs);
    hardTimer.unref();
  }

  // NB: the progress display belongs to the caller's status channel
  // (lib/status-channel.js): it serializes every status write, runs the
  // wall-clock heartbeat that keeps the display moving through a long silent
  // tool call, and closes itself before delivery. The runner never writes to
  // a surface — it only decides when a run is over.

  // Buffer the SDK child's stderr — logged at debug for normal runs,
  // escalated to error when the run fails so the user can see WHY (auth
  // errors, missing OAuth token, etc.) without flipping YODA_LOG_LEVEL=debug.
  const stderrBuf = [];
  const onStderr = (data) => {
    const line = String(data);
    logger.debug('claude stderr', { surface, line: line.trim() });
    if (stderrBuf.join('').length < STDERR_BUF_MAX) stderrBuf.push(line);
  };

  const stopped = () => tick.userStopped || tick.killed || tick.timedOut;

  let finalResult = null;
  let queryError = null;
  try {
    const q = engine.run({
      prompt,
      // The engine decides what to do with a model name — a value left over
      // from another engine must not be sent to this one.
      model: engine.mapModel ? engine.mapModel(model) : (model || undefined),
      effort: engine.mapEffort ? engine.mapEffort(effort) : effort,
      allowedTools: config.claude.allowedTools,
      permissionMode: config.claude.permissionMode,
      cwd: config.workspace,
      abortController: controller,
      stderr: onStderr,
      resume,
      // Hand the child its conversation identity so a background watch it sets
      // (bin/watch.js) knows which thread + user to wake when its condition
      // fires, plus the operator's live sizing knobs so the CLI enforces the
      // real limits (the de-rooted child's curated env strips YODA_* otherwise,
      // which is why these are forwarded explicitly). Non-secret values only.
      // Gated on the feature flag so a disabled install can't accumulate orphan
      // watch files.
      extraEnv: config.watches.enabled ? {
        YODA_CONVERSATION_ID: conversationId || '',
        YODA_SURFACE: surface || '',
        YODA_USER_ID: userId || '',
        YODA_REPLY_TARGET: replyTarget ? JSON.stringify(replyTarget) : '',
        YODA_WATCH_ENABLED: '1',
        YODA_WATCH_DEFAULT_INTERVAL_MS: String(config.watches.defaultIntervalMs),
        YODA_WATCH_MIN_INTERVAL_MS: String(config.watches.minIntervalMs),
        YODA_WATCH_DEFAULT_TIMEOUT_MS: String(config.watches.defaultTimeoutMs),
        YODA_WATCH_MAX_TIMEOUT_MS: String(config.watches.maxTimeoutMs),
        YODA_WATCH_MAX_ACTIVE: String(config.watches.maxActive),
      } : { YODA_WATCH_ENABLED: '0' },
    });

    // Run the translator over the SDK message stream. Status updates and the
    // final text both go through the surface-supplied callbacks. If Claude
    // hits too many api_retry events (Anthropic 529 throttling), the
    // translator calls onMaxRetries → we abort to fail fast and avoid
    // deepening the cooldown by sustaining concurrent load.
    const translator = translateMessages(q, {
      // Fired on every SDK message, BEFORE the user-facing throttle/dedupe in
      // the translator can swallow it — so the idle watchdog tracks true
      // stream liveness, not just distinct status changes.
      onActivity: () => bumpIdle(),
      onStatus: async (text, opts) => {
        if (stopped()) return;
        try { await onStatus(text, opts); }
        catch (e) { logger.debug('onStatus failed', { err: e.message }); }
      },
      onFinal: async (text, meta) => {
        if (stopped()) return;
        // Stream complete, reply composed — delivery has begun. Disarm the
        // watchdogs so a slow surface post (Slack 429s/retries) can't be
        // misclassified as a timeout and overwrite the delivered reply.
        // Callers must close their status channel before delivering (see
        // dispatcher.js) so a late status write can't land over the answer.
        tick.delivering = true;
        disarm();
        try {
          await onFinal(text, meta);
          tick.delivered = true;
        } catch (e) { logger.warn('onFinal failed', { err: e.message }); }
      },
      maxRetries: config.claude.maxRetries,
      onMaxRetries: () => {
        logger.warn('claude api retries exceeded, aborting fast', {
          surface, conversationId, maxRetries: config.claude.maxRetries,
        });
        tick.killed = true;
        controller.abort();
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
          logger.warn('iteration cap hit, aborting', {
            surface, conversationId, count: g.count, max: g.max,
          });
          tick.killed = true;
          controller.abort();
        } else {
          logger.info('guardrail tripped', { surface, conversationId, ...g });
        }
      },
    });

    // Abort backstop. controller.abort() interrupts the translator's iterator
    // await, but NOT an await stuck inside a surface callback (a hung Slack
    // call in onStatus/onFinal has no timeout of its own). Every recovery
    // path — killTick, watchdogs, throttle fail-fast, shutdown — funnels
    // through abort(), so racing the translator against abort+5s guarantees
    // runClaude settles, the queue lane unblocks, and the tick is cleared.
    // The stopped() gates keep a late-settling translator from posting.
    translator.catch(() => {}); // no unhandled rejection if the backstop wins
    const backstop = new Promise((resolve) => {
      // Deliberately NOT unref'd: this timer only exists for ≤5s after an
      // abort, and it must be allowed to fire even if nothing else holds the
      // event loop open — it is what guarantees the run settles.
      const arm = () => { setTimeout(() => resolve(null), 5000); };
      if (controller.signal.aborted) arm();
      else controller.signal.addEventListener('abort', arm, { once: true });
    });
    finalResult = await Promise.race([translator, backstop]);
  } catch (e) {
    queryError = e;
  } finally {
    settled = true;
    disarm();
    activeTicks.delete(conversationId);
    persistTicks();
  }

  if (finalResult?.tracker) appendToolRuns(conversationId, surface, finalResult.tracker);
  if (finalResult?.usage) appendUsage(surface, model, finalResult.usage, engine.id);

  // Classification mirrors the old process-exit handler: an explicit user
  // stop wins over a watchdog that fired in the same instant, then timeouts,
  // then internal aborts (throttle fail-fast surfaces the translator's
  // throttled result so the dispatcher can fall back to another model).
  if (iterationCap) {
    return {
      ok: false,
      error: 'iteration_cap',
      killed: true,
      guardrailMessage: `🛑 Iteration cap hit (${iterationCap.count}/${iterationCap.max}), claude was looping. See logs/yoda.log and state/tool-runs.json.`,
    };
  }
  if (tick.userStopped) {
    // The stop-handler already updated the placeholder, so the dispatcher's
    // 'killed' branch is a deliberate no-op.
    return { ok: false, error: 'killed', killed: true };
  }
  if (tick.timedOut) {
    // 'idle' = went silent (stuck); 'hard' = hit the absolute ceiling while
    // still active. Distinct codes so the dispatcher can explain accurately.
    return { ok: false, error: tick.timeoutKind === 'hard' ? 'hard_timeout' : 'timeout', killed: true };
  }
  if (tick.killed) {
    // Fail-fast on throttle: surface the translator's result so the
    // dispatcher can fall back to a different model.
    if (finalResult && finalResult.throttled) {
      return { ...finalResult, killed: true };
    }
    return { ok: false, error: 'killed', killed: true };
  }
  if (queryError && !isAbortError(queryError)) {
    // The query itself failed (runtime missing, auth error, crash). Surface
    // the buffered stderr so the user can see WHY.
    const stderr = stderrBuf.join('').trim();
    logger.error('claude query failed', {
      surface, conversationId, err: queryError.message, stderr: stderr || '(empty)',
    });
    const detail = stderr ? `: ${stderr.split('\n').filter(Boolean).slice(-3).join(' / ')}` : '';
    // An out-of-the-blue SIGKILL is almost always the kernel OOM killer —
    // the Claude engine needs several hundred MB and tiny VMs run out.
    const oomHint = /SIGKILL/.test(queryError.message)
      ? ' (likely out of memory — check free RAM/swap, see `yodacode doctor`)'
      : '';
    return { ok: false, error: `${queryError.message}${detail}${oomHint}` };
  }
  if (finalResult) return finalResult;
  return { ok: false, error: 'no result from claude' };
}

/**
 * Look up a tick by conversationId. Returns a snapshot of the tick or null.
 */
export function findTick(conversationId) {
  const t = activeTicks.get(conversationId);
  if (!t) return null;
  return { conversationId: t.conversationId, surface: t.surface, placeholder: t.placeholder, startedAt: t.startedAt };
}

/**
 * Look up any tick that matches a predicate. Used by the stop-handler when
 * the user types "stop" outside the original conversation.
 */
export function findTickWhere(predicate) {
  for (const [id, t] of activeTicks) {
    if (predicate(id, t)) {
      return { conversationId: id, surface: t.surface, placeholder: t.placeholder, startedAt: t.startedAt };
    }
  }
  return null;
}

/**
 * Stop an in-flight tick (explicit user "stop"). Aborts the SDK run.
 */
export function killTick(tick) {
  const t = tick && tick.conversationId ? activeTicks.get(tick.conversationId) : null;
  if (!t) return false;
  // Flag BEFORE aborting so the owning run classifies this as a user stop
  // even if a watchdog fires in the same instant — the user's intent wins.
  t.userStopped = true;
  try { t.controller.abort(); } catch (e) {
    logger.warn('killTick abort failed', { err: e.message, conversationId: t.conversationId });
    return false;
  }
  logger.info('stopped tick', { surface: t.surface, conversationId: t.conversationId });
  return true;
}

/**
 * Abort ALL in-flight runs. Used on shutdown so SDK children don't outlive
 * the yoda parent.
 *
 * Interrupted runs are recorded to ORPHANS_FILE first: each run's cleanup
 * (the finally in runClaude) deletes its tick and rewrites the mirror, so by
 * process exit current-ticks.json is empty — without this record a graceful
 * shutdown (docker stop, `yodacode update`) would leave no trace for the
 * next boot's restart recovery. User-stopped ticks are deliberately not
 * recorded: the user ended those on purpose.
 */
export function killAllTicks() {
  let killed = 0;
  const orphans = {};
  for (const [id, t] of activeTicks) {
    // Record only runs that were genuinely interrupted mid-work. Not:
    // user-stopped (ended on purpose), already killed/timed-out (they died
    // for their own reasons and are just awaiting the abort backstop), or
    // delivered (the reply is on the surface — resurrecting it would answer
    // twice; `delivering` ones ARE recorded, the recovery prompt's
    // check-the-thread-first rule covers the reply-landed-anyway case).
    if (!t.userStopped && !t.killed && !t.timedOut && !t.delivered) {
      orphans[id] = tickRecord(t, { reason: 'shutdown', orphanedAt: Date.now() });
    }
    t.killed = true; // internal abort, not a user stop — no final text is posted
    try { t.controller.abort(); killed++; } catch (_) {}
  }
  if (Object.keys(orphans).length) {
    let prev = {};
    try {
      if (existsSync(ORPHANS_FILE)) prev = JSON.parse(readFileSync(ORPHANS_FILE, 'utf8')) || {};
    } catch (_) { prev = {}; }
    try {
      writeJsonAtomic(ORPHANS_FILE, { ...prev, ...orphans });
    } catch (e) {
      logger.warn('orphan ticks persist failed', { err: e.message });
    }
  }
  persistTicks();
  return killed;
}
