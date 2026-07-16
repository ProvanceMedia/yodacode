// encodeRequestBody() — the broker's outbound-body shaping, incl. base64 binary
// uploads (real .xlsx / images / PDFs) that text bodies would corrupt. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRequestBody } from '../workspace/broker/http-call.js';

test('no body → nothing to send', () => {
  assert.deepEqual(encodeRequestBody({}), {});
});

test('JSON object body is stringified as application/json', () => {
  const enc = encodeRequestBody({ body: { a: 1 } });
  assert.equal(enc.body, '{"a":1}');
  assert.equal(enc.contentType, 'application/json');
});

test('string body passes through unchanged (still defaults to json content-type)', () => {
  const enc = encodeRequestBody({ body: 'hello=world' });
  assert.equal(enc.body, 'hello=world');
  assert.equal(enc.contentType, 'application/json');
});

test('binary upload: base64 round-trips to EXACT bytes (a .xlsx zip survives)', () => {
  // PK\x03\x04 (zip magic) + bytes above 0x7F that a UTF-8 text body would mangle.
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0xff, 0x00, 0x80, 0xfe, 0x00, 0x7f]);
  const enc = encodeRequestBody({ bodyBase64: bytes.toString('base64') });
  assert.ok(Buffer.isBuffer(enc.body), 'body is a Buffer, not a string');
  assert.deepEqual(enc.body, bytes, 'every byte preserved, including >0x7F');
  assert.equal(enc.contentType, 'application/octet-stream', 'default MIME');
});

test('binary upload honours an explicit MIME type', () => {
  const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const enc = encodeRequestBody({ bodyBase64: Buffer.from('data').toString('base64'), contentType: xlsx });
  assert.equal(enc.contentType, xlsx);
});

test('bodyBase64 tolerates whitespace/newlines (base64 with line wraps)', () => {
  const raw = Buffer.from('a fairly long payload that would wrap across lines when base64-encoded');
  const wrapped = raw.toString('base64').replace(/(.{20})/g, '$1\n');
  const enc = encodeRequestBody({ bodyBase64: wrapped });
  assert.deepEqual(enc.body, raw);
});

test('bodyBase64 wins when both body and bodyBase64 are present', () => {
  const enc = encodeRequestBody({ body: '{"json":true}', bodyBase64: Buffer.from('bin').toString('base64') });
  assert.ok(Buffer.isBuffer(enc.body));
  assert.deepEqual(enc.body, Buffer.from('bin'));
});

test('rejects invalid base64', () => {
  assert.match(encodeRequestBody({ bodyBase64: 'not valid !!! base64 @@@' }).error, /not valid base64/);
  assert.match(encodeRequestBody({ bodyBase64: 'abc' }).error, /not valid base64/); // length % 4 != 0
});

test('rejects an empty / whitespace-only payload', () => {
  assert.match(encodeRequestBody({ bodyBase64: '   ' }).error, /decoded to nothing|not valid/);
});

test('rejects an over-cap payload before decoding', () => {
  const huge = 'A'.repeat(8_000_004); // valid base64 chars, over the ~6MB cap
  assert.match(encodeRequestBody({ bodyBase64: huge }).error, /too large/);
});

test('contentType is validated as a bare MIME — no header smuggling', () => {
  const b64 = Buffer.from('x').toString('base64');
  // CRLF injection attempt must be rejected, not passed to the header layer.
  assert.match(encodeRequestBody({ bodyBase64: b64, contentType: 'text/plain\r\nAuthorization: bearer evil' }).error, /plain MIME/);
  assert.match(encodeRequestBody({ bodyBase64: b64, contentType: 'not-a-mime' }).error, /plain MIME/);
  // over-long value rejected (a real MIME is short)
  assert.match(encodeRequestBody({ bodyBase64: b64, contentType: 'a/' + 'x'.repeat(200) }).error, /plain MIME/);
  // a normal MIME is fine
  assert.equal(encodeRequestBody({ bodyBase64: b64, contentType: 'image/png' }).contentType, 'image/png');
});

test('contentType is honoured on the text body path too (form/xml/csv), not just binary', () => {
  const enc = encodeRequestBody({ body: 'a=1&b=2', contentType: 'application/x-www-form-urlencoded' });
  assert.equal(enc.body, 'a=1&b=2');
  assert.equal(enc.contentType, 'application/x-www-form-urlencoded');
  // still defaults to json when not given
  assert.equal(encodeRequestBody({ body: '{}' }).contentType, 'application/json');
  // and an invalid contentType is rejected regardless of which body path
  assert.match(encodeRequestBody({ body: 'x', contentType: 'bad\r\ninject' }).error, /plain MIME/);
});
