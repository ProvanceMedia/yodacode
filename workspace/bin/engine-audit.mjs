#!/usr/bin/env node
// @yoda-tool
// name: engine-audit.mjs
// summary: Check cron tasks and the stored credential against a target engine, before switching to it.
// tags: cron, infra
// usage:
//   node ./bin/engine-audit.mjs <claude|codex>
// examples:
//   node ./bin/engine-audit.mjs codex
// @end
//
// Runs BEFORE an engine change, and deliberately touches nothing. Two questions:
//
//   1. Would any cron task break on the target engine? A task pinned to the
//      current engine's model keeps that value after the switch and then fails
//      on its own schedule, which is the worst way to find out.
//   2. Is there a usable credential for the target? Checked by decoding the
//      token locally — never by asking the engine, which can consume a
//      single-use refresh token just by being asked.
//
// Output is line-oriented for the shell to read: OK / BLOCKED / CRED lines.
// Exit 0 means the switch is safe to make.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { auditTasks } from '../lib/engine/model-tiers.js';
import { tokenExpiryMs } from '../lib/engine/codex/adapter.js';

const WORKSPACE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CRON_DIR = path.join(path.dirname(WORKSPACE), 'cron-tasks');

const target = (process.argv[2] || '').trim();
if (!['claude', 'codex'].includes(target)) {
  console.error('usage: engine-audit.mjs <claude|codex>');
  process.exit(2);
}

// ── crons ────────────────────────────────────────────────────────────────────
const tasks = [];
if (existsSync(CRON_DIR)) {
  for (const f of readdirSync(CRON_DIR)) {
    if (!f.endsWith('.yaml') || f.startsWith('_')) continue;
    try {
      const def = parseYaml(readFileSync(path.join(CRON_DIR, f), 'utf8'));
      if (def?.name) tasks.push({ name: def.name, model: def.model, effort: def.effort, file: f });
    } catch {
      console.log(`UNPARSEABLE ${f}`);
    }
  }
}

const { ok, blocked } = auditTasks(tasks, target);
for (const name of ok) console.log(`OK ${name}`);
for (const b of blocked) console.log(`BLOCKED ${b.name} ${b.model}`);

// ── credential ───────────────────────────────────────────────────────────────
let credOk = false;
if (target === 'codex') {
  const home = process.env.CODEX_HOME || '/home/yoda/.codex';
  const ms = tokenExpiryMs(home);
  if (ms > 0) { credOk = true; console.log(`CRED ok ${Math.floor(ms / 86400000)}`); }
  else if (existsSync(path.join(home, 'auth.json'))) console.log('CRED expired');
  else console.log('CRED missing');
} else {
  // Claude's credential is an env var carried into the container.
  const tok = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
  if (tok.startsWith('sk-ant-')) { credOk = true; console.log('CRED ok'); }
  else console.log('CRED missing');
}

process.exit(blocked.length === 0 && credOk ? 0 : 1);
