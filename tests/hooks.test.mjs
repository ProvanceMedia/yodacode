// lib/hooks.js — the outbound-action gate. The classifier is the security
// boundary here, so it gets the most attention: a false negative sends
// something irreversible. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The hooks write a real audit log to config.stateDir. Point that at a temp
// dir BEFORE the module graph loads, or running the suite drops a state/
// directory in the repo root and dirties the working tree. config.js reads
// the environment once at import, so this has to precede the import — hence
// the dynamic form.
process.env.YODA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-hooks-'));
const { classifyExternalWrite, isExternalActionAuthorized, buildHooks } =
  await import('../workspace/lib/hooks.js');

// ─── classifier: things that reach the outside world ───────────────────────

test('classifies always-external broker tools', () => {
  for (const cmd of [
    "./bin/broker call slack_post '{\"channel\":\"C123\",\"text\":\"hi\"}'",
    'broker call slack_upload --channel C123 --file ./report.xlsx',
    "bin/broker call ssh_exec '{\"host\":\"box\",\"cmd\":\"systemctl restart api\"}'",
  ]) {
    assert.ok(classifyExternalWrite(cmd), `should be external: ${cmd}`);
  }
});

test('http_call is judged on its HTTP verb', () => {
  assert.equal(classifyExternalWrite('broker call http_call --host api.x.com --path v1/me'), null,
    'no --method defaults to GET, which only reads');
  assert.equal(classifyExternalWrite('broker call http_call --host api.x.com --method GET'), null);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const hit = classifyExternalWrite(`broker call http_call --host api.x.com --method ${method}`);
    assert.ok(hit, `${method} should be external`);
    assert.match(hit.detail, new RegExp(method));
  }
});

test('http_call reads the verb out of the JSON form too', () => {
  const hit = classifyExternalWrite(
    `broker call http_call '{"host":"api.stripe.com","path":"v1/charges","method":"POST"}'`);
  assert.ok(hit);
  assert.match(hit.detail, /POST/);
  assert.match(hit.detail, /api\.stripe\.com/);
});

test('slack_api defaults to external unless the method is a known read', () => {
  assert.equal(
    classifyExternalWrite(`broker call slack_api '{"method":"conversations.history"}'`), null);
  assert.equal(
    classifyExternalWrite('broker call slack_api --method users.info'), null);

  assert.ok(classifyExternalWrite(`broker call slack_api '{"method":"chat.postMessage"}'`));
  assert.ok(classifyExternalWrite('broker call slack_api --method chat.delete'));
  // Unreadable method must NOT be treated as safe.
  assert.ok(classifyExternalWrite('broker call slack_api'),
    'a slack_api call whose method we cannot see must count as external');
});

test('named services fall back to the name when the verb is invisible', () => {
  assert.ok(classifyExternalWrite("broker call send_invoice '{\"to\":\"a@b.c\"}'"));
  assert.ok(classifyExternalWrite("broker call create_ticket '{}'"));
  assert.equal(classifyExternalWrite("broker call weather_lookup '{\"city\":\"London\"}'"), null);
  // An explicit read verb on a send-shaped name still reads.
  assert.equal(classifyExternalWrite('broker call send_invoice --method GET'), null);
});

test('slack-tools.sh gates the subcommands that reach a human', () => {
  for (const sub of ['post', 'reply', 'update', 'upload']) {
    assert.ok(classifyExternalWrite(`./bin/slack-tools.sh ${sub} C123 "hello"`),
      `${sub} should be external`);
  }
  for (const sub of ['fetch', 'list', 'thread', 'whoami', 'react', 'mark']) {
    assert.equal(classifyExternalWrite(`./bin/slack-tools.sh ${sub} C123`), null,
      `${sub} should not be gated`);
  }
});

test('purely local commands are never flagged', () => {
  for (const cmd of [
    'ls -la', 'cat memory/2026-07-29.md', 'git status', 'npm test',
    'grep -rn broker lib/', './bin/memory-search.sh "deploy"',
    'broker manifest', 'broker status', 'broker ping',
  ]) {
    assert.equal(classifyExternalWrite(cmd), null, `should be local: ${cmd}`);
  }
});

test('classifier survives commands embedded in a shell pipeline', () => {
  assert.ok(classifyExternalWrite('cd /app/workspace && ./bin/broker call slack_post --channel C1 --text hi'));
  assert.ok(classifyExternalWrite('echo start; broker call ssh_exec --host box --cmd uptime'));
});

test('classifier is total — no input crashes it', () => {
  for (const bad of [undefined, null, '', 0, {}, [], 'broker call']) {
    assert.doesNotThrow(() => classifyExternalWrite(bad));
  }
});

// ─── turn authorisation ────────────────────────────────────────────────────

test('a request to act externally authorises the turn', () => {
  for (const t of [
    'email Bob the summary', 'send it to the team', 'reply to that thread',
    'post this in #general', 'DM Sarah the link', 'upload the spreadsheet',
    'deploy it', 'ssh in and restart the api',
  ]) {
    assert.ok(isExternalActionAuthorized(t), `should authorise: ${t}`);
  }
});

test('plain assent authorises the turn', () => {
  for (const t of ['yes', 'yep', 'go ahead', 'do it', 'send it', 'ok', 'confirmed', 'ship it']) {
    assert.ok(isExternalActionAuthorized(t), `should authorise: ${t}`);
  }
});

test('idle chat and read-only requests do not authorise', () => {
  for (const t of [
    '', '   ', 'what did we decide yesterday?', 'summarise this doc',
    'how many open PRs are there', 'thanks!',
  ]) {
    assert.equal(isExternalActionAuthorized(t), false, `should NOT authorise: ${t}`);
  }
});

// ─── hook behaviour ────────────────────────────────────────────────────────

const preToolUseInput = (command) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  tool_use_id: 't1',
  session_id: 's1',
  transcript_path: '/tmp/t.jsonl',
  cwd: '/app/workspace',
});

async function runGate(hooks, command) {
  return hooks.PreToolUse[0].hooks[0](preToolUseInput(command), 't1', { signal: null });
}

test("confirm mode denies an unauthorised send, and says why", async () => {
  const hooks = buildHooks({ mode: 'confirm', authorized: false, conversationId: 'c1', surface: 'slack' });

  const out = await runGate(hooks, './bin/broker call slack_post --channel C1 --text hi');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /confirm/i);
  // The model must be told not to route around it.
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /not.*retry|route around/i);
});

test('confirm mode allows the same send once the turn is authorised', async () => {
  const hooks = buildHooks({ mode: 'confirm', authorized: true, conversationId: 'c1', surface: 'slack' });

  const out = await runGate(hooks, './bin/broker call slack_post --channel C1 --text hi');
  assert.deepEqual(out, {}, 'an authorised send must pass through untouched');
});

test('local commands are never gated, authorised or not', async () => {
  const hooks = buildHooks({ mode: 'confirm', authorized: false });
  assert.deepEqual(await runGate(hooks, 'ls -la'), {});
  assert.deepEqual(await runGate(hooks, 'git log --oneline -5'), {});
});

test('audit mode never blocks', async () => {
  const hooks = buildHooks({ mode: 'audit', authorized: false });
  const out = await runGate(hooks, './bin/broker call slack_post --channel C1 --text hi');
  assert.deepEqual(out, {}, 'audit mode observes, it does not intervene');
});

test('off disables hooks entirely', () => {
  assert.equal(buildHooks({ mode: 'off', authorized: false }), undefined);
});

test('a subagent gets no exemption from the gate', async () => {
  const hooks = buildHooks({ mode: 'confirm', authorized: false });
  const input = { ...preToolUseInput('broker call slack_post --channel C1 --text hi'), agent_id: 'sub-7' };
  const out = await hooks.PreToolUse[0].hooks[0](input, 't1', { signal: null });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('audit mode records what confirm mode WOULD have blocked', async () => {
  // Without this, audit mode is not a dry run: it says an external call
  // happened but not whether the gate would have stopped it.
  const hooks = buildHooks({ mode: 'audit', authorized: false, conversationId: 'c9' });
  const out = await runGate(hooks, 'broker call slack_post --channel C1 --text hi');
  assert.deepEqual(out, {}, 'audit must not block');

  const entry = fs.readFileSync(path.join(process.env.YODA_STATE_DIR, 'external-calls.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l))
    .find((l) => l.conversationId === 'c9');
  assert.ok(entry, 'the attempt must be logged');
  assert.equal(entry.blocked, false, 'audit mode blocks nothing');
  assert.equal(entry.wouldBlock, true, 'but it must record that confirm WOULD have');
});

test('failed external calls are audited too, not just successful ones', () => {
  // A Bash command that exits non-zero fires PostToolUseFailure, NOT
  // PostToolUse. Registering only the latter loses every failed send.
  const hooks = buildHooks({ mode: 'audit' });
  assert.ok(hooks.PostToolUseFailure, 'PostToolUseFailure must be registered');
  assert.equal(hooks.PostToolUseFailure[0].matcher, 'Bash');
  assert.equal(typeof hooks.PostToolUseFailure[0].hooks[0], 'function');
});

test('hooks are shaped the way the SDK expects', () => {
  const hooks = buildHooks({ mode: 'audit' });
  for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PreCompact']) {
    assert.ok(Array.isArray(hooks[event]), `${event} must be a matcher array`);
    assert.ok(Array.isArray(hooks[event][0].hooks), `${event} matcher needs a hooks array`);
    assert.equal(typeof hooks[event][0].hooks[0], 'function');
  }
  assert.equal(hooks.PreToolUse[0].matcher, 'Bash');
});
