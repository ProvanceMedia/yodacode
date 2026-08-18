// Flattening the persona for an engine with no @-imports.
//
// The behaviour under test is mostly about what must NOT happen silently: a
// missing document, an import line surviving into a file no engine will act on,
// or the whole persona quietly exceeding the size the engine will read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assemblePersona, writePersona, parseImports,
} from '../workspace/lib/engine/codex/persona.js';

function workspace(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'yoda-persona-'));
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, name);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

const ROOT = `# Yoda

You are **Yoda**, someone's personal agent.

## Your persona — load these first

@./IDENTITY.md
@./SOUL.md
@./skills/INDEX.md

These define who you are.
`;

test('finds the imported document paths in order', () => {
  assert.deepEqual(parseImports(ROOT), ['IDENTITY.md', 'SOUL.md', 'skills/INDEX.md']);
});

test('ignores things that merely look like imports', () => {
  assert.deepEqual(parseImports('email me @ someone@example.com\n@ not a path\ntext @./x.md inline'), []);
});

test('inlines every document, in order, with its provenance', () => {
  const dir = workspace({
    'CLAUDE.md': ROOT,
    'IDENTITY.md': 'I am Yoda.',
    'SOUL.md': 'Be warm.',
    'skills/INDEX.md': '- writing',
  });
  try {
    const r = assemblePersona({ workspace: dir });
    assert.deepEqual(r.included, ['IDENTITY.md', 'SOUL.md', 'skills/INDEX.md']);
    assert.deepEqual(r.missing, []);
    for (const s of ['I am Yoda.', 'Be warm.', '- writing']) assert.ok(r.text.includes(s));
    assert.ok(r.text.indexOf('I am Yoda.') < r.text.indexOf('Be warm.'), 'order preserved');
    assert.ok(r.text.includes('<!-- from IDENTITY.md -->'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strips the import lines, which no longer mean anything', () => {
  const dir = workspace({ 'CLAUDE.md': ROOT, 'IDENTITY.md': 'x', 'SOUL.md': 'y', 'skills/INDEX.md': 'z' });
  try {
    const { text } = assemblePersona({ workspace: dir });
    assert.ok(!/^@\.\//m.test(text),
      'an import line left in the file tells the model to load something it cannot load');
    // The surrounding prose must survive — only the directives go.
    assert.ok(text.includes('These define who you are.'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reports missing documents instead of dropping them quietly', () => {
  const dir = workspace({ 'CLAUDE.md': ROOT, 'SOUL.md': 'Be warm.' });
  try {
    const r = assemblePersona({ workspace: dir });
    assert.deepEqual(r.missing, ['IDENTITY.md', 'skills/INDEX.md']);
    assert.deepEqual(r.included, ['SOUL.md']);
    // Still produces a usable persona — a partial agent beats no agent.
    assert.ok(r.text.includes('Be warm.'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an empty document counts as missing, not as included', () => {
  const dir = workspace({ 'CLAUDE.md': ROOT, 'IDENTITY.md': '   \n', 'SOUL.md': 'y', 'skills/INDEX.md': 'z' });
  try {
    const r = assemblePersona({ workspace: dir });
    assert.ok(r.missing.includes('IDENTITY.md'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('flags when the result exceeds what the engine will read', () => {
  const dir = workspace({ 'CLAUDE.md': ROOT, 'IDENTITY.md': 'x'.repeat(5000), 'SOUL.md': 'y', 'skills/INDEX.md': 'z' });
  try {
    assert.equal(assemblePersona({ workspace: dir, maxBytes: 1024 }).truncated, true);
    assert.equal(assemblePersona({ workspace: dir, maxBytes: 1024 * 1024 }).truncated, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing source file is reported rather than throwing', () => {
  const dir = workspace({});
  try {
    const r = assemblePersona({ workspace: dir });
    assert.deepEqual(r.missing, ['CLAUDE.md']);
    assert.equal(r.text, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writes AGENTS.override.md — which REPLACES AGENTS.md on this engine', () => {
  const dir = workspace({
    'CLAUDE.md': ROOT, 'IDENTITY.md': 'I am Yoda.', 'SOUL.md': 'Be warm.', 'skills/INDEX.md': '- writing',
    // The workspace's own AGENTS.md carries operating rules. Codex sends ONLY
    // the override when both exist, so those rules have to travel inside the
    // assembled file or they are silently lost.
    'AGENTS.md': 'WORKSPACE_RULE: always check the broker first.',
  });
  try {
    const r = writePersona({ workspace: dir });
    const written = readFileSync(path.join(dir, 'AGENTS.override.md'), 'utf8');
    assert.equal(r.target, 'AGENTS.override.md');
    assert.ok(written.includes('I am Yoda.'));
    // AGENTS.md is not in this CLAUDE.md's import list, so it is NOT included —
    // and that is exactly the silent-loss case the persona check has to catch.
    assert.ok(!written.includes('WORKSPACE_RULE'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the real template lists AGENTS.md among its imports', () => {
  // Guards the case above: as long as CLAUDE.md.template imports AGENTS.md, the
  // assembled override carries the workspace rules. If someone removes that
  // import, this test fails rather than the agent quietly losing the rules.
  const tpl = readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'templates', 'CLAUDE.md.template'), 'utf8');
  assert.ok(parseImports(tpl).includes('AGENTS.md'),
    'CLAUDE.md.template must import AGENTS.md, or Codex loses the workspace rules');
});
