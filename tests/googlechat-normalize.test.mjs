// Google Chat adapter — pure normaliser + the authorization gate. The network
// paths (Pub/Sub pull, Chat REST send) are integration-only. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Configure authz BEFORE importing config.js (its Sets are built eagerly at import).
process.env.YODA_GCHAT_AUTHORIZED = 'users/alice';
process.env.YODA_GCHAT_SPACES = 'spaces/ROOM_OK';

const { normalizeChatEvent, statusText, default: surface } = await import('../workspace/lib/surfaces/googlechat.js');

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
  assert.equal(e.conversationId, 'gchat:spaces/DM1/threads/t1');
  assert.equal(e.messageId, 'spaces/DM1/messages/m1');
  assert.equal(e.text, 'hello there');
  assert.equal(e.isDirect, true);
  assert.equal(e.isMention, false);
  assert.deepEqual(e.replyTarget, { space: 'spaces/DM1', thread: 'spaces/DM1/threads/t1' });
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
