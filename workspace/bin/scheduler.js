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
import { readFileSync, readdirSync, existsSync, watch } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { CronExpressionParser } from 'cron-parser';

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.dirname(BIN_DIR);
const PROJECT_ROOT = path.dirname(WORKSPACE);
const CRON_TASKS_DIR = path.join(PROJECT_ROOT, 'cron-tasks');
const TZ = process.env.TZ || 'UTC';

function log(...a) {
  console.error(`[scheduler ${new Date().toISOString()}]`, ...a);
}

// ── systemd OnCalendar → 5-field cron, for the forms our crons actually use ──
// Supports: weekday prefix (Mon, Mon..Fri), date part "*-*-*" (ignored = every day),
// and a time "H..H:MM" / "HH:MM[:SS]" / "HH,HH:MM" with optional "/step" on the hour.
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function dowField(tok) {
  if (!tok) return '*';
  const m = tok.toLowerCase().match(/^([a-z]{3})(?:\.\.([a-z]{3}))?$/);
  if (!m) return null;
  const a = DOW[m[1]];
  if (a == null) return null;
  if (!m[2]) return String(a);
  const b = DOW[m[2]];
  if (b == null) return null;
  return `${a}-${b}`;
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
    if (/^[A-Za-z]{3}(\.\.[A-Za-z]{3})?$/.test(tok)) { dow = dowField(tok) ?? dow; }
    else if (tok.includes('-')) { datePart = tok; } // *-*-* date (we only support "every day")
    else if (tok.includes(':')) { timePart = tok; }
  }
  if (!timePart) return null;
  if (datePart && !/^\*-\*-\*$/.test(datePart)) return null; // specific dates unsupported
  const tf = timeFields(timePart);
  if (!tf) return null;
  return `${tf.minute} ${tf.hour} * * ${dow}`;
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

function clearAll() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

function runTask(name) {
  log(`firing ${name}`);
  const child = spawn(process.execPath, [path.join(BIN_DIR, 'cron-runner.js'), name], {
    cwd: WORKSPACE,
    stdio: 'inherit',
  });
  child.on('exit', (code) => log(`${name} exited ${code}`));
}

function scheduleNext(name, cronExpr) {
  let it;
  try {
    it = CronExpressionParser.parse(cronExpr, { tz: TZ });
  } catch (e) {
    log(`WARN: bad cron "${cronExpr}" for ${name}: ${e.message}`);
    return;
  }
  const next = it.next().toDate();
  const delay = Math.max(1000, next.getTime() - Date.now());
  const t = setTimeout(() => {
    runTask(name);
    scheduleNext(name, cronExpr); // re-arm for the following occurrence
  }, delay);
  if (t.unref) t.unref();
  timers.set(name, t);
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
  log(`starting (tz ${TZ})`);
  loadAll();
  watchTasks();
  process.on('SIGTERM', () => { clearAll(); process.exit(0); });
  process.on('SIGINT', () => { clearAll(); process.exit(0); });
  setInterval(() => {}, 1 << 30); // keep alive
}

// Only run the loop when executed directly, not when imported for testing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
