// The status channel is the single owner of a run's progress display:
// serialized writes, one heartbeat, human wording, and a close() that
// guarantees nothing lands after the reply.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStatusChannel } from '../workspace/lib/status-channel.js';
import { isGenericStatus, pickPhrase, heartbeatKind } from '../workspace/lib/status-phrases.js';

// A send that never resolves until released — lets a test hold a write
// "in flight" and prove ordering.
function gatedSend() {
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const send = async (text) => { calls.push(text); await gate; };
  return { send, calls, release: () => release() };
}

const immediate = () => {
  const calls = [];
  return { send: async (t) => { calls.push(t); }, calls };
};

test('generic phases collapse to one human phrase and cost exactly one write', async () => {
  const { send, calls } = immediate();
  const ch = createStatusChannel({ send, autoBeat: false, rand: () => 0 });
  await ch.post('thinking…');
  await ch.post('starting up…');
  await ch.post('working…');
  assert.ok(!calls.join(' ').match(/thinking|starting up|working…/), 'machine phases never reach the surface');
  assert.equal(calls.length, 1,
    'three machine phases mean the same thing — re-writing it burns a surface call and re-renders for nothing');
});

test('the opening phrase already on the placeholder is not restated', async () => {
  const { send, calls } = immediate();
  const ch = createStatusChannel({ send, autoBeat: false, openingPhrase: 'on it' });
  await ch.post('thinking…');
  assert.deepEqual(calls, [], 'the placeholder already says it — do not repaint it');
});

test('specific statuses pass through untouched — real information is never replaced', async () => {
  const { send, calls } = immediate();
  const ch = createStatusChannel({ send, autoBeat: false });
  await ch.post('reading config.js');
  await ch.post('calling api.example.com');
  assert.deepEqual(calls, ['reading config.js', 'calling api.example.com']);
});

const tick = () => new Promise((r) => setImmediate(r));

test('writes are serialized and latest-wins: a stale frame is dropped, not queued', async () => {
  const g = gatedSend();
  const ch = createStatusChannel({ send: g.send, autoBeat: false });
  ch.post('reading a.js');
  await tick();                     // writer picks it up and blocks on the gate
  assert.deepEqual(g.calls, ['reading a.js']);
  ch.post('reading b.js');          // waits — a write is in flight
  ch.post('reading c.js');          // replaces b, which is now stale
  assert.deepEqual(g.calls, ['reading a.js'], 'never two writes at once');
  g.release();
  await tick(); await tick();
  assert.deepEqual(g.calls, ['reading a.js', 'reading c.js'], 'b was superseded, never sent');
});

test('close() drops queued work rather than writing it over the reply', async () => {
  const g = gatedSend();
  const ch = createStatusChannel({ send: g.send, autoBeat: false });
  ch.post('reading a.js');
  await tick();
  ch.post('reading b.js');          // queued behind the in-flight write
  g.release();
  await ch.close();
  assert.deepEqual(g.calls, ['reading a.js'], 'the queued frame is abandoned at handover');
});

test('close() waits for the in-flight write, so a reply can never be overwritten', async () => {
  const g = gatedSend();
  const ch = createStatusChannel({ send: g.send, autoBeat: false });
  ch.post('reading a.js');
  let closed = false;
  const closing = ch.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false, 'close does not resolve while a write is in flight');
  g.release();
  await closing;
  assert.equal(closed, true);
});

test('a closed channel accepts nothing further', async () => {
  const { send, calls } = immediate();
  const ch = createStatusChannel({ send, autoBeat: false });
  await ch.close();
  await ch.post('reading late.js');
  ch.beat();
  assert.deepEqual(calls, [], 'no writes after handover');
  assert.equal(ch.closed, true);
});

test('heartbeat leads with liveness and keeps live detail alongside it', async () => {
  let t = 1_000_000;
  const { send, calls } = immediate();
  const ch = createStatusChannel({
    send, autoBeat: false, heartbeatMs: 15000, startedAt: t, now: () => t,
  });
  await ch.post('running build.sh');
  t += 20000;
  await ch.beat();
  assert.match(calls[1], /^still .* · running build\.sh$/,
    'says it is still going AND what it is waiting on');
});

test('a finished tool is never left ticking as if it were the current state', async () => {
  let t = 1_000_000;
  const { send, calls } = immediate();
  const ch = createStatusChannel({
    send, autoBeat: false, heartbeatMs: 15000, startedAt: t, now: () => t,
  });
  await ch.post('reading config.js ✓');   // the tool returned
  t += 20000;
  await ch.beat();
  assert.ok(!calls[1].includes('reading config.js'),
    'a completed action paired with a growing clock reads as stuck');
  assert.match(calls[1], /still/);
});

test('wording follows elapsed time, never the moment it was first picked', async () => {
  let t = 1_000_000;
  const { send, calls } = immediate();
  const ch = createStatusChannel({
    send, autoBeat: false, heartbeatMs: 15000, startedAt: t, now: () => t,
  });
  await ch.post('thinking…');
  assert.ok(!/still/.test(calls[0]), 'opens with an opener');
  t += 270000;                                   // four and a half minutes in
  await ch.post('thinking…');                    // another generic phase
  assert.ok(!/^(on it|one sec|having a look|getting started)$/.test(calls[1]),
    `"${calls[1]} · 4m30s" would be absurd — a long run must not say "one sec"`);
});

test('the display never runs backwards from "still going" to "getting started"', async () => {
  let t = 1_000_000;
  const { send, calls } = immediate();
  const ch = createStatusChannel({
    send, autoBeat: false, heartbeatMs: 15000, startedAt: t, now: () => t,
  });
  await ch.post('thinking…');
  t += 60000;
  await ch.beat();                                // "still ..."
  await ch.post('starting up…');                  // a late generic phase
  const opener = /^(on it|one sec|having a look|getting started)$/;
  assert.ok(!opener.test(calls[calls.length - 1]),
    'a run one minute in cannot announce that it is getting started');
});

test('an important status is guaranteed a write, never superseded', async () => {
  const g = gatedSend();
  const ch = createStatusChannel({ send: g.send, autoBeat: false });
  ch.post('reading a.js');
  await tick();                                   // in flight
  ch.post('⚠️ Bash failed 3× in a row — may be stuck', { important: true });
  ch.post('reading b.js');                        // ordinary, latest-wins
  ch.post('reading c.js');
  g.release();
  await tick(); await tick(); await tick();
  assert.ok(g.calls.includes('⚠️ Bash failed 3× in a row — may be stuck'),
    'a one-off warning must not be swallowed by the current-state line');
});

test('close() cannot be blocked forever by a hung surface write', async () => {
  const hang = { send: () => new Promise(() => {}) };   // never resolves
  const ch = createStatusChannel({ send: hang.send, autoBeat: false, closeGraceMs: 50 });
  ch.post('reading a.js');
  await tick();
  // Hold the loop open so the grace timer (deliberately unref'd in
  // production) can actually fire under the test runner.
  const keepAlive = setTimeout(() => {}, 5000);
  const started = Date.now();
  await ch.close();                                // must return, not wedge
  clearTimeout(keepAlive);
  assert.ok(Date.now() - started < 5000, 'a dead socket must not hold the conversation hostage');
});

test('heartbeat holds off until the interval has actually passed', async () => {
  let t = 1_000_000;
  const { send, calls } = immediate();
  const ch = createStatusChannel({
    send, autoBeat: false, heartbeatMs: 15000, startedAt: t, now: () => t,
  });
  await ch.post('thinking…');
  t += 5000;
  await ch.beat();
  assert.equal(calls.length, 1, 'no beat inside the interval');
});

test('a long wait is acknowledged honestly instead of repeating "still on it"', () => {
  assert.equal(heartbeatKind(60_000, 240_000), 'still');
  assert.equal(heartbeatKind(300_000, 240_000), 'slow');
});

test('phrases avoid immediate repeats and never overclaim progress', () => {
  const recent = [];
  const seen = new Set();
  for (let i = 0; i < 4; i++) seen.add(pickPhrase('still', recent, Math.random));
  assert.ok(seen.size > 1, 'rotation, not one phrase forever');
  for (const p of seen) {
    assert.ok(!/almost|nearly|finishing|done/i.test(p), `"${p}" promises an ending it cannot know`);
  }
});

test('isGenericStatus separates machine phases from real detail', () => {
  for (const g of ['thinking…', 'starting up…', 'working']) assert.ok(isGenericStatus(g));
  for (const s of ['reading config.js', 'calling api.example.com', 'drafting reply…']) {
    assert.ok(!isGenericStatus(s), `"${s}" carries information and must survive`);
  }
});

test('a one-off warning is not mistaken for the current state afterwards', async () => {
  let t = 1_000_000;
  const { send, calls } = immediate();
  const ch = createStatusChannel({
    send, autoBeat: false, heartbeatMs: 15000, startedAt: t, now: () => t,
    importantDwellMs: 0,
  });
  await ch.post('running build.sh');
  await ch.post('⚠️ Bash failed 2× in a row — may be stuck', { important: true });
  t += 20000;
  await ch.beat();
  t += 20000;
  await ch.beat();
  const beats = calls.slice(2);
  assert.ok(beats.length, 'heartbeats happened');
  for (const b of beats) {
    assert.ok(!b.includes('⚠️'),
      `"${b}" re-announces an event as if it were still happening`);
  }
});

test('a guardrail that keeps tripping does not become a write flood', async () => {
  const { send, calls } = immediate();
  const ch = createStatusChannel({ send, autoBeat: false, importantDwellMs: 0 });
  for (let i = 0; i < 8; i++) {
    await ch.post('⚠️ Bash failed 3× in a row — may be stuck', { important: true });
  }
  assert.equal(calls.length, 1, 'the same warning is worth exactly one surface write');
});

test('the current state does not paint over a warning instantly', async () => {
  const g = gatedSend();
  const ch = createStatusChannel({ send: g.send, autoBeat: false, importantDwellMs: 120 });
  ch.post('⚠️ Bash failed 2× in a row — may be stuck', { important: true });
  await tick();
  ch.post('reading next.js');
  g.release();
  const started = Date.now();
  await tick(); await tick();
  assert.deepEqual(g.calls, ['⚠️ Bash failed 2× in a row — may be stuck'],
    'the warning is still on screen — it needs a moment to be readable');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(g.calls.includes('reading next.js'), 'and the live status follows after the dwell');
  assert.ok(Date.now() - started >= 100);
});

test('the opener window is independent of the heartbeat cadence knob', async () => {
  let t = 1_000_000;
  const { send, calls } = immediate();
  // An operator raising the re-render interval to cut API churn must not
  // thereby make a 4-minute run say "one sec".
  const ch = createStatusChannel({
    send, autoBeat: false, heartbeatMs: 300000, startedAt: t, now: () => t,
  });
  await ch.post('thinking…');
  t += 270000;
  await ch.post('starting up…');
  assert.ok(!/^(on it|one sec|having a look|getting started)$/.test(calls[calls.length - 1]),
    'opener wording must expire on its own clock');
});
