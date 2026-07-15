// Broker OAuth token path — exercised against a stub token endpoint. Covers the
// refresh-token rotation overlay (token-store.js), public clients (no client_secret),
// renew-wins reconciliation, and the terminal invalid_grant / interaction_required
// contract. Run: npm test  (node --test tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Environment must be pinned BEFORE the modules under test are imported: the vault
// and token store resolve their file locations from it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-oauth-test-'));
const vaultFile = path.join(tmp, 'vault.json');
const stateDir = path.join(tmp, 'broker-state');
const storeFile = path.join(stateDir, 'rotated-tokens.json');
process.env.YODA_VAULT_FILE = vaultFile;
process.env.YODA_ENV_FILE = path.join(tmp, 'no-such.env'); // hermetic — never read the real .env
process.env.YODA_BROKER_STATE_DIR = stateDir;

function writeVault(obj) {
  fs.writeFileSync(vaultFile, JSON.stringify(obj));
}
writeVault({
  CID: 'client-1',
  CSECRET: 'secret-1',
  RT: 'rt-0',
  RT2: 'rt2-0',
  RT3: 'rt3-0',
  MS_CID: 'ms-client',
  MS_RT: 'ms-rt-0',
});

const { getAccessToken, invalidateAccessToken, resetOauthState } = await import('../workspace/broker/oauth.js');
const { unsealVault, reloadVault } = await import('../workspace/broker/vault.js');
const { persistRotatedToken, dropRotatedToken, pruneRotatedTokens, currentRefreshToken } = await import(
  '../workspace/broker/token-store.js'
);
unsealVault();

// --- stub token endpoint ------------------------------------------------------
let handler = () => [500, { error: 'no handler set' }];
const requests = []; // parsed x-www-form-urlencoded bodies, in order
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const params = Object.fromEntries(new URLSearchParams(body));
    requests.push(params);
    const [status, json] = handler(params);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(json));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const tokenUrl = `http://127.0.0.1:${server.address().port}/token`;
test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const lastRequest = () => requests[requests.length - 1];
const overlay = () => JSON.parse(fs.readFileSync(storeFile, 'utf8'));

// Host entries, as auth-hosts.json would define them.
const googleLike = { provider: 'google', tokenUrl, clientIdKey: 'CID', clientSecretKey: 'CSECRET', refreshTokenKey: 'RT' };
const msLike = { provider: 'microsoft', tokenUrl, clientIdKey: 'MS_CID', refreshTokenKey: 'MS_RT' };

// Mint counters so each scenario can hand out distinguishable tokens.
let mint = 0;

test('non-rotating provider with a secret: classic google-shaped refresh', async () => {
  handler = () => [200, { access_token: 'at-google-1', expires_in: '3599' }]; // string on purpose (Microsoft does this)
  const res = await getAccessToken(googleLike);
  assert.equal(res.token, 'at-google-1');
  const p = lastRequest();
  assert.equal(p.client_id, 'client-1');
  assert.equal(p.client_secret, 'secret-1');
  assert.equal(p.refresh_token, 'rt-0');
  assert.equal(p.grant_type, 'refresh_token');
  assert.ok(!fs.existsSync(storeFile), 'no rotation → no overlay file');
});

test('access tokens are cached until expiry (string expires_in parsed fine)', async () => {
  const before = requests.length;
  const res = await getAccessToken(googleLike);
  assert.equal(res.token, 'at-google-1');
  assert.equal(requests.length, before, 'second mint served from cache');
});

test('public client (no clientSecretKey): rotation is persisted, client_secret omitted', async () => {
  handler = (p) => {
    mint += 1;
    const n = Number(p.refresh_token.split('-').pop());
    return [200, { access_token: `at-ms-${mint}`, expires_in: 3600, refresh_token: `ms-rt-${n + 1}` }];
  };
  const res = await getAccessToken(msLike);
  assert.ok(res.token);
  const p = lastRequest();
  assert.ok(!('client_secret' in p), 'public client must not send client_secret');
  assert.equal(p.refresh_token, 'ms-rt-0');

  const entry = overlay().MS_RT;
  assert.equal(entry.token, 'ms-rt-1');
  assert.ok(entry.base, 'entry records which .env token it descends from');
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700, 'state dir is private');
  assert.equal(fs.statSync(storeFile).mode & 0o777, 0o600, 'store file is private');

  // Next mint must USE the rotated token and persist the next replacement.
  invalidateAccessToken(msLike);
  await getAccessToken(msLike);
  assert.equal(lastRequest().refresh_token, 'ms-rt-1');
  assert.equal(overlay().MS_RT.token, 'ms-rt-2');
});

test('rotation chain survives a broker restart (reload)', async () => {
  resetOauthState(); // what reloadAll()/a restart does
  await getAccessToken(msLike);
  assert.equal(lastRequest().refresh_token, 'ms-rt-2', 'persisted rotation picked up from disk');
});

test('connect --renew wins: a new .env token outranks the persisted rotation', async () => {
  writeVault({ CID: 'client-1', CSECRET: 'secret-1', RT: 'rt-0', RT2: 'rt2-0', MS_CID: 'ms-client', MS_RT: 'ms-rt-100' });
  reloadVault();
  resetOauthState();
  await getAccessToken(msLike);
  assert.equal(lastRequest().refresh_token, 'ms-rt-100', 'fingerprint mismatch → stale overlay ignored');
  assert.equal(overlay().MS_RT.token, 'ms-rt-101', 'new chain descends from the renewed token');
});

test('rejected rotated token self-heals: drop the overlay, retry from .env next call', async () => {
  invalidateAccessToken(msLike);
  handler = () => [400, { error: 'invalid_grant' }];
  const res = await getAccessToken(msLike);
  assert.match(res.error, /retrying from the original sign-in/);
  assert.ok(!overlay().MS_RT, 'rejected rotation dropped');

  handler = (p) => [200, { access_token: 'at-ms-healed', expires_in: 3600, refresh_token: 'ms-rt-101' }];
  const res2 = await getAccessToken(msLike);
  assert.equal(res2.token, 'at-ms-healed', 'not negative-cached — retried immediately');
  assert.equal(lastRequest().refresh_token, 'ms-rt-100', 'retried with the .env token');
});

test('invalid_grant on the .env token itself is terminal and negative-cached', async () => {
  invalidateAccessToken(googleLike);
  handler = () => [400, { error: 'invalid_grant' }];
  const res = await getAccessToken(googleLike);
  assert.match(res.error, /expired or been revoked/);
  assert.match(res.error, /yodacode connect google --renew/);
  const before = requests.length;
  const res2 = await getAccessToken(googleLike);
  assert.match(res2.error, /expired or been revoked/);
  assert.equal(requests.length, before, 'dead-cached — no second hit on the endpoint');
});

test('interaction_required (Microsoft MFA / Conditional Access) is terminal too', async () => {
  const host = { provider: 'microsoft', tokenUrl, clientIdKey: 'MS_CID', refreshTokenKey: 'RT2' };
  handler = () => [400, { error: 'interaction_required' }];
  const res = await getAccessToken(host);
  assert.match(res.error, /expired or been revoked/);
  assert.match(res.error, /yodacode connect microsoft --renew/);
});

test('a declared-but-missing secret is still an error', async () => {
  // RT3: its own key — RT/RT2 are negative-cached by the terminal tests above.
  const host = { tokenUrl, clientIdKey: 'CID', clientSecretKey: 'NOPE', refreshTokenKey: 'RT3' };
  const res = await getAccessToken(host);
  assert.match(res.error, /vault is missing NOPE/);
});

test('invalid_client for a public client names only real vault keys (no "undefined")', async () => {
  invalidateAccessToken(msLike);
  handler = () => [400, { error: 'invalid_client' }];
  const res = await getAccessToken(msLike);
  assert.match(res.error, /check MS_CID, or re-run: yodacode connect microsoft/);
  assert.doesNotMatch(res.error, /undefined/);
});

test('a stale in-flight rejection cannot rewind a newer persisted rotation', () => {
  persistRotatedToken('SIBLING', 'base-0', 'tok-2'); // the concurrent sibling's newer chain
  dropRotatedToken('SIBLING', 'tok-1'); // stale mint's rejected token — must be a no-op
  assert.equal(currentRefreshToken('SIBLING', 'base-0'), 'tok-2', 'newer rotation survives');
  dropRotatedToken('SIBLING', 'tok-2'); // the actually-rejected token — drops
  assert.equal(currentRefreshToken('SIBLING', 'base-0'), 'base-0', 'falls back to the vault token');
});

test('prune drops entries for disconnected providers, keeps live and superseded ones', () => {
  persistRotatedToken('LIVE_KEY', 'live-0', 'live-1');
  persistRotatedToken('GONE_KEY', 'gone-0', 'gone-1');
  pruneRotatedTokens((key) => key !== 'GONE_KEY');
  assert.equal(currentRefreshToken('LIVE_KEY', 'live-0'), 'live-1', 'live entry kept');
  assert.equal(currentRefreshToken('GONE_KEY', 'gone-0'), 'gone-0', 'orphaned entry pruned → vault value');
  dropRotatedToken('LIVE_KEY', 'live-1'); // cleanup
});

test('a failed rotation persist is survivable: token still minted, loudly logged', async () => {
  // Point the state dir somewhere unwritable (under a regular file) and rotate.
  fs.writeFileSync(path.join(tmp, 'blocker'), '');
  process.env.YODA_BROKER_STATE_DIR = path.join(tmp, 'blocker', 'nested');
  resetOauthState();
  handler = () => [200, { access_token: 'at-despite-failure', expires_in: 3600, refresh_token: 'ms-rt-999' }];
  const res = await getAccessToken(msLike);
  assert.equal(res.token, 'at-despite-failure', 'mint succeeds even when the overlay cannot be written');
  process.env.YODA_BROKER_STATE_DIR = stateDir;
  resetOauthState();
});
