// WhatsApp surface adapter — wraps Baileys behind the surface contract.
//
// First-run flow:
//   1. yoda.service starts; this surface has no saved auth state
//   2. Baileys generates a QR code, we render it as ASCII to the log
//   3. Stu opens WhatsApp → Settings → Linked Devices → Link a Device → scan
//   4. Baileys writes session creds to ./state/whatsapp-auth/
//   5. Subsequent restarts reuse the saved session
//
// Session lifetime: ~14 days. WhatsApp may unpair the device if your phone
// is offline for too long, requiring a fresh QR scan.
//
// Implements the lib/surface.js contract.

import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode';
import { mkdirSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../logger.js';

let sock = null;
let onMessageCallback = null;
let myJid = null;        // our own phone-based JID
let myLid = null;        // our own LID (linked-identity) JID — used by self-chat
let reconnectTimer = null;
let stopping = false;

// Silent Baileys logger (it's chatty otherwise)
const baileysLog = pino({ level: 'silent' });

// ─── helpers ───────────────────────────────────────────────────────────────

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function jidToPhone(jid) {
  // Strip the @s.whatsapp.net or :NN@s.whatsapp.net suffix and the device part
  if (!jid) return '';
  return jid.split('@')[0].split(':')[0];
}

function extractText(message) {
  if (!message) return '';
  // Various message types Baileys delivers — pull text from whichever is set
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    ''
  );
}

/**
 * Convert a Baileys messages.upsert event into the normalised event shape.
 */
function normalize(msg) {
  if (!msg || !msg.message) return null;

  const remoteJid = msg.key.remoteJid;
  if (!remoteJid) return null;

  // Filter out our own outbound messages — UNLESS this is the user's
  // "Message Yourself" self-chat, which is the canonical way to talk to a
  // personal Baileys-based bot when Yoda is linked to your own WhatsApp
  // account. WhatsApp self-chats use a LID-style JID (e.g. "26125...@lid"),
  // distinct from the phone-number JID, so we compare against both.
  if (msg.key.fromMe) {
    const myBarePhone = (myJid || '').split(':')[0].split('@')[0];
    const myBareLid = (myLid || '').split(':')[0].split('@')[0];
    const remoteBare = remoteJid.split('@')[0];
    const isSelfChat =
      (myBarePhone && remoteBare === myBarePhone) ||
      (myBareLid && remoteBare === myBareLid);
    if (!isSelfChat) return null;
  }

  // Sender phone — for groups, the participant; for 1:1 messages the
  // remoteJid IS the sender. For our own fromMe messages (self-chat), the
  // sender is us, so use our phone-based JID rather than the opaque LID.
  let senderPhone;
  if (msg.key.fromMe) {
    senderPhone = jidToPhone(myJid || '');
  } else if (isGroupJid(remoteJid)) {
    senderPhone = jidToPhone(msg.key.participant || msg.participant || remoteJid);
  } else {
    senderPhone = jidToPhone(remoteJid);
  }

  const text = extractText(msg.message);
  if (!text) return null;

  const isDirect = !isGroupJid(remoteJid);
  // WhatsApp doesn't have @-mentions in the structured way Slack does, but
  // Baileys exposes mentionedJid in extendedTextMessage. We treat any mention
  // of our own jid as an @-mention.
  const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const isMention = myJid ? mentioned.includes(myJid) : false;

  return {
    surface: 'whatsapp',
    userId: senderPhone,
    conversationId: `wa:${remoteJid}`,
    messageId: msg.key.id,
    text,
    isDirect,
    isMention,
    replyTarget: {
      jid: remoteJid,
      conversationId: `wa:${remoteJid}`,
      isGroup: isGroupJid(remoteJid),
    },
    raw: msg,
  };
}

// ─── connection lifecycle ──────────────────────────────────────────────────

async function connect() {
  // Ensure auth dir exists
  const authDir = config.whatsapp.authDir;
  mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // Fetch the current WhatsApp Web protocol version from Baileys' public
  // version endpoint. Without this, Baileys uses a baked-in version that
  // becomes stale and gets rejected by WhatsApp with HTTP 405.
  let version;
  try {
    const v = await fetchLatestBaileysVersion();
    version = v.version;
    logger.info('whatsapp: using WA web version', { version: version.join('.'), isLatest: v.isLatest });
  } catch (e) {
    logger.warn('whatsapp: failed to fetch latest version, using default', { err: e.message });
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger: baileysLog,
    browser: Browsers.macOS('Yoda'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // If we have no creds and a pairing phone is configured, request a pairing
  // code from WhatsApp. The user types it into WhatsApp → Settings →
  // Linked Devices → Link a Device → "Link with phone number instead".
  let pairingRequested = false;
  const tryRequestPairing = async () => {
    if (pairingRequested) return;
    if (sock.authState.creds.registered) return;
    if (!config.whatsapp.pairingPhone) return;
    pairingRequested = true;
    try {
      // Tiny delay to let the socket settle before requesting
      await new Promise((r) => setTimeout(r, 1500));
      const code = await sock.requestPairingCode(config.whatsapp.pairingPhone);
      // Format as XXXX-XXXX for readability
      const formatted = code.match(/.{1,4}/g)?.join('-') || code;
      logger.info('whatsapp: PAIRING CODE READY', { code: formatted });
      logger.info('whatsapp: open WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number instead → enter this code');
    } catch (e) {
      logger.error('whatsapp: requestPairingCode failed', { err: e.message });
      pairingRequested = false; // allow retry
    }
  };

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Render the QR as a high-resolution PNG so it can be scanned cleanly.
      // Lives in the workspace state dir so the IDE file browser can open it.
      const out = './state/whatsapp-qr.png';
      qrcode.toFile(out, qr, { width: 512, margin: 2 })
        .then(() => logger.info('whatsapp: QR PNG written', { path: out, length: qr.length }))
        .catch((e) => logger.error('whatsapp: QR PNG write failed', { err: e.message }));
    }

    // On 'connecting', request a pairing code if we need one
    if (connection === 'connecting') {
      tryRequestPairing().catch(() => {});
    }

    if (connection === 'open') {
      myJid = sock.user?.id || null;
      myLid = sock.user?.lid || null;
      logger.info('whatsapp: connected', { jid: myJid, lid: myLid });
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      logger.warn('whatsapp: connection closed', { code, loggedOut });

      if (stopping) return;

      if (loggedOut) {
        logger.error('whatsapp: logged out — auth state is stale, delete ./state/whatsapp-auth and re-pair');
        return;
      }

      // Reconnect with backoff
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        logger.info('whatsapp: reconnecting…');
        connect().catch((e) => logger.error('whatsapp: reconnect failed', { err: e.message }));
      }, 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        const normalised = normalize(msg);
        if (normalised && onMessageCallback) {
          await onMessageCallback(normalised);
        }
      } catch (e) {
        logger.error('whatsapp: message handler error', { err: e.message });
      }
    }
  });
}

// ─── surface contract ──────────────────────────────────────────────────────

const whatsappSurface = {
  name: 'whatsapp',

  async start(onIncomingMessage) {
    onMessageCallback = onIncomingMessage;
    await connect();
    logger.info('whatsapp: surface started');
  },

  async stop() {
    stopping = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (sock) {
      try { sock.end(); } catch (_) {}
      sock = null;
    }
  },

  isAuthorized(event) {
    // 1. Groups: only allowed if explicitly listed
    if (event.replyTarget.isGroup) {
      return config.whatsapp.allowedGroups.has(event.replyTarget.jid);
    }
    // 2. DMs: only authorised users
    return config.whatsapp.authorizedUsers.has(event.userId);
  },

  async fetchContext(event) {
    // WhatsApp doesn't expose a "fetch last N messages" API the way Slack does
    // (Baileys can only see messages it has received in-session). For now,
    // context is just the current message itself. Future improvement: keep an
    // in-memory ring buffer of recent messages per chat.
    return {
      messages: [{
        user: event.userId,
        ts: event.messageId,
        text: event.text,
      }],
      replyTargetTs: event.messageId,
      convName: jidToPhone(event.replyTarget.jid),
      isIm: !event.replyTarget.isGroup,
    };
  },

  async postPlaceholder(replyTarget, text) {
    if (!sock) throw new Error('whatsapp: not connected');
    // Strip Slack-style underscores so the placeholder looks right on WA
    const waText = text.replace(/^_(.*)_$/, '_$1_');  // WA also supports _italic_
    const sent = await sock.sendMessage(replyTarget.jid, { text: waText });
    return {
      surface: 'whatsapp',
      jid: replyTarget.jid,
      key: sent.key,
      conversationId: replyTarget.conversationId,
    };
  },

  async updateMessage(handle, text) {
    if (!sock || !handle) return;
    try {
      // Baileys protocolMessage edit — works within ~15 min of original send
      await sock.sendMessage(handle.jid, { text, edit: handle.key });
    } catch (e) {
      logger.debug('whatsapp: edit failed', { err: e.message });
    }
  },

  formatPromptHints() {
    return `Surface formatting hints (WhatsApp):
- WhatsApp markdown: *bold* (single asterisks), _italic_, ~strike~, \`inline code\`, triple backticks for code blocks
- Plain URLs only — WhatsApp does not support <url|text> link syntax
- No @-mentions of users in the Slack <@USER_ID> form
- Keep replies tight; long messages are awkward to read on mobile
- This message will be sent as a normal WhatsApp message (no threads in WhatsApp)`;
  },
};

export default whatsappSurface;
