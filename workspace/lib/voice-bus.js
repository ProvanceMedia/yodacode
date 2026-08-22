// Voice transport bus — the seam between the WebSocket endpoint (ui/server.js)
// and the voice surface (lib/surfaces/voice.js).
//
// The two can't import each other directly: the UI server is always loaded,
// while a surface is only imported when its name is in YODA_SURFACES. A static
// import either way would either drag the surface in when voice is disabled or
// make the endpoint depend on load order. So both talk to this instead — the
// surface ATTACHES a handler when it starts, the endpoint routes sockets here,
// and with no surface attached the endpoint can refuse a connection with an
// honest reason instead of accepting one nobody is listening to.
//
// Nothing here knows about audio. The client transcribes speech itself and
// sends text, so this carries small JSON messages in both directions.

import { logger } from './logger.js';

/** @typedef {{ id: string, send: (msg: object) => void, close: (code?: number, reason?: string) => void }} VoiceClient */

/** @type {Set<VoiceClient>} */
const clients = new Set();

/** @type {null | ((utterance: { text: string, clientId: string }) => Promise<void>)} */
let handler = null;

let clientSeq = 0;

export const voiceBus = {
  /** True once the voice surface has started and is ready to accept utterances. */
  isReady() {
    return handler !== null;
  },

  /**
   * Called by the voice surface on start(). The handler receives each utterance
   * a client sends and is responsible for turning it into a dispatcher event.
   */
  attach(fn) {
    handler = fn;
  },

  /**
   * Called by the voice surface on stop(). Detaching first, then closing, means
   * a client that reconnects during shutdown gets refused rather than accepted
   * into a bus with no listener.
   */
  detach() {
    handler = null;
    for (const c of [...clients]) {
      try { c.close(1001, 'server shutting down'); } catch (_) { /* already gone */ }
    }
    clients.clear();
  },

  /** Register a connected client. Returns the id used in logs. */
  addClient(client) {
    client.id = client.id || `vc-${++clientSeq}`;
    clients.add(client);
    logger.info('voice: client connected', { clientId: client.id, clients: clients.size });
    return client.id;
  },

  removeClient(client) {
    if (clients.delete(client)) {
      logger.info('voice: client disconnected', { clientId: client.id, clients: clients.size });
    }
  },

  clientCount() {
    return clients.size;
  },

  /**
   * Hand an utterance to the surface. Returns false when no surface is attached
   * so the caller can tell the client rather than dropping it silently.
   */
  async submit(utterance) {
    if (!handler) return false;
    await handler(utterance);
    return true;
  },

  /**
   * Send a message to every connected client. Broadcast rather than addressed:
   * a spoken answer should reach whichever device you're actually near, and the
   * install is single-user by construction (one token, one asserted user id).
   * A send that throws must never take down a turn — a dead socket is the
   * client's problem to recover from, not a reason to fail the reply.
   */
  broadcast(msg) {
    let delivered = 0;
    for (const c of [...clients]) {
      try {
        c.send(msg);
        delivered++;
      } catch (e) {
        logger.debug('voice: send failed, dropping client', { clientId: c.id, err: e.message });
        clients.delete(c);
      }
    }
    return delivered;
  },
};
