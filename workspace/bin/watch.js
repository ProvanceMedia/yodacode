#!/usr/bin/env node
// @yoda-tool
// name: watch.js
// summary: Set a BACKGROUND WATCH — poll a shell command after this turn ends and ping THIS thread when it finishes (or times out). How you keep a promise like "I'll tell you when the deploy is done" instead of falsely claiming you'll return.
// tags: automation
// requires:
// usage:
//   ./bin/watch.js create --label "<what>" --command "<bash; exit 0 = done>" [--every 30s] [--timeout 20m] [--report "<what to tell them>"]
//   ./bin/watch.js list
//   ./bin/watch.js cancel <id>
// examples:
//   ./bin/watch.js create --label "prod deploy" --command "curl -sf https://mysite/health" --every 30s --timeout 20m --report "confirm the site is live and on the new version"
//   ./bin/watch.js create --label "build" --command "test -f /tmp/build/DONE" --every 15s --timeout 30m
//   ./bin/watch.js create --label "job log" --command "grep -q FINISHED /var/log/job.log" --every 1m --timeout 2h
// @end
//
// To wait for specific OUTPUT rather than an exit code, put the match in the
// command itself so it runs sandboxed — e.g. --command "curl -s $URL | grep -q DONE".
//
// Runs INSIDE an agent turn (you invoke it via Bash). It reads the conversation
// identity the runner injected (YODA_CONVERSATION_ID / SURFACE / USER_ID /
// REPLY_TARGET), writes a watch descriptor to state/watches/, and returns. The
// resident supervisor then polls the command; when it succeeds — or the
// deadline passes — it wakes THIS thread with a fresh turn (your session
// resumed) so you can report the outcome. Frame --command so exit 0 means the
// thing you're waiting for is DONE (e.g. a health check passing, a file
// existing, a log line appearing). Nothing you background yourself survives the
// end of this turn — a watch is the only thing that does.

import { watchStore } from '../lib/watch-store.js';

// Safety bounds. claude-runner forwards the operator's live YODA_WATCH_* values
// into this child's env (its curated env would otherwise strip them), so the CLI
// enforces the real limits; the hardcoded numbers are the fallback + match the
// config defaults. The watcher additionally re-clamps interval + deadline, so
// these are a fast create-time check, not the sole enforcement point.
const intEnv = (name, fallback) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const DEFAULT_INTERVAL_MS = intEnv('YODA_WATCH_DEFAULT_INTERVAL_MS', 60_000);
const MIN_INTERVAL_MS = intEnv('YODA_WATCH_MIN_INTERVAL_MS', 15_000);
const DEFAULT_TIMEOUT_MS = intEnv('YODA_WATCH_DEFAULT_TIMEOUT_MS', 60 * 60_000);
const MAX_TIMEOUT_MS = intEnv('YODA_WATCH_MAX_TIMEOUT_MS', 24 * 60 * 60_000);
const MAX_ACTIVE = intEnv('YODA_WATCH_MAX_ACTIVE', 50);

function parseDuration(str, fallback) {
  if (str == null || str === '') return fallback;
  const m = String(str).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return Math.round(n * mult);
}

// All flags take a value; positionals collect in _.
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) out[t.slice(2)] = argv[++i];
    else out._.push(t);
  }
  return out;
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function newId() {
  return `w_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function fmtMs(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function identity() {
  return {
    conversationId: process.env.YODA_CONVERSATION_ID || '',
    surface: process.env.YODA_SURFACE || '',
    userId: process.env.YODA_USER_ID || '',
    replyTargetRaw: process.env.YODA_REPLY_TARGET || '',
    enabled: process.env.YODA_WATCH_ENABLED !== '0',
  };
}

function cmdCreate(args) {
  const id = identity();
  if (!id.enabled) {
    die('Background watches are disabled on this install (YODA_WATCH_ENABLED=0).');
  }
  if (!id.conversationId || !id.surface || !id.replyTargetRaw) {
    die('No conversation context — watches can only be set from an interactive message, not a cron/subagent run.');
  }

  const command = args.command;
  if (!command) die('Missing --command. Give a bash command that exits 0 when the thing you\'re waiting for is done.');

  let replyTarget;
  try {
    replyTarget = JSON.parse(id.replyTargetRaw);
  } catch (e) {
    die(`Corrupt YODA_REPLY_TARGET (${e.message}).`);
  }

  const active = watchStore.list().filter((w) => !w.state || w.state === 'active');
  if (active.length >= MAX_ACTIVE) {
    die(`Too many active watches (${active.length}/${MAX_ACTIVE}). Cancel some with \`./bin/watch.js cancel <id>\` first.`);
  }

  const intervalReq = parseDuration(args.every, DEFAULT_INTERVAL_MS);
  if (intervalReq === null) die(`Bad --every "${args.every}". Use e.g. 30s, 2m, 1h.`);
  const timeoutReq = parseDuration(args.timeout, DEFAULT_TIMEOUT_MS);
  if (timeoutReq === null) die(`Bad --timeout "${args.timeout}". Use e.g. 20m, 2h.`);
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, timeoutReq);
  // Floor at the min interval, but never exceed the timeout — otherwise the
  // watch would deadline out before its first poll ever runs.
  const intervalMs = Math.min(timeoutMs, Math.max(MIN_INTERVAL_MS, intervalReq));

  const now = Date.now();
  const watch = {
    id: newId(),
    createdAt: now,
    surface: id.surface,
    conversationId: id.conversationId,
    userId: id.userId,
    replyTarget,
    label: args.label || command.slice(0, 60),
    report: args.report || '',
    check: {
      command,
      successExit: 0,
    },
    intervalMs,
    checkTimeoutMs: null, // null = use the server default
    deadlineAt: now + timeoutMs,
    nextCheckAt: now + intervalMs, // first poll after one interval — give it time
    attempts: 0,
    errorCount: 0,
    state: 'active',
  };
  watchStore.save(watch);

  console.log(
    `Watch set: ${watch.id} — "${watch.label}"\n` +
    `  polling every ${fmtMs(intervalMs)} until the command exits 0; gives up after ${fmtMs(timeoutMs)}.\n` +
    `  I'll report back in this thread when it fires. Tell the user this, then end your turn — do NOT wait.`,
  );
}

function cmdList() {
  const all = watchStore.list().filter((w) => !w.state || w.state === 'active');
  if (!all.length) {
    console.log('No active watches.');
    return;
  }
  const now = Date.now();
  const mine = process.env.YODA_CONVERSATION_ID || '';
  for (const w of all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
    const due = Math.max(0, (w.nextCheckAt || now) - now);
    const left = Math.max(0, (w.deadlineAt || now) - now);
    const here = w.conversationId === mine ? ' (this thread)' : '';
    console.log(
      `${w.id} — ${w.label}${here}\n` +
      `  command: ${w.check?.command}\n` +
      `  next check in ${fmtMs(due)}, expires in ${fmtMs(left)}, ${w.attempts || 0} checks so far`,
    );
  }
}

function cmdCancel(args) {
  const id = args._[0];
  if (!id) die('Usage: ./bin/watch.js cancel <id>  (see `./bin/watch.js list` for ids)');
  console.log(watchStore.remove(id) ? `Cancelled ${id}.` : `No watch ${id} (already fired or cancelled?).`);
}

function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const args = parseArgs(argv.slice(1));
  switch (sub) {
    case 'create': return cmdCreate(args);
    case 'list': return cmdList(args);
    case 'cancel': return cmdCancel(args);
    default:
      console.error('Usage:\n  ./bin/watch.js create --label "<what>" --command "<bash; exit 0 = done>" [--every 30s] [--timeout 20m] [--report "<what to tell them>"]\n  ./bin/watch.js list\n  ./bin/watch.js cancel <id>');
      process.exit(sub ? 1 : 0);
  }
}

main();
