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
