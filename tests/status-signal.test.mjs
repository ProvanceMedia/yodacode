// The one-signal-at-a-time rule for Slack DM progress: shimmer first, then a
// single handover to a persistent status card. Two signals at once reads as
// the bot answering itself twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusTarget } from '../workspace/lib/surfaces/status-signal.js';

const NOW = 1_000_000;
const OPTS = { now: NOW, cardAfterMs: 60_000 };
const dm = (over = {}) => ({ shimmer: true, startedAt: NOW - 5_000, ts: null, ...over });

test('a young DM run shows the shimmer only', () => {
  assert.equal(statusTarget(dm(), OPTS), 'shimmer');
});

test('past the threshold it takes over with a card', () => {
  assert.equal(statusTarget(dm({ startedAt: NOW - 61_000 }), OPTS), 'create-card');
});

test('after handover the card is the ONLY signal — never the shimmer again', () => {
  const handed = dm({ startedAt: NOW - 120_000, ts: '1.1', handedOver: true });
  assert.equal(statusTarget(handed, OPTS), 'card');
});

test('a card creation in flight does not spawn a second card', () => {
  const pending = dm({ startedAt: NOW - 61_000, cardPending: {} });
  assert.equal(statusTarget(pending, OPTS), 'shimmer');
});

test('channel handles (no shimmer) always drive the card', () => {
  assert.equal(statusTarget({ shimmer: false, ts: '1.1', startedAt: NOW }, OPTS), 'card');
  assert.equal(statusTarget({ shimmer: false, ts: null, startedAt: NOW }, OPTS), 'none');
});

test('a finished handle accepts no further status writes', () => {
  assert.equal(statusTarget(dm({ finished: true }), OPTS), 'none');
  assert.equal(statusTarget(dm({ ts: '1.1', handedOver: true, finished: true }), OPTS), 'none');
});

test('cardAfterMs = 0 disables handover: shimmer forever', () => {
  assert.equal(statusTarget(dm({ startedAt: NOW - 600_000 }), { now: NOW, cardAfterMs: 0 }), 'shimmer');
});
