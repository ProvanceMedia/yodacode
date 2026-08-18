// Codex event stream → Anthropic stream-json. The fixtures are real recorded
// turns (a tool-using turn and a resumed one), so these tests pin the mapping
// against what the engine actually emits rather than what its docs describe.
// They need no engine, no credential and no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  translateEvent, createTranslatorState, stripShellWrapper, mapUsage,
} from '../workspace/lib/engine/codex/translate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  return readFileSync(path.join(HERE, 'fixtures', name), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Run a whole recorded turn through the translator. */
function translateAll(events, finalText = null) {
  const state = createTranslatorState();
  if (finalText != null) state.finalText = finalText;
  const out = [];
  for (const ev of events) out.push(...translateEvent(ev, state));
  return { out, state };
}

// ── the shell wrapper ────────────────────────────────────────────────────────

test('strips the /bin/bash -lc wrapper so status shows the command', () => {
  assert.equal(stripShellWrapper("/bin/bash -lc 'wc -l sample.txt'"), 'wc -l sample.txt');
  assert.equal(stripShellWrapper('/bin/sh -c "ls -la"'), 'ls -la');
});

test('leaves a bare command alone', () => {
  assert.equal(stripShellWrapper('git status'), 'git status');
});

test('survives junk without throwing', () => {
  for (const bad of [null, undefined, 42, '', "/bin/bash -lc 'unterminated"]) {
    assert.doesNotThrow(() => stripShellWrapper(bad));
  }
});

// ── usage ────────────────────────────────────────────────────────────────────

test('maps cached_input_tokens onto the Anthropic cache-read field', () => {
  const u = mapUsage({
    input_tokens: 53519, cached_input_tokens: 40448,
    output_tokens: 311, reasoning_output_tokens: 45,
  });
  assert.equal(u.input_tokens, 53519);
  assert.equal(u.cache_read_input_tokens, 40448);
  assert.equal(u.output_tokens, 311);
  assert.equal(u.reasoning_output_tokens, 45);
  // Codex reports no cache-creation figure; it must not be invented.
  assert.equal(u.cache_creation_input_tokens, 0);
});

test('missing usage stays undefined rather than becoming zeroes', () => {
  assert.equal(mapUsage(undefined), undefined);
});

// ── a real recorded tool-using turn ──────────────────────────────────────────

test('the recorded turn produces an init with the thread id', () => {
  const { out } = translateAll(loadFixture('codex-turn-tools.jsonl'));
  const init = out[0];
  assert.equal(init.type, 'system');
  assert.equal(init.subtype, 'init');
  assert.equal(init.session_id, '01a015bf-5826-70a1-a08d-5559baa64794');
});

test('shell commands become Bash tool_use with the wrapper stripped', () => {
  const { out } = translateAll(loadFixture('codex-turn-tools.jsonl'));
  const uses = out.filter((m) => m.type === 'assistant')
    .flatMap((m) => m.message.content).filter((b) => b.type === 'tool_use');
  const bash = uses.filter((b) => b.name === 'Bash');
  assert.equal(bash.length, 2);
  assert.equal(bash[0].input.command, 'wc -l sample.txt');
  assert.equal(bash[1].input.command, 'nl -ba sample.txt');
});

test('a file edit becomes an Edit tool_use carrying the path', () => {
  const { out } = translateAll(loadFixture('codex-turn-tools.jsonl'));
  const edit = out.filter((m) => m.type === 'assistant')
    .flatMap((m) => m.message.content)
    .find((b) => b.type === 'tool_use' && b.name === 'Edit');
  assert.ok(edit, 'expected an Edit tool_use');
  assert.match(edit.input.file_path, /sample\.txt$/);
});

test('every tool_use is answered by a tool_result with the same id', () => {
  const { out } = translateAll(loadFixture('codex-turn-tools.jsonl'));
  const useIds = out.filter((m) => m.type === 'assistant')
    .flatMap((m) => m.message.content).filter((b) => b.type === 'tool_use').map((b) => b.id);
  const resultIds = out.filter((m) => m.type === 'user')
    .flatMap((m) => m.message.content).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
  assert.deepEqual(resultIds, useIds);
  assert.ok(useIds.length >= 3);
});

test('a successful command is not flagged as an error', () => {
  const { out } = translateAll(loadFixture('codex-turn-tools.jsonl'));
  const results = out.filter((m) => m.type === 'user')
    .flatMap((m) => m.message.content).filter((b) => b.type === 'tool_result');
  assert.ok(results.every((r) => r.is_error === false));
  assert.match(results[0].content, /3 sample\.txt/);
});

test('the reply comes from the last-message file, not from mid-turn narration', () => {
  const AUTHORITATIVE = 'Original count: 3 lines.';
  const { out } = translateAll(loadFixture('codex-turn-tools.jsonl'), AUTHORITATIVE);
  const result = out.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.subtype, 'success');
  assert.equal(result.result, AUTHORITATIVE);
  // The narration still travelled as assistant text (it drives the status
  // line) but did not become the answer.
  const texts = out.filter((m) => m.type === 'assistant')
    .flatMap((m) => m.message.content).filter((b) => b.type === 'text').map((b) => b.text);
  assert.ok(texts.some((t) => /appending the requested line/i.test(t)));
});

test('without a last-message file it falls back to the final agent_message', () => {
  const { out } = translateAll(loadFixture('codex-turn-tools.jsonl'));
  const result = out.at(-1);
  assert.match(result.result, /^Original count: 3 lines\./);
});

test('usage rides on the result message', () => {
  const { out } = translateAll(loadFixture('codex-turn-tools.jsonl'));
  const result = out.at(-1);
  assert.equal(result.usage.input_tokens, 53519);
  assert.equal(result.usage.cache_read_input_tokens, 40448);
});

// ── the recorded resumed turn ────────────────────────────────────────────────

test('a resumed turn reports the same thread id', () => {
  const { out } = translateAll(loadFixture('codex-turn-resume.jsonl'));
  assert.equal(out[0].session_id, '01a015bf-5826-70a1-a08d-5559baa64794');
  assert.equal(out.at(-1).session_id, '01a015bf-5826-70a1-a08d-5559baa64794');
});

test('a turn with no tool calls still produces exactly one result', () => {
  const { out } = translateAll(loadFixture('codex-turn-resume.jsonl'));
  const results = out.filter((m) => m.type === 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].is_error, false);
});

// ── failures ─────────────────────────────────────────────────────────────────

test('turn.failed becomes an error result rather than ending the stream silently', () => {
  const state = createTranslatorState();
  state.threadId = 'thread-1';
  const out = translateEvent(
    { type: 'turn.failed', error: { message: 'model overloaded' } }, state);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'result');
  assert.equal(out[0].is_error, true);
  assert.deepEqual(out[0].errors, ['model overloaded']);
});

test('a bare error event also produces a result', () => {
  const state = createTranslatorState();
  const out = translateEvent({ type: 'error', message: 'stream disconnected' }, state);
  assert.equal(out[0].is_error, true);
  assert.deepEqual(out[0].errors, ['stream disconnected']);
});

test('a failed command result is flagged as an error', () => {
  const state = createTranslatorState();
  const out = translateEvent({
    type: 'item.completed',
    item: { id: 'item_9', type: 'command_execution', command: '/bin/bash -lc \'false\'', aggregated_output: '', exit_code: 1, status: 'completed' },
  }, state);
  assert.equal(out[0].message.content[0].is_error, true);
});

// ── things that must NOT leak through ────────────────────────────────────────

test('reasoning items are dropped, so scratchpad never reaches the reply', () => {
  const state = createTranslatorState();
  const out = translateEvent(
    { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'thinking out loud' } }, state);
  assert.deepEqual(out, []);
  assert.equal(state.lastMessage, '');
});

test('unknown event types are ignored rather than throwing', () => {
  const state = createTranslatorState();
  for (const ev of [{ type: 'item.updated' }, { type: 'brand.new.event' }, {}, null]) {
    assert.doesNotThrow(() => translateEvent(ev, state));
    assert.deepEqual(translateEvent(ev, state), []);
  }
});
