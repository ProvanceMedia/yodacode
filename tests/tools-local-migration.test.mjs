// ensure_tools_local() (scripts/common.sh) — the TOOLS.md → TOOLS.local.md split
// migration. Exercised against throwaway git repos so no real install is touched.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMON = path.join(REPO, 'scripts', 'common.sh');
const TEMPLATE = path.join(REPO, 'templates', 'TOOLS.local.md.template');

// Build a minimal fake install (git repo with a committed TOOLS.md + template),
// run a bash snippet that sources the REAL common.sh and calls ensure_tools_local,
// and hand back the resulting tree for assertions.
function scenario(setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-toolslocal-'));
  fs.mkdirSync(path.join(dir, 'workspace'));
  fs.mkdirSync(path.join(dir, 'templates'));
  fs.copyFileSync(TEMPLATE, path.join(dir, 'templates', 'TOOLS.local.md.template'));
  fs.writeFileSync(path.join(dir, 'workspace', 'TOOLS.md'), '# TOOLS.md (shipped)\n\nReference only.\n');
  fs.writeFileSync(path.join(dir, 'workspace', 'AGENTS.md'), '# AGENTS.md (shipped)\n\nWorkspace rules.\n');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@e.st');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-qm', 'base');
  setup(dir, git); // mutate the working tree before the migration runs
  execFileSync('bash', ['-c', `set -uo pipefail; cd "${dir}"; source "${COMMON}"; ensure_tools_local`], { stdio: 'pipe' });
  return dir;
}

const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const exists = (dir, f) => fs.existsSync(path.join(dir, f));
const fileClean = (dir, f) => {
  try {
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', f], { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};
const toolsMdClean = (dir) => fileClean(dir, 'workspace/TOOLS.md');

test('fresh install: seeds TOOLS.local.md from the template, leaves TOOLS.md alone', () => {
  const dir = scenario(() => {});
  assert.ok(exists(dir, 'workspace/TOOLS.local.md'), 'notes file created');
  assert.match(read(dir, 'workspace/TOOLS.local.md'), /your service notes/i);
  assert.ok(toolsMdClean(dir), 'TOOLS.md untouched');
});

test('legacy install: rescues appended notes and restores TOOLS.md so a pull is clean', () => {
  const marker = '## MyCamera  (host: cam.local)\n- Notes: rtsp on :554, admin/admin\n';
  const dir = scenario((d) => {
    fs.appendFileSync(path.join(d, 'workspace', 'TOOLS.md'), '\n' + marker);
  });
  const local = read(dir, 'workspace/TOOLS.local.md');
  assert.match(local, /MyCamera/, 'rescued the appended service block');
  assert.match(local, /rtsp on :554/, 'rescued the note body');
  assert.match(local, /recovered from your edited TOOLS.md/, 'marked the rescued block');
  assert.ok(toolsMdClean(dir), 'TOOLS.md restored to HEAD — a fast-forward pull will not be blocked');
});

test('AGENTS.md is NOT rescued/reverted: in-place customizations are left for the update to merge', () => {
  // AGENTS.md holds deliberate edits (tool paths, security rules), not append-notes.
  // ensure_tools_local must leave them ALONE — reverting would destroy them.
  const custom = '2. Run `./bin/memory-search.sh` for it\n';
  const dir = scenario((d) => {
    const p = path.join(d, 'workspace', 'AGENTS.md');
    fs.appendFileSync(p, '\n' + custom);
  });
  assert.ok(!fileClean(dir, 'workspace/AGENTS.md'), 'AGENTS.md left modified (not reverted)');
  assert.match(read(dir, 'workspace/AGENTS.md'), /memory-search\.sh/, 'the customization survives intact');
  const local = read(dir, 'workspace/TOOLS.local.md');
  assert.doesNotMatch(local, /memory-search\.sh/, 'AGENTS.md content was NOT lifted into TOOLS.local.md');
});

test('only TOOLS.md is rescued when both it and AGENTS.md are dirty', () => {
  const dir = scenario((d) => {
    fs.appendFileSync(path.join(d, 'workspace', 'TOOLS.md'), '\n## SvcA (host: a.io)\n- note A\n');
    fs.appendFileSync(path.join(d, 'workspace', 'AGENTS.md'), '\n- a deliberate AGENTS edit\n');
  });
  assert.match(read(dir, 'workspace/TOOLS.local.md'), /note A/, 'TOOLS.md notes rescued');
  assert.ok(toolsMdClean(dir), 'TOOLS.md reverted to shipped');
  assert.ok(!fileClean(dir, 'workspace/AGENTS.md'), 'AGENTS.md left for the update to merge');
});

test('zero-loss on +-prefixed notes: markdown bullets, phone numbers, blank lines survive', () => {
  // git diff renders each added line as +<content>; a note whose OWN content
  // starts with + becomes ++... — the rescue must strip exactly one marker.
  const notes = [
    '## Notes',
    '+ RTSP bullet on :554', // markdown '+' bullet
    '',                       // blank line between notes
    '+44 20 7946 0000 is the outbound SMS number', // leading-+ phone number
    '- normal dash bullet',
  ].join('\n');
  const dir = scenario((d) => {
    fs.appendFileSync(path.join(d, 'workspace', 'TOOLS.md'), '\n' + notes + '\n');
  });
  const local = read(dir, 'workspace/TOOLS.local.md');
  assert.match(local, /\+ RTSP bullet on :554/, 'markdown + bullet preserved verbatim');
  assert.match(local, /\+44 20 7946 0000 is the outbound SMS number/, 'leading-+ phone number preserved');
  assert.match(local, /- normal dash bullet/, 'dash bullet preserved');
  assert.ok(toolsMdClean(dir), 'source restored — no lingering divergence');
});

test('deletion-only divergence leaves no empty recovered stanza', () => {
  const dir = scenario((d) => {
    // Remove a shipped line (a pure deletion, no additions).
    const p = path.join(d, 'workspace', 'TOOLS.md');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('Reference only.\n', ''));
  });
  const local = read(dir, 'workspace/TOOLS.local.md');
  assert.doesNotMatch(local, /recovered from your edited TOOLS.md/, 'no empty rescue stanza');
  assert.ok(toolsMdClean(dir));
});

test('dangling-import guard: TOOLS.local.md is created even when the template is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-notemplate-'));
  fs.mkdirSync(path.join(dir, 'workspace'));
  fs.mkdirSync(path.join(dir, 'templates')); // deliberately empty — no template shipped yet
  fs.writeFileSync(path.join(dir, 'workspace', 'TOOLS.md'), '# TOOLS.md (shipped)\n');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 't@e.st'); git('config', 'user.name', 'T');
  git('add', '-A'); git('commit', '-qm', 'base');
  execFileSync('bash', ['-c', `set -uo pipefail; cd "${dir}"; source "${COMMON}"; ensure_tools_local`], { stdio: 'pipe' });
  assert.ok(exists(dir, 'workspace/TOOLS.local.md'), 'stub created so the @-import is never dangling');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('idempotent: a second run on a clean tree changes nothing', () => {
  const dir = scenario(() => {});
  const before = read(dir, 'workspace/TOOLS.local.md');
  execFileSync('bash', ['-c', `set -uo pipefail; cd "${dir}"; source "${COMMON}"; ensure_tools_local`], { stdio: 'pipe' });
  assert.equal(read(dir, 'workspace/TOOLS.local.md'), before, 'notes file unchanged on re-run');
  assert.ok(toolsMdClean(dir));
});

test('preserves existing notes: rescue appends, never clobbers a prior TOOLS.local.md', () => {
  const dir = scenario((d) => {
    fs.writeFileSync(path.join(d, 'workspace', 'TOOLS.local.md'), '# TOOLS.local.md\n\n## Kept earlier\n- keep me\n');
    fs.appendFileSync(path.join(d, 'workspace', 'TOOLS.md'), '\n## LaterService  (host: api.later.io)\n');
  });
  const local = read(dir, 'workspace/TOOLS.local.md');
  assert.match(local, /keep me/, 'pre-existing notes retained');
  assert.match(local, /LaterService/, 'newly rescued notes appended');
  assert.ok(toolsMdClean(dir));
});

// Integration: mirror cmd_update's git sequence (ensure_tools_local → stash →
// pull --ff-only → stash pop) end-to-end, proving an in-place AGENTS.md
// customization survives an update that ALSO changed AGENTS.md.
test('update flow: an AGENTS.md customization is merged, not lost, across a pull that changed it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-updateflow-'));
  const run = (cwd, ...args) => execFileSync(args[0], args.slice(1), { cwd, stdio: 'pipe', encoding: 'utf8' });
  const git = (cwd, ...a) => run(cwd, 'git', ...a);
  // origin + upstream working clone
  git(root, 'init', '-q', '--bare', 'origin.git');
  const up = path.join(root, 'up');
  git(root, 'clone', '-q', path.join(root, 'origin.git'), 'up');
  git(up, 'config', 'user.email', 'u@p'); git(up, 'config', 'user.name', 'up');
  fs.mkdirSync(path.join(up, 'workspace'));
  fs.mkdirSync(path.join(up, 'templates'));
  fs.copyFileSync(TEMPLATE, path.join(up, 'templates', 'TOOLS.local.md.template'));
  fs.writeFileSync(path.join(up, 'workspace', 'TOOLS.md'), '# TOOLS.md\n\nOld ref.\n');
  fs.writeFileSync(path.join(up, 'workspace', 'AGENTS.md'), 'line1: shipped\nline2: shipped\nline3: shipped\n');
  git(up, 'add', '-A'); git(up, 'commit', '-qm', 'v1'); git(up, 'push', '-q', 'origin', 'HEAD:main');
  // operator clone, customizes AGENTS.md line3 (a deliberate in-place edit)
  const box = path.join(root, 'box');
  git(root, 'clone', '-q', path.join(root, 'origin.git'), 'box');
  git(box, 'config', 'user.email', 'b@x'); git(box, 'config', 'user.name', 'box');
  git(box, 'checkout', '-qB', 'main', 'origin/main');
  fs.writeFileSync(path.join(box, 'workspace', 'AGENTS.md'), 'line1: shipped\nline2: shipped\nline3: MY CUSTOM RULE\n');
  // upstream ships a change to a DIFFERENT line of AGENTS.md
  fs.writeFileSync(path.join(up, 'workspace', 'AGENTS.md'), 'line1: UPSTREAM v2\nline2: shipped\nline3: shipped\n');
  git(up, 'commit', '-qam', 'v2'); git(up, 'push', '-q', 'origin', 'HEAD:main');
  git(box, 'fetch', '-q');
  // run cmd_update's reconciliation sequence
  execFileSync('bash', ['-c', `set -uo pipefail; cd "${box}"
    source "${COMMON}"; ensure_tools_local
    git diff --quiet HEAD || git stash push -m up --quiet
    git pull --ff-only --quiet
    git stash list | grep -q . && git stash pop --quiet`], { stdio: 'pipe' });
  const agents = fs.readFileSync(path.join(box, 'workspace', 'AGENTS.md'), 'utf8');
  assert.match(agents, /MY CUSTOM RULE/, 'the operator customization survived the update');
  assert.match(agents, /line1: UPSTREAM v2/, 'the upstream change was also applied (3-way merge)');
  assert.doesNotMatch(agents, /<<<<<<</, 'no conflict markers for non-overlapping edits');
  fs.rmSync(root, { recursive: true, force: true });
});
