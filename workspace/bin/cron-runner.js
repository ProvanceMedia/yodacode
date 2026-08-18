#!/usr/bin/env node
// @yoda-tool
// name: cron-runner.js
// summary: Run a declarative YAML cron task definition end-to-end (agent invoke + Slack delivery + reflectors).
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
// Reads ../cron-tasks/<task-name>.yaml, runs the declared prompt through the
// Claude Agent SDK, optionally posts the output to a Slack channel, and
// optionally fires the skill + memory reflectors. One runner replaces
// ~80 lines of per-cron bash boilerplate.
//
// YAML schema (see cron-tasks/_template.yaml for an annotated example):
//
//   name: my-task                      # required
//   description: ...                   # optional
//   on_calendar: "..."                 # systemd OnCalendar (used by gen-timers.sh, not the runner)
//   model: claude-haiku-4-5            # required; every cron names its model
//   timeout: 600                       # seconds, default 600
//   allowed_tools: [Bash, Read, ...]   # default sensible
//   effort: xhigh                      # low|medium|high|xhigh|max; omit = model default
//   deliver:                           # optional auto-delivery
//     surface: slack
//     channel: D0123456789
//     format: "..."                    # template, supports {{output}} {{name}} {{today}}
//   reflect: true                      # opt-in skill + memory reflectors
//   prompt: |
//     ... multi-line prompt ...
//
// Prompts and the deliver.format support {{today}}, {{date}}, {{name}},
// and ${ENV_VAR} substitution.

import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { runAgentText } from '../lib/agent-query.js';
import { reflectAfterCron } from '../lib/cron-reflect.js';

const __filename = fileURLToPath(import.meta.url);
const BIN_DIR = path.dirname(__filename);
const WORKSPACE = path.dirname(BIN_DIR);
const PROJECT_ROOT = path.dirname(WORKSPACE);
const CRON_TASKS_DIR = path.join(PROJECT_ROOT, 'cron-tasks');
const LOG_DIR = path.join(PROJECT_ROOT, 'logs');

function loadEnvFile(envPath) {
  if (!existsSync(envPath)) return;
  // In a container the agent is non-root and may not be able to read a root-only
  // .env — fine: its config comes from the container env, keys from the broker.
  let contents;
  try {
    contents = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const raw of contents.split('\n')) {
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

let logWriteWarned = false;
function logLine(logPath, line) {
  const entry = `[${new Date().toISOString()}] ${line}\n`;
  try {
    appendFileSync(logPath, entry);
  } catch (e) {
    // Never lose run records silently: fall back to stderr (the scheduler inherits
    // it, so this lands in `docker compose logs`) and say why, once per run.
    if (!logWriteWarned) {
      logWriteWarned = true;
      console.error(`[cron-runner] WARN cannot write ${logPath}: ${e.message} — logging to stderr. Fix: chmod g+w on the logs dir/files.`);
    }
    console.error(entry.trimEnd());
  }
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

async function main() {
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
  if (!def.model) {
    console.error(`${taskPath}: missing required field 'model:' — every cron must name its model explicitly`);
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

  // Optional pre_hook: bash command(s) run BEFORE the agent invocation.
  // Useful for jitter sleeps, queue topups, anything the agent shouldn't
  // wait on with its own turn quota. The hook runs in workspace/ with the
  // same env as the agent. Hook stdout/stderr go to the log.
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
  const allowedTools = def.allowed_tools || [
    'Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Glob', 'Grep',
  ];
  const timeoutMs = (def.timeout || 600) * 1000;

  // Optional credential isolation. Inside a container the boundary is the
  // container itself (unprivileged user, no service keys) — honour `deroot:`
  // only on a bare-metal host install, where the run gets a curated
  // secret-free env (credentialed calls go through `broker call …`) and,
  // when this runner is root, the SDK child is spawned as the unprivileged
  // agent user. See docs/BROKER.md and lib/agent-query.js.
  const inContainer = process.env.YODA_IN_CONTAINER === '1' || existsSync('/.dockerenv');
  const deroot = !!def.deroot && !inContainer;
  if (deroot) {
    logLine(logPath, `deroot: curated secret-free env via broker; secrets withheld from agent`);
  }

  const stderrBuf = [];
  const res = await runAgentText({
    prompt,
    model: def.model,
    effort: def.effort,
    allowedTools,
    permissionMode: def.permission_mode || 'acceptEdits',
    cwd: WORKSPACE,
    deroot,
    timeoutMs,
    stderr: (data) => { if (stderrBuf.join('').length < 16384) stderrBuf.push(String(data)); },
  });

  let output = (res.text || '').trim();
  if (!res.ok) {
    if (res.timedOut) {
      logLine(logPath, `${def.name} TIMED OUT after ${Math.round(timeoutMs / 1000)}s`);
    } else {
      logLine(logPath, `${def.name} FAILED: ${res.error || 'unknown'}`);
    }
    const stderr = stderrBuf.join('').trim();
    if (stderr) logLine(logPath, `agent stderr (tail):\n${stderr.split('\n').slice(-10).join('\n')}`);
    if (!output) output = `(no output — ${res.error || 'run failed'})`;
  }
  ctx.output = output;
  logLine(logPath, output);

  // Even on failure we may still have useful output — try to deliver.
  if (def.deliver) {
    try { deliverOutput(def.deliver, ctx, logPath); }
    catch (e) { logLine(logPath, `deliver failed: ${e.message}`); }
  }

  if (def.reflect) {
    try {
      await reflectAfterCron({
        taskName: def.name,
        cronPrompt: prompt,
        cronOutput: output,
        cwd: WORKSPACE,
        deroot,
        log: (l) => logLine(logPath, l),
      });
    } catch (e) {
      logLine(logPath, `reflection trigger failed: ${e.message}`);
    }
  } else {
    logLine(logPath, `reflection skipped (reflect: false in yaml)`);
  }

  logLine(logPath, `${def.name} finished (ok=${res.ok})`);
  process.exit(res.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`[cron-runner] fatal: ${e.message}`);
  process.exit(1);
});
