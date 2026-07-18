// Google Chat surface adapter — implements the lib/surface.js contract.
//
// Transport: Google Chat publishes every inbound event (DMs, @mentions in
// spaces, card clicks) to a Cloud Pub/Sub topic; this adapter holds a PULL
// subscription and pulls events over an outbound-only connection — no public
// webhook endpoint, the same no-ingress model as Slack Socket Mode. Outbound
// replies go via the Chat REST API. Both authenticate with a Google
// service-account key (Pub/Sub subscriber + Chat bot scopes).
//
// Setup (one-time, in Google Cloud): create a project, enable the Chat API +
// Pub/Sub API, create a service account + key, create a topic (grant Publisher
// to chat-api-push@system.gserviceaccount.com) and a pull subscription (grant
// Subscriber to your service account), then configure the Chat app with
// Connection = "Cloud Pub/Sub" pointing at that topic. See docs/providers.
//
// google-auth-library is imported lazily so this module (and its pure
// normaliser) load even where the dep isn't installed / googlechat isn't enabled.

import { config } from '../config.js';
import { logger } from '../logger.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PUBSUB_BASE = 'https://pubsub.googleapis.com/v1';
const CHAT_BASE = 'https://chat.googleapis.com/v1';
const SCOPES = ['https://www.googleapis.com/auth/pubsub', 'https://www.googleapis.com/auth/chat.bot'];
// Resource-name shapes. `space` is interpolated into the Chat REST URL, so a
// malformed one must never reach fetch; `thread` rides in the JSON body but is
// validated too so a hostile value can't reshape a reply.
const SPACE_RE = /^spaces\/[A-Za-z0-9_-]+$/;
const THREAD_RE = /^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_.-]+$/;
const PULL_TIMEOUT_MS = 90_000; // abort a stuck long-poll so a dead connection recovers

let onMessageCallback = null;
let stopping = false;
let authClient = null;
let currentPullAbort = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pub/Sub is at-least-once: an ack failure (or a crash between dispatch and ack)
// redelivers a message, so dedup by the Chat message resource name to avoid
// replying to the same message twice. Bounded so memory stays capped.
const seenMessageIds = new Set();
const SEEN_MAX = 500;
function firstSight(id) {
  if (!id) return true;
  if (seenMessageIds.has(id)) return false;
  seenMessageIds.add(id);
  if (seenMessageIds.size > SEEN_MAX) {
    const keep = [...seenMessageIds].slice(-Math.floor(SEEN_MAX / 2));
    seenMessageIds.clear();
    for (const k of keep) seenMessageIds.add(k);
  }
  return true;
}

// ─── conversation history buffer ─────────────────────────────────────────────
// A Google Chat bot has NO way to fetch a DM's history: spaces.messages.list
// returns 403 for the chat.bot scope, and 400 "DMs are not supported for methods
// requiring app authentication" even with chat.messages.readonly. Yet the
// dispatcher rotates (drops) the SDK session whenever a tick's input grows past
// YODA_SESSION_ROTATE_TOKENS — with a heavy persona that's EVERY tick — after
// which resume is gone and, with no history to rebuild from, the bot would reply
// with zero context. So we keep our own rolling transcript from the messages we
// already handle (every inbound event in fetchContext, every reply in
// recordReply) and hand it back in fetchContext — the same fallback Slack gets
// for free from conversations.history. Persisted so it survives a restart.
const HISTORY_FILE = path.join(config.stateDir, 'googlechat-history.json');
const HISTORY_PER_LANE = 24;    // messages kept per conversation (both sides)
const HISTORY_MAX_LANES = 2000; // bound the file on busy installs
let historyCache = null;

function loadHistory() {
  if (historyCache) return historyCache;
  try {
    historyCache = existsSync(HISTORY_FILE) ? JSON.parse(readFileSync(HISTORY_FILE, 'utf8')) : {};
    if (!historyCache || typeof historyCache !== 'object' || Array.isArray(historyCache)) historyCache = {};
  } catch { historyCache = {}; }
  return historyCache;
}

function laneTouch(list) {
  const last = Array.isArray(list) ? list[list.length - 1] : null;
  return last ? Number(last.ts) || 0 : 0;
}

function persistHistory() {
  try {
    const lanes = Object.entries(historyCache || {});
    if (lanes.length > HISTORY_MAX_LANES) {
      lanes.sort((a, b) => laneTouch(b[1]) - laneTouch(a[1])); // keep most-recent lanes
      historyCache = Object.fromEntries(lanes.slice(0, HISTORY_MAX_LANES));
    }
    mkdirSync(config.stateDir, { recursive: true });
    // Atomic write: a crash or full disk mid-write would otherwise leave a
    // truncated file, and loadHistory resets to {} on a parse error — one bad
    // write would wipe every conversation's memory. Write a temp then rename
    // (atomic on the same filesystem), so the live file is only ever whole.
    const tmp = `${HISTORY_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(historyCache));
    renameSync(tmp, HISTORY_FILE);
  } catch (e) {
    logger.warn('googlechat: history persist failed', { err: e.message });
  }
}

// pure: append entry to a capped list, dropping a redelivered duplicate (same id
// as the last entry) and trimming to the newest `cap` entries.
export function appendCapped(list, entry, cap) {
  const out = Array.isArray(list) ? list.slice() : [];
  if (entry.id && out.length && out[out.length - 1].id === entry.id) return out;
  out.push(entry);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

function recordMessage(conversationId, entry) {
  const cache = loadHistory();
  cache[conversationId] = appendCapped(cache[conversationId], entry, HISTORY_PER_LANE);
  persistHistory();
}

function recentMessages(conversationId, n = HISTORY_PER_LANE) {
  const list = loadHistory()[conversationId] || [];
  return list.slice(Math.max(0, list.length - n));
}

// ─── pure: native Chat event → normalised surface event ──────────────────────

/**
 * Convert a Google Chat event (as delivered on the Pub/Sub topic) into the
 * lib/surface.js normalised shape. Returns null for anything we don't reply to
 * (non-MESSAGE events, bot/own messages, empty text, missing sender).
 */
export function normalizeChatEvent(event) {
  if (!event || event.type !== 'MESSAGE') return null;
  const msg = event.message;
  if (!msg) return null;

  const space = event.space || msg.space || {};
  const spaceName = space.name;
  // `space` is interpolated into the Chat REST URL; require a well-formed resource
  // name so a malformed/hostile Pub/Sub payload can never reshape the request.
  if (!spaceName || !SPACE_RE.test(spaceName)) return null;

  // Chat exposes both a legacy `type` ('ROOM'|'DM') and a newer `spaceType'
  // ('SPACE'|'GROUP_CHAT'|'DIRECT_MESSAGE'); honour whichever is present.
  const isDirect = space.type === 'DM' || space.spaceType === 'DIRECT_MESSAGE';

  const sender = msg.sender || event.user || {};
  const userId = sender.name;
  if (!userId) return null;
  if (sender.type && sender.type !== 'HUMAN') return null; // ignore the bot's own / other bots' messages

  // argumentText has the leading "@Bot" mention stripped in spaces; fall back to text.
  const text = String(msg.argumentText ?? msg.text ?? '').trim();
  // A file sent with no caption is still a real message — keep it if it carries
  // attachments, even when the text is empty (otherwise it would vanish).
  const attachments = Array.isArray(msg.attachment) ? msg.attachment : [];
  if (!text && !attachments.length) return null;

  const rawThread = msg.thread?.name || null;
  const thread = rawThread && THREAD_RE.test(rawThread) ? rawThread : null;

  // Session lane. DMs and group chats are UNTHREADED in Google Chat: every new
  // top-level message gets a brand-new thread name, so laning by thread would
  // start a fresh session on every message — the bot would forget the whole
  // conversation between turns (context lives in the resumed session, and Chat
  // gives a bot no history to rebuild it from). So lane an unthreaded space by
  // the SPACE itself (the space IS the conversation; a DM space is 1:1). Named
  // spaces are threaded by default, so there we keep laning by thread to hold
  // parallel threads apart. The lane rides in replyTarget too, so postPlaceholder
  // reproduces the exact same key (matches the Slack/WhatsApp adapters).
  const isGroupChat = space.spaceType === 'GROUP_CHAT';
  const unthreaded = isDirect || isGroupChat;
  const conversationId = `gchat:${unthreaded ? spaceName : (thread || spaceName)}`;

  // An orderable timestamp (epoch ms) from the Chat createTime, so the history
  // buffer and the dispatcher's delta selection can sort/cut on it. The message
  // resource name isn't orderable, so fall back to no-ts (still marked as the
  // reply target, just not used as a delta cutoff).
  const created = msg.createTime ? Date.parse(msg.createTime) : NaN;
  const createdTs = Number.isFinite(created) ? String(created) : '';

  return {
    surface: 'googlechat',
    userId,
    conversationId,
    messageId: msg.name,
    createdTs,
    text,
    isDirect,
    // Chat only delivers space events to the app when it's @mentioned, so a
    // non-DM message here is by definition a mention.
    isMention: !isDirect,
    replyTarget: { space: spaceName, thread, conversationId },
    attachments, // raw Chat Attachment objects; fetchContext downloads them locally
    raw: event,
  };
}

// ─── auth + REST helpers ─────────────────────────────────────────────────────

async function getAccessToken() {
  if (!authClient) {
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ credentials: config.googlechat.serviceAccountKey, scopes: SCOPES });
    authClient = await auth.getClient();
  }
  const { token } = await authClient.getAccessToken();
  if (!token) throw new Error('googlechat: failed to obtain an access token');
  return token;
}

async function gfetch(url, { method = 'GET', token, body, signal } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const txt = await res.text();
  let data;
  try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
  if (!res.ok) throw new Error(`${method} ${url.split('?')[0]} -> HTTP ${res.status}: ${txt.slice(0, 200)}`);
  return data;
}

// Create a message in a space/thread. Replies fall back to a new thread if the
// referenced thread is gone.
async function chatSend(space, thread, text) {
  const token = await getAccessToken();
  const url = `${CHAT_BASE}/${space}/messages${thread ? '?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' : ''}`;
  const body = thread ? { text, thread: { name: thread } } : { text };
  return gfetch(url, { method: 'POST', token, body });
}

async function chatUpdate(name, text) {
  const token = await getAccessToken();
  return gfetch(`${CHAT_BASE}/${name}?updateMask=text`, { method: 'PATCH', token, body: { text } });
}

async function chatDelete(name) {
  const token = await getAccessToken();
  return gfetch(`${CHAT_BASE}/${name}`, { method: 'DELETE', token });
}

// Download a user's inbound attachments so the agent can Read them locally. Chat's
// media DOWNLOAD supports app auth (unlike upload). UPLOADED_CONTENT is fetched via
// the media API; a DRIVE_FILE isn't downloadable this way (needs Drive) so it's
// flagged, letting the agent tell the user rather than silently ignore it. Mirrors
// slack.js's downloadAttachments; returns { name, mimetype, size, path } | { name, error }.
async function downloadAttachments(attachments, msgId) {
  if (!attachments?.length) return [];
  const safeId = String(msgId || 'msg').replace(/[^A-Za-z0-9._-]/g, '_');
  const baseDir = path.join(os.tmpdir(), 'yoda-attachments', safeId);
  mkdirSync(baseDir, { recursive: true });
  const token = await getAccessToken();
  const out = [];
  for (const a of attachments) {
    const name = a.contentName || 'attachment';
    const resourceName = a.attachmentDataRef?.resourceName;
    // Google Chat stores most attachments as Drive files. The Chat bot can't fetch
    // those via the media API, but the agent has the user's Google connection — so
    // hand it the id/type/link and let it read the file itself (a Doc via the Docs
    // API, a Sheet via Sheets, else Drive). Only genuinely UPLOADED_CONTENT falls
    // through to the direct media download below.
    if (a.source === 'DRIVE_FILE' || a.driveDataRef?.driveFileId) {
      const fileId = a.driveDataRef?.driveFileId;
      out.push({
        name,
        note: `Google Drive file (type ${a.contentType || 'unknown'}${fileId ? `, id ${fileId}` : ''}). `
          + `Read it with your Google connection: a Doc via docs.googleapis.com, a Sheet via `
          + `sheets.googleapis.com, otherwise the Drive API (drive/v3/files/${fileId || '<id>'}?alt=media). `
          + `If you truly can't read it, share this link with the user: https://drive.google.com/open?id=${fileId || ''}`,
      });
      continue;
    }
    if (!resourceName) {
      out.push({ name, error: 'no downloadable reference' });
      continue;
    }
    try {
      const res = await fetch(`${CHAT_BASE}/media/${resourceName}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        out.push({ name, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` });
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const filePath = path.join(baseDir, name.replace(/[^A-Za-z0-9._-]/g, '_'));
      writeFileSync(filePath, buf);
      out.push({ name, mimetype: a.contentType || 'application/octet-stream', size: buf.length, path: filePath });
      logger.info('googlechat: downloaded attachment', { name, bytes: buf.length });
    } catch (e) {
      out.push({ name, error: e.message });
      logger.warn('googlechat: attachment download failed', { name, err: e.message });
    }
  }
  return out;
}

// ─── Pub/Sub pull loop ───────────────────────────────────────────────────────

async function pullLoop() {
  const sub = config.googlechat.subscription;
  while (!stopping) {
    try {
      const token = await getAccessToken();
      // Abortable long-poll: stop() aborts it for a prompt shutdown, and the timer
      // aborts a stuck connection so a silently-dropped socket can't deafen us.
      const ac = new AbortController();
      currentPullAbort = ac;
      const pullTimer = setTimeout(() => ac.abort(), PULL_TIMEOUT_MS);
      let data;
      try {
        data = await gfetch(`${PUBSUB_BASE}/${sub}:pull`, {
          method: 'POST', token, body: { maxMessages: 10 }, signal: ac.signal,
        });
      } finally {
        clearTimeout(pullTimer);
        currentPullAbort = null;
      }
      const received = data.receivedMessages || [];
      if (!received.length) {
        await sleep(2000); // no messages; back off so we don't hot-loop the pull
        continue;
      }
      const ackIds = [];
      for (const rm of received) {
        if (rm.ackId) ackIds.push(rm.ackId);
        try {
          const raw = rm.message?.data;
          if (!raw) continue;
          const event = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
          const norm = normalizeChatEvent(event);
          // firstSight() dedups a redelivered (at-least-once) message so we never reply twice.
          if (norm && firstSight(norm.messageId) && onMessageCallback) {
            // Fire-and-forget: ack the pull immediately and let the dispatcher's
            // per-conversation queue handle the (possibly minutes-long) reply.
            // Blocking the pull on a full Claude run would stall the subscription.
            Promise.resolve(onMessageCallback(norm)).catch((e) =>
              logger.error('googlechat: dispatch failed', { err: e.message }),
            );
          }
        } catch (e) {
          logger.error('googlechat: event decode/handle failed', { err: e.message });
        }
      }
      // Ack everything pulled. Delivery is at-least-once (an ack failure redelivers),
      // so firstSight() above guards the double-reply; acking regardless also keeps a
      // poison message from redelivering forever.
      if (ackIds.length) {
        try {
          await gfetch(`${PUBSUB_BASE}/${sub}:acknowledge`, { method: 'POST', token, body: { ackIds } });
        } catch (e) {
          logger.error('googlechat: ack failed', { err: e.message });
        }
      }
    } catch (e) {
      if (stopping) break; // an aborted in-flight pull during shutdown is expected
      logger.error('googlechat: pull loop error', { err: e.message });
      await sleep(5000);
    }
  }
  logger.info('googlechat: pull loop stopped');
}

// ─── live status (mirrors Slack's status card) ───────────────────────────────
// The dispatcher streams progress via setStatus; without it the raw stream (its
// "thinking…" phases and tool chatter) gets dumped into the message. This
// collapses the generic phases to a bare "working · 4s…" and keeps only real
// tool-use detail, italicised so it reads as a system indicator, not a reply.
function formatElapsed(startedAt) {
  const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`;
}
export function statusText(status, startedAt) {
  const clean = String(status || '').trim() || 'working…';
  const elapsed = startedAt ? ` · ${formatElapsed(startedAt)}` : '';
  const body = /^(thinking|starting up|working)/i.test(clean)
    ? `working${elapsed}…`
    : `working${elapsed} · ${clean}`;
  return `_${body}_`;
}

// ─── surface contract ────────────────────────────────────────────────────────

const googlechatSurface = {
  name: 'googlechat',

  async start(onIncomingMessage) {
    onMessageCallback = onIncomingMessage;
    stopping = false;
    // Validate credentials + subscription up front so a misconfig fails loudly here.
    await getAccessToken();
    pullLoop().catch((e) => logger.error('googlechat: pull loop crashed', { err: e.message }));
    logger.info('googlechat: surface started (Pub/Sub pull)', { subscription: config.googlechat.subscription });
  },

  async stop() {
    stopping = true;
    if (currentPullAbort) currentPullAbort.abort(); // interrupt an in-flight long-poll
  },

  isAuthorized(event) {
    if (event.isDirect) {
      return config.googlechat.dmOpen || config.googlechat.authorizedUsers.has(event.userId);
    }
    return config.googlechat.allowedSpaces.has(event.replyTarget.space);
  },

  async fetchContext(event) {
    // Chat gives a bot no way to fetch history (see the history-buffer note), so
    // we serve our OWN rolling transcript instead of a single message. The
    // messages are recorded at ingress (recordInbound) and after each reply
    // (recordReply); here we only READ the recent window, so a rotated/expired
    // session still answers with the conversation in view. Bot entries are tagged
    // with bot_id so the dispatcher's effort scan and self-filters skip them (the
    // model must not be able to escalate its own effort by quoting "ultrathink").
    const attachments = await downloadAttachments(event.attachments, event.messageId);
    const messages = recentMessages(event.conversationId).map((m) => (
      m.bot
        ? { user: m.user, ts: m.ts, text: m.text, bot_id: 'assistant' }
        : { user: m.user, ts: m.ts, text: m.text }
    ));
    return {
      messages,
      replyTargetTs: event.createdTs || event.messageId,
      convName: event.replyTarget.space,
      isIm: event.isDirect,
      attachments,
    };
  },

  // Record an inbound user message into the rolling transcript. Called by the
  // dispatcher at ingress — BEFORE the per-conversation queue can coalesce a
  // rapid burst — so a message whose worker never runs is still kept for context
  // (Slack recovers such messages by re-fetching history; a Chat bot can't).
  // Skips synthetic wake events, which aren't real user messages.
  recordInbound(event) {
    if (!event?.conversationId || event.synthetic || event.wake) return;
    try {
      recordMessage(event.conversationId, {
        user: event.userId,
        ts: event.createdTs || event.messageId,
        text: event.text || '(sent a file)',
        id: event.messageId,
      });
    } catch (e) {
      logger.debug('googlechat: recordInbound failed', { err: e.message });
    }
  },

  // Record the bot's own reply into the rolling transcript so the next tick sees
  // both sides of the conversation. Called by the dispatcher after a text reply
  // is delivered (optional surface hook; a no-op for surfaces that can fetch
  // their own history). Best-effort — never let a bookkeeping failure surface.
  recordReply(event, text) {
    if (!event?.conversationId || !text) return;
    try {
      recordMessage(event.conversationId, {
        user: 'assistant', ts: String(Date.now()), text: String(text).slice(0, 8000), bot: true,
      });
    } catch (e) {
      logger.debug('googlechat: recordReply failed', { err: e.message });
    }
  },

  async postPlaceholder(replyTarget, text) {
    const msg = await chatSend(replyTarget.space, replyTarget.thread, text);
    return {
      surface: 'googlechat',
      messageName: msg.name,
      // Same lane key normalizeChatEvent computed — DMs by space, not per-message
      // thread — so the stop-handler and session store correlate to one lane.
      conversationId: replyTarget.conversationId,
      startedAt: Date.now(),
    };
  },

  async updateMessage(handle, text) {
    if (!handle?.messageName) return;
    try {
      await chatUpdate(handle.messageName, text);
    } catch (e) {
      logger.debug('googlechat: message update failed', { err: e.message });
    }
  },

  // Live tool-use status during a run — a clean "working · 4s · reading …" line,
  // NOT the raw stream (which would surface the model's thinking phases). The
  // dispatcher prefers this over updateMessage when present, matching Slack.
  async setStatus(handle, text) {
    if (!handle?.messageName) return;
    try {
      await chatUpdate(handle.messageName, statusText(text, handle.startedAt));
    } catch (e) {
      logger.debug('googlechat: status update failed', { err: e.message });
    }
  },

  // Remove the placeholder without posting (a <silent/> final).
  async suppressPlaceholder(handle) {
    if (!handle?.messageName) return;
    try {
      await chatDelete(handle.messageName);
    } catch (e) {
      logger.debug('googlechat: placeholder delete failed', { err: e.message });
    }
  },

  formatPromptHints() {
    return `Surface formatting hints (Google Chat):
- Google Chat markdown: *bold*, _italic_, ~strike~, \`inline code\`, and triple-backtick code blocks
- Use plain URLs (Chat auto-links them). No Slack <url|text> or <@USER_ID> syntax.
- Your reply posts into the same thread; keep it tight and skimmable.`;
  },
};

export default googlechatSurface;
