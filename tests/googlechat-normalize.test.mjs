// Google Chat adapter — pure normaliser + the authorization gate. The network
// paths (Pub/Sub pull, Chat REST send) are integration-only. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';

// Configure authz + an isolated state dir BEFORE importing config.js (its values
// are read eagerly at import). The history buffer persists under stateDir, so a
// throwaway dir keeps the test hermetic.
process.env.YODA_GCHAT_AUTHORIZED = 'users/alice';
process.env.YODA_GCHAT_SPACES = 'spaces/ROOM_OK';
const STATE_DIR = path.join(os.tmpdir(), `yc-gchat-test-${process.pid}`);
rmSync(STATE_DIR, { recursive: true, force: true });
process.env.YODA_STATE_DIR = STATE_DIR;

const { normalizeChatEvent, statusText, appendCapped, chunkText, buildMediaUrl, default: surface } = await import('../workspace/lib/surfaces/googlechat.js');

// Build a DM event with full control over space, message id, text, thread and
// createTime (the dm() helper below only overrides message fields).
const dmEvent = (space, msgName, text, thread, createTime) => ({
  type: 'MESSAGE',
  space: { name: space, type: 'DM' },
  message: {
    name: msgName, sender: { name: 'users/alice', type: 'HUMAN' },
    text, thread: { name: thread }, space: { name: space, type: 'DM' }, createTime,
  },
});

const dm = (over = {}) => ({
  type: 'MESSAGE',
  space: { name: 'spaces/DM1', type: 'DM' },
  user: { name: 'users/alice', type: 'HUMAN' },
  message: {
    name: 'spaces/DM1/messages/m1',
    sender: { name: 'users/alice', type: 'HUMAN' },
    text: 'hello there',
    thread: { name: 'spaces/DM1/threads/t1' },
    space: { name: 'spaces/DM1', type: 'DM' },
    ...over,
  },
});

const room = (over = {}) => ({
  type: 'MESSAGE',
  space: { name: 'spaces/ROOM_OK', spaceType: 'SPACE' },
  user: { name: 'users/bob', type: 'HUMAN' },
  message: {
    name: 'spaces/ROOM_OK/messages/m2',
    sender: { name: 'users/bob', type: 'HUMAN' },
    text: '@Yoda do the thing',
    argumentText: ' do the thing',
    thread: { name: 'spaces/ROOM_OK/threads/t2' },
    space: { name: 'spaces/ROOM_OK', spaceType: 'SPACE' },
    ...over,
  },
});

test('normalise: a DM message maps to the surface event shape', () => {
  const e = normalizeChatEvent(dm());
  assert.equal(e.surface, 'googlechat');
  assert.equal(e.userId, 'users/alice');
  // DMs are unthreaded — lane by SPACE, not the per-message thread, so the
  // session resumes across messages instead of forgetting each turn.
  assert.equal(e.conversationId, 'gchat:spaces/DM1');
  assert.equal(e.messageId, 'spaces/DM1/messages/m1');
  assert.equal(e.text, 'hello there');
  assert.equal(e.isDirect, true);
  assert.equal(e.isMention, false);
  // replyTarget still carries the actual thread (the reply threads onto the
  // triggering message) plus the canonical lane key for postPlaceholder.
  assert.deepEqual(e.replyTarget, {
    space: 'spaces/DM1',
    thread: 'spaces/DM1/threads/t1',
    conversationId: 'gchat:spaces/DM1',
  });
});

test('normalise: successive DM messages in different threads share ONE lane (session continuity)', () => {
  // Google Chat gives each new top-level DM message a fresh thread name. Both
  // must resolve to the same conversationId or the bot loses all context.
  const first = normalizeChatEvent(dm({ name: 'spaces/DM1/messages/m1', thread: { name: 'spaces/DM1/threads/tA' } }));
  const second = normalizeChatEvent(dm({ name: 'spaces/DM1/messages/m2', thread: { name: 'spaces/DM1/threads/tB' } }));
  assert.equal(first.conversationId, 'gchat:spaces/DM1');
  assert.equal(second.conversationId, first.conversationId, 'same DM space → same session lane');
});

test('normalise: a group chat is unthreaded too — laned by space', () => {
  const gc = normalizeChatEvent({
    type: 'MESSAGE',
    space: { name: 'spaces/GC1', spaceType: 'GROUP_CHAT' },
    message: {
      name: 'spaces/GC1/messages/m', sender: { name: 'users/alice', type: 'HUMAN' },
      text: 'hi all', thread: { name: 'spaces/GC1/threads/tz' },
      space: { name: 'spaces/GC1', spaceType: 'GROUP_CHAT' },
    },
  });
  assert.equal(gc.conversationId, 'gchat:spaces/GC1');
});

test('normalise: a space message is a mention, and argumentText (mention stripped) wins over text', () => {
  const e = normalizeChatEvent(room());
  assert.equal(e.isDirect, false);
  assert.equal(e.isMention, true);
  assert.equal(e.text, 'do the thing', 'uses argumentText, not the raw @-mention text');
  assert.equal(e.conversationId, 'gchat:spaces/ROOM_OK/threads/t2');
});

test('normalise: lanes by space when there is no thread', () => {
  const e = normalizeChatEvent(dm({ thread: undefined }));
  assert.equal(e.conversationId, 'gchat:spaces/DM1');
  assert.equal(e.replyTarget.thread, null);
});

test('normalise: drops non-MESSAGE events, bots, empty text, missing sender', () => {
  assert.equal(normalizeChatEvent({ type: 'ADDED_TO_SPACE', space: { name: 'spaces/x' } }), null);
  assert.equal(normalizeChatEvent(null), null);
  assert.equal(normalizeChatEvent(dm({ sender: { name: 'users/self', type: 'BOT' } })), null, 'bot sender dropped');
  assert.equal(normalizeChatEvent(dm({ text: '   ', argumentText: '' })), null, 'empty text dropped');
  assert.equal(normalizeChatEvent(dm({ sender: {} })), null, 'no sender name dropped');
});

test('normalise: rejects a malformed space name (no injection into the Chat URL)', () => {
  // A hostile/malformed resource name that would otherwise be interpolated into the URL.
  const evil = {
    type: 'MESSAGE',
    space: { name: 'spaces/REAL?updateMask=x&', type: 'DM' },
    message: { name: 'spaces/REAL/messages/m', sender: { name: 'users/a', type: 'HUMAN' }, text: 'hi', space: { name: 'spaces/REAL?updateMask=x&', type: 'DM' } },
  };
  assert.equal(normalizeChatEvent(evil), null, 'malformed space dropped');
  // A malformed thread falls back to null (still replies in the space), not injected.
  const badThread = normalizeChatEvent(dm({ thread: { name: 'spaces/DM1/threads/../../evil' } }));
  assert.equal(badThread.replyTarget.thread, null);
  assert.equal(badThread.conversationId, 'gchat:spaces/DM1', 'lanes by space when the thread is rejected');
});

test('normalise: honours the newer spaceType=DIRECT_MESSAGE as well as legacy type=DM', () => {
  const e = normalizeChatEvent(dm({ space: { name: 'spaces/DM2', spaceType: 'DIRECT_MESSAGE' } }));
  // event.space still says DM here; the per-message space override says DIRECT_MESSAGE
  assert.equal(normalizeChatEvent({
    type: 'MESSAGE',
    space: { name: 'spaces/DM2', spaceType: 'DIRECT_MESSAGE' },
    message: { name: 'm', sender: { name: 'users/z', type: 'HUMAN' }, text: 'hi', space: { name: 'spaces/DM2', spaceType: 'DIRECT_MESSAGE' } },
  }).isDirect, true);
});

test('normalise: extracts attachments and keeps a caption-less file message', () => {
  const withFile = normalizeChatEvent(dm({
    text: '', argumentText: '',
    attachment: [{ contentName: 'report.xlsx', contentType: 'application/xlsx', source: 'UPLOADED_CONTENT', attachmentDataRef: { resourceName: 'spaces/DM1/messages/m1/attachments/a1' } }],
  }));
  assert.ok(withFile, 'a file sent with no caption is NOT dropped');
  assert.equal(withFile.attachments.length, 1);
  assert.equal(withFile.attachments[0].contentName, 'report.xlsx');
  // but a truly empty message (no text, no files) is still dropped
  assert.equal(normalizeChatEvent(dm({ text: '', argumentText: '', attachment: [] })), null);
});

test('normalise: derives an orderable createdTs from createTime (empty when absent)', () => {
  const e = normalizeChatEvent(dm({ createTime: '2026-07-18T08:00:00.000Z' }));
  assert.equal(e.createdTs, String(Date.parse('2026-07-18T08:00:00.000Z')));
  assert.match(e.createdTs, /^\d+$/, 'createdTs is all-digits so the dispatcher can order on it');
  assert.equal(normalizeChatEvent(dm()).createdTs, '', 'no createTime → empty (falls back to messageId)');
});

test('appendCapped: keeps the newest N and drops a redelivered duplicate id', () => {
  let l = [];
  for (let i = 0; i < 30; i++) l = appendCapped(l, { id: 'x' + i, text: 'm' + i }, 24);
  assert.equal(l.length, 24);
  assert.equal(l[0].text, 'm6', 'oldest trimmed to the cap');
  assert.equal(l[23].text, 'm29');
  const n = l.length;
  l = appendCapped(l, { id: 'x29', text: 'dup-redelivery' }, 24); // same id as last → ignored
  assert.equal(l.length, n, 'redelivered message is not appended twice');
  assert.equal(l[l.length - 1].text, 'm29');
});

test('history: a DM keeps its transcript across messages (the context fix)', async () => {
  // Message 1: the user states a fact, in thread tA. recordInbound runs at
  // ingress (as the dispatcher does), then the bot replies.
  const e1 = normalizeChatEvent(dmEvent('spaces/DMH', 'spaces/DMH/messages/m1', 'my name is Sam', 'spaces/DMH/threads/tA', '2026-07-18T08:00:00.000Z'));
  assert.equal(e1.conversationId, 'gchat:spaces/DMH');
  surface.recordInbound(e1);
  const c1 = await surface.fetchContext(e1);
  assert.deepEqual(c1.messages.map((m) => m.text), ['my name is Sam']);
  surface.recordReply(e1, 'Nice to meet you, Sam.');

  // Message 2 arrives in a DIFFERENT thread (unthreaded DM) — in production the
  // SDK session has also rotated away. The transcript must still carry both the
  // earlier user message AND the bot's reply, or the bot answers blank.
  const e2 = normalizeChatEvent(dmEvent('spaces/DMH', 'spaces/DMH/messages/m2', "what's my name?", 'spaces/DMH/threads/tB', '2026-07-18T08:05:00.000Z'));
  assert.equal(e2.conversationId, e1.conversationId, 'same DM lane despite the new thread');
  surface.recordInbound(e2);
  const c2 = await surface.fetchContext(e2);
  assert.deepEqual(
    c2.messages.map((m) => m.text),
    ['my name is Sam', 'Nice to meet you, Sam.', "what's my name?"],
    'the bot now sees the whole conversation, not just the latest message',
  );
  // The newest message is the marked reply target and ordered last.
  assert.equal(c2.replyTargetTs, e2.createdTs);
  assert.equal(c2.messages[c2.messages.length - 1].ts, e2.createdTs);
  // The bot's own line is tagged so the dispatcher's effort-scan/self-filter
  // skip it — the model cannot escalate its own effort by quoting "ultrathink".
  const botLine = c2.messages.find((m) => m.text === 'Nice to meet you, Sam.');
  assert.equal(botLine.bot_id, 'assistant', 'bot reply carries a bot marker');
  assert.equal(c2.messages.find((m) => m.text === 'my name is Sam').bot_id, undefined, 'user lines are unmarked');
});

test('history: a coalesced mid-burst message is still kept for context (finding A)', async () => {
  // Three rapid messages: in production the queue coalesces, so the MIDDLE one's
  // worker never runs. recordInbound fires at ingress for every message, so the
  // correction is not lost from context even though it was never replied to.
  const s = 'spaces/BURST';
  surface.recordInbound(normalizeChatEvent(dmEvent(s, `${s}/messages/m1`, 'book Paris', `${s}/threads/a`, '2026-07-18T09:00:00.000Z')));
  surface.recordInbound(normalizeChatEvent(dmEvent(s, `${s}/messages/m2`, 'actually London', `${s}/threads/b`, '2026-07-18T09:00:01.000Z')));
  const last = normalizeChatEvent(dmEvent(s, `${s}/messages/m3`, 'and a hotel', `${s}/threads/c`, '2026-07-18T09:00:02.000Z'));
  surface.recordInbound(last);
  const ctx = await surface.fetchContext(last); // worker runs only for the last (pending) event
  assert.deepEqual(ctx.messages.map((m) => m.text), ['book Paris', 'actually London', 'and a hotel'],
    'the coalesced-away "London" correction survives in the transcript');
});

test('history: synthetic wake events are not recorded (finding C)', async () => {
  const s = 'spaces/WAKE';
  const real = normalizeChatEvent(dmEvent(s, `${s}/messages/m1`, 'ping', `${s}/threads/a`, '2026-07-18T10:00:00.000Z'));
  surface.recordInbound(real);
  // A background-watch wake carries synthetic:true / a wake object / empty text.
  surface.recordInbound({ conversationId: `gchat:${s}`, synthetic: true, wake: {}, userId: 'users/alice', messageId: 'wake-1', text: '' });
  const ctx = await surface.fetchContext(real);
  assert.deepEqual(ctx.messages.map((m) => m.text), ['ping'], 'no phantom "(sent a file)" line from the wake');
});

test('statusText: collapses thinking/generic phases to a bare "working…", keeps real tool-use detail', () => {
  // generic phases carry no detail → bare working, italicised, no "thinking" leaking
  assert.equal(statusText('thinking…'), '_working…_');
  assert.equal(statusText('working'), '_working…_');
  assert.equal(statusText('starting up'), '_working…_');
  assert.equal(statusText(''), '_working…_');
  // a real tool-use verb is kept
  assert.equal(statusText('reading config.js'), '_working · reading config.js_');
  // elapsed time appears when startedAt is given (just assert the shape)
  assert.match(statusText('reading config.js', Date.now() - 4000), /^_working · \ds · reading config\.js_$/);
});

test('chunkText: leaves a short reply whole, splits a long one under the limit (A1)', () => {
  assert.deepEqual(chunkText('hi there', 4000), ['hi there'], 'short text is one chunk, unchanged');
  // A single 10k-char line has no newline to break on → hard cuts, nothing lost.
  const long = 'x'.repeat(10000);
  const parts = chunkText(long, 4000);
  assert.ok(parts.length >= 3, 'a 10k line splits into multiple messages');
  assert.ok(parts.every((p) => p.length <= 4000), 'every chunk is within Chat’s limit');
  assert.equal(parts.join(''), long, 'hard-cut chunks reassemble to the original');
  // Prefers a newline near the boundary.
  const withBreak = 'a'.repeat(3900) + '\n' + 'b'.repeat(3900);
  const broken = chunkText(withBreak, 4000);
  assert.equal(broken[0], 'a'.repeat(3900), 'first chunk ends at the newline, not mid-word');
  assert.equal(broken[1], 'b'.repeat(3900));
});

test('buildMediaUrl: accepts real base64 resourceNames, blocks traversal/injection (fixes the "unsafe image" regression)', () => {
  // A real Chat attachment resourceName is an opaque token with base64 chars the
  // old character-whitelist wrongly rejected — this is exactly what broke images.
  const tok = 'CO4l7fMd+EAIaFwoT/ABPK9w=';
  const url = buildMediaUrl(tok);
  assert.ok(url, 'a base64 resourceName (+ / =) is NOT rejected');
  assert.ok(url.startsWith('https://chat.googleapis.com/v1/media/'), 'stays on the media endpoint');
  assert.ok(url.includes(tok), 'the token is preserved verbatim (same URL that worked before v2.18.4)');
  assert.ok(url.endsWith('alt=media'));
  // Still blocks the things the guard is actually for:
  assert.equal(buildMediaUrl('../../v1/spaces/secret'), null, 'path traversal off /media/ is rejected');
  const injected = buildMediaUrl('tok?alt=json&steal=1');
  assert.ok(injected && !injected.includes('steal=1') && injected.endsWith('alt=media'), 'injected query params are dropped');
});

test('normalise: singleUserBotDm marks a DM even without type/spaceType (A5)', () => {
  const e = normalizeChatEvent({
    type: 'MESSAGE',
    space: { name: 'spaces/DMX', singleUserBotDm: true },
    message: {
      name: 'spaces/DMX/messages/m', sender: { name: 'users/alice', type: 'HUMAN' },
      text: 'hi', thread: { name: 'spaces/DMX/threads/t1' },
      space: { name: 'spaces/DMX', singleUserBotDm: true },
    },
  });
  assert.equal(e.isDirect, true, 'singleUserBotDm is recognised as a DM');
  assert.equal(e.conversationId, 'gchat:spaces/DMX', 'so it lanes by space, not the unthreaded thread');
});

test('isAuthorized: DM allowed only for listed users; space allowed only if listed', () => {
  assert.equal(surface.isAuthorized(normalizeChatEvent(dm())), true, 'users/alice DM allowed');
  assert.equal(surface.isAuthorized(normalizeChatEvent(dm({ sender: { name: 'users/mallory', type: 'HUMAN' } }))), false, 'unlisted DM denied');
  assert.equal(surface.isAuthorized(normalizeChatEvent(room())), true, 'spaces/ROOM_OK allowed');
  const otherRoom = normalizeChatEvent({
    type: 'MESSAGE',
    space: { name: 'spaces/ROOM_NO', spaceType: 'SPACE' },
    user: { name: 'users/bob', type: 'HUMAN' },
    message: {
      name: 'spaces/ROOM_NO/messages/m', sender: { name: 'users/bob', type: 'HUMAN' },
      text: 'x', argumentText: 'x', space: { name: 'spaces/ROOM_NO', spaceType: 'SPACE' },
    },
  });
  assert.equal(surface.isAuthorized(otherRoom), false, 'unlisted space denied');
});
