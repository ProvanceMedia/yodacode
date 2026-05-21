#!/usr/bin/env node
// @yoda-tool
// name: cron-runner.js
// summary: Run a declarative YAML cron task definition end-to-end (claude invoke + Slack delivery + reflectors).
// tags: cron, infra
// requires:
// usage:
//   node ./bin/cron-runner.js <task-name>
// examples:
//   node ./bin/cron-runner.js morning-brief
// @end
//
// Yoda declarative cron runner.
//
//   node ./bin/cron-runner.js <task-name>
//
// Reads ../cron-tasks/<task-name>.yaml, invokes `claude -p` with the
// declared prompt, optionally posts the output to a Slack channel, and
// optionally fires the skill + memory reflectors. One runner replaces
// ~80 lines of per-cron bash boilerplate.
//
// YAML schema (see cron-tasks/_template.yaml for an annotated example):
//
//   name: my-task                      # required
//   description: ...                   # optional
//   on_calendar: "..."                 # systemd OnCalendar (used by gen-timers.sh, not the runner)
//   model: claude-haiku-4-5            # optional; empty → default
//   timeout: 600                       # seconds, default 600
//   allowed_tools: [Bash, Read, ...]   # default sensible
//   thinking: true                     # default false
//   deliver:                           # optional auto-delivery
//     surface: slack
//     channel: D0AR8C2P814
//     format: "..."                    # template, supports {{output}} {{name}} {{today}}
//   reflect: true                      # opt-in skill + memory reflectors
//   prompt: |
//     ... multi-line prompt ...
//
// Prompts and the deliver.format support {{today}}, {{date}}, {{name}},
// and ${ENV_VAR} substitution.

import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const BIN_DIR = path.dirname(__filename);
const WORKSPACE = path.dirname(BIN_DIR);
const PROJECT_ROOT = path.dirname(WORKSPACE);
const CRON_TASKS_DIR = path.join(PROJECT_ROOT, 'cron-tasks');
const LOG_DIR = path.join(PROJECT_ROOT, 'logs');

function loadEnvFile(envPath) {
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

function logLine(logPath, line) {
  try { appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`); }
  catch (_) {}
}

function substitute(template, ctx) {
  if (!template) return '';
  let out = template
    .replace(/\{\{today\}\}/g, ctx.today)
    .replace(/\{\{date\}\}/g, ctx.today)
    .replace(/\{\{name\}\}/g, ctx.name)
    .replace(/\{\{output\}\}/g, ctx.output || '');
  out = out.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? '');
  return out;
}

function deliverOutput(deliver, ctx, logPath) {
  if (!deliver) return;
  if (deliver.surface === 'slack' && deliver.channel) {
    const slackTools = path.join(BIN_DIR, 'slack-tools.sh');
    if (!existsSync(slackTools)) {
      logLine(logPath, `deliver: slack-tools.sh not found, skipping`);
      return;
    }
    const text = deliver.format
      ? substitute(deliver.format, ctx)
      : ctx.output;
    const res = spawnSync(slackTools, ['post', deliver.channel, text], {
      cwd: WORKSPACE,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      logLine(logPath, `deliver slack: failed (${res.status}) — ${res.stderr || ''}`);
    } else {
      logLine(logPath, `deliver slack: posted to ${deliver.channel}`);
    }
  }
}

function triggerReflection(taskName, prompt, output) {
  // Librarian crons don't reflect on themselves.
  if (taskName === 'memory-consolidate' || taskName === 'skill-review') return;
  const skillOn = process.env.YODA_SKILL_REFLECTOR_ENABLED === '1';
  const memoryOn = process.env.YODA_MEMORY_REFLECTOR_ENABLED === '1';
  if (!skillOn && !memoryOn) return;
  const helper = path.join(CRON_TASKS_DIR, 'lib', 'reflect-after.sh');
  if (!existsSync(helper)) return;
  // bash -c invocation; the helper spawns its own detached children.
  const child = spawn('bash', [
    '-c',
    `. "${helper}" && reflect_after_cron "$0" "$1" "$2"`,
    taskName,
    prompt,
    output,
  ], {
    cwd: WORKSPACE,
    env: { ...process.env, ANTHROPIC_API_KEY: '' },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}

function main() {
  const taskName = process.argv[2];
  if (!taskName) {
    console.error('usage: cron-runner.js <task-name>');
    process.exit(2);
  }
  const taskPath = path.join(CRON_TASKS_DIR, `${taskName}.yaml`);
  if (!existsSync(taskPath)) {
    console.error(`task definition not found: ${taskPath}`);
    process.exit(2);
  }

  let def;
  try {
    def = parseYaml(readFileSync(taskPath, 'utf8'));
  } catch (e) {
    console.error(`failed to parse ${taskPath}: ${e.message}`);
    process.exit(2);
  }
  if (!def || !def.name || !def.prompt) {
    console.error(`${taskPath}: missing required field (name, prompt)`);
    process.exit(2);
  }

  // Load .env (idempotent — won't override systemd EnvironmentFile)
  loadEnvFile(path.join(PROJECT_ROOT, '.env'));
  delete process.env.ANTHROPIC_API_KEY;  // force OAuth/sub auth

  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${def.name}.log`);
  const today = new Date().toISOString().slice(0, 10);
  const ctx = { today, name: def.name, output: '' };

  logLine(logPath, `${def.name} starting`);

  // Optional pre_hook: bash command(s) run BEFORE the claude invocation.
  // Useful for jitter sleeps, queue topups, anything the agent shouldn't
  // wait on with its own turn quota. The hook runs in workspace/ with the
  // same env as claude. Hook stdout/stderr go to the log.
  if (def.pre_hook) {
    logLine(logPath, `pre_hook running`);
    const hook = spawnSync('bash', ['-c', def.pre_hook], {
      cwd: WORKSPACE,
      env: { ...process.env, ANTHROPIC_API_KEY: '' },
      encoding: 'utf8',
      timeout: (def.pre_hook_timeout || 3600) * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (hook.stdout) logLine(logPath, `pre_hook stdout:\n${hook.stdout.trim()}`);
    if (hook.stderr) logLine(logPath, `pre_hook stderr:\n${hook.stderr.trim()}`);
    if (hook.status !== 0) {
      logLine(logPath, `pre_hook exited ${hook.status} — continuing anyway`);
    }
  }

  const prompt = substitute(def.prompt, ctx);
  const tools = (def.allowed_tools || [
    'Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'Glob', 'Grep'
  ]).join(',');
  const args = [
    '-p', prompt,
    '--output-format', 'text',
    '--permission-mode', def.permission_mode || 'acceptEdits',
    '--allowed-tools', tools,
  ];
  if (def.model) args.push('--model', def.model);
  if (def.thinking) args.push('--thinking', 'enabled');

  const timeoutMs = (def.timeout || 600) * 1000;
  const claudeBin = process.env.CLAUDE_BIN || 'claude';

  const res = spawnSync(claudeBin, args, {
    cwd: WORKSPACE,
    env: { ...process.env, ANTHROPIC_API_KEY: '' },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 50 * 1024 * 1024,
  });

  const output = ((res.stdout || '') + (res.stderr ? `\n${res.stderr}` : '')).trim();
  ctx.output = output;
  logLine(logPath, output);

  // Even when claude exits non-zero, we may still have useful output — try to deliver.
  if (res.status !== 0 && !res.stdout) {
    logLine(logPath, `${def.name} FAILED (exit ${res.status ?? 'null'})`);
  }

  if (def.deliver) {
    try { deliverOutput(def.deliver, ctx, logPath); }
    catch (e) { logLine(logPath, `deliver failed: ${e.message}`); }
  }

  if (def.reflect) {
    try { triggerReflection(def.name, prompt, output); }
    catch (e) { logLine(logPath, `reflection trigger failed: ${e.message}`); }
  }

  logLine(logPath, `${def.name} finished (exit ${res.status ?? 'null'})`);
  process.exit(res.status === 0 ? 0 : (res.status ?? 1));
}

main();
