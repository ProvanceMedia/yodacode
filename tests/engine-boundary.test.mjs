// One rule: nothing runs a turn except through the engine seam.
//
// This exists because of a real regression. lib/agent-query.js called the Claude
// SDK's query() directly, so crons and all three reflectors ran on Claude no
// matter which engine the install was configured for. Everything else was
// correct — the model tier resolved against the right engine, the tests passed —
// and the work was handed to the wrong engine at the last step. On a Codex
// install it failed as "OAuth access token is invalid", on a schedule, with
// nobody watching.
//
// A source-level check is crude, but it catches the shape of that mistake in a
// way behavioural tests did not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workspace');

/** Every .js/.mjs file under workspace/, excluding dependencies. */
function sources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(js|mjs)$/.test(entry)) out.push(p);
  }
  return out;
}

const FILES = sources(ROOT);

test('only the Claude adapter may call the SDK that runs a turn', () => {
  const offenders = [];
  for (const file of FILES) {
    const rel = path.relative(ROOT, file);
    if (rel === path.join('lib', 'engine', 'claude.js')) continue;
    const src = readFileSync(file, 'utf8');
    // `query` is the call that RUNS a turn. AbortError is a type used for
    // classifying a stop and is harmless to import anywhere.
    const importsQuery = /import\s*\{[^}]*\bquery\b[^}]*\}\s*from\s*['"]@anthropic-ai\/claude-agent-sdk['"]/.test(src);
    if (importsQuery) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    `these run a turn outside the engine seam, so they ignore YODA_ENGINE: ${offenders.join(', ')}`);
});

test('the engine module knows about both engines', async () => {
  const { ENGINE_IDS } = await import('../workspace/lib/engine/index.js');
  assert.deepEqual([...ENGINE_IDS].sort(), ['claude', 'codex']);
});

test('an unknown engine fails loudly rather than falling back', async () => {
  const { selectEngine } = await import('../workspace/lib/engine/index.js');
  assert.throws(() => selectEngine('gemini'), /unknown engine/i,
    'falling back would run turns on an engine the operator did not choose, and bill the wrong account');
});

test('both engines implement the whole interface', async () => {
  const { selectEngine, ENGINE_IDS } = await import('../workspace/lib/engine/index.js');
  for (const id of ENGINE_IDS) {
    const e = selectEngine(id);
    for (const method of ['run', 'isAbortError', 'isResumeFailure', 'preflight']) {
      assert.equal(typeof e[method], 'function', `${id}.${method} must be a function`);
    }
    for (const cap of ['toolUseIds', 'atImports', 'throttleSignal', 'rootInstructionFile', 'shellToolName']) {
      assert.ok(cap in e.caps, `${id}.caps.${cap} must be declared, not left to be discovered`);
    }
  }
});

// ── settings that outlive an engine change ───────────────────────────────────
// YODA_CLAUDE_MODEL, the /opus and /sonnet shortcuts, a thread-sticky effort:
// none of them change when the engine does. Sent to the wrong engine they come
// back as a raw provider error mid-conversation, which is a poor way to find out
// that a setting from the other engine is still in place.

test('an engine refuses to send a model belonging to another engine', async () => {
  const { selectEngine } = await import('../workspace/lib/engine/index.js');
  const codex = selectEngine('codex');
  assert.equal(codex.mapModel('claude-opus-5'), undefined, 'must fall back to the engine default');
  assert.equal(codex.mapModel('claude-sonnet-5'), undefined);
  assert.equal(codex.mapModel('gpt-5.5'), 'gpt-5.5', 'its own models still pass through');
});

test('the Claude engine still takes its own models unchanged', async () => {
  const { selectEngine } = await import('../workspace/lib/engine/index.js');
  const claude = selectEngine('claude');
  assert.equal(claude.mapModel('claude-opus-5'), 'claude-opus-5');
  assert.equal(claude.mapModel(''), undefined);
});

test('an effort level the engine does not have is dropped, not sent', async () => {
  const { selectEngine } = await import('../workspace/lib/engine/index.js');
  const codex = selectEngine('codex');
  assert.equal(codex.mapEffort('max'), undefined, "'max' is a Claude level");
  assert.equal(codex.mapEffort('xhigh'), 'xhigh');
  assert.equal(selectEngine('claude').mapEffort('max'), 'max');
});

test('every engine implements the mapping methods', async () => {
  const { selectEngine, ENGINE_IDS } = await import('../workspace/lib/engine/index.js');
  for (const id of ENGINE_IDS) {
    for (const m of ['mapModel', 'mapEffort']) {
      assert.equal(typeof selectEngine(id)[m], 'function', `${id}.${m}`);
    }
  }
});

test('a configured Codex model is used instead of a leftover Claude one', () => {
  // config.js reads the environment once at import, so this has to run in a
  // fresh process to mean anything — an in-process env tweak would test nothing.
  const script = `
    import { selectEngine } from './workspace/lib/engine/index.js';
    process.stdout.write(String(selectEngine('codex').mapModel('claude-opus-5')));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, YODA_ENGINE: 'codex', YODA_CODEX_MODEL: 'gpt-5.4' },
    encoding: 'utf8',
  });
  assert.equal(out.trim(), 'gpt-5.4',
    "the operator's choice for THIS engine must win over the other engine's leftover");
});
