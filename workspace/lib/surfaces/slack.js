// Slack surface adapter — wraps Socket Mode + Web API behind the surface
// contract defined in lib/surface.js.
//
// Implements:
//   - start(onIncomingMessage) → opens Socket Mode, normalises events
//   - stop()
//   - isAuthorized(event)
//   - fetchContext(event)
//   - postPlaceholder(replyTarget, text)
//   - updateMessage(handle, text)
//   - formatPromptHints()

import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '../config.js';
import { logger } from '../logger.js';

let web;
let sm;
let botUserId = null;

// Thread-sticky model overrides: conversationId ("channel:threadTs") → model id.
// When a user invokes /opus, /sonnet, or /haiku, the override is pinned to that
// thread so every follow-up message in the same thread keeps using the chosen
// model. In-memory only — resets on yoda restart, which is fine for short-lived
// threads.
const threadModelOverrides = new Map();

// Conversation info cache so we know if a channel is an IM
const convInfoCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function getConvInfo(channel) {
  const cached = convInfoCache.get(channel);
  if (cached && Date.now() - cached.t < CACHE_TTL_MS) return cached.info;
  try {
    const r = await web.conversations.info({ channel });
    convInfoCache.set(channel, { info: r.channel, t: Date.now() });
    return r.channel;
  } catch (e) {
    logger.warn('slack: conversations.info failed', { channel, err: e.message });
    return null;
  }
}

/**
 * Download Slack-hosted files for a message so claude can `Read` them locally.
 * Slack file URLs are private and require the bot token in an Authorization
 * header. Files land in /tmp/yoda-attachments/<msg-ts>/<filename>.
 *
 * @param {Array} files event.files (Slack file objects)
 * @param {string} messageTs the parent message ts (used as the dir name)
 * @returns {Promise<Array<{ id, name, mimetype, size, path, error?: string }>>}
 */
async function downloadAttachments(files, messageTs) {
  if (!files || !files.length) return [];
  const baseDir = path.join(os.tmpdir(), 'yoda-attachments', messageTs);
  mkdirSync(baseDir, { recursive: true });

  const out = [];
  for (const f of files) {
    const url = f.url_private_download || f.url_private;
    if (!url) {
      out.push({ id: f.id, name: f.name, error: 'no url' });
      continue;
    }
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${config.slack.botToken}` },
      });
      if (!res.ok) {
        out.push({ id: f.id, name: f.name, error: `HTTP ${res.status}` });
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const safe = (f.name || f.id).replace(/[^A-Za-z0-9._-]/g, '_');
      const filePath = path.join(baseDir, safe);
      writeFileSync(filePath, buf);
      out.push({
        id: f.id,
        name: f.name || safe,
        mimetype: f.mimetype || 'application/octet-stream',
        size: buf.length,
        path: filePath,
      });
      logger.info('slack: downloaded attachment', { name: f.name, bytes: buf.length, path: filePath });
    } catch (e) {
      out.push({ id: f.id, name: f.name, error: e.message });
      logger.warn('slack: download failed', { name: f.name, err: e.message });
    }
  }
  return out;
}

async function discoverBotUserId() {
  if (botUserId) return botUserId;
  if (config.botUserId) {
    botUserId = config.botUserId;
    return botUserId;
  }
  const auth = await web.auth.test();
  botUserId = auth.user_id;
  config.botUserId = auth.user_id;
  logger.info('slack: discovered bot user id', { botUserId });
  return botUserId;
}

/**
 * Convert a Slack message event into the normalised event shape.
 *
 * Accepted shapes:
 *   - Plain text message (no subtype)
 *   - File attachment with optional caption (subtype 'file_share')
 *   - Edited messages are NOT processed (avoid double-replying)
 */
async function normalize(event) {
  if (!event || !event.user) return null;
  if (event.bot_id) return null;
  // Allow only "plain" or file_share. Reject every other subtype (joins,
  // channel_topic, message_changed, message_deleted, etc).
  if (event.subtype && event.subtype !== 'file_share') return null;

  const files = Array.isArray(event.files) ? event.files : [];
  const text = event.text || '';
  // Need either text or at least one file
  if (!text && files.length === 0) return null;

  const convInfo = await getConvInfo(event.channel);
  const isIm = !!(convInfo && convInfo.is_im);
  const isMention = botUserId ? text.includes(`<@${botUserId}>`) : false;

  // The thread root is what we use for queueing + threading replies.
  // For top-level messages, the message itself becomes the thread root.
  const threadTs = event.thread_ts || event.ts;
  const conversationId = `${event.channel}:${threadTs}`;

  // If this thread was started with /opus, /sonnet, /haiku — inherit that model.
  const modelOverride = threadModelOverrides.get(conversationId);

  return {
    surface: 'slack',
    userId: event.user,
    conversationId,
    messageId: event.ts,
    text,
    files,                         // ← passes file metadata through
    isDirect: isIm,
    isMention,
    modelOverride,
    replyTarget: {
      channel: event.channel,
      threadTs,
      conversationId,
      isIm,
      convName: convInfo?.name || (isIm ? `im:${convInfo?.user || '?'}` : event.channel),
    },
    raw: event,
  };
}

const slackSurface = {
  name: 'slack',

  async start(onIncomingMessage) {
    web = new WebClient(config.slack.botToken, {
      retryConfig: { retries: 3, factor: 2 },
    });
    sm = new SocketModeClient({
      appToken: config.slack.appToken,
      logLevel: 'error',
    });

    sm.on('connecting', () => logger.info('slack: socket mode connecting'));
    sm.on('connected', () => logger.info('slack: socket mode connected'));
    sm.on('disconnecting', () => logger.warn('slack: socket mode disconnecting'));
    sm.on('disconnected', (e) => logger.warn('slack: disconnected', { reason: e?.reason }));
    sm.on('reconnecting', () => logger.warn('slack: reconnecting'));
    sm.on('error', (err) => logger.error('slack: socket error', { err: err?.message || String(err) }));

    sm.on('message', async ({ event, ack }) => {
      try { await ack(); } catch (_) {}
      if (!event) return;
      try {
        const normalised = await normalize(event);
        if (normalised) await onIncomingMessage(normalised);
      } catch (e) {
        logger.error('slack: normalize/dispatch error', { err: e.message });
      }
    });

    // We listen on `message` for everything (including @-mentions in channels)
    // and detect mentions ourselves so the routing is in one place.
    sm.on('app_mention', async ({ ack }) => { try { await ack(); } catch (_) {} });

    // Slash commands — let the user pick a specific model for a one-off reply.
    // Registered in Slack app config: /opus, /sonnet, /haiku. Each takes the
    // user's question as its argument. Ack fast, post a public echo that
    // becomes the thread root, then dispatch through the normal pipeline with
    // modelOverride set.
    const SLASH_MODELS = {
      '/opus': { model: 'claude-opus-4-7', label: 'opus' },
      '/sonnet': { model: 'claude-sonnet-4-6', label: 'sonnet' },
      '/haiku': { model: 'claude-haiku-4-5', label: 'haiku' },
    };
    sm.on('slash_commands', async ({ body, ack }) => {
      try { await ack(); } catch (_) {}
      try {
        const spec = SLASH_MODELS[body.command];
        if (!spec) return;
        const text = (body.text || '').trim();
        if (!text) {
          try {
            await web.chat.postEphemeral({
              channel: body.channel_id,
              user: body.user_id,
              text: `Usage: \`${body.command} <your question>\``,
            });
          } catch (e) {
            logger.warn('slack: postEphemeral failed', { err: e.message });
          }
          return;
        }
        // Post the echo as thread root so the reply lands in a thread and
        // subsequent messages continue naturally.
        const root = await web.chat.postMessage({
          channel: body.channel_id,
          text: `<@${body.user_id}> asked (_${spec.label}_): ${text}`,
        });
        const rootTs = root.ts;
        const conversationId = `${body.channel_id}:${rootTs}`;
        // Pin this model to the thread so follow-up messages keep using it.
        threadModelOverrides.set(conversationId, spec.model);
        const convInfo = await getConvInfo(body.channel_id);
        const isIm = !!(convInfo && convInfo.is_im);
        const normalised = {
          surface: 'slack',
          userId: body.user_id,
          conversationId,
          messageId: rootTs,
          text,
          files: [],
          isDirect: isIm,
          isMention: true,
          isSlashCommand: true,
          modelOverride: spec.model,
          replyTarget: {
            channel: body.channel_id,
            threadTs: rootTs,
            conversationId: `${body.channel_id}:${rootTs}`,
            isIm,
            convName: convInfo?.name || body.channel_name || body.channel_id,
          },
          raw: {
            ts: rootTs,
            thread_ts: rootTs,
            channel: body.channel_id,
            user: body.user_id,
            text,
          },
        };
        await onIncomingMessage(normalised);
      } catch (e) {
        logger.error('slack: slash_commands handler error', { err: e.message });
      }
    });

    await discoverBotUserId();
    await sm.start();
    logger.info('slack: ready', { botUserId });
  },

  async stop() {
    try { if (sm) await sm.disconnect(); } catch (_) {}
  },

  isAuthorized(event) {
    // event is the normalised shape
    const channel = event.replyTarget.channel;
    const text = event.text;

    // 0. Slash commands — explicit user invocation. Same allowlist as DMs.
    if (event.isSlashCommand) {
      if (config.policy.dmOpen) return true;
      return config.policy.dmAuthorizedUsers.has(event.userId);
    }

    // 1. DMs — authorised user list (or open DMs)
    if (event.isDirect) {
      if (config.policy.dmOpen) return true;
      return config.policy.dmAuthorizedUsers.has(event.userId);
    }

    // 2. Restricted channels — only respond when configured user mentions us
    const restrictedUser = config.policy.restrictedChannels.get(channel);
    if (restrictedUser !== undefined) {
      if (event.userId !== restrictedUser) return false;
      return botUserId && text.includes(`<@${botUserId}>`);
    }

    // 3. Mention channels — respond on @-mention
    if (config.policy.mentionChannels.has(channel)) {
      return botUserId && text.includes(`<@${botUserId}>`);
    }

    return false;
  },

  async fetchContext(event) {
    // Slash commands have no prior conversation — synthesise a one-message
    // context from the command text so the prompt stays clean (no bot echo
    // leaking into the transcript).
    if (event.isSlashCommand) {
      return {
        messages: [{ user: event.userId, ts: event.messageId, text: event.text }],
        replyTargetTs: event.messageId,
        convName: event.replyTarget.convName,
        isIm: event.replyTarget.isIm,
        attachments: [],
      };
    }

    const { channel, threadTs, isIm, convName } = event.replyTarget;
    const inExistingThread = !!event.raw.thread_ts;

    let messages;
    try {
      if (inExistingThread) {
        const r = await web.conversations.replies({
          channel, ts: threadTs, limit: config.context.threadFetchLimit,
        });
        messages = (r.messages || []).slice(-config.context.threadFetchLimit);
      } else {
        const r = await web.conversations.history({
          channel, limit: config.context.channelFetchLimit,
        });
        messages = (r.messages || []).slice().reverse();
      }
    } catch (e) {
      logger.warn('slack: failed to fetch context', { err: e.message });
      messages = [event.raw];
    }

    // Download any files attached to the triggering message so claude can
    // Read them locally. We only download files attached to THIS message,
    // not the entire thread history (would be wasteful).
    const attachments = await downloadAttachments(event.files || [], event.messageId);

    return {
      messages,
      replyTargetTs: event.messageId,
      convName,
      isIm,
      attachments,
    };
  },

  async postPlaceholder(replyTarget, text) {
    const isThinking = typeof text === 'string' && /^_(💭|.*thinking).*_$/i.test(text.trim());
    // DMs: try the typing-indicator shimmer (assistant.threads.setStatus).
    // If the app doesn't have the assistant:write scope, that call fails
    // and we fall back to posting a normal placeholder.
    if (replyTarget.isIm && isThinking) {
      try {
        await web.assistant.threads.setStatus({
          channel_id: replyTarget.channel,
          thread_ts: replyTarget.threadTs,
          status: 'thinking…',
        });
        return {
          surface: 'slack',
          channel: replyTarget.channel,
          ts: null,
          threadTs: replyTarget.threadTs,
          conversationId: replyTarget.conversationId,
          shimmer: true,
        };
      } catch (e) {
        logger.debug('slack: shimmer unavailable, using placeholder', { err: e.message });
      }
    }
    const r = await web.chat.postMessage({
      channel: replyTarget.channel,
      text,
      thread_ts: replyTarget.threadTs,
    });
    return {
      surface: 'slack',
      channel: replyTarget.channel,
      ts: r.ts,
      threadTs: replyTarget.threadTs,
      conversationId: replyTarget.conversationId,
    };
  },

  // Live status update during a tick. For DMs in shimmer mode, uses
  // assistant.threads.setStatus (the typing-indicator shimmer). For channels
  // and oversized cases, falls back to editing the placeholder message.
  async setStatus(handle, text) {
    if (!handle || !handle.shimmer) {
      return this.updateMessage(handle, text);
    }
    try {
      await web.assistant.threads.setStatus({
        channel_id: handle.channel,
        thread_ts: handle.threadTs,
        status: typeof text === 'string' ? text.slice(0, 250) : '',
      });
    } catch (e) {
      logger.debug('slack: assistant.threads.setStatus failed', { err: e.message });
    }
  },

  async updateMessage(handle, text) {
    if (!handle || !handle.channel) return;

    // Shimmer-mode handle (DM): clear the status and post the final reply
    // as a fresh threaded message.
    if (handle.shimmer) {
      try {
        await web.assistant.threads.setStatus({
          channel_id: handle.channel,
          thread_ts: handle.threadTs,
          status: '',
        });
      } catch (_) {}
      try {
        await web.chat.postMessage({
          channel: handle.channel,
          thread_ts: handle.threadTs,
          text,
        });
      } catch (e) {
        logger.warn('slack: chat.postMessage (shimmer final) failed', { err: e.message });
      }
      return;
    }

    if (!handle.ts) return;
    try {
      await web.chat.update({ channel: handle.channel, ts: handle.ts, text });
    } catch (e) {
      // Don't crash on rate limits or transient failures — the next update
      // will retry.
      logger.debug('slack: chat.update failed', { err: e.message });
    }
  },

  formatPromptHints() {
    return `Surface formatting hints (Slack):
- Use Slack markdown: *bold* (single asterisks), _italic_, ~strike~, \`inline code\`, triple backticks for code blocks
- Mention users with <@USER_ID>, channels with <#CHANNEL_ID|name>, links with <url|display text>
- No # headings — use *Bold Title* on its own line
- Lists with • or -
- This message will be sent into a thread`;
  },
};

export default slackSurface;
