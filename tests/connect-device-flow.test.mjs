// The connect wizard's device-code flow (connect-lib.py device-start/device-poll)
// and public-client handling, exercised against stub provider endpoints via a
// test-only catalog (YODA_CATALOG_FILE). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(REPO, 'scripts', 'connect-lib.py');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-device-test-'));

// --- stub provider: /devicecode, /token, /userinfo ----------------------------
let handler = () => [500, {}];
const requests = []; // { path, params }
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const params = Object.fromEntries(new URLSearchParams(body));
    const entry = { path: req.url, params };
    requests.push(entry);
    const [status, json] = handler(entry);
    if (status === 0) {
      // simulate a network blip: drop the connection without a response
      res.socket.destroy();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(json));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// connect-lib's URL_RE is https-only with a loopback-http exemption — which is
// exactly what lets this catalog point at the stub above.
const catalogFile = path.join(tmp, 'catalog.json');
const catalog = {
  testms: {
    kind: 'oauth-provider',
    label: 'TestMS',
    aliases: ['tms'],
    flow: 'device-code',
    deviceCodeUrl: `${base}/devicecode`,
    tokenUrl: `${base}/token`,
    clientIdKey: 'TESTMS_OAUTH_CLIENT_ID',
    refreshTokenKey: 'TESTMS_REFRESH_TOKEN',
    clientIdPattern: '^[0-9a-f-]{8,}$',
    identityScopes: ['openid', 'email'],
    identityUrl: `${base}/userinfo`,
    identityField: 'email',
    setupGuide: 'docs/providers/testms.md',
    setupSteps: [{ text: 'Register an app', url: 'https://example.com/register' }],
    services: {
      mail: {
        label: 'Test Mail',
        aliases: [],
        hosts: ['api.testms.example'],
        scopeTiers: [
          { key: 'read', label: 'Read-only', scopes: ['Mail.Read'] },
          { key: 'full', label: 'Read + send', scopes: ['Mail.ReadWrite', 'Mail.Send'], default: true },
        ],
        testPath: 'v1/me/messages',
      },
      cal: {
        label: 'Test Calendar',
        aliases: [],
        hosts: ['api.testms.example'],
        scopeTiers: [{ key: 'full', label: 'Full', scopes: ['Cal.ReadWrite'], default: true }],
        testPath: 'v1/me/events',
      },
    },
  },
  testbad: {
    kind: 'oauth-provider',
    label: 'TestBad',
    aliases: [],
    flow: 'device-code',
    deviceCodeUrl: `${base}/devicecode`,
    tokenUrl: `${base}/token`,
    clientIdKey: 'TESTBAD_OAUTH_CLIENT_ID',
    clientSecretKey: 'TESTBAD_OAUTH_CLIENT_SECRET',
    refreshTokenKey: 'TESTBAD_REFRESH_TOKEN',
    identityScopes: [],
    services: {
      thing: {
        label: 'Thing',
        hosts: ['api.testbad.example'],
        scopeTiers: [{ key: 'full', label: 'Full', scopes: ['t.rw'], default: true }],
      },
    },
  },
  testac: {
    kind: 'oauth-provider',
    label: 'TestAC',
    aliases: [],
    authUrl: 'https://auth.testac.example/authorize',
    tokenUrl: `${base}/token`,
    clientIdKey: 'TESTAC_OAUTH_CLIENT_ID',
    refreshTokenKey: 'TESTAC_REFRESH_TOKEN',
    identityScopes: [],
    services: {
      thing: {
        label: 'Thing',
        hosts: ['api.testac.example'],
        scopeTiers: [{ key: 'full', label: 'Full', scopes: ['thing.rw'], default: true }],
      },
    },
  },
  // same shape as testac, but sharpens the exchange wording via the catalog
  testhint: {
    kind: 'oauth-provider',
    label: 'TestHint',
    aliases: [],
    authUrl: 'https://auth.testhint.example/authorize',
    tokenUrl: `${base}/token`,
    clientIdKey: 'TESTHINT_OAUTH_CLIENT_ID',
    refreshTokenKey: 'TESTHINT_REFRESH_TOKEN',
    identityScopes: [],
    exchangeHints: { invalid_grant: 'TestHint codes die in 42 seconds — get a fresh link' },
    services: {
      thing: {
        label: 'Thing',
        hosts: ['api.testhint.example'],
        scopeTiers: [{ key: 'full', label: 'Full', scopes: ['thing.rw'], default: true }],
      },
    },
  },
};
fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 2));

const baseEnv = {
  ...process.env,
  YODA_CATALOG_FILE: catalogFile,
  YODA_ENV_FILE: path.join(tmp, 'no-such.env'),
};

// Async on purpose: a synchronous spawn would block the event loop, and the
// stub server above could never answer the very request the child is waiting on.
function runLib(cmd, env = {}, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn('python3', [LIB, cmd], { env: { ...baseEnv, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const to = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(to);
      resolve({ code, out, err });
    });
  });
}

// Parse the lib's shlex-quoted KEY=value output lines into an object.
function parseVars(out) {
  const vars = {};
  for (const line of out.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    let rest = line.slice(eq + 1);
    let val = '';
    while (rest.length) {
      if (rest[0] === "'") {
        const end = rest.indexOf("'", 1);
        val += rest.slice(1, end);
        rest = rest.slice(end + 1);
      } else if (rest[0] === '"') {
        const end = rest.indexOf('"', 1);
        val += rest.slice(1, end);
        rest = rest.slice(end + 1);
      } else {
        const m = rest.match(/^[^'"]+/);
        val += m[0];
        rest = rest.slice(m[0].length);
      }
    }
    vars[key] = val;
  }
  return vars;
}

const DEV_ENV = {
  CN_PROVIDER: 'testms',
  CN_SERVICES: 'mail,cal',
  CN_TIERS: 'mail=full,cal=full',
  CN_CLIENT_ID: 'abcd1234-ffff',
};

test('resolve: device-code provider exposes flow, no secret key, no publish check', async () => {
  const { code, out } = await runLib('resolve', { CN_PROVIDER: 'testms' });
  assert.equal(code, 0);
  const v = parseVars(out);
  assert.equal(v.CN_FLOW, 'device-code');
  assert.equal(v.CN_CLIENT_SECRET_KEY, '');
  assert.equal(v.CN_PUBLISH_CHECK, '');
  assert.equal(v.CN_CLIENT_ID_KEY, 'TESTMS_OAUTH_CLIENT_ID');
});

test('device-start: requests the tier scope union, no secret, emits the user code', async () => {
  handler = () => [200, {
    device_code: 'dev-code-1',
    user_code: 'ABCD-1234',
    verification_uri: 'https://example.com/devicelogin',
    interval: 0,
    expires_in: 900,
  }];
  const { code, out } = await runLib('device-start', DEV_ENV);
  assert.equal(code, 0, out);
  const v = parseVars(out);
  assert.equal(v.CN_OK, '1');
  assert.equal(v.CN_DEVICE_CODE, 'dev-code-1');
  assert.equal(v.CN_USER_CODE, 'ABCD-1234');
  assert.equal(v.CN_VERIFICATION_URI, 'https://example.com/devicelogin');
  assert.equal(v.CN_INTERVAL, '1', 'a degenerate interval of 0 is floored to 1s');
  assert.match(v.CN_SCOPE_SUMMARY, /Test Mail/);
  const req = requests[requests.length - 1];
  assert.equal(req.path, '/devicecode');
  assert.ok(!('client_secret' in req.params), 'public client sends no secret');
  assert.ok(!('redirect_uri' in req.params), 'device flow has no redirect');
  const scopes = req.params.scope.split(' ');
  for (const s of ['Mail.ReadWrite', 'Mail.Send', 'Cal.ReadWrite', 'openid', 'email']) {
    assert.ok(scopes.includes(s), `scope ${s} requested`);
  }
});

test('device-start: a rejected client id is actionable', async () => {
  handler = () => [400, { error: 'invalid_client', error_description: 'bad app' }];
  const { code, out } = await runLib('device-start', DEV_ENV);
  assert.equal(code, 2);
  const v = parseVars(out);
  assert.equal(v.CN_OK, '');
  assert.match(v.CN_ERROR, /client \(application\) ID was rejected/);
});

test('device-start: a non-numeric interval is a clean malformed-response error', async () => {
  handler = () => [200, {
    device_code: 'd', user_code: 'C-1', verification_uri: 'https://example.com/x', interval: 'soon', expires_in: 900,
  }];
  const { code, out } = await runLib('device-start', DEV_ENV);
  assert.equal(code, 2, out);
  assert.match(parseVars(out).CN_ERROR, /malformed/);
});

test('device-start: a plain-http verification URL from the provider is rejected', async () => {
  handler = () => [200, {
    device_code: 'd', user_code: 'C-2', verification_uri: `${base}/devicelogin`, interval: 5, expires_in: 900,
  }];
  const { code, out } = await runLib('device-start', DEV_ENV);
  assert.equal(code, 2, out);
  assert.match(parseVars(out).CN_ERROR, /malformed/);
});

test('the catalog rejects a device-code provider that declares a client secret', async () => {
  const { code, err } = await runLib('resolve', { CN_PROVIDER: 'testbad' });
  assert.equal(code, 1);
  assert.match(err, /public clients/);
});

test('device-poll: scattered network blips during a long approval do not abort', async () => {
  let polls = 0;
  handler = ({ path }) => {
    if (path === '/userinfo') return [200, { email: 'user@example.com' }];
    polls += 1;
    // 6 dropped connections interleaved with pending — never 2 in a row, so a
    // CONSECUTIVE counter survives where a cumulative one would abort at 5.
    if (polls <= 12) return polls % 2 ? [0, null] : [400, { error: 'authorization_pending' }];
    return [200, { access_token: 'at-blip', refresh_token: 'rt-blip', expires_in: 3599 }];
  };
  const { code, out } = await runLib('device-poll', { ...DEV_ENV, CN_DEVICE_CODE: 'x', CN_INTERVAL: '0', CN_EXPIRES_IN: '900' });
  assert.equal(code, 0, out);
  assert.equal(parseVars(out).CN_REFRESH_TOKEN, 'rt-blip');
});

test('device-poll: pending → pending → tokens, with identity lookup', async () => {
  let polls = 0;
  handler = ({ path }) => {
    if (path === '/userinfo') return [200, { email: 'user@example.com' }];
    polls += 1;
    if (polls < 3) return [400, { error: 'authorization_pending' }];
    return [200, {
      access_token: 'at-dev-1',
      refresh_token: 'rt-dev-1',
      expires_in: 3599,
      scope: 'Mail.ReadWrite Mail.Send',
    }];
  };
  const { code, out } = await runLib('device-poll', {
    ...DEV_ENV, CN_DEVICE_CODE: 'dev-code-1', CN_INTERVAL: '0', CN_EXPIRES_IN: '900',
  });
  assert.equal(code, 0, out);
  const v = parseVars(out);
  assert.equal(v.CN_OK, '1');
  assert.equal(v.CN_REFRESH_TOKEN, 'rt-dev-1');
  assert.equal(v.CN_ACCESS_TOKEN, 'at-dev-1');
  assert.equal(v.CN_ACCOUNT, 'user@example.com');
  const tokenReq = requests.find((r) => r.path === '/token' && r.params.device_code);
  assert.equal(tokenReq.params.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  assert.ok(!('client_secret' in tokenReq.params));
});

test('device-poll: declined stops without a retry', async () => {
  handler = () => [400, { error: 'authorization_declined' }];
  const { code, out } = await runLib('device-poll', { ...DEV_ENV, CN_DEVICE_CODE: 'x', CN_INTERVAL: '0', CN_EXPIRES_IN: '900' });
  assert.equal(code, 2);
  const v = parseVars(out);
  assert.match(v.CN_ERROR, /declined/);
  assert.equal(v.CN_RETRY_URL, '');
});

test('device-poll: an expired code asks for a fresh one', async () => {
  handler = () => [400, { error: 'expired_token' }];
  const { code, out } = await runLib('device-poll', { ...DEV_ENV, CN_DEVICE_CODE: 'x', CN_INTERVAL: '0', CN_EXPIRES_IN: '900' });
  assert.equal(code, 2);
  const v = parseVars(out);
  assert.match(v.CN_ERROR, /expired/);
  assert.equal(v.CN_RETRY_URL, '1');
});

test('device-poll: the public-client toggle mistake gets the exact fix', async () => {
  handler = () => [400, { error: 'invalid_client', error_description: 'AADSTS7000218: client_assertion or client_secret' }];
  const { code, out } = await runLib('device-poll', { ...DEV_ENV, CN_DEVICE_CODE: 'x', CN_INTERVAL: '0', CN_EXPIRES_IN: '900' });
  assert.equal(code, 2);
  const v = parseVars(out);
  assert.match(v.CN_ERROR, /Allow public client flows/);
});

test('device-poll: a token response without a refresh token aborts', async () => {
  handler = () => [200, { access_token: 'at-only', expires_in: 3599 }];
  const { code, out } = await runLib('device-poll', { ...DEV_ENV, CN_DEVICE_CODE: 'x', CN_INTERVAL: '0', CN_EXPIRES_IN: '900' });
  assert.equal(code, 2);
  const v = parseVars(out);
  assert.equal(v.CN_OK, '');
  assert.match(v.CN_ERROR, /no refresh token/);
});

test('auth-url refuses a device-code provider (and vice versa is guarded)', async () => {
  const { code, err } = await runLib('auth-url', DEV_ENV);
  assert.equal(code, 1);
  assert.match(err, /device-code flow/);
});

test('exchange: public client without a secret key omits client_secret', async () => {
  handler = () => [200, { access_token: 'at-ac', refresh_token: 'rt-ac', expires_in: 3600 }];
  const { code, out } = await runLib('exchange', {
    CN_PROVIDER: 'testac',
    CN_CLIENT_ID: 'ac-client',
    CN_CLIENT_SECRET: '',
    CN_PKCE_VERIFIER: 'v'.repeat(43),
    CN_STATE: 'state-1',
    CN_PASTE: 'http://127.0.0.1:8765/?code=authcode-1234567890&state=state-1',
  });
  assert.equal(code, 0, out);
  const v = parseVars(out);
  assert.equal(v.CN_REFRESH_TOKEN, 'rt-ac');
  const req = requests[requests.length - 1];
  assert.equal(req.params.grant_type, 'authorization_code');
  assert.ok(!('client_secret' in req.params), 'no secret sent for a public client');
});

test('exchange hints: catalog override sharpens the wording, no override stays provider-neutral', async () => {
  const paste = 'http://127.0.0.1:8765/?code=authcode-1234567890&state=state-1';
  const base_ = { CN_CLIENT_ID: 'c', CN_PKCE_VERIFIER: 'v'.repeat(43), CN_STATE: 'state-1', CN_PASTE: paste };
  handler = () => [400, { error: 'invalid_grant' }];

  // testac declares no exchangeHints → the neutral default, with no Google-isms
  const a = await runLib('exchange', { ...base_, CN_PROVIDER: 'testac' });
  const av = parseVars(a.out);
  assert.match(av.CN_ERROR, /sign-in code expired or was already used/);
  assert.doesNotMatch(av.CN_ERROR, /10 minutes|Desktop app/, 'no provider-specific copy leaks into the default');
  assert.equal(av.CN_RETRY_URL, '1', 'retry semantics preserved');

  // testhint overrides it → its own wording wins, retry semantics unchanged
  const b = await runLib('exchange', { ...base_, CN_PROVIDER: 'testhint' });
  const bv = parseVars(b.out);
  assert.match(bv.CN_ERROR, /TestHint codes die in 42 seconds/);
  assert.equal(bv.CN_RETRY_URL, '1', 'override does not disturb the retry flag');
});

test('a hint never hides the provider error_description (the AADSTS code docs are keyed on)', async () => {
  // One OAuth code covers many real causes, so the friendly hint is the LIKELY cause —
  // the operator still needs the provider's own code to look up the actual one.
  handler = () => [400, { error: 'invalid_grant', error_description: 'AADSTS70008: expired' }];
  const { out } = await runLib('exchange', {
    CN_PROVIDER: 'testhint', CN_CLIENT_ID: 'c', CN_PKCE_VERIFIER: 'v'.repeat(43), CN_STATE: 's',
    CN_PASTE: 'http://127.0.0.1:8765/?code=authcode-1234567890&state=s',
  });
  const v = parseVars(out);
  assert.match(v.CN_ERROR, /TestHint codes die in 42 seconds/, 'friendly hint still leads');
  assert.match(v.CN_ERROR, /AADSTS70008/, 'and the provider code survives for lookup');
});

test('a bare pasted code is accepted at Entra length (~1200+ chars), not just Google length', async () => {
  handler = () => [200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }];
  const longCode = '0.AXsA' + 'a1b2C3d4-_.'.repeat(140); // ~1540 chars, Entra-shaped
  assert.ok(longCode.length > 1200, 'fixture really is Entra-length');
  const { code, out } = await runLib('exchange', {
    CN_PROVIDER: 'testac', CN_CLIENT_ID: 'c', CN_PKCE_VERIFIER: 'v'.repeat(43), CN_STATE: 's',
    CN_PASTE: longCode, // bare code, not a URL — the truncated-address-bar fallback
  });
  assert.equal(code, 0, out);
  assert.equal(parseVars(out).CN_REFRESH_TOKEN, 'rt');
  assert.equal(requests[requests.length - 1].params.code, longCode, 'passed through intact');
});
