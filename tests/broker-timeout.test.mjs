// Per-host request timeout (auth-hosts.js hostTimeoutMs) + its propagation from the
// catalog through addkey into an auth-hosts entry. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostTimeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, loadAuthHosts, lookupHost } from '../workspace/broker/auth-hosts.js';

test('hostTimeoutMs: default when unset, honoured when set, clamped, junk-safe', () => {
  assert.equal(hostTimeoutMs(undefined), DEFAULT_TIMEOUT_MS);
  assert.equal(hostTimeoutMs({}), DEFAULT_TIMEOUT_MS);
  assert.equal(hostTimeoutMs({ timeoutMs: 120_000 }), 120_000);
  assert.equal(hostTimeoutMs({ timeoutMs: 5_000 }), DEFAULT_TIMEOUT_MS, 'never shorter than the default');
  assert.equal(hostTimeoutMs({ timeoutMs: 9e9 }), MAX_TIMEOUT_MS, 'capped');
  assert.equal(hostTimeoutMs({ timeoutMs: -1 }), DEFAULT_TIMEOUT_MS);
  assert.equal(hostTimeoutMs({ timeoutMs: 'junk' }), DEFAULT_TIMEOUT_MS);
  assert.equal(hostTimeoutMs({ timeoutMs: NaN }), DEFAULT_TIMEOUT_MS);
});

test('lookupHost normalises host (trim + case) so both timeout layers agree', () => {
  // http-call.js and index.js both resolve the timeout via lookupHost; if they
  // normalised differently a padded host would give a 120s fetch but an 18s kill.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-hosts-'));
  const file = path.join(dir, 'auth-hosts.json');
  fs.writeFileSync(file, JSON.stringify({ 'api.slow.example': { scheme: 'bearer', vaultKey: 'K', timeoutMs: 120000 } }));
  process.env.YODA_AUTH_HOSTS_FILE = file;
  try {
    loadAuthHosts();
    for (const h of ['api.slow.example', '  api.slow.example  ', 'API.Slow.Example', 'api.slow.example\n']) {
      assert.equal(hostTimeoutMs(lookupHost(h)), 120000, `padded/cased host "${JSON.stringify(h)}" must still resolve`);
    }
    assert.equal(hostTimeoutMs(lookupHost('unknown.example')), DEFAULT_TIMEOUT_MS, 'unknown host → default');
  } finally {
    delete process.env.YODA_AUTH_HOSTS_FILE;
    loadAuthHosts();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the shipped OpenAI catalog entry carries a longer timeout (image generation is slow)', () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const openai = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', 'service-catalog.json'), 'utf8')).openai;
  assert.ok(openai.timeoutMs >= 60_000, `expected a raised timeout, got ${openai.timeoutMs}`);
  assert.ok(hostTimeoutMs(openai) > DEFAULT_TIMEOUT_MS, 'and the broker would honour it');
});

test('addkey resolve emits AK_TIMEOUT_MS from the catalog (so `addkey openai` writes it)', () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const LIB = path.join(REPO, 'scripts', 'addkey-lib.py');
  const r = spawnSync('python3', [LIB, 'resolve'], {
    env: { ...process.env, AK_SERVICE: 'openai', YODA_ENV_FILE: '/nonexistent' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^AK_TIMEOUT_MS=120000$/m, 'resolve forwards the catalog timeout');
});

test('a plain (non-slow) host emits no timeout, so it keeps the tight default', () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const LIB = path.join(REPO, 'scripts', 'addkey-lib.py');
  const r = spawnSync('python3', [LIB, 'resolve'], {
    env: { ...process.env, AK_SERVICE: 'github', YODA_ENV_FILE: '/nonexistent' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  // shlex-quoted empty → AK_TIMEOUT_MS='' (not a bare =), which the shell reads as empty.
  assert.match(r.stdout, /^AK_TIMEOUT_MS=(''|"")$/m, 'no timeout forwarded for a normal host');
});
