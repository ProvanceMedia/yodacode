// Background-watch poller. Runs INSIDE the resident supervisor (yoda.js) — the
// one process that outlives an agent turn — and is the mechanism that makes
// "I'll tell you when it's done" a promise the agent can actually keep.
//
// Flow:
//   1. During a turn the agent calls bin/watch.js, which writes a watch
//      descriptor (command + condition + conversation identity) to state/watches/.
//   2. The turn ends; its SDK child (and anything it backgrounded) dies.
//   3. This loop keeps polling the watch's command. When the condition is met —
//      or the deadline passes, or the command keeps erroring — it synthesises a
//      wake event and hands it to the normal dispatcher, which resumes the
//      thread's SDK session and lets the agent report back IN THAT THREAD.
//
// Security posture: the check command is agent-authored shell, so it runs with
// exactly the environment (and, when the supervisor is root, the unprivileged
// uid/gid) of a normal agent turn — never the supervisor's fuller env. A watch
// can therefore do nothing a turn couldn't. Authorisation happened when the
// watch was created (only an authorised turn can write one, and it records the
// user + thread), so the wake it produces is trusted and bypasses the surface
// re-authorisation that would otherwise reject a message with no bot @-mention.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './logger.js';
import { watchStore } from './watch-store.js';
import { getSurface } from './surface.js';
import { handleMessage } from './dispatcher.js';
import { curatedAgentEnv } from './agent-query.js';
import { buildAgentEnv, derootEnabled, resolveAgentIds } from './deroot.js';

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_TAIL_CHARS = 1500;

let timer = null;
let scanning = false;                 // guards against overlapping scans
const evaluating = new Set();         // watch ids with a check in flight
const firing = new Set();             // watch ids mid-wake
let dispatchFn = handleMessage;       // seam: overridable in tests via startWatcher({dispatch})

// Environment + (when root) uid/gid for the check command — the agent's own,
// NOT the supervisor's. Mirrors resolveRunIsolation() in agent-query.js exactly
// so a watch's poll runs in the identical environment (and identity) the agent
// authored it in, and can never read more than a turn could.
function legacyEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // never API-key auth; OAuth/sub only
  return env;
}
function checkIsolation() {
  if (!derootEnabled()) return { env: legacyEnv(), ids: null };
  const ids = resolveAgentIds();
  // Agent user unavailable (e.g. container without it) → same legacy fallback
  // agent-query uses, rather than failing the poll.
  if (!ids) return { env: legacyEnv(), ids: null };
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    // Root supervisor: curated env with the agent user's own HOME, and drop to
    // its uid/gid — matching the SDK spawn hook.
    return { env: buildAgentEnv(), ids };
  }
  // Non-root supervisor (container): curated env, real HOME, no uid switch.
  return { env: curatedAgentEnv(), ids: null };
}

function tail(s) {
  const str = String(s || '').trim();
  return str.length > OUTPUT_TAIL_CHARS ? `…${str.slice(-OUTPUT_TAIL_CHARS)}` : str;
}

// Run one poll of a watch's command. Resolves { exitCode, output, error? };
// never rejects. A timeout is reported as an error (exitCode null).
function runCheck(command, timeoutMs) {
  return new Promise((resolve) => {
    const { env, ids } = checkIsolation();
    const opts = {
      cwd: WORKSPACE,
      env,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    if (ids) { opts.uid = ids.uid; opts.gid = ids.gid; }

    let child;
    try {
      child = spawn('bash', ['-lc', command], opts);
    } catch (e) {
      resolve({ exitCode: null, output: '', error: e.message });
      return;
    }

    const chunks = [];
    let size = 0;
    const onData = (d) => { if (size < 8192) { chunks.push(d); size += d.length; } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      resolve({ exitCode: null, output: Buffer.concat(chunks).toString('utf8'), error: e.message });
    });
    child.on('close', (code, signal) => {
      const output = Buffer.concat(chunks).toString('utf8');
      if (signal === 'SIGKILL') {
        resolve({ exitCode: null, output, error: `check command timed out after ${Math.round(timeoutMs / 1000)}s` });
      } else {
        resolve({ exitCode: code, output });
      }
    });
  });
}

// Is the watch's condition satisfied? Purely an exit-code comparison (default
// 0). There is deliberately NO supervisor-side output regex: matching on output
// is done INSIDE the check command (e.g. `... | grep -q DONE`), so any
// pattern-matching runs in the sandboxed, timeout-bounded, de-rooted child —
// never as an untimed regex in the supervisor's shared event loop (which a
// catastrophic-backtracking pattern could freeze). A check that errored (spawn
// failure / timeout) is never "met".
function conditionMet(watch, res) {
  if (res.error) return false;
  const want = Number.isInteger(watch.check?.successExit) ? watch.check.successExit : 0;
  return res.exitCode === want;
}

// Run up to `limit` async tasks concurrently over `items`, awaiting all. Keeps
// one slow/hung check from head-of-line-blocking every other due watch (each
// check is already wall-clock-bounded by checkTimeoutMs).
async function runPool(items, limit, fn) {
  const q = items.slice();
  // Coerce limit defensively: a NaN/≤0 limit must not collapse to zero workers
  // (Array.from({length: NaN}) → []), which would silently drain nothing.
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 1;
  const n = Math.max(1, Math.min(safeLimit, q.length || 1));
  await Promise.all(Array.from({ length: n }, async () => {
    while (q.length) await fn(q.shift());
  }));
}

// Build the synthetic "wake" event and hand it to the dispatcher. The
// descriptor is removed BEFORE dispatch (at-most-once: a crash mid-wake loses a
// notification rather than re-firing a surprise duplicate on restart).
async function fire(watch, outcome, detail) {
  firing.add(watch.id);
  watchStore.remove(watch.id);

  const surface = getSurface(watch.surface);
  if (!surface) {
    logger.warn('watch fired but its surface is not available — dropping', {
      id: watch.id, surface: watch.surface,
    });
    firing.delete(watch.id);
    return;
  }

  logger.info('watch fired', {
    id: watch.id, outcome, label: watch.label, conversationId: watch.conversationId,
  });

  const event = {
    surface: watch.surface,
    userId: watch.userId,
    conversationId: watch.conversationId,
    messageId: `wake-${watch.id}`,        // non-numeric so it can't corrupt ts cutoffs
    text: '',
    files: [],
    isDirect: !!(watch.replyTarget && watch.replyTarget.isIm),
    isMention: false,
    synthetic: true,                      // dispatcher skips stop-check + re-authz
    noCoalesce: true,                     // queue must NOT drop this — it carries unique state
    wake: {
      id: watch.id,
      label: watch.label,
      report: watch.report || '',
      command: watch.check?.command,
      outcome,                            // 'met' | 'timeout' | 'error'
      ...detail,                          // exitCode, outputTail, elapsedMs, errorCount
    },
    replyTarget: watch.replyTarget,
    raw: {
      thread_ts: watch.replyTarget?.threadTs,
      channel: watch.replyTarget?.channel,
      ts: `wake-${watch.id}`,
      user: watch.userId,
    },
  };

  try {
    await dispatchFn(event, surface);
  } catch (e) {
    logger.error('watch wake dispatch failed', { id: watch.id, err: e.message });
  } finally {
    firing.delete(watch.id);
  }
}

// The effective give-up time, re-clamped to the LIVE maxTimeoutMs each scan so
// an operator lowering the cap (or a forged descriptor with a huge deadline)
// can't outlive it.
function effectiveDeadline(w) {
  const cap = (w.createdAt || 0) + config.watches.maxTimeoutMs;
  return w.deadlineAt ? Math.min(w.deadlineAt, cap) : cap;
}

// Evaluate one due watch: deadline first (so a timeout is never delayed behind
// its own poll interval), otherwise poll the command and fire/reschedule.
async function evaluateWatch(w, now) {
  if (!w.check || !w.check.command) {
    logger.warn('watch missing a check command — dropping', { id: w.id });
    watchStore.remove(w.id);
    return;
  }
  if (now >= effectiveDeadline(w)) {
    await fire(w, 'timeout', { elapsedMs: now - (w.createdAt || now) });
    return;
  }
  if (now < (w.nextCheckAt || 0)) return; // not yet due for a poll (and deadline not reached)

  evaluating.add(w.id);
  try {
    // Floor the poll interval at the live minIntervalMs; never let it exceed the
    // remaining time to deadline, so a slow interval can't starve the timeout.
    const remaining = Math.max(1000, effectiveDeadline(w) - now);
    const interval = Math.min(remaining, Math.max(config.watches.minIntervalMs, w.intervalMs || config.watches.defaultIntervalMs));
    const res = await runCheck(w.check.command, w.checkTimeoutMs || config.watches.checkTimeoutMs);
    const t = Date.now();

    if (conditionMet(w, res)) {
      await fire(w, 'met', { exitCode: res.exitCode, outputTail: tail(res.output), elapsedMs: t - (w.createdAt || t) });
    } else if (res.error) {
      w.errorCount = (w.errorCount || 0) + 1;
      if (w.errorCount >= config.watches.maxErrors) {
        await fire(w, 'error', { errorCount: w.errorCount, outputTail: tail(res.output || res.error), elapsedMs: t - (w.createdAt || t) });
      } else {
        w.attempts = (w.attempts || 0) + 1;
        w.lastError = res.error;
        w.nextCheckAt = t + interval;
        watchStore.save(w);
      }
    } else {
      // Clean poll, just not satisfied yet — reschedule; a real (errorless)
      // check resets the consecutive-error counter.
      w.attempts = (w.attempts || 0) + 1;
      w.errorCount = 0;
      w.lastExitCode = res.exitCode;
      w.nextCheckAt = t + interval;
      watchStore.save(w);
    }
  } catch (e) {
    logger.warn('watch check threw', { id: w.id, err: e.message });
  } finally {
    evaluating.delete(w.id);
  }
}

async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    const now = Date.now();
    let active = watchStore.list().filter((w) =>
      (!w.state || w.state === 'active') && !firing.has(w.id) && !evaluating.has(w.id));

    // Supervisor-side maxActive backstop. bin/watch.js caps creation, but a
    // descriptor written straight into state/watches/ bypasses that; without a
    // ceiling here the file count and wake fan-out are unbounded. Keep the
    // OLDEST maxActive (established watches) and evict the newest excess — a
    // runaway flood is newest, so this sheds the flood, not the legit ones.
    if (active.length > config.watches.maxActive) {
      active.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      const excess = active.slice(config.watches.maxActive);
      for (const w of excess) watchStore.remove(w.id);
      logger.warn('watch count over maxActive — evicted newest excess', {
        evicted: excess.length, max: config.watches.maxActive,
      });
      active = active.slice(0, config.watches.maxActive);
    }

    const due = active.filter((w) => now >= (w.nextCheckAt || 0) || now >= effectiveDeadline(w));
    // Bounded concurrency so one slow check can't stall the others (or a
    // deadline that just came due). fire() itself only enqueues the wake, so it
    // returns quickly and never blocks the pool on a full agent turn.
    await runPool(due, config.watches.concurrency, (w) => evaluateWatch(w, now));
  } catch (e) {
    logger.warn('watcher scan error', { err: e.message });
  } finally {
    scanning = false;
  }
}

export function startWatcher(opts = {}) {
  if (opts.dispatch) dispatchFn = opts.dispatch; // test seam; production passes nothing
  if (!config.watches.enabled) {
    logger.info('watcher disabled (YODA_WATCH_ENABLED=0)');
    return;
  }
  timer = setInterval(scan, config.watches.tickMs);
  if (timer.unref) timer.unref();
  logger.info('watcher started', { tickMs: config.watches.tickMs, dir: watchStore.dir });
  // Immediate first pass so a watch already due at boot doesn't wait a tick.
  scan();
}

export function stopWatcher() {
  if (timer) { clearInterval(timer); timer = null; }
}
