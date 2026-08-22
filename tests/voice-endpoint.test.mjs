// Voice WebSocket endpoint — the parts the unit tests can't reach: the shared
// upgrade router, the handshake, and a whole spoken turn driven the way the
// dispatcher drives one. This boots the real UI server on a throwaway port.
// Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

// Node's own global WebSocket (undici), not the `ws` package: the runtime deps
// live in workspace/node_modules and aren't resolvable from here, and the rest
// of this suite is dependency-free too.
//
// That global landed unflagged in Node 22.4, but the root package.json still
// declares engines >=20 (the Docker image is node:22, so the deployed runtime
// is fine either way). Rather than fail confusingly for a contributor on Node
// 20, the socket tests skip themselves there and say why. The HTTP tests below
// have no such dependency and always run.
const NO_WS = typeof WebSocket === 'undefined';
const wsOnly = { skip: NO_WS && 'needs the global WebSocket from Node 22.4+' };

const PORT = 7890 + (process.pid % 900) + 1;
const ROOT = path.join(os.tmpdir(), `yc-voice-ep-${process.pid}`);
const STATE_DIR = path.join(ROOT, 'state');
// ui/server.js derives its log dir as <config.workspace>/../logs, so pointing
// the workspace inside the throwaway tree keeps the real repo untouched.
const LOGS_DIR = path.join(ROOT, 'logs');

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(STATE_DIR, { recursive: true });
process.env.YODA_WORKSPACE = path.join(ROOT, 'workspace');
process.env.YODA_STATE_DIR = STATE_DIR;
process.env.YODA_UI_PORT = String(PORT);
process.env.YODA_UI_PASS = '';           // the logs socket's own auth is tested separately
process.env.YODA_VOICE_TOKEN = 'good-token';
process.env.YODA_VOICE_USER_ID = 'voice-owner';
process.env.YODA_VOICE_WAKE_WORDS = 'hey yoda,ok yoda';
process.env.YODA_VOICE_MIC_MODE = 'hotkey';

const { startUI, stopUI } = await import('../workspace/ui/server.js');
const { default: surface } = await import('../workspace/lib/surfaces/voice.js');

// Every event the surface hands to the dispatcher lands here. The handler below
// stands in for dispatcher.processReply: it posts the placeholder the same way,
// so the ack really does travel over the socket rather than being faked.
const received = [];
let pendingHandle = null;

async function fakeDispatcher(event) {
  received.push(event);
  // processReply's step 5, verbatim in shape: the opening phrase is a generic
  // status word and the surface is expected to ignore it in favour of the echo.
  pendingHandle = await surface.postPlaceholder(event.replyTarget, 'on it', { working: true });
}

const url = (p, token) => `ws://127.0.0.1:${PORT}${p}${token ? `?token=${token}` : ''}`;

/** Open a socket and collect what the server sends, until `until` says stop. */
function collect(wsUrl, { until, timeoutMs = 3000, onOpen } = {}) {
  return new Promise((resolve) => {
    const msgs = [];
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) { /* already closing */ }
      resolve({ msgs, ...extra });
    };
    const timer = setTimeout(() => finish({}), timeoutMs);
    ws.addEventListener('open', () => { if (onOpen) onOpen(ws); });
    ws.addEventListener('message', async (ev) => {
      let m;
      try { m = JSON.parse(String(ev.data)); } catch { m = { raw: String(ev.data) }; }
      msgs.push(m);
      if (until && await until(m, msgs, ws)) finish({});
    });
    ws.addEventListener('close', (ev) => finish({ code: ev.code, reason: ev.reason }));
    ws.addEventListener('error', () => { /* close always follows */ });
  });
}

before(async () => {
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(path.join(LOGS_DIR, 'yoda.log'), 'existing line\n');
  startUI();
  await new Promise((r) => setTimeout(r, 150));
  // The "refuses before the surface is running" test starts it in-line, but it
  // is skipped without a global WebSocket — so start it here too when the
  // socket tests won't. Idempotent either way.
  if (NO_WS) await surface.start(fakeDispatcher);
});

after(async () => {
  await surface.stop();
  stopUI();
  rmSync(ROOT, { recursive: true, force: true });
});

// ─── handshake ──────────────────────────────────────────────────────────────

test('the socket refuses a connection before the voice surface is running', wsOnly, async () => {
  const { code } = await collect(url('/ws/voice', 'good-token'));
  assert.equal(code, 4004, 'told plainly that voice is not enabled, not left hanging');
});

test('a wrong token is rejected once the surface IS running', wsOnly, async () => {
  await surface.start(fakeDispatcher);
  const { code } = await collect(url('/ws/voice', 'wrong-token'));
  assert.equal(code, 4001);
});

test('a missing token is rejected', wsOnly, async () => {
  const { code } = await collect(url('/ws/voice'));
  assert.equal(code, 4001);
});

test('a good token gets the wake words the server is configured with', wsOnly, async () => {
  const { msgs } = await collect(url('/ws/voice', 'good-token'), {
    until: (m) => m.type === 'ready',
  });
  assert.equal(msgs[0].type, 'ready');
  assert.deepEqual(msgs[0].wakeWords, ['hey yoda', 'ok yoda']);
  // The client needs the mode at handshake: in 'hotkey' it must not start the
  // microphone at all, so this cannot wait for a later message.
  assert.equal(msgs[0].micMode, 'hotkey');
});

// ─── upgrade routing (the refactor's real risk) ─────────────────────────────

test('the logs socket still works after the noServer refactor', wsOnly, async () => {
  const { msgs } = await collect(`ws://127.0.0.1:${PORT}/ws/logs?log=yoda.log`, {
    until: (m) => Boolean(m.raw),
    timeoutMs: 2500,
  });
  assert.ok(msgs.some((m) => (m.raw || '').includes('existing line')),
    'tail -f still streams — the second WSS did not steal its upgrades');
});

test('an unknown websocket path is refused, not routed to either endpoint', wsOnly, async () => {
  const res = await collect(`ws://127.0.0.1:${PORT}/ws/nope`, { timeoutMs: 1500 });
  assert.equal(res.msgs.length, 0);
});

// ─── a whole spoken turn ────────────────────────────────────────────────────

test('a spoken turn: ack immediately, tool chatter never, answer at the end', wsOnly, async () => {
  received.length = 0;

  const result = await collect(url('/ws/voice', 'good-token'), {
    timeoutMs: 5000,
    onOpen: (ws) => ws.send(JSON.stringify({ type: 'utterance', text: 'check whether the sync ran' })),
    until: async (m) => {
      if (m.type !== 'ack') return false;
      // The ack is out. Now drive the rest of the turn exactly as the
      // dispatcher does: status writes through updateMessage (because this
      // surface has no setStatus), then the final reply.
      const handle = pendingHandle;
      await surface.updateMessage(handle, '_calling api.hubapi.com_', { status: true });
      await surface.updateMessage(handle, '_reading SOUL.md_', { status: true });
      await surface.updateMessage(handle, '**Yes** — it ran at `09:14`, no errors.');
      return false; // let the timeout collect everything that follows
    },
  });

  const types = result.msgs.map((m) => m.type);
  assert.deepEqual(types, ['ready', 'ack', 'speak'],
    'exactly three messages: no status ever reached the client');

  const ack = result.msgs.find((m) => m.type === 'ack');
  assert.equal(ack.text, 'Got it: check whether the sync ran', 'verbatim echo of what was heard');

  const spoken = result.msgs.find((m) => m.type === 'speak');
  assert.equal(spoken.text, 'Yes — it ran at 09:14, no errors.', 'shaped for the ear');

  assert.equal(received.length, 1, 'the utterance reached the dispatcher once');
  assert.equal(received[0].surface, 'voice');
  assert.equal(received[0].conversationId, 'voice:voice-owner');
  assert.equal(received[0].text, 'check whether the sync ran');
});

// ─── hostile input ──────────────────────────────────────────────────────────

test('malformed and unknown messages are answered, not crashed on', wsOnly, async () => {
  const res = await collect(url('/ws/voice', 'good-token'), {
    timeoutMs: 1500,
    onOpen: (ws) => {
      ws.send('not json at all');
      ws.send(JSON.stringify({ type: 'nonsense' }));
      ws.send(JSON.stringify({ type: 'utterance', text: '   ' }));
      ws.send(JSON.stringify({ type: 'ping' }));
    },
  });
  const types = res.msgs.map((m) => m.type);
  assert.ok(types.includes('error'), 'malformed JSON gets an error back');
  assert.ok(types.includes('pong'), 'and the socket is still alive afterwards');
});

test('a client that goes away is removed from the bus', wsOnly, async () => {
  const { voiceBus } = await import('../workspace/lib/voice-bus.js');

  // Sockets from earlier tests close asynchronously; wait for the bus to settle
  // so this measures its own client and not the tail of someone else's.
  const settle = async () => {
    for (let i = 0; i < 40 && voiceBus.clientCount() > 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return voiceBus.clientCount();
  };
  assert.equal(await settle(), 0, 'no client leaked from the earlier tests');

  const ws = new WebSocket(url('/ws/voice', 'good-token'));
  await new Promise((r) => ws.addEventListener('open', r));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(voiceBus.clientCount(), 1);

  ws.close();
  assert.equal(await settle(), 0, 'the client was removed on close');
});

// ─── cross-site protection ──────────────────────────────────────────────────
// Publishing the dashboard port is what makes these reachable: a page the
// operator merely visits can send requests to their own machine. The browser
// won't ask permission first for a "simple" POST, and WebSockets aren't subject
// to CORS at all — so both gates have to live here.

const http = await import('node:http');

function post(pathname, body, headers = {}) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
      headers: { 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end(data);
  });
}

test('a simple-request POST is refused, so a drive-by cannot rewrite the persona', async () => {
  // text/plain needs no CORS preflight, which is exactly why it must not work.
  const res = await post('/api/memory/write',
    { path: 'MEMORY.md', content: 'pwned' }, { 'Content-Type': 'text/plain' });
  assert.equal(res.status, 415);
  assert.doesNotMatch(res.body, /"ok":true/);
});

test('a cross-origin JSON POST is refused even with the right content type', async () => {
  const res = await post('/api/memory/write',
    { path: 'MEMORY.md', content: 'pwned' },
    { 'Content-Type': 'application/json', Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});

test('the dashboard\'s own same-origin POST still works', async () => {
  const res = await post('/api/memory/write',
    { path: 'nope.txt', content: 'x' },
    { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}` });
  // Reaches the handler (which rejects the path on its own merits) rather than
  // being turned away as cross-origin.
  assert.equal(res.status, 200);
  assert.match(res.body, /only \.md files/);
});

test('a websocket upgrade from a foreign origin is refused', async () => {
  // WebSockets ignore CORS entirely, so any page could otherwise read the live
  // log stream — which has no token of its own.
  const res = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/ws/logs?log=yoda.log', method: 'GET',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        Origin: 'https://evil.example',
      },
    });
    req.on('upgrade', () => resolve('upgraded'));
    req.on('response', (r) => resolve(`http ${r.statusCode}`));
    req.on('error', () => resolve('refused'));
    req.end();
  });
  assert.notEqual(res, 'upgraded', 'a foreign origin must not get a socket');
});
