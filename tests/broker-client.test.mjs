// broker-client.js — the supervisor's JS client for the broker unix socket.
// Exercised against a mock broker that speaks the real framing. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeFrame, FrameDecoder } from '../workspace/broker/framing.js';
import { brokerCall, brokerCallOrThrow, brokerAvailable } from '../workspace/lib/broker-client.js';

// Spin up a mock broker on a temp unix socket. `handler(request)` returns the
// reply object to frame back (or null to hang, for timeout tests).
function mockBroker(handler) {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-brk-')), 'b.sock');
  const server = net.createServer((conn) => {
    const dec = new FrameDecoder();
    conn.on('data', (chunk) => {
      let frames;
      try { frames = dec.push(chunk); } catch { conn.destroy(); return; }
      for (const req of frames) {
        const reply = handler(req);
        if (reply !== null && reply !== undefined) conn.write(encodeFrame(reply));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(sock, () => resolve({ sock, close: () => new Promise((r) => server.close(r)) }));
  });
}

test('brokerCall: round-trips a request and returns the reply frame verbatim', async () => {
  const seen = [];
  const b = await mockBroker((req) => {
    seen.push(req);
    return { t: 'result', ok: true, data: { echoTool: req.tool, echoArgs: req.args } };
  });
  try {
    const reply = await brokerCall('googlechat_send', { space: 'spaces/AAA', text: 'hi' }, { sock: b.sock });
    assert.equal(reply.ok, true);
    assert.equal(reply.data.echoTool, 'googlechat_send');
    assert.deepEqual(reply.data.echoArgs, { space: 'spaces/AAA', text: 'hi' });
    // the request the broker actually received
    assert.equal(seen[0].t, 'call');
    assert.equal(seen[0].tool, 'googlechat_send');
  } finally {
    await b.close();
  }
});

test('brokerCall: a tool-level {ok:false} resolves (does not reject); brokerCallOrThrow throws', async () => {
  const b = await mockBroker(() => ({ t: 'result', ok: false, error: 'no such space' }));
  try {
    const reply = await brokerCall('googlechat_send', {}, { sock: b.sock });
    assert.equal(reply.ok, false);
    assert.equal(reply.error, 'no such space');
    await assert.rejects(() => brokerCallOrThrow('googlechat_send', {}, { sock: b.sock }), /no such space/);
  } finally {
    await b.close();
  }
});

test('brokerCall: rejects on timeout when the broker never replies', async () => {
  const b = await mockBroker(() => null); // accept, never answer
  try {
    await assert.rejects(
      () => brokerCall('slow', {}, { sock: b.sock, timeoutMs: 150 }),
      /timed out after 150ms/,
    );
  } finally {
    await b.close();
  }
});

test('brokerCall: rejects cleanly when the socket does not exist', async () => {
  await assert.rejects(
    () => brokerCall('x', {}, { sock: '/nonexistent/yc-broker.sock', timeoutMs: 1000 }),
    /broker socket error/,
  );
});

test('brokerCall: reassembles a reply split across TCP chunks', async () => {
  // Send the reply frame one byte at a time to prove the FrameDecoder buffering works.
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-brk-'));
  const sock = path.join(sockDir, 'b.sock');
  const server = net.createServer((conn) => {
    const dec = new FrameDecoder();
    conn.on('data', (chunk) => {
      const frames = dec.push(chunk);
      if (frames.length) {
        const buf = encodeFrame({ t: 'result', ok: true, data: { chunked: true } });
        for (const byte of buf) conn.write(Buffer.from([byte]));
      }
    });
  });
  await new Promise((r) => server.listen(sock, r));
  try {
    const reply = await brokerCall('x', {}, { sock });
    assert.equal(reply.data.chunked, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('brokerAvailable reflects socket existence', async () => {
  assert.equal(brokerAvailable('/nonexistent/nope.sock'), false);
  const b = await mockBroker(() => ({ ok: true }));
  try {
    assert.equal(brokerAvailable(b.sock), true);
  } finally {
    await b.close();
  }
});
