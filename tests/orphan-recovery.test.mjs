// Restart-recovery decision logic: which orphaned ticks (runs killed by a
// restart) get a recovery wake, and which are skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOrphanRecovery } from '../workspace/lib/orphan-plan.js';

const NOW = 1_000_000_000_000;
const HOUR = 60 * 60 * 1000;
const OPTS = { now: NOW, maxAgeMs: 12 * HOUR, hasSurface: (n) => n === 'slack' };

const tick = (over = {}) => ({
  surface: 'slack',
  startedAt: NOW - 10 * 60 * 1000, // started 10 min ago
  userId: 'U123',
  replyTarget: { channel: 'D1', threadTs: '1.0', isIm: true },
  textExcerpt: 'clean this csv',
  ...over,
});

test('a fresh orphan with a live surface is recovered', () => {
  const { recover, skipped } = planOrphanRecovery({ 'D1:1.0': tick() }, OPTS);
  assert.equal(recover.length, 1);
  assert.equal(recover[0][0], 'D1:1.0');
  assert.equal(skipped.length, 0);
});

test('an orphan older than maxAgeMs is skipped', () => {
  const { recover, skipped } = planOrphanRecovery(
    { 'D1:1.0': tick({ startedAt: NOW - 13 * HOUR }) }, OPTS);
  assert.equal(recover.length, 0);
  assert.deepEqual(skipped, [{ id: 'D1:1.0', reason: 'too old' }]);
});

test('missing startedAt counts as too old (never a NaN recovery)', () => {
  const { recover, skipped } = planOrphanRecovery(
    { 'D1:1.0': tick({ startedAt: undefined }) }, OPTS);
  assert.equal(recover.length, 0);
  assert.equal(skipped[0].reason, 'too old');
});

test('an orphan without a reply target cannot be recovered', () => {
  const { skipped } = planOrphanRecovery({ 'D1:1.0': tick({ replyTarget: null }) }, OPTS);
  assert.deepEqual(skipped, [{ id: 'D1:1.0', reason: 'no reply target' }]);
});

test('an orphan whose surface is not running is skipped', () => {
  const { skipped } = planOrphanRecovery({ 'G1:2.0': tick({ surface: 'googlechat' }) }, OPTS);
  assert.deepEqual(skipped, [{ id: 'G1:2.0', reason: 'surface not running' }]);
});

test('mixed batch: each orphan judged independently', () => {
  const { recover, skipped } = planOrphanRecovery({
    'a': tick(),
    'b': tick({ startedAt: NOW - 24 * HOUR }),
    'c': tick({ surface: 'whatsapp' }),
  }, OPTS);
  assert.deepEqual(recover.map(([id]) => id), ['a']);
  assert.equal(skipped.length, 2);
});

test('empty/absent input is a no-op', () => {
  assert.deepEqual(planOrphanRecovery({}, OPTS).recover, []);
  assert.deepEqual(planOrphanRecovery(undefined, OPTS).recover, []);
});

test('recovery attempts are capped — a crash-looping run is not resurrected forever', () => {
  const once = planOrphanRecovery({ 'D1:1.0': tick({ recoveryAttempt: 1 }) }, OPTS);
  assert.equal(once.recover.length, 1, 'one prior attempt → one more allowed');
  const twice = planOrphanRecovery({ 'D1:1.0': tick({ recoveryAttempt: 2 }) }, OPTS);
  assert.deepEqual(twice.skipped, [{ id: 'D1:1.0', reason: 'recovery attempts exhausted' }]);
});

test('a lane the user already re-asked in is left alone', () => {
  const { recover, skipped } = planOrphanRecovery({ 'D1:1.0': tick() },
    { ...OPTS, isBusy: (id) => id === 'D1:1.0' });
  assert.equal(recover.length, 0);
  assert.deepEqual(skipped, [{ id: 'D1:1.0', reason: 'conversation already active' }]);
});
