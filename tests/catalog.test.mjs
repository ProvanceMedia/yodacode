// Every oauth-provider entry in the SHIPPED catalog must pass connect-lib's
// load-bearing validation (endpoints, key names, flow shape, service hosts) —
// a bad catalog edit should fail here, not in front of an operator mid-wizard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(REPO, 'scripts', 'connect-lib.py');
const catalog = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', 'service-catalog.json'), 'utf8'));
const providers = Object.entries(catalog).filter(([, e]) => e && e.kind === 'oauth-provider');

function resolveProvider(slug) {
  return new Promise((resolve) => {
    const child = spawn('python3', [LIB, 'resolve'], {
      env: { ...process.env, CN_PROVIDER: slug, YODA_ENV_FILE: '/nonexistent/.env' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('every shipped oauth provider passes catalog validation', async () => {
  assert.ok(providers.length >= 2, 'expected at least google + microsoft in the catalog');
  for (const [slug, entry] of providers) {
    const { code, out, err } = await resolveProvider(slug);
    assert.equal(code, 0, `${slug} failed validation: ${err}`);
    assert.match(out, /^CN_OK=1$/m, `${slug} resolve did not report CN_OK`);
    // Device-code providers are public clients; auth-code providers may have secrets.
    if (entry.flow === 'device-code') {
      assert.ok(!entry.clientSecretKey, `${slug}: device-code providers must not declare clientSecretKey`);
    }
  }
});

// Microsoft blocks device code by default in managed tenants, and device-code sessions
// are protocol-tracked so the refresh token dies permanently once the policy flips.
// Auth-code + PKCE is the only durable flow there — don't let this regress silently.
test('microsoft uses auth-code + PKCE, never device code', () => {
  const ms = catalog.microsoft;
  assert.ok(ms, 'microsoft provider present');
  assert.equal(ms.flow, 'auth-code', 'must not be device-code: managed tenants block it');
  assert.ok(!ms.deviceCodeUrl, 'no deviceCodeUrl — the registration deliberately leaves public-client flows off');
  assert.ok(ms.authUrl?.startsWith('https://login.microsoftonline.com/'), 'has a Microsoft authorize endpoint');
  assert.ok(!ms.clientSecretKey, 'public client — no secret to expire');
  // Loopback paste-back: the browser must land the code in the address bar as a query
  // string, so response_mode=query (never form_post, which POSTs to a dead endpoint).
  assert.match(ms.redirectUri ?? '', /^http:\/\/localhost(:\d+)?$/, 'loopback redirect for paste-back');
  assert.equal(ms.authParams?.response_mode, 'query', 'form_post would leave nothing to paste');
  assert.ok(ms.identityScopes?.includes('offline_access'), 'offline_access is what yields a refresh token');
  // ~60s code lifetime is the sharp edge; the operator must be warned before consenting.
  assert.match(JSON.stringify(ms.signInNotes ?? []), /60 SECONDS/i, 'warns about the ~60s code expiry');
  assert.match(ms.exchangeHints?.invalid_grant ?? '', /60 seconds/i, 'expiry hint names the real lifetime');
});
