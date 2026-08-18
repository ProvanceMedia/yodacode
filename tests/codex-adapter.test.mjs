// Codex adapter — the parts that can be tested without an engine, a credential
// or a network: argument construction and the credential-expiry check that
// decides whether a turn needs the refresh lock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildArgs, tokenExpiryMs, needsRefreshLock } from '../workspace/lib/engine/codex/adapter.js';

// ── argument construction ────────────────────────────────────────────────────

const BASE = { prompt: 'do a thing', cwd: '/workspace', lastMessageFile: '/tmp/last.txt' };

test('a fresh turn passes the working directory and sandbox as flags', () => {
  const a = buildArgs(BASE);
  assert.equal(a[0], 'exec');
  assert.ok(a.includes('-C') && a[a.indexOf('-C') + 1] === '/workspace');
  assert.ok(a.includes('--sandbox'));
  assert.equal(a.at(-1), 'do a thing');
});

test('a resumed turn names the thread and omits the flags resume rejects', () => {
  const a = buildArgs({ ...BASE, resume: 'thread-abc' });
  assert.deepEqual(a.slice(0, 3), ['exec', 'resume', 'thread-abc']);
  // codex exec resume rejects these outright — including them fails at argv
  // parsing, which would break every resumed turn while fresh ones worked.
  for (const flag of ['--sandbox', '-C', '--cd', '--color', '--add-dir', '-p', '--profile']) {
    assert.ok(!a.includes(flag), `resume args must not contain ${flag}`);
  }
});

test('the sandbox still applies on resume, as a config override', () => {
  const a = buildArgs({ ...BASE, resume: 'thread-abc' });
  assert.ok(a.some((x) => /^sandbox_mode=/.test(x)), 'expected -c sandbox_mode=…');
});

test('both paths request the last-message file and JSON output', () => {
  for (const args of [buildArgs(BASE), buildArgs({ ...BASE, resume: 't' })]) {
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('-o') && args[args.indexOf('-o') + 1] === '/tmp/last.txt');
    assert.ok(args.includes('--skip-git-repo-check'));
  }
});

test('model and effort are optional and omitted when unset', () => {
  const a = buildArgs(BASE);
  assert.ok(!a.includes('--model'));
  assert.ok(!a.some((x) => /model_reasoning_effort/.test(x)));
  const b = buildArgs({ ...BASE, model: 'gpt-5.5', effort: 'high' });
  assert.equal(b[b.indexOf('--model') + 1], 'gpt-5.5');
  assert.ok(b.some((x) => x === 'model_reasoning_effort="high"'));
});

test('the prompt is always last, so it can never be read as a flag value', () => {
  assert.equal(buildArgs({ ...BASE, prompt: '--not-a-flag' }).at(-1), '--not-a-flag');
  assert.equal(buildArgs({ ...BASE, resume: 't', prompt: '--not-a-flag' }).at(-1), '--not-a-flag');
});

// ── credential expiry ────────────────────────────────────────────────────────

/** Codex only base64-decodes the JWT payload — it never verifies the signature —
 *  so an unsigned token with the right shape exercises the real code path. */
function fakeHome(expSeconds) {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-home-'));
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: `header.${payload}.signature`, refresh_token: 'r' },
  }));
  return dir;
}

test('reads the expiry out of the token payload', () => {
  const now = 1_800_000_000_000;
  const dir = fakeHome(now / 1000 + 3600);
  try {
    assert.equal(Math.round(tokenExpiryMs(dir, now) / 1000), 3600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a healthy credential does NOT take the refresh lock', () => {
  const now = 1_800_000_000_000;
  const dir = fakeHome(now / 1000 + 86_400);   // a day left
  try {
    assert.equal(needsRefreshLock(dir, now), false,
      'locking a healthy turn would serialise every conversation for no reason');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a credential at or past expiry DOES take the lock', () => {
  const now = 1_800_000_000_000;
  for (const exp of [now / 1000 - 10, now / 1000 + 60]) {   // expired, and inside the grace window
    const dir = fakeHome(exp);
    try {
      assert.equal(needsRefreshLock(dir, now), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('an unreadable or malformed credential locks rather than assuming health', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-home-'));
  try {
    assert.equal(needsRefreshLock(dir, Date.now()), true, 'missing auth.json');
    writeFileSync(path.join(dir, 'auth.json'), 'not json at all');
    assert.equal(needsRefreshLock(dir, Date.now()), true, 'unparseable auth.json');
    writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'nope' } }));
    assert.equal(needsRefreshLock(dir, Date.now()), true, 'token that is not a JWT');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── sandbox posture ──────────────────────────────────────────────────────────
// Found by running a real turn: asking Codex for its own sandbox inside the
// container makes every shell command fail with a bubblewrap namespace error,
// while the TURN still reports success — so it surfaces as the model saying it
// couldn't run the command, not as a configuration error anyone would look for.

test('the sandbox default matches the generated config, on both paths', () => {
  const fresh = buildArgs(BASE);
  assert.equal(fresh[fresh.indexOf('--sandbox') + 1], 'danger-full-access');
  const resumed = buildArgs({ ...BASE, resume: 't' });
  assert.ok(resumed.includes('sandbox_mode="danger-full-access"'));
});

test('a caller can still narrow the sandbox deliberately', () => {
  const a = buildArgs({ ...BASE, sandbox: 'read-only' });
  assert.equal(a[a.indexOf('--sandbox') + 1], 'read-only');
});
