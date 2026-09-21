import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const schedulerUrl = new URL('../workspace/bin/scheduler.js', import.meta.url);
const require = createRequire(schedulerUrl);
const { CronExpressionParser } = require('cron-parser');
const MAX_DELAY = 2147483647;
// Execute the real scheduler with an isolated clock and process boundary. No
// cron-runner can be started by these tests, even against the vulnerable code.
const source = readFileSync(schedulerUrl, 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace(/^export /gm, '')
  .replaceAll('import.meta.url', JSON.stringify(schedulerUrl.href));

function harness(start = '2026-09-17T08:00:00.000Z', dry = true) {
  let now = Date.parse(start);
  let monotonic = 0;
  const pending = new Set();
  const logs = [];
  const children = [];
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    Date: Clock, path, fileURLToPath,
    performance: { now: () => monotonic },
    process: { env: { TZ: 'UTC', YODA_SCHEDULER_DRY: dry ? '1' : '0' }, argv: [], execPath: process.execPath },
    console: { error: (...args) => logs.push(args.join(' ')) },
    CronExpressionParser: { parse: (expr, options) => CronExpressionParser.parse(expr, { ...options, currentDate: new Date(now) }) },
    setTimeout(callback, delay) {
      assert.ok(delay >= 1 && delay <= MAX_DELAY, `unsafe timer delay: ${delay}`);
      const timer = { callback, delay, at: now + delay, unref() { this.unreffed = true; } };
      pending.add(timer);
      return timer;
    },
    clearTimeout(timer) { pending.delete(timer); },
    spawn() { const child = new EventEmitter(); children.push(child); return child; },
  });
  vm.runInContext(source, context, { filename: 'scheduler.js' });
  return {
    context, pending, logs, children,
    eval: (code) => vm.runInContext(code, context),
    advance(ms) {
      const end = now + ms;
      let callbacks = 0;
      while (true) {
        const timer = [...pending].sort((a, b) => a.at - b.at)[0];
        if (!timer || timer.at > end) break;
        assert.ok(++callbacks < 1000, 'scheduler entered a hot loop');
        monotonic += timer.at - now;
        now = timer.at;
        pending.delete(timer);
        timer.callback();
      }
      monotonic += end - now;
      now = end;
    },
    shiftWall(ms) { now += ms; },
    fires: () => logs.filter((line) => line.includes('] firing ')),
  };
}

for (const [name, cron, start, target] of [
  ['monthly', '0 8 17 * *', '2026-09-17T08:00:00Z', '2026-10-17T08:00:00Z'],
  ['annual-16', '0 8 16 9 *', '2026-09-17T08:00:00Z', '2027-09-16T08:00:00Z'],
  ['annual-17', '0 8 17 9 *', '2026-09-17T08:00:00Z', '2027-09-17T08:00:00Z'],
  ['daily', '0 8 * * *', '2026-09-17T08:00:00Z', '2026-09-18T08:00:00Z'],
]) {
  test(`${name}: no premature fires, fires once at target and safely re-arms`, () => {
    const h = harness(start);
    h.eval(`scheduleNext('${name}', '${cron}')`);
    assert.equal(h.pending.size, 1);
    assert.ok([...h.pending][0].unreffed);
    h.advance(5000);
    assert.equal(h.fires().length, 0);
    h.advance(Date.parse(target) - Date.parse(start) - 5001);
    assert.equal(h.fires().length, 0);
    h.advance(1);
    assert.equal(h.fires().length, 1);
    assert.equal(h.pending.size, 1);
    h.advance(5000);
    assert.equal(h.fires().length, 1);
  });
}

test('reload/shutdown cancels the current chunk, including stale callbacks', () => {
  const h = harness();
  h.eval("scheduleNext('annual', '0 8 17 9 *')");
  h.advance(MAX_DELAY);
  const timer = [...h.pending][0];
  assert.ok(timer.unreffed);
  h.eval('clearAll()');
  assert.equal(h.pending.size, 0);
  timer.callback();
  assert.equal(h.pending.size, 0);
  assert.equal(h.fires().length, 0);
});

test('late chunk callbacks retain the absolute deadline', () => {
  const h = harness();
  h.eval(`armTimer('late', Date.now() + ${MAX_DELAY} + 5000, () => runTask('late'))`);
  const timer = [...h.pending][0];
  h.pending.delete(timer);
  h.shiftWall(MAX_DELAY + 2000);
  timer.callback();
  assert.equal([...h.pending][0].delay, 3000);
  h.advance(3000);
  assert.equal(h.fires().length, 1);
});

test('backward clock change rechecks the deadline without firing early', () => {
  const h = harness();
  h.eval("armTimer('clock', Date.now() + 1000, () => runTask('clock'))");
  const timer = [...h.pending][0];
  h.pending.delete(timer);
  h.shiftWall(-5000);
  timer.callback();
  assert.equal([...h.pending][0].delay, 6000);
  assert.equal(h.fires().length, 0);
  h.advance(6000);
  assert.equal(h.fires().length, 1);
});

test('preserves one-second floor near a cron boundary', () => {
  const h = harness('2026-09-17T07:59:59.999Z');
  h.eval("scheduleNext('daily', '0 8 * * *')");
  assert.equal([...h.pending][0].delay, 1000);
  h.advance(999);
  assert.equal(h.fires().length, 0);
  h.advance(1);
  assert.equal(h.fires().length, 1);
});

test('rapid scheduled/manual runs share a cooldown that survives reload cancellation', () => {
  const h = harness(undefined, false);
  h.eval("runTask('task')");
  h.children[0].emit('exit', 0);
  h.eval('clearAll()');
  for (let i = 0; i < 100; i++) h.eval("runTask('task', 'manual')");
  assert.equal(h.children.length, 1);
  assert.equal(h.logs.filter((line) => line.includes('WARN: refusing')).length, 1);
  h.eval("runTask('other')");
  assert.equal(h.children.length, 2);
  h.advance(9999);
  h.eval("runTask('task')");
  assert.equal(h.children.length, 2);
  h.advance(1);
  h.eval("runTask('task')");
  assert.equal(h.children.length, 3);
});

test('running tasks cannot overlap after the cooldown', () => {
  const h = harness(undefined, false);
  h.eval("runTask('task')");
  h.advance(10000);
  h.eval("runTask('task'); runTask('task', 'manual')");
  assert.equal(h.children.length, 1);
  h.children[0].emit('exit', 0);
  h.eval("runTask('task')");
  assert.equal(h.children.length, 2);
});

test('spawn errors are logged and allow recovery after the cooldown', () => {
  const h = harness(undefined, false);
  h.eval("runTask('task')");
  h.children[0].emit('error', new Error('EAGAIN'));
  assert.ok(h.logs.some((line) => line.includes('ERROR: could not spawn task: EAGAIN')));
  h.advance(10000);
  h.eval("runTask('task')");
  assert.equal(h.children.length, 2);
});

test('invalid cron and non-finite deadlines do not arm timers', () => {
  const h = harness();
  h.eval("scheduleNext('bad', 'invalid'); armTimer('invalid', NaN, () => {})");
  assert.equal(h.pending.size, 0);
  assert.equal(h.fires().length, 0);
});

test('real scheduler dry run: monthly and annual crons stay quiet without overflow', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yoda-scheduler-'));
  let child;
  try {
    mkdirSync(path.join(dir, 'workspace', 'bin'), { recursive: true });
    mkdirSync(path.join(dir, 'cron-tasks'));
    writeFileSync(path.join(dir, 'workspace', 'package.json'), '{"type":"module"}');
    writeFileSync(path.join(dir, 'workspace', 'bin', 'scheduler.js'), readFileSync(schedulerUrl));
    symlinkSync(fileURLToPath(new URL('../workspace/node_modules', import.meta.url)), path.join(dir, 'workspace', 'node_modules'));
    // Freeze wall time just after the annual dates; real Node timers still run.
    writeFileSync(path.join(dir, 'clock.cjs'), `
      const RealDate = Date;
      global.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : ['2026-09-17T08:00:00Z'])); }
        static now() { return RealDate.parse('2026-09-17T08:00:00Z'); }
      };
    `);
    for (const [name, cron] of [['monthly', '0 8 17 * *'], ['annual', '0 8 17 9 *']]) {
      writeFileSync(path.join(dir, 'cron-tasks', `${name}.yaml`), `name: ${name}\nschedule: "${cron}"\n`);
    }
    child = spawn(process.execPath, ['--require', path.join(dir, 'clock.cjs'), path.join(dir, 'workspace', 'bin', 'scheduler.js')], {
      env: { ...process.env, TZ: 'UTC', YODA_SCHEDULER_DRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    let output = '';
    child.stderr.on('data', (data) => { output += data; });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(child.exitCode, null, output);
    assert.match(output, /loaded 2 scheduled task/);
    assert.doesNotMatch(output, /firing |TimeoutOverflowWarning|ERROR:/);
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
