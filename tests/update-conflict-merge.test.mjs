// merge_favor_operator (scripts/common.sh) — the update path's conflict resolver.
// Exercised against real git repos with genuine 3-way conflicts. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMON = path.join(REPO, 'scripts', 'common.sh');

function bash(script, cwd) {
  return execFileSync('bash', ['-euo', 'pipefail', '-c', script], { cwd, encoding: 'utf8' });
}
// merge_favor_operator's return code + stdout, run in `cwd`.
function runResolver(cwd) {
  return execFileSync('bash', ['-c', `source '${COMMON}'; out="$(merge_favor_operator)"; rc=$?; printf '%s\\nRC=%s\\n' "$out" "$rc"`],
    { cwd, encoding: 'utf8' });
}

// A repo where HEAD (upstream) and a merged branch (operator) both changed the SHARED
// line, and upstream separately appended a line further down (separated by unchanged
// context). `git merge` leaves it conflicted — exactly like a conflicted stash-pop.
function conflictedRepo({ extraConflict = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-upd-'));
  const app = (v) => (extraConflict ? `printf '${v}\\n' > workspace/app.js` : ':');
  bash(`
    git init -q -b main; git config user.email t@t; git config user.name t; git config commit.gpgsign false
    mkdir -p workspace/skills
    printf 'intro\\nSHARED original\\nmiddle\\nouter\\n' > workspace/SOUL.md
    ${app('v0')}
    git add -A; git commit -qm base
    # upstream: change SHARED + append a line at the end (separated by middle/outer)
    printf 'intro\\nSHARED placeholder\\nmiddle\\nouter\\nUPSTREAM NEW\\n' > workspace/SOUL.md
    ${app('v-upstream')}
    git commit -qam upstream
    # operator branch off base: change SHARED their way
    git checkout -q -b operator HEAD~1
    printf 'intro\\nSHARED operator-custom\\nmiddle\\nouter\\n' > workspace/SOUL.md
    ${app('v-operator')}
    git commit -qam operator
    git checkout -q main
    git merge --no-edit operator >/dev/null 2>&1 || true   # conflict expected
  `, dir);
  return dir;
}

test('operator wins the clashing line; upstream non-conflicting change (separated by context) still lands', () => {
  const dir = conflictedRepo();
  const out = runResolver(dir);
  const soul = fs.readFileSync(path.join(dir, 'workspace/SOUL.md'), 'utf8');
  assert.match(out, /workspace\/SOUL\.md/, 'reports the auto-resolved file');
  assert.match(out, /RC=0/, 'returns success');
  assert.match(soul, /SHARED operator-custom/, 'operator version wins the conflict');
  assert.doesNotMatch(soul, /SHARED placeholder/, 'upstream side of the conflict dropped');
  assert.match(soul, /UPSTREAM NEW/, "upstream's separated addition kept");
  assert.match(soul, /intro/, 'untouched content preserved');
  assert.doesNotMatch(soul, /^[<>=]{7}/m, 'no conflict markers remain');
  assert.equal(bash('git diff --name-only --diff-filter=U', dir).trim(), '', 'tree fully merged');
});

test('a conflict in a NON-operator file is left for a human and returns non-zero', () => {
  const dir = conflictedRepo({ extraConflict: true });
  const out = runResolver(dir);
  assert.match(out, /RC=1/, 'returns 1 when a non-operator file still conflicts');
  assert.match(fs.readFileSync(path.join(dir, 'workspace/SOUL.md'), 'utf8'), /SHARED operator-custom/, 'the persona doc is still auto-resolved');
  assert.equal(bash('git diff --name-only --diff-filter=U', dir).trim(), 'workspace/app.js', 'only the non-operator file remains unmerged');
});

test('a clean tree (no unmerged files) is a no-op returning success', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-upd-'));
  bash(`git init -q -b main; git config user.email t@t; git config user.name t; printf x > a; git add -A; git commit -qm x`, dir);
  assert.match(runResolver(dir), /RC=0/, 'no-op success on an already-clean tree');
});
