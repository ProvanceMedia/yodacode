// The single owner of a run's progress display.
//
// Status used to be written from several places at once — the stream
// translator on every SDK event, a wall-clock heartbeat, the model-fallback
// notice — each awaiting the surface independently. Concurrent writers to one
// message race: a slow edit can land after a newer one, or after the final
// reply, leaving a stale "working…" over the answer.
//
// So every progress write for a run funnels through one channel: a single
// serialized writer, one heartbeat, and one place that decides the wording.
// close() is the handover to delivery — it stops the heartbeat, drops queued
// work, and waits (briefly) for the in-flight write, so the caller can
// deliver knowing nothing else will touch the message.
//
// Queue shape is "latest wins": while a write is in flight, a newer status
// replaces any waiting one rather than queueing behind it. Progress is a
// current-state display, not a log — stale frames have no value and would
// just burn the surface's rate limit. Statuses marked important are the
// exception: a guardrail warning is a one-off event, so it gets its own FIFO
// lane and is guaranteed to be written rather than superseded.

import { isGenericStatus, pickPhrase, heartbeatKind } from './status-phrases.js';

// A hung surface call must never hold a conversation hostage. close() is on
// the path to delivering the reply (and to every failure notice), so it waits
// only this long for an in-flight write: a reply landing over a stale status
// line is strictly better than a lane that never answers again.
const CLOSE_DRAIN_MS = 2000;

// How long the opening phrase stays appropriate. Deliberately NOT tied to the
// heartbeat cadence: raising the re-render interval is a rate-limit decision,
// and it must never widen this window into a run that greets you with "one
// sec" four minutes in.
const OPENER_WINDOW_MS = 15000;

// After a one-off event (a guardrail warning) is written, hold it on screen
// this long before the current-state line paints over it. Written-but-unread
// is not the same as shown.
const IMPORTANT_DWELL_MS = 1500;

// A repeating guardrail must not become a write flood — the display would
// churn through a backlog while the run has moved on.
const MUSTSEND_MAX = 3;

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

/** Detail from a finished tool ("reading config.js ✓") is history, not state. */
function isCompleted(text) {
  return /✓\s*$/.test(String(text || ''));
}

/**
 * @param {object} args
 * @param {(text: string) => Promise<void>} args.send   Surface write
 * @param {number} [args.heartbeatMs]  Re-render cadence during silence (0 = off)
 * @param {number} [args.slowAfterMs]  When a run counts as slow (wording only)
 * @param {number} [args.startedAt]
 * @param {string} [args.openingPhrase] Wording already shown by the placeholder
 * @param {() => number} [args.now]    Injectable clock (tests)
 * @param {() => number} [args.rand]   Injectable RNG (tests)
 * @param {boolean} [args.autoBeat]    Start the internal timer (tests pass false)
 * @param {number} [args.closeGraceMs] How long close() waits for an in-flight write
 */
export function createStatusChannel({
  send,
  heartbeatMs = 0,
  slowAfterMs = 240000,
  startedAt = Date.now(),
  openingPhrase = null,
  now = () => Date.now(),
  rand,
  autoBeat = true,
  closeGraceMs = CLOSE_DRAIN_MS,
  importantDwellMs = IMPORTANT_DWELL_MS,
} = {}) {
  let closed = false;
  let chain = Promise.resolve();
  let writing = false;
  let pending = null;      // newest ordinary status (latest wins)
  const mustSend = [];     // one-off events that may not be superseded
  let lastRaw = null;      // last CURRENT-STATE status as the agent phrased it
  // Seeded with the placeholder's wording: it is already on screen, so
  // re-writing it would be a wasted surface call and a pointless re-render.
  let lastWritten = openingPhrase;
  let lastImportant = null;
  let dwellUntil = 0;
  let lastWriteAt = startedAt;
  // The opening phrase is reused for the first few seconds so a burst of
  // generic phases doesn't stutter through three different greetings.
  let startPhrase = openingPhrase;
  const openerWindowMs = OPENER_WINDOW_MS;
  let timer = null;
  const recent = openingPhrase ? [openingPhrase] : [];

  function enqueue(text, { important = false, allowRepeat = false } = {}) {
    if (closed || !text) return chain;
    if (important) {
      // A guardrail that keeps tripping repeats its text; queueing each one
      // would spend a surface write per failure and bury the live status.
      if (text === lastImportant || mustSend.includes(text)) return chain;
      if (mustSend.length >= MUSTSEND_MAX) mustSend.shift();
      mustSend.push(text);
    } else {
      // Nothing to say that isn't already on screen. (Heartbeats pass
      // allowRepeat: re-rendering identical text is the whole point there,
      // since the surface refreshes the elapsed clock with it.)
      if (!allowRepeat && text === lastWritten && !mustSend.length) return chain;
      pending = text;
    }
    if (writing) return chain;           // the running writer will pick it up
    writing = true;
    chain = chain.then(async () => {
      while (!closed && (mustSend.length || pending !== null)) {
        const isImportant = mustSend.length > 0;
        const next = isImportant ? mustSend.shift() : pending;
        if (!isImportant) pending = null;
        // Let a one-off event be read before the current state paints over it.
        if (!isImportant && dwellUntil > now()) {
          await sleep(Math.min(dwellUntil - now(), importantDwellMs));
          if (closed) break;
        }
        lastWriteAt = now();
        lastWritten = next;
        if (isImportant) {
          lastImportant = next;
          dwellUntil = now() + importantDwellMs;
        }
        try { await send(next); } catch (_) { /* status is best-effort */ }
      }
      writing = false;
    });
    return chain;
  }

  /**
   * Wording for a status with no detail of its own. Tied to elapsed time, not
   * to when it was first picked: a run that has been going four minutes must
   * not greet you with "one sec", and must never run backwards from "still
   * going" to "getting started".
   */
  function genericWording() {
    const elapsed = now() - startedAt;
    if (elapsed < openerWindowMs) {
      if (!startPhrase) startPhrase = pickPhrase('start', recent, rand);
      return startPhrase;
    }
    return pickPhrase(heartbeatKind(elapsed, slowAfterMs), recent, rand);
  }

  /**
   * A status from the agent's stream.
   * @param {string} raw
   * @param {{ important?: boolean }} [opts] important = a one-off event
   *   (guardrail warning, context compaction) that must not be superseded.
   */
  function post(raw, opts) {
    if (closed || !raw) return chain;
    const important = !!(opts && opts.important);
    // An important frame is an EVENT, not the current state — recording it as
    // state would make the heartbeat keep re-announcing a warning about work
    // that finished minutes ago.
    if (!important) lastRaw = raw;
    if (!isGenericStatus(raw)) return enqueue(raw, { important });
    return enqueue(genericWording(), { important });
  }

  /**
   * Wall-clock tick. A long silent tool call emits nothing, so without this
   * the display freezes — including its elapsed counter. Always leads with a
   * liveness phrase: re-sending the last tool line verbatim would pair a
   * finished action with a growing clock, which reads as stuck. Live detail
   * is kept alongside it so a slow step still says what it is waiting on.
   */
  function beat() {
    if (closed || heartbeatMs <= 0) return chain;
    if (now() - lastWriteAt < heartbeatMs) return chain;
    const phrase = pickPhrase(heartbeatKind(now() - startedAt, slowAfterMs), recent, rand);
    // Drop the step counter here: with a phrase, the detail and the elapsed
    // clock, a fourth clause turns the line into rattle.
    const detail = lastRaw && !isGenericStatus(lastRaw) && !isCompleted(lastRaw)
      ? lastRaw.replace(/\s·\sstep\s\d+$/, '')
      : null;
    return enqueue(detail ? `${phrase} · ${detail}` : phrase, { allowRepeat: true });
  }

  /**
   * Hand the message over to delivery: stop the heartbeat, abandon queued
   * work, and give an in-flight write a bounded moment to land.
   */
  async function close() {
    closed = true;
    if (timer) { clearInterval(timer); timer = null; }
    pending = null;
    mustSend.length = 0;
    let t;
    const grace = new Promise((r) => { t = setTimeout(r, closeGraceMs); if (t.unref) t.unref(); });
    try { await Promise.race([chain, grace]); } catch (_) {}
    clearTimeout(t);
  }

  if (autoBeat && heartbeatMs > 0) {
    timer = setInterval(beat, Math.max(2000, Math.round(heartbeatMs / 3)));
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    post,
    beat,
    close,
    get closed() { return closed; },
    get lastRaw() { return lastRaw; },
  };
}
