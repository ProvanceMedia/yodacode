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
const toolsMdClean = (dir) => {
  try {
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'workspace/TOOLS.md'], { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

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
