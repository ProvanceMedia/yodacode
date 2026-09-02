// A shortcut whose tier is defined by effort rather than model (extraDeep on
// Codex is the deep model thinking harder) pins that effort to the thread. The
// dispatcher must use it when nothing in the conversation says otherwise, and
// must still let a person's own "xhigh off" or "ultrathink" win.
//
// config.js reads the environment once at import, so this runs in a fresh
// process with the effort default cleared — an in-process import would carry
// whatever this shell happens to have set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveAll() {
  const script = `
    import { resolveEffort } from './lib/dispatcher.js';
    const ev = (text, effortOverride) => ({ text, effortOverride });
    const ctx = { messages: [] };
    process.stdout.write(JSON.stringify({
      none: resolveEffort(ev('hello'), ctx) ?? null,
      pinned: resolveEffort(ev('hello', 'xhigh'), ctx) ?? null,
      pinnedLow: resolveEffort(ev('hello', 'low'), ctx) ?? null,
      off: resolveEffort(ev('xhigh off please', 'xhigh'), ctx) ?? null,
      signal: resolveEffort(ev('ultrathink this', 'low'), ctx) ?? null,
    }));
  `;
  const env = { ...process.env, YODA_CLAUDE_EFFORT: '' };
  delete env.YODA_EFFORT_ESCALATE_PATTERN;
  delete env.YODA_EFFORT_DEESCALATE_PATTERN;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    // From workspace/, as the app runs: importing the dispatcher opens its
    // state stores relative to the working directory.
    cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workspace'),
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out.trim());
}

test('a pinned effort applies when the conversation says nothing', () => {
  const r = resolveAll();
  assert.equal(r.none, null, 'no pin, no signal, no default: the model decides');
  assert.equal(r.pinned, 'xhigh');
  assert.equal(r.pinnedLow, 'low', 'any level, not only xhigh');
});

test("a person's own effort signal beats the pin, in both directions", () => {
  const r = resolveAll();
  assert.equal(r.off, null, '"xhigh off" drops the pinned effort too');
  assert.equal(r.signal, 'xhigh', '"ultrathink" escalates over a lower pin');
});
