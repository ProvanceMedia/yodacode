// Final-reply parsing — only the <say> part of the model's output may reach chat.
// The scratchpad around it is deliberation and must never be posted. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFinalReply } from '../workspace/lib/reply-policy.js';

test('parseFinalReply posts only the tagged reply and silences the rest', () => {
  // Narration outside the tags is dropped.
  assert.deepEqual(
    parseFinalReply('just a casual greeting, light ack\n<say>  hey there  </say>\nmore notes'),
    { kind: 'text', text: 'hey there' },
  );
  // Cut off mid-reply: the text after the open tag is still the reply.
  assert.deepEqual(parseFinalReply('scratchpad <say>partial answer'), { kind: 'text', text: 'partial answer' });
  // Untagged output is posted whole (back-compat).
  assert.deepEqual(parseFinalReply('plain answer'), { kind: 'text', text: 'plain answer' });
  // Every way of saying nothing is silence, not a post.
  for (const t of ['', '   ', null, '<say>  </say>', 'thinking <silent/>', '<react>👍</react>', 'NO_REPLY\nnot worth it']) {
    assert.deepEqual(parseFinalReply(t), { kind: 'silent' }, `${JSON.stringify(t)} must be silent`);
  }
});
