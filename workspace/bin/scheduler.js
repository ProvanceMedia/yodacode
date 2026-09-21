#!/usr/bin/env node
// In-container cron scheduler. Replaces the host systemd timers: reads every
// cron-tasks/<name>.yaml, works out when each should fire, and runs
// `cron-runner.js <name>` at that time — all inside the container, no systemd.
//
// Scheduling field (in the YAML), in order of precedence:
//   schedule:    "*/30 7-20 * * 1-5"   ← standard 5-field cron (canonical)
//   on_calendar: "Mon..Fri *-*-* 07..20:00/30"  ← systemd syntax (common forms translated)
//   disabled: true                     ← skip this task
//
// The agent can create/edit/enable/disable a cron just by writing the YAML file;
// the scheduler watches the directory and reloads. No host privileges involved.
import { readFileSync, readdirSync, existsSync, watch, mkdirSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { CronExpressionParser } from 'cron-parser';

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.dirname(BIN_DIR);
const PROJECT_ROOT = path.dirname(WORKSPACE);
const CRON_TASKS_DIR = path.join(PROJECT_ROOT, 'cron-tasks');
// Drop a file named after a task in here to run it NOW (out of schedule). This is
// how the agent (and the operator) trigger manual runs: the agent's own spawned
// workers have no auth token by design, but the scheduler does — so it runs the
// task exactly like a scheduled fire. `touch state/cron-triggers/<task-name>`.
const TRIGGER_DIR = path.join(WORKSPACE, 'state', 'cron-triggers');
const TZ = process.env.TZ || 'UTC';
const DRY = process.env.YODA_SCHEDULER_DRY === '1'; // test mode: log fires, don't spawn

function log(...a) {
  console.error(`[scheduler ${new Date().toISOString()}]`, ...a);
}

// ── systemd OnCalendar → 5-field cron, for the forms our crons actually use ──
// Supports: weekday prefix (Mon, Mon..Fri, Mon,Thu), date part "*-*-*" (every day)
// or "*-*-D[,D...]" (day-of-month list), and a time "H..H:MM" / "HH:MM[:SS]" /
// "HH,HH:MM" with optional "/step" on the hour.
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function dowField(tok) {
  if (!tok) return '*';
  // weekday, a range (Mon..Fri / Mon-Fri), or a comma list of either (Mon,Thu)
  const out = [];
  for (const part of tok.toLowerCase().split(',')) {
    const m = part.match(/^([a-z]{3})(?:(?:\.\.|-)([a-z]{3}))?$/);
    if (!m) return null;
    const a = DOW[m[1]];
    if (a == null) return null;
    if (!m[2]) { out.push(String(a)); continue; }
    const b = DOW[m[2]];
    if (b == null) return null;
    out.push(`${a}-${b}`);
  }
  return out.join(',');
}

// "07..20:00/30" -> {hour:"7-20", minute:"0,30"}; "10,14:00" -> {hour:"10,14", minute:"0"}
// "09:30:00" -> {hour:"9", minute:"30"}; "03:00" -> {hour:"3", minute:"0"}
function timeFields(tok) {
  let step = null;
  let t = tok;
  const sm = t.match(/\/(\d+)$/);
  if (sm) { step = Number(sm[1]); t = t.replace(/\/\d+$/, ''); }
  const parts = t.split(':');
  if (parts.length < 2) return null;
  const hourSpec = parts[0];
  const minute = String(Number(parts[1])); // seconds ignored
  // hour spec may be H..H (range), H,H (list), or H. The /step (if any) is a
  // MINUTE step within each of those hours — it never narrows the hour set.
  const r = hourSpec.match(/^(\d+)\.\.(\d+)$/);
  const hour = r
    ? `${Number(r[1])}-${Number(r[2])}`
    : hourSpec.split(',').map((x) => String(Number(x))).join(',');
  const minField = step ? `*/${step}` : minute;
  return { hour, minute: minField };
}

export function onCalendarToCron(expr) {
  // strip a trailing timezone name if present (we apply TZ separately)
  const tokens = expr.trim().replace(/\s+[A-Za-z]+\/[A-Za-z_]+$/, '').trim().split(/\s+/);
  let dow = '*';
  let datePart = null;
  let timePart = null;
  for (const tok of tokens) {
    // Weekday (Mon / Mon..Fri / Mon-Fri / Mon,Thu) — must be tested before the date
    // branch, since a "-" range would otherwise look like a date token.
    if (/^[A-Za-z]{3}(?:(?:\.\.|-)[A-Za-z]{3})?(?:,[A-Za-z]{3}(?:(?:\.\.|-)[A-Za-z]{3})?)*$/.test(tok)) { dow = dowField(tok) ?? dow; }
    else if (tok.includes(':')) { timePart = tok; }
    else if (tok.includes('-')) { datePart = tok; } // *-*-* or *-*-D[,D...] date
  }
  if (!timePart) return null;
  let dom = '*';
  if (datePart) {
    const dm = datePart.match(/^\*-\*-(\*|\d+(?:,\d+)*)$/);
    if (!dm) return null; // other specific-date forms unsupported
    dom = dm[1];
  }
  const tf = timeFields(timePart);
  if (!tf) return null;
  return `${tf.minute} ${tf.hour} ${dom} * ${dow}`;
}

function cronFor(def) {
  if (def.disabled) return null;
  if (def.schedule) return String(def.schedule).trim();
  if (def.on_calendar) {
    const c = onCalendarToCron(String(def.on_calendar));
    if (!c) log(`WARN: could not translate on_calendar "${def.on_calendar}" — add a 'schedule:' cron field`);
    return c;
  }
  return null;
}

// ── scheduling loop ──────────────────────────────────────────────────────────
const timers = new Map(); // name -> Timeout
const MAX_DELAY = 2147483647; // Node turns larger delays into 1 ms.
const MIN_RUN_INTERVAL = 10_000; // Last line of defence against rapid spawn loops.

function clearAll() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

const running = new Map(); // name -> child (refuse overlapping fires from any source)
const lastRun = new Map(); // monotonic timestamps; deliberately survive schedule reloads
const lastRefusal = new Map(); // throttle guard warnings too

function refuseTask(name, reason, now) {
  if (now - (lastRefusal.get(name) ?? -Infinity) >= MIN_RUN_INTERVAL) {
    log(`WARN: refusing ${name}: ${reason}`);
    lastRefusal.set(name, now);
  }
}

function runTask(name, source = 'schedule') {
  const now = performance.now();
  if (running.has(name)) {
    refuseTask(name, 'already running', now);
    return;
  }
  if (now - (lastRun.get(name) ?? -Infinity) < MIN_RUN_INTERVAL) {
    refuseTask(name, `minimum run interval is ${MIN_RUN_INTERVAL} ms`, now);
    return;
  }
  lastRun.set(name, now);
  log(`firing ${name}${source === 'manual' ? ' (manual trigger)' : ''}`);
  if (DRY) { log(`DRY: would spawn cron-runner.js ${name}`); return; }
  const child = spawn(process.execPath, [path.join(BIN_DIR, 'cron-runner.js'), name], {
    cwd: WORKSPACE,
    stdio: 'inherit',
  });
  running.set(name, child);
  child.on('exit', (code) => {
    running.delete(name);
    log(`${name} exited ${code}`);
  });
  child.on('error', (err) => {
    running.delete(name);
    log(`ERROR: could not spawn ${name}: ${err.message}`);
  });
}

// ── manual triggers ──────────────────────────────────────────────────────────
// A file appearing in TRIGGER_DIR named <task> (extension ignored) fires that task
// immediately. Watched + polled (fs.watch can be unreliable on bind mounts).
function knownTask(name) {
  return existsSync(path.join(CRON_TASKS_DIR, `${name}.yaml`));
}

function checkTriggers() {
  let files;
  try {
    files = readdirSync(TRIGGER_DIR);
  } catch {
    return;
  }
  for (const f of files) {
    if (f.startsWith('.')) continue;
    const name = f.replace(/\.[a-z]+$/i, '');
    try { unlinkSync(path.join(TRIGGER_DIR, f)); } catch { continue; } // claimed by someone else
    if (!knownTask(name)) {
      log(`trigger for unknown task "${name}" ignored (no cron-tasks/${name}.yaml)`);
      continue;
    }
    runTask(name, 'manual');
  }
}

function watchTriggers() {
  try { mkdirSync(TRIGGER_DIR, { recursive: true }); } catch (_) {}
  try {
    watch(TRIGGER_DIR, { persistent: false }, () => setTimeout(checkTriggers, 200));
  } catch (e) {
    log(`WARN: cannot watch trigger dir: ${e.message}`);
  }
  const poll = setInterval(checkTriggers, 5000); // reliable fallback
  if (poll.unref) poll.unref();
}

// Wait against an absolute deadline so chunk boundaries and late callbacks do
// not accumulate drift. Keep the current chunk in timers so reload/shutdown
// always cancels it. Never pass a long cron delay directly to setTimeout.
function armTimer(name, targetMs, fire) {
  if (!Number.isFinite(targetMs)) {
    log(`ERROR: refusing invalid timer target for ${name}: ${targetMs}`);
    return;
  }
  const delay = Math.min(MAX_DELAY, Math.max(1, targetMs - Date.now()));
  const t = setTimeout(() => {
    if (timers.get(name) !== t) return;
    if (Date.now() < targetMs) {
      armTimer(name, targetMs, fire);
      return;
    }
    timers.delete(name);
    fire();
  }, delay);
  if (t.unref) t.unref();
  timers.set(name, t);
}

function scheduleNext(name, cronExpr) {
  let next;
  try {
    next = CronExpressionParser.parse(cronExpr, { tz: TZ }).next().toDate();
  } catch (e) {
    log(`WARN: bad cron "${cronExpr}" for ${name}: ${e.message}`);
    return;
  }
  const target = Math.max(Date.now() + 1000, next.getTime());
  armTimer(name, target, () => {
    runTask(name);
    scheduleNext(name, cronExpr); // re-arm for the following occurrence
  });
  log(`${name}: next run ${next.toISOString()} (cron "${cronExpr}", tz ${TZ})`);
}

function loadAll() {
  clearAll();
  if (!existsSync(CRON_TASKS_DIR)) { log(`no cron-tasks dir at ${CRON_TASKS_DIR}`); return; }
  const files = readdirSync(CRON_TASKS_DIR).filter((f) => f.endsWith('.yaml') && f !== '_template.yaml');
  let scheduled = 0;
  for (const f of files) {
    let def;
    try {
      def = parseYaml(readFileSync(path.join(CRON_TASKS_DIR, f), 'utf8'));
    } catch (e) {
      log(`WARN: ${f} parse error: ${e.message}`);
      continue;
    }
    if (!def || !def.name) continue;
    const cronExpr = cronFor(def);
    if (!cronExpr) { if (def.disabled) log(`${def.name}: disabled`); continue; }
    scheduleNext(def.name, cronExpr);
    scheduled++;
  }
  log(`loaded ${scheduled} scheduled task(s) from ${files.length} file(s)`);
}

// Reload on any change in the cron-tasks dir (debounced) so the agent editing a
// YAML takes effect without a restart.
let reloadTimer = null;
function watchTasks() {
  if (!existsSync(CRON_TASKS_DIR)) return;
  try {
    watch(CRON_TASKS_DIR, { persistent: false }, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { log('cron-tasks changed, reloading'); loadAll(); }, 1500);
    });
  } catch (e) {
    log(`WARN: cannot watch cron-tasks: ${e.message}`);
  }
}

function main() {
  process.on('warning', (warning) => {
    if (warning.name === 'TimeoutOverflowWarning') {
      log(`ERROR: timer overflow detected; check scheduler timers: ${warning.message}`);
    }
  });
  log(`starting (tz ${TZ})`);
  loadAll();
  watchTasks();
  watchTriggers();
  process.on('SIGTERM', () => { clearAll(); process.exit(0); });
  process.on('SIGINT', () => { clearAll(); process.exit(0); });
  setInterval(() => {}, 1 << 30); // keep alive
}

// Only run the loop when executed directly, not when imported for testing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
