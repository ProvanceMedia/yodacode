// Commitments ledger tool — the store the daily sweep and chat turns share.
// Exercises the real CLI (spawned as a child) against a throwaway state dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../workspace/bin/commitments.js');
const STATE = mkdtempSync(path.join(os.tmpdir(), 'yc-commitments-'));
process.on('exit', () => rmSync(STATE, { recursive: true, force: true }));

function run(...args) {
  try {
    return { out: execFileSync('node', [TOOL, ...args], {
      env: { ...process.env, YODA_STATE_DIR: STATE },
      encoding: 'utf8',
    }).trim(), code: 0 };
  } catch (e) {
    return { out: `${e.stdout || ''}`.trim(), code: e.status ?? 1 };
  }
}

test('add: records a commitment and returns its id', () => {
  const r = run('add', '--text', 'Send Dave the quote', '--who', 'mine', '--source', 'email', '--due', 'Friday');
  assert.equal(r.out, 'ADDED 1');
  assert.ok(existsSync(path.join(STATE, 'commitments.json')), 'state file created');
});

test('add: the same commitment re-seen tomorrow is a DUP, not a ghost twin', () => {
  // Punctuation/case/whitespace differences must not defeat the dedupe — the
  // extractor will phrase it slightly differently on different days.
  const r = run('add', '--text', '  send dave the QUOTE!! ', '--who', 'mine', '--source', 'email');
  assert.equal(r.out, 'DUP 1');
  const db = JSON.parse(readFileSync(path.join(STATE, 'commitments.json'), 'utf8'));
  assert.equal(db.items.length, 1, 'no duplicate row was created');
});

test('add: same text from a different source IS a separate commitment', () => {
  const r = run('add', '--text', 'Send Dave the quote', '--who', 'mine', '--source', 'slack');
  assert.equal(r.out, 'ADDED 2');
});

test('list: shows open items with ledger ids; done removes from the open view', () => {
  assert.match(run('list').out, /1\. \[email\] Send Dave the quote\s+\(you promised\)\s+due: Friday/);
  assert.equal(run('done', '1').out, 'DONE 1');
  assert.ok(!run('list').out.includes('[email] Send Dave the quote'), 'done item gone from open list');
  assert.match(run('list', '--all').out, /\[done\]/, 'still visible with --all');
});

test('dismiss: a dismissed item stays gone even when the sweep re-finds it', () => {
  run('add', '--text', 'Grab coffee with Alex sometime', '--who', 'mine', '--source', 'slack');
  const id = JSON.parse(run('open-json').out).find((x) => x.text.includes('coffee')).id;
  assert.equal(run('dismiss', String(id)).out, `DISMISS ${id}`);
  // Tomorrow's sweep re-finds the identical commitment: it must be SUPPRESSED,
  // not resurrected — otherwise dismiss is meaningless and the digest nags forever.
  const re = run('add', '--text', 'Grab coffee with Alex sometime', '--who', 'mine', '--source', 'slack');
  assert.equal(re.out, `SUPPRESSED ${id}`);
  const again = JSON.parse(run('open-json').out).filter((x) => x.text.includes('coffee'));
  assert.equal(again.length, 0, 'nothing about it is open');
});

test('done does NOT suppress a recurrence: the weekly report can be tracked again', () => {
  run('add', '--text', 'Send the weekly report', '--who', 'mine', '--source', 'email');
  const id = JSON.parse(run('open-json').out).find((x) => x.text.includes('weekly report')).id;
  run('done', String(id));
  // Promised again the following week → a genuinely new instance, tracked fresh.
  const re = run('add', '--text', 'Send the weekly report', '--who', 'mine', '--source', 'email');
  assert.match(re.out, /^ADDED /, 'a completed commitment can recur as a new item');
});

test('chase: stamps lastChased so the digest can say "chased yesterday"', () => {
  const open = JSON.parse(run('open-json').out);
  const id = open[0].id;
  assert.equal(run('chase', String(id)).out, `CHASED ${id}`);
  const after = JSON.parse(run('open-json').out).find((x) => x.id === id);
  assert.ok(after.lastChased > 0);
});

test('open-json: machine view carries the fields the digest needs', () => {
  const open = JSON.parse(run('open-json').out);
  assert.ok(open.length >= 1);
  for (const it of open) {
    assert.ok(it.id && it.text && it.who && it.source, 'id/text/who/source all present');
    assert.equal(it.status, 'open');
  }
});

test('DUP merges new detail: a draft created on a re-seen commitment reaches the ledger', () => {
  run('add', '--text', 'Reply to the venue about catering', '--who', 'mine', '--source', 'email');
  // Next sweep re-finds it AND creates the draft — the DUP path must keep the
  // draft note, or every future sweep would re-create the same Gmail draft.
  const re = run('add', '--text', 'Reply to the venue about catering', '--who', 'mine', '--source', 'email',
    '--draft', 'in your Gmail drafts', '--due', 'Thursday');
  assert.match(re.out, /^DUP /);
  const it = JSON.parse(run('open-json').out).find((x) => x.text.includes('venue'));
  assert.equal(it.draft, 'in your Gmail drafts', 'draft note merged onto the open twin');
  assert.equal(it.due, 'Thursday', 'due date merged too');
});

test('the tool is executable exactly as every doc instructs (./bin/commitments.js …)', () => {
  // The cron prompt, CAPABILITIES.md and docs all invoke it directly — a lost
  // exec bit makes every documented call fail with "Permission denied".
  const out = execFileSync(TOOL, ['list'], {
    env: { ...process.env, YODA_STATE_DIR: STATE }, encoding: 'utf8',
  });
  assert.ok(out.length > 0, 'direct execution works (exec bit + shebang intact)');
});

test('bad input: unknown id and malformed add fail with non-zero exit', () => {
  assert.equal(run('done', '999').code, 1);
  assert.match(run('done', '999').out, /NOT_FOUND/);
  assert.equal(run('add', '--text', 'x', '--who', 'nobody', '--source', 'email').code, 1);
});

test('corrupt state file: tool starts fresh instead of crashing', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'yc-commitments-corrupt-'));
  try {
    execFileSync('node', ['-e', `require('fs').writeFileSync('${dir}/commitments.json','{not json')`]);
    const r = execFileSync('node', [TOOL, 'list'], {
      env: { ...process.env, YODA_STATE_DIR: dir }, encoding: 'utf8',
    }).trim();
    assert.match(r, /clean slate/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
