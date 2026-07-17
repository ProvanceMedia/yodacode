// Supervisor-side JS client for the yodacode broker socket — the mirror of
// bin/_broker_client.py (which the de-rooted agent's shell tools use). The
// resident supervisor (yoda.js) uses this to route a credentialed call through
// the host-side broker WITHOUT holding the secret itself: connect to the unix
// socket, send one length-prefixed {t:'call',tool,args} frame, read one reply
// frame. It reuses the broker's own framing (broker/framing.js) so the wire
// format can never drift between the two ends.
//
// This is foundational plumbing: a push-based surface can deliver outbound via a
// broker-mediated tool (keeping the service key in the broker, not the agent),
// and it's the JS half of the broker protocol the supervisor previously never
// needed (Slack holds its own token, so it never called the broker).
import net from 'node:net';
import fs from 'node:fs';
import { encodeFrame, FrameDecoder } from '../broker/framing.js';

export const DEFAULT_BROKER_SOCK = process.env.YODA_BROKER_SOCK || '/run/yodacode-broker.sock';
// Matches the Python client's default. NOTE: this is BELOW some broker per-tool
// ceilings (ssh_exec is 310s; http_call can reach ~303s) — for a tool that can
// legitimately run longer than this, pass an explicit larger `timeoutMs`, or this
// single wall-clock cutoff will pre-empt a still-valid reply. It comfortably covers
// the common tools (slack_upload 130s and the 18s default).
export const DEFAULT_TIMEOUT_MS = 140_000;

/** True if the broker socket file exists (a cheap pre-check, not a liveness guarantee). */
export function brokerAvailable(sock = DEFAULT_BROKER_SOCK) {
  try {
    return fs.existsSync(sock);
  } catch {
    return false;
  }
}

/**
 * Call a broker tool over the unix socket. Resolves with the raw reply object
 * ({ t:'result', ok, data|error }) — mirroring the Python client, so callers
 * inspect `.ok` themselves. Rejects ONLY on a transport failure (no socket,
 * closed early, timeout, undecodable frame), never on a tool-level {ok:false}.
 */
export function brokerCall(tool, args = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, sock = DEFAULT_BROKER_SOCK } = {}) {
  return new Promise((resolve, reject) => {
    const decoder = new FrameDecoder();
    let settled = false;
    let socket = null;
    let timer = null;

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (socket) {
        try { socket.destroy(); } catch { /* already gone */ }
      }
      err ? reject(err) : resolve(val);
    };

    timer = setTimeout(
      () => finish(new Error(`broker call '${tool}' timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    socket = net.createConnection(sock);
    socket.on('connect', () => {
      try {
        socket.write(encodeFrame({ t: 'call', tool: String(tool), args: args ?? {} }));
      } catch (e) {
        finish(new Error(`broker write failed: ${e?.message ?? e}`));
      }
    });
    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (e) {
        return finish(new Error(`broker frame decode failed: ${e?.message ?? e}`));
      }
      if (frames.length) finish(null, frames[0]); // exactly one reply frame per call
    });
    socket.on('error', (e) => finish(new Error(`broker socket error: ${e?.message ?? e}`)));
    socket.on('close', () => finish(new Error('broker closed the connection before replying')));
  });
}

/**
 * Convenience wrapper that THROWS on a tool-level failure. Use where you just
 * want the data and treat {ok:false} as an error (e.g. an outbound send that
 * must surface a failure to the caller). Returns the reply's `data`.
 */
export async function brokerCallOrThrow(tool, args = {}, opts = {}) {
  const reply = await brokerCall(tool, args, opts);
  if (!reply || reply.ok !== true) {
    throw new Error(`broker tool '${tool}' failed: ${reply?.error ?? 'unknown error'}`);
  }
  return reply.data;
}
