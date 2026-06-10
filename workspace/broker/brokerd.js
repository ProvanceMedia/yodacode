#!/usr/bin/env node
// yodacode-brokerd — the long-lived host-side credential broker.
//
// Runs as root (it reads the vault: the project .env + any vault file). Listens on a Unix
// domain socket and answers length-prefixed NDJSON requests from the `broker` CLI that
// the (de-rooted) agent runs. The broker holds every secret in memory and performs the
// outbound authenticated call itself; the agent only ever sees the response body.
//
// Requests (one frame each):
//   { t: 'call',     tool, args }   -> { t: 'result', ok, data?, error? }
//   { t: 'manifest' }               -> { t: 'manifest', tools: [...] }
//   { t: 'status' }                 -> { t: 'status', ... }
//   { t: 'reload' }                 -> { t: 'result', ok: true }   (re-read vault/config)
//   { t: 'ping' }                   -> { t: 'pong' }
//
// Socket path: $YODA_BROKER_SOCK (default /run/yodacode-broker.sock).
// Socket perms: 0660, group `yodacode` (so the agent user, a member of `yodacode`, can
// connect — but cannot read the vault files, which stay root:root 0600).
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { FrameDecoder, encodeFrame } from './framing.js';
import { initBroker, reloadAll, handleMediatedCall, allMediatedManifest, brokerStatus } from './index.js';

const SOCK = process.env.YODA_BROKER_SOCK || '/run/yodacode-broker.sock';
const SOCK_GROUP = process.env.YODA_BROKER_GROUP || 'yodacode';

function log(...a) {
  console.error(`[brokerd ${new Date().toISOString()}]`, ...a);
}

function chgrpSocket() {
  // Make the socket group-owned by the broker group and mode 0660 so the agent user can
  // connect without being able to read it as world. Best-effort: if the group does
  // not exist yet (pre-de-rooting), fall back to leaving default perms and warn.
  try {
    fs.chmodSync(SOCK, 0o660);
  } catch (e) {
    log('warn: chmod socket failed:', e?.message ?? e);
  }
  try {
    execFileSync('chgrp', [SOCK_GROUP, SOCK]);
  } catch (e) {
    log(`warn: chgrp ${SOCK_GROUP} socket failed (group may not exist yet):`, e?.message ?? e);
  }
}

async function handleFrame(frame) {
  if (!frame || typeof frame !== 'object') return { t: 'result', ok: false, error: 'bad frame' };
  switch (frame.t) {
    case 'ping':
      return { t: 'pong' };
    case 'status':
      return { t: 'status', ...brokerStatus() };
    case 'manifest':
      return { t: 'manifest', tools: allMediatedManifest() };
    case 'reload':
      reloadAll();
      log('vault/config reloaded:', JSON.stringify(brokerStatus()));
      return { t: 'result', ok: true };
    case 'call': {
      const tool = String(frame.tool ?? '');
      const args = frame.args && typeof frame.args === 'object' ? frame.args : {};
      const res = await handleMediatedCall(tool, args);
      return { t: 'result', ...res };
    }
    default:
      return { t: 'result', ok: false, error: `unknown request type: ${frame.t}` };
  }
}

function onConnection(sock) {
  const dec = new FrameDecoder();
  sock.on('data', (chunk) => {
    let frames;
    try {
      frames = dec.push(chunk);
    } catch (e) {
      sock.end(encodeFrame({ t: 'result', ok: false, error: `frame decode error: ${e?.message ?? e}` }));
      return;
    }
    for (const frame of frames) {
      handleFrame(frame)
        .then((reply) => {
          if (sock.writable) sock.write(encodeFrame(reply));
        })
        .catch((e) => {
          if (sock.writable) sock.write(encodeFrame({ t: 'result', ok: false, error: String(e?.message ?? e) }));
        });
    }
  });
  sock.on('error', () => {
    /* client vanished mid-call — ignore */
  });
}

function start() {
  initBroker();
  log('vault unsealed:', JSON.stringify(brokerStatus()));

  // Stale socket from a previous run blocks bind; remove it (only ours, in /run).
  try {
    if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK);
  } catch (e) {
    log('warn: could not remove stale socket:', e?.message ?? e);
  }

  const server = net.createServer(onConnection);
  server.on('error', (e) => {
    log('server error:', e?.message ?? e);
    process.exit(1);
  });
  server.listen(SOCK, () => {
    chgrpSocket();
    log(`listening on ${SOCK} (user ${os.userInfo().username})`);
  });

  const shutdown = () => {
    try {
      server.close();
      if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK);
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', () => {
    reloadAll();
    log('SIGHUP: reloaded', JSON.stringify(brokerStatus()));
  });
}

start();
