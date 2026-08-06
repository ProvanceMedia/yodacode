// The update drain gate's tick counter: agent_active_ticks (scripts/common.sh)
// reads the runner's current-ticks.json mirror from the host side. It must
// report 0 for missing/empty/unparseable files and the true count otherwise —
// a wrong non-zero blocks updates, a wrong zero kills in-flight runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMON = path.join(REPO, 'scripts', 'common.sh');

function countTicks(prepare) {
  const dir = mkdtempSync(path.join(tmpdir(), 'yoda-drain-'));
  mkdirSync(path.join(dir, 'workspace', 'state'), { recursive: true });
  if (prepare) prepare(path.join(dir, 'workspace', 'state', 'current-ticks.json'));
  const out = execFileSync('bash', ['-c', `source "${COMMON}" >/dev/null 2>&1; agent_active_ticks`], {
    cwd: dir, encoding: 'utf8',
  });
  return out.trim();
}

test('missing ticks file → 0', () => {
  assert.equal(countTicks(null), '0');
});

test('idle mirror ({}) → 0', () => {
  assert.equal(countTicks((f) => writeFileSync(f, '{}')), '0');
});

test('two active runs → 2, placeholder startedAt not double-counted', () => {
  // Real persisted shape: each tick embeds its surface placeholder handle,
  // which carries its OWN startedAt one indent level deeper — the counter
  // must only match the tick-level key.
  assert.equal(countTicks((f) => writeFileSync(f, JSON.stringify({
    'D1:1.0': {
      surface: 'slack', startedAt: 1, replyTarget: { isIm: true },
      placeholder: { channel: 'D1', ts: null, shimmer: true, startedAt: 1 },
    },
    'G2:9.9': {
      surface: 'googlechat', startedAt: 2, replyTarget: {},
      placeholder: { space: 'G2', startedAt: 2 },
    },
  }, null, 2))), '2');
});

test('garbage file → 0 (never blocks an update on corrupt state)', () => {
  assert.equal(countTicks((f) => writeFileSync(f, 'not json at all')), '0');
});
