// Naming a model so a cron survives an engine change.
//
// The failure being designed against: a task pinned to `claude-sonnet-4-6`
// keeps that value after a switch to Codex, and then fails on its own schedule
// when nobody is watching. Tiers avoid it; literal names still work but must
// fail loudly and early.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveModel, auditTasks, modelEngine, isTier, TIERS,
} from '../workspace/lib/engine/model-tiers.js';

// ── tiers ────────────────────────────────────────────────────────────────────

test('every tier resolves on both engines', () => {
  for (const engine of ['claude', 'codex']) {
    for (const tier of TIERS) {
      const r = resolveModel(engine, tier);
      assert.equal(r.tier, tier);
      assert.ok(r.model || r.effort, `${engine}/${tier} must resolve to something`);
    }
  }
});

test('the Claude tiers name current models', () => {
  // Pinned deliberately: a tier that resolves to an older model than the one the
  // operator's existing crons already name is a silent downgrade for anything
  // written the portable way.
  assert.equal(resolveModel('claude', 'fast').model, 'claude-haiku-4-5');
  assert.equal(resolveModel('claude', 'balanced').model, 'claude-sonnet-5');
  assert.equal(resolveModel('claude', 'deep').model, 'claude-fable-5-1');
});

test('the Codex tiers name current models, strongest at deep', () => {
  // OpenAI names the 5.6 family along this same axis. Pinned deliberately: a
  // tier that only raised EFFORT would make `deep` think harder on whatever
  // model was configured — possibly an older one than `fast` would have used.
  assert.equal(resolveModel('codex', 'fast').model, 'gpt-5.6-luna');
  assert.equal(resolveModel('codex', 'balanced').model, 'gpt-5.6-terra');
  assert.equal(resolveModel('codex', 'deep').model, 'gpt-5.6-sol');
});

test('effort is left to each model, which the vendor tunes per model', () => {
  // Sol defaults to LOW on purpose — it is strong at lighter reasoning — so
  // forcing an effort per tier would override a deliberate vendor choice.
  for (const t of ['fast', 'balanced', 'deep']) {
    assert.equal(resolveModel('codex', t).effort, undefined);
  }
  // Unless the task asks for one.
  assert.equal(resolveModel('codex', 'deep', 'xhigh').effort, 'xhigh');
});

test('tiers are case- and whitespace-insensitive', () => {
  assert.equal(resolveModel('codex', '  DEEP ').model, 'gpt-5.6-sol');
  assert.equal(resolveModel('claude', 'Balanced').model, 'claude-sonnet-5');
});

test("a task's own effort beats the tier's", () => {
  assert.equal(resolveModel('codex', 'fast', 'xhigh').effort, 'xhigh');
  assert.equal(resolveModel('claude', 'deep', 'low').effort, 'low');
});

// ── literal model names ──────────────────────────────────────────────────────

test('a literal name for the running engine passes through untouched', () => {
  assert.equal(resolveModel('claude', 'claude-opus-4-1').model, 'claude-opus-4-1');
  assert.equal(resolveModel('codex', 'gpt-5.5').model, 'gpt-5.5');
});

test("a literal name from the OTHER engine throws, and says what to do", () => {
  assert.throws(() => resolveModel('codex', 'claude-sonnet-4-6'), (e) => {
    assert.match(e.message, /belongs to the claude engine/);
    assert.match(e.message, /fast, balanced, deep/, 'must point at the portable option');
    return true;
  });
  assert.throws(() => resolveModel('claude', 'gpt-5.5'), /belongs to the codex engine/);
});

test('an unrecognised model is allowed through rather than guessed at', () => {
  // A new or self-hosted slug this table has never heard of must not be blocked
  // on a naming heuristic; the engine itself is the authority.
  assert.equal(resolveModel('claude', 'some-new-model').model, 'some-new-model');
});

test('identifies which engine a model name belongs to', () => {
  assert.equal(modelEngine('claude-haiku-4-5'), 'claude');
  assert.equal(modelEngine('gpt-5.5'), 'codex');
  assert.equal(modelEngine('o3-mini'), 'codex');
  assert.equal(modelEngine('mystery-model'), null);
  assert.equal(modelEngine(''), null);
});

test('tier detection does not mistake a model name for a tier', () => {
  assert.equal(isTier('fast'), true);
  assert.equal(isTier('claude-haiku-4-5'), false);
  assert.equal(isTier(undefined), false);
});

test('an empty model resolves to the engine default rather than throwing', () => {
  const r = resolveModel('codex', '');
  assert.equal(r.model, undefined);
  assert.equal(r.tier, null);
});

// ── the pre-switch audit ─────────────────────────────────────────────────────

test('the audit separates portable tasks from ones that would break', () => {
  const tasks = [
    { name: 'brief', model: 'balanced' },
    { name: 'sweep', model: 'claude-haiku-4-5' },
    { name: 'review', model: 'claude-sonnet-4-6' },
    { name: 'digest', model: 'deep' },
  ];
  const r = auditTasks(tasks, 'codex');
  assert.deepEqual(r.ok.sort(), ['brief', 'digest']);
  assert.deepEqual(r.blocked.map((b) => b.name).sort(), ['review', 'sweep']);
  assert.match(r.blocked[0].reason, /belongs to the claude engine/);
});

test('the audit passes everything when the engine is unchanged', () => {
  const tasks = [{ name: 'a', model: 'claude-haiku-4-5' }, { name: 'b', model: 'fast' }];
  assert.equal(auditTasks(tasks, 'claude').blocked.length, 0);
});

test('the audit tolerates an empty or missing task list', () => {
  assert.deepEqual(auditTasks([], 'codex'), { ok: [], blocked: [] });
  assert.deepEqual(auditTasks(undefined, 'codex'), { ok: [], blocked: [] });
});
