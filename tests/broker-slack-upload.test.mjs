// slack_upload — file delivery to Slack (3-step external-upload flow, host-side).
// These cover the pure validation + guard paths that return BEFORE any network call;
// the live 3-call flow is exercised against a real workspace, not here. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Hermetic vault: never read the real .env; seed a fake bot token via a YODA_VAULT_*
// env var (the only process.env channel vault.js reads), so slackUpload gets past its
// token gate and we can exercise the input guards behind it.
process.env.YODA_ENV_FILE = '/nonexistent/.env';
process.env.YODA_VAULT_SLACK_BOT_TOKEN = 'xoxb-test-token';

const { decodeUploadBody, slackUpload, slackUploadDef } = await import('../workspace/broker/slack-upload.js');
const { unsealVault, reloadVault } = await import('../workspace/broker/vault.js');
unsealVault();

test('decodeUploadBody: valid base64 decodes to the exact bytes', () => {
  const r = decodeUploadBody(Buffer.from('hello world').toString('base64'));
  assert.equal(r.error, undefined);
  assert.ok(Buffer.isBuffer(r.bytes));
  assert.equal(r.bytes.toString(), 'hello world');
});

test('decodeUploadBody: tolerates whitespace/newlines in the base64', () => {
  const raw = Buffer.from('abcdefghij0123456789');
  const b64 = raw.toString('base64');
  const wrapped = `${b64.slice(0, 4)}\n  ${b64.slice(4)}`; // as if line-wrapped
  const r = decodeUploadBody(wrapped);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.bytes, raw);
});

test('decodeUploadBody: rejects empty, junk, and oversized', () => {
  assert.match(decodeUploadBody('').error, /required/);
  assert.match(decodeUploadBody(undefined).error, /required/);
  assert.match(decodeUploadBody('not*valid*base64!').error, /not valid base64/);
  const tooBig = Buffer.alloc(30 * 1024 * 1024 + 1).toString('base64');
  assert.match(decodeUploadBody(tooBig).error, /too large/);
});

test('slackUploadDef exposes the params the agent needs', () => {
  assert.equal(slackUploadDef.name, 'slack_upload');
  for (const p of ['channel', 'filename', 'contentBase64', 'title', 'comment', 'thread_ts']) {
    assert.ok(slackUploadDef.params[p], `missing param: ${p}`);
  }
});

test('slackUpload: input guards all return before any network call', async () => {
  const okB64 = Buffer.from('x').toString('base64');
  // filename with a slash — path-traversal shaped; rejected before decode/network
  let r = await slackUpload({ filename: 'a/b.txt', contentBase64: okB64 });
  assert.equal(r.ok, false);
  assert.match(r.error, /filename/);
  // control character in filename
  r = await slackUpload({ filename: 'a\nb', contentBase64: okB64 });
  assert.equal(r.ok, false);
  assert.match(r.error, /filename/);
  // valid filename but bad base64 — reaches (and fails) the decode guard
  r = await slackUpload({ filename: 'ok.txt', contentBase64: 'not*base64*' });
  assert.equal(r.ok, false);
  assert.match(r.error, /base64/);
  // empty body
  r = await slackUpload({ filename: 'ok.txt', contentBase64: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /required/);
});

test('slackUpload: a missing bot token is a clear, safe failure (no network)', async () => {
  delete process.env.YODA_VAULT_SLACK_BOT_TOKEN;
  reloadVault();
  try {
    const r = await slackUpload({ filename: 'ok.txt', contentBase64: Buffer.from('x').toString('base64') });
    assert.equal(r.ok, false);
    assert.match(r.error, /SLACK_BOT_TOKEN/);
  } finally {
    process.env.YODA_VAULT_SLACK_BOT_TOKEN = 'xoxb-test-token';
    reloadVault();
  }
});
