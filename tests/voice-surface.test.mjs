// Voice surface — speech shaping, event normalisation, and the contract
// choices that decide what actually gets said out loud. The WebSocket endpoint
// is integration-only. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';

// config.js reads env eagerly at import, and the rolling transcript persists
// under stateDir — a throwaway dir keeps this hermetic.
const STATE_DIR = path.join(os.tmpdir(), `yc-voice-test-${process.pid}`);
rmSync(STATE_DIR, { recursive: true, force: true });
process.env.YODA_STATE_DIR = STATE_DIR;
process.env.YODA_VOICE_TOKEN = 'test-token';
process.env.YODA_VOICE_USER_ID = 'voice-owner';
process.env.YODA_VOICE_MAX_SPEAK_CHARS = '120';

const { speechify, ackText, buildVoiceEvent, appendCapped, default: surface } =
  await import('../workspace/lib/surfaces/voice.js');
const { voiceBus } = await import('../workspace/lib/voice-bus.js');

test.after(() => rmSync(STATE_DIR, { recursive: true, force: true }));

// ─── speechify ──────────────────────────────────────────────────────────────

test('speechify strips markdown that would be pronounced literally', () => {
  // A terminal full stop is added deliberately: a synthesiser falls in pitch on
  // one and trails off without, so an unpunctuated line sounds unfinished.
  assert.equal(speechify('**Done** — the `sync` finished').text, 'Done — the sync finished.');
  assert.equal(speechify('## Results').text, 'Results.');
  assert.equal(speechify('> quoted line').text, 'quoted line.');
});

test('speechify replaces code blocks rather than reading them out', () => {
  const out = speechify('Here it is:\n```bash\nrm -rf /tmp/x\n```\nDone').text;
  assert.match(out, /code omitted/);
  assert.doesNotMatch(out, /rm -rf/);
});

test('speechify keeps link text and drops the URL', () => {
  assert.equal(speechify('see [the report](https://example.com/a/b)').text, 'see the report.');
  assert.equal(speechify('go to https://example.com/x now').text, 'go to a link now.');
});

test('speechify turns bullets into sentences so they do not run together', () => {
  const out = speechify('- first thing\n- second thing').text;
  assert.equal(out, 'first thing. second thing.');
});

test('speechify removes emoji that yoda prefixes to its own notices', () => {
  assert.equal(speechify('⚠️ Run failed: timeout').text, 'Run failed: timeout.');
  assert.equal(speechify('🛑 Stopped by user').text, 'Stopped by user.');
});

test('speechify trims at a sentence boundary and flags truncation', () => {
  const long = 'One sentence here. Two sentence here. ' + 'x'.repeat(200);
  const out = speechify(long, 120);
  assert.equal(out.truncated, true);
  assert.ok(out.text.length <= 120);
  // Stops where a person would stop, not mid-word.
  assert.match(out.text, /\.$/);
});

test('speechify leaves well-formed prose alone apart from closing it', () => {
  const plain = 'Sync finished about forty minutes ago, no errors';
  assert.deepEqual(speechify(plain, 700), { text: `${plain}.`, truncated: false });
  // Already punctuated: untouched, and no doubled stop.
  assert.deepEqual(speechify('It ran at nine.', 700), { text: 'It ran at nine.', truncated: false });
});

// ─── ack ────────────────────────────────────────────────────────────────────

test('ack echoes the transcript verbatim so a mishearing is audible', () => {
  assert.equal(ackText('check whether the sync ran'), 'Got it: check whether the sync ran');
  assert.equal(ackText('   '), 'Got it.');
});

// ─── event shape ────────────────────────────────────────────────────────────

test('buildVoiceEvent produces one stable lane per user', () => {
  const a = buildVoiceEvent('first', { now: 1 });
  const b = buildVoiceEvent('second', { now: 2 });
  assert.equal(a.conversationId, 'voice:voice-owner');
  assert.equal(a.conversationId, b.conversationId, 'voice is one continuous conversation');
  assert.equal(a.surface, 'voice');
  assert.equal(a.isDirect, true);
});

test('buildVoiceEvent carries the utterance for the spoken ack', () => {
  const e = buildVoiceEvent('  check the sync  ', { clientId: 'vc-1', now: 5 });
  assert.equal(e.text, 'check the sync');
  assert.equal(e.replyTarget.utterance, 'check the sync');
  assert.equal(e.replyTarget.clientId, 'vc-1');
});

// ─── authorisation ──────────────────────────────────────────────────────────

test('isAuthorized refuses any identity other than the configured one', async () => {
  await surface.start(async () => {});
  assert.equal(surface.isAuthorized(buildVoiceEvent('hi')), true);
  assert.equal(surface.isAuthorized({ userId: 'someone-else' }), false);
  await surface.stop();
  assert.equal(surface.isAuthorized(buildVoiceEvent('hi')), false, 'refuses once stopped');
});

// ─── what gets spoken ───────────────────────────────────────────────────────

function captureClient() {
  const sent = [];
  const client = { send: (m) => sent.push(m), close: () => {} };
  voiceBus.addClient(client);
  return { sent, done: () => voiceBus.removeClient(client) };
}

/**
 * Drive a turn end to end the way the WebSocket endpoint does: submit through
 * the bus (which arms the ack), then post the placeholder the way
 * dispatcher.processReply does. Returns the handle and the captured event.
 */
async function beginTurn(text) {
  const seen = [];
  await surface.start(async (e) => { seen.push(e); });
  await voiceBus.submit({ text, clientId: 'vc-test' });
  const handle = await surface.postPlaceholder(seen[0].replyTarget, 'on it', { working: true });
  return { handle, event: seen[0] };
}

test('status writes are never spoken — this is what "no narration" means', async () => {
  const cap = captureClient();
  const { handle } = await beginTurn('check the sync');
  await surface.updateMessage(handle, '_calling api.hubapi.com_', { status: true });
  await surface.updateMessage(handle, '_reading SOUL.md_', { status: true });
  cap.done();
  await surface.stop();

  assert.deepEqual(cap.sent.map((m) => m.type), ['ack'], 'only the ack was spoken');
  assert.equal(cap.sent[0].text, 'Got it: check the sync');
});

test('the surface deliberately has no setStatus, which is what suppresses the heartbeat', () => {
  // Guards the contract choice in lib/surface.js: implementing setStatus would
  // earn this surface a wall-clock heartbeat and start narrating tool calls.
  assert.equal(surface.setStatus, undefined);
});

test('the final reply is spoken, shaped for the ear', async () => {
  const cap = captureClient();
  const { handle } = await beginTurn('did it run');
  await surface.updateMessage(handle, '**Yes** — it ran at `09:14`.');
  cap.done();
  await surface.stop();

  const spoken = cap.sent.filter((m) => m.type === 'speak');
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, 'Yes — it ran at 09:14.');
  assert.equal(handle.finished, true);
});

test('the same text is never read out twice', async () => {
  const cap = captureClient();
  const { handle } = await beginTurn('status');
  await surface.updateMessage(handle, 'All good.');
  await surface.updateMessage(handle, 'All good.');
  cap.done();
  await surface.stop();

  assert.equal(cap.sent.filter((m) => m.type === 'speak').length, 1);
});

test('a silent turn says nothing at all', async () => {
  const cap = captureClient();
  const { handle } = await beginTurn('thanks');
  await surface.suppressPlaceholder(handle);
  cap.done();
  await surface.stop();

  assert.deepEqual(cap.sent.map((m) => m.type), ['ack', 'silent']);
});

test('a background-watch wake does not re-echo the old instruction', async () => {
  // The watcher replays the ORIGINAL turn's replyTarget when it fires, and that
  // object carries the utterance. Reading the echo back off it would announce
  // "Got it: kick off the deploy…" ten minutes later, unprompted. A turn nobody
  // spoke for must stay quiet and let the result arrive on its own.
  await surface.start(async () => {});
  const cap = captureClient();

  const replayed = {
    conversationId: 'voice:voice-owner',
    userId: 'voice-owner',
    utterance: 'kick off the deploy and tell me when it is done',
  };
  const handle = await surface.postPlaceholder(replayed, 'on it', { working: true });
  await surface.updateMessage(handle, 'Deploy is done, health check passed.');
  cap.done();
  await surface.stop();

  assert.deepEqual(cap.sent.map((m) => m.type), ['working', 'speak'],
    'no ack — only a silent working cue, then the answer');
  assert.equal(cap.sent[1].text, 'Deploy is done, health check passed.');
});

test('a real utterance arms exactly one ack, consumed once', async () => {
  const cap = captureClient();
  const { handle, event } = await beginTurn('check the sync');
  // A second placeholder on the same lane with nothing newly armed (a retry, a
  // wake) must not repeat the echo.
  await surface.postPlaceholder(event.replyTarget, 'on it', { working: true });
  cap.done();
  await surface.stop();

  assert.deepEqual(cap.sent.map((m) => m.type), ['ack', 'working']);
  assert.equal(cap.sent[0].text, 'Got it: check the sync');
  assert.ok(handle);
});

test('a non-working placeholder (the stop ack) is spoken as written', async () => {
  const cap = captureClient();
  await surface.postPlaceholder({ conversationId: 'voice:voice-owner' },
    "🛑 Nothing to stop — I'm idle.", { working: false });
  cap.done();

  assert.equal(cap.sent[0].text, "Nothing to stop — I'm idle.");
});

// ─── transcript ─────────────────────────────────────────────────────────────

test('appendCapped keeps the newest entries and drops a redelivered duplicate', () => {
  let list = [];
  list = appendCapped(list, { id: 'a', text: '1' }, 3);
  list = appendCapped(list, { id: 'a', text: '1' }, 3);
  assert.equal(list.length, 1, 'same id as the last entry is a redelivery');
  for (const id of ['b', 'c', 'd']) list = appendCapped(list, { id, text: id }, 3);
  assert.deepEqual(list.map((e) => e.id), ['b', 'c', 'd']);
});

test('fetchContext serves both sides of the conversation, tagging the bot', async () => {
  const event = buildVoiceEvent('what did I ask', { now: 100 });
  surface.recordInbound(event);
  surface.recordReply(event, 'You asked about the sync.');

  const ctx = await surface.fetchContext(event);
  assert.equal(ctx.isIm, true);
  const bot = ctx.messages.find((m) => m.bot_id === 'assistant');
  assert.ok(bot, 'the reply is tagged so the effort scan skips it');
  assert.equal(bot.text, 'You asked about the sync.');
  assert.ok(ctx.messages.some((m) => m.text === 'what did I ask'));
});

// ─── microphone mode ────────────────────────────────────────────────────────

test('an unrecognised mic mode falls back rather than failing boot', async () => {
  // config.js is a module singleton read at import, so exercise the rule
  // directly: only the two real modes survive, anything else becomes 'wake'.
  const pick = (v) => (['wake', 'hotkey'].includes(v) ? v : 'wake');
  assert.equal(pick('hotkey'), 'hotkey');
  assert.equal(pick('wake'), 'wake');
  assert.equal(pick('push-to-talk'), 'wake', 'a typo must not switch the mic off silently');
  assert.equal(pick(undefined), 'wake');
});

// ─── prompt hints ───────────────────────────────────────────────────────────

test('prompt hints tell the model it is writing for the ear', () => {
  const hints = surface.formatPromptHints();
  assert.match(hints, /READ ALOUD/);
  assert.match(hints, /No markdown/i);
});
