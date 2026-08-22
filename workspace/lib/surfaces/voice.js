// Voice surface — hands-free speech in, spoken answers out.
//
// Shape of the thing (deliberately half-duplex):
//
//   "hey yoda"                     → client wakes, starts capturing
//   "…check whether the sync ran"  → client transcribes, sends TEXT
//   "Got it: check whether the sync ran"   ← spoken immediately (the ack)
//   …silence while the agent works…
//   "Sync finished about forty minutes ago, no errors"  ← spoken when done
//
// The microphone never reaches this process. The client (ui/public/voice.js in
// a browser, or anything else that can hold a WebSocket) does the listening,
// the wake-word match and the speech-to-text, then sends a line of text. So
// this file has no audio in it at all — it is a text surface whose output
// happens to be read aloud.
//
// Two contract choices worth knowing, because they're what makes it feel right
// rather than exhausting:
//
//   * setStatus is NOT implemented. Per lib/surface.js that's what earns a
//     surface the wall-clock heartbeat, so leaving it out is precisely how you
//     get "don't narrate every tool call" — and updateMessage drops the status
//     writes that would otherwise arrive in its place. Tool chatter is useful
//     on a screen and intolerable in a room.
//   * The ack echoes the TRANSCRIPT, not a paraphrase. Hands-free, the failure
//     you actually hit is being misheard, and only a verbatim echo catches it
//     while you can still say "stop".
//
// Implements the lib/surface.js contract.

import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { voiceBus } from '../voice-bus.js';

const HISTORY_FILE = path.join(config.stateDir, 'voice-history.json');

// ─── speech shaping ─────────────────────────────────────────────────────────

// Markdown read aloud is worse than a bad voice reading a plain sentence: a
// premium TTS engine will happily pronounce backticks, asterisks and a raw URL
// character by character. The agent is *told* to write for speech
// (formatPromptHints below), but a status line, an error notice or a watch
// footer is written by yoda itself and still arrives dressed for Slack — so
// everything gets shaped here on the way out, and nothing depends on the model
// having complied.

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

/**
 * Turn display text into something worth hearing. Pure — exported for tests.
 *
 * @param {string} raw
 * @param {number} [maxChars]  Trim point; 0/absent = no trim.
 * @returns {{ text: string, truncated: boolean }}
 */
export function speechify(raw, maxChars = 0) {
  let t = String(raw ?? '');

  // Fenced code first: reading a shell script aloud helps nobody, and the
  // fence's contents would otherwise survive the inline-code strip below.
  t = t.replace(/```[\s\S]*?```/g, ' (code omitted) ');
  t = t.replace(/`([^`]*)`/g, '$1');

  // Links: keep the label, drop the target. A spoken URL is noise at best.
  t = t.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1');
  t = t.replace(/\bhttps?:\/\/\S+/gi, 'a link');

  // Emphasis, headings, quotes, rules.
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?;:]|$)/g, '$1$2');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s{0,3}>\s?/gm, '');
  t = t.replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, '');

  // Bullets and numbered items become sentences. Spoken, a list needs a full
  // stop between items or it runs together into one breathless line.
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+[.)]\s+/gm, '');
  t = t.split('\n').map((line) => {
    const s = line.trim();
    if (!s) return '';
    return /[.!?:,;]$/.test(s) ? s : `${s}.`;
  }).join(' ');

  t = t.replace(EMOJI_RE, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  // The line-to-sentence pass can leave "word. ." where a line was punctuation.
  t = t.replace(/\s+([.,!?;:])/g, '$1').replace(/([.!?])\1+/g, '$1');

  if (!maxChars || t.length <= maxChars) return { text: t, truncated: false };

  // Trim at the last sentence end inside the budget so it stops somewhere a
  // person would stop; fall back to a word boundary if there isn't one.
  const window = t.slice(0, maxChars);
  const lastStop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  const cut = lastStop > maxChars * 0.4 ? lastStop + 1 : window.lastIndexOf(' ');
  return { text: `${t.slice(0, cut > 0 ? cut : maxChars).trim()}`, truncated: true };
}

/** The spoken confirmation. Verbatim, so a mis-transcription is audible. */
export function ackText(utterance) {
  const said = String(utterance ?? '').trim();
  return said ? `Got it: ${said}` : 'Got it.';
}

// ─── rolling transcript ─────────────────────────────────────────────────────
// Voice has no history to re-fetch — nothing but this process ever saw the
// conversation. The dispatcher drops the SDK session whenever a tick's input
// grows past YODA_SESSION_ROTATE_TOKENS, and without a transcript to rebuild
// from the next turn would answer with no idea what was just said. Same
// problem Google Chat has, same fix: keep our own and serve it in fetchContext.

let historyCache = null;

function loadHistory() {
  if (historyCache) return historyCache;
  try {
    historyCache = existsSync(HISTORY_FILE) ? JSON.parse(readFileSync(HISTORY_FILE, 'utf8')) : {};
    if (!historyCache || typeof historyCache !== 'object' || Array.isArray(historyCache)) historyCache = {};
  } catch {
    historyCache = {};
  }
  return historyCache;
}

function persistHistory() {
  try {
    mkdirSync(config.stateDir, { recursive: true });
    // Temp-then-rename: loadHistory resets to {} on a parse error, so a torn
    // write would silently wipe the conversation instead of failing loudly.
    const tmp = `${HISTORY_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(historyCache));
    renameSync(tmp, HISTORY_FILE);
  } catch (e) {
    logger.warn('voice: history persist failed', { err: e.message });
  }
}

/** pure: append to a capped list, dropping an immediate duplicate id. */
export function appendCapped(list, entry, cap) {
  const out = Array.isArray(list) ? list.slice() : [];
  if (entry.id && out.length && out[out.length - 1].id === entry.id) return out;
  out.push(entry);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

function recordMessage(laneKey, entry) {
  const h = loadHistory();
  h[laneKey] = appendCapped(h[laneKey], entry, config.voice.historyPerLane);
  persistHistory();
}

function recentMessages(laneKey) {
  return loadHistory()[laneKey] || [];
}

// ─── event shaping ──────────────────────────────────────────────────────────

/**
 * Build the normalised dispatcher event for a spoken utterance. Pure —
 * exported for tests.
 *
 * A voice install is single-user by construction (one token on the socket, one
 * asserted user id), so there is exactly one lane. That's deliberate: it makes
 * voice one continuous conversation with session resume behind it, rather than
 * a series of amnesiac one-shots.
 */
export function buildVoiceEvent(text, { userId, clientId, now = Date.now() } = {}) {
  const uid = userId || config.voice.userId;
  const conversationId = `voice:${uid}`;
  const utterance = String(text ?? '').trim();
  return {
    surface: 'voice',
    userId: uid,
    conversationId,
    messageId: String(now),
    text: utterance,
    isDirect: true,
    isMention: true,
    // The reply target carries the utterance so postPlaceholder can echo it
    // back verbatim — the dispatcher hands the placeholder a generic opening
    // phrase ("on it"), which is the wrong thing to say to someone who needs
    // to know they were heard correctly.
    replyTarget: { conversationId, userId: uid, utterance, clientId },
    raw: { clientId, receivedAt: now },
  };
}

// ─── surface ────────────────────────────────────────────────────────────────

let started = false;

// The echo is armed by an inbound utterance and consumed by the placeholder it
// produces. It is NOT taken from the reply target, even though the utterance is
// carried there: a background watch stores that whole object and replays it when
// it fires, so reading it back would re-echo "Got it: kick off the deploy and
// tell me when it's done" ten minutes later, unprompted, just before the result.
// A turn nobody spoke for — a watch wake, a restart recovery — has nothing to
// confirm, so it stays quiet and lets the answer arrive on its own.
const pendingAck = new Map();

function armAck(conversationId, utterance) {
  if (utterance) pendingAck.set(conversationId, utterance);
}

function consumeAck(conversationId) {
  const u = pendingAck.get(conversationId);
  pendingAck.delete(conversationId);
  return u || null;
}

/** Speak on every connected client, unless there's nothing worth saying. */
function say(text, { kind = 'speak', truncated = false } = {}) {
  if (!text) return 0;
  return voiceBus.broadcast({ type: kind, text, truncated });
}

const voiceSurface = {
  name: 'voice',

  async start(onIncomingMessage) {
    voiceBus.attach(async ({ text, clientId }) => {
      const event = buildVoiceEvent(text, { clientId });
      if (!event.text) return;
      logger.info('voice: utterance', { clientId, chars: event.text.length });
      // Armed here, one turn before the placeholder that consumes it. A burst
      // that the queue coalesces overwrites this, which is right — the worker
      // rebuilds from the latest state, so the latest utterance is the one to
      // confirm.
      armAck(event.conversationId, event.text);
      await onIncomingMessage(event);
    });
    started = true;
    // Nothing to connect to: the /ws/voice endpoint lives in the web UI, which
    // yoda.js starts just after the surfaces. Attaching to the bus first is the
    // right order — the endpoint never exists before something is listening
    // behind it.
    if (!config.voice.token) {
      logger.warn('voice: YODA_VOICE_TOKEN is not set — the socket will refuse every client');
    }
    logger.info('voice: ready', { userId: config.voice.userId, wakeWords: config.voice.wakeWords });
  },

  async stop() {
    voiceBus.detach();
    started = false;
  },

  isAuthorized(event) {
    // The socket already proved possession of YODA_VOICE_TOKEN — an
    // unauthenticated client never gets far enough to produce an event. This
    // second gate exists so a token that leaks can still only act as the one
    // identity the operator configured, never as an arbitrary user id.
    return started && event.userId === config.voice.userId;
  },

  async fetchContext(event) {
    const messages = recentMessages(event.conversationId).map((m) => (
      m.bot
        // Tagged so the dispatcher's self-filters and effort scan skip it — the
        // model must not be able to escalate its own effort by quoting itself.
        ? { user: m.user, ts: m.ts, text: m.text, bot_id: 'assistant' }
        : { user: m.user, ts: m.ts, text: m.text }
    ));
    return {
      messages,
      replyTargetTs: event.messageId,
      convName: 'voice',
      isIm: true,
      attachments: [],
    };
  },

  recordInbound(event) {
    if (!event?.conversationId || event.synthetic || event.wake) return;
    try {
      recordMessage(event.conversationId, {
        user: event.userId, ts: event.messageId, text: event.text || '(nothing heard)', id: event.messageId,
      });
    } catch (e) {
      logger.debug('voice: recordInbound failed', { err: e.message });
    }
  },

  recordReply(event, text) {
    if (!event?.conversationId || !text) return;
    try {
      recordMessage(event.conversationId, {
        user: 'assistant', ts: String(Date.now()), text: String(text).slice(0, 8000), bot: true,
      });
    } catch (e) {
      logger.debug('voice: recordReply failed', { err: e.message });
    }
  },

  async postPlaceholder(replyTarget, text, opts) {
    const working = Boolean(opts && opts.working);
    const conversationId = replyTarget?.conversationId || `voice:${config.voice.userId}`;

    let spoken = null;
    if (!working) {
      // A real message, not a working state — the stop handler's "Nothing to
      // stop". Spoken as written.
      spoken = speechify(text, config.voice.maxSpeakChars).text;
    } else {
      // The ack: echo what was just heard, not the generic opening phrase the
      // dispatcher passes ("on it"), because the failure that actually bites
      // hands-free is being misheard. Nothing armed means nobody spoke for this
      // turn — stay quiet and let the client show it's working.
      const utterance = consumeAck(conversationId);
      spoken = utterance ? ackText(utterance) : null;
    }

    if (spoken) say(spoken, { kind: 'ack' });
    else voiceBus.broadcast({ type: 'working' });

    return {
      surface: 'voice',
      conversationId,
      userId: replyTarget?.userId || config.voice.userId,
      clientId: replyTarget?.clientId || null,
      startedAt: Date.now(),
      finished: false,
      lastSpoken: spoken,
    };
  },

  async updateMessage(handle, text, opts) {
    // Status writes land here because this surface has no setStatus. Dropping
    // them IS the feature — see the header. They still reach the dashboard and
    // the log, so nothing is lost, it just isn't said out loud.
    if (opts && opts.status) return;

    const { text: spoken, truncated } = speechify(text, config.voice.maxSpeakChars);
    if (!spoken) return;
    // A late duplicate (an error notice restating what was just delivered)
    // would be read out twice, which sounds broken in a way it doesn't look on
    // a screen.
    if (handle && handle.lastSpoken === spoken) return;

    const delivered = say(spoken, { truncated });
    if (handle) {
      handle.finished = true;
      handle.lastSpoken = spoken;
    }
    if (!delivered) {
      // Nobody was listening — the answer is still in the log and the Slack
      // thread if one exists, but the user asked out loud and heard nothing.
      logger.warn('voice: reply had no connected client', { chars: spoken.length });
    }
  },

  // <silent/> means say nothing at all. On a screen that leaves a bare "·";
  // in a room, silence is the correct and complete response.
  async suppressPlaceholder(handle) {
    voiceBus.broadcast({ type: 'silent' });
    if (handle) handle.finished = true;
  },

  formatPromptHints() {
    return `This reply will be READ ALOUD by a speech synthesiser, not displayed. Write for the ear:
- Short, plain sentences. No markdown at all — no bullets, headings, bold, or code blocks.
- No URLs, file paths, or code. If you must refer to one, describe it ("the config file").
- Numbers, dates and times as you'd say them out loud ("about forty minutes ago", not "~40m").
- Lead with the answer. The listener cannot skim, re-read, or scroll back.
- Keep it under a few sentences unless detail was explicitly asked for; offer to say more instead.`;
  },
};

export default voiceSurface;
