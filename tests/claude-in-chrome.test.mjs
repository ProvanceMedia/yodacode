import { test } from 'node:test';
import assert from 'node:assert/strict';

// Claude-in-Chrome wiring. Two non-secret env vars let the bundled runtime
// auto-register the claude-in-chrome MCP server so the agent can drive the
// operator's own signed-in browser. Both wiring points must hold:
//   1. the vars survive the de-root allowlist (else the agent child never sees
//      them and the feature is silently off for every de-rooted run);
//   2. the claude-in-chrome tools are allow-listed ONLY when CFC is on (else the
//      agent can see the browser but not act, or we widen the surface for free).

test('CFC env vars survive the de-root allowlist', async () => {
  const prev = { ...process.env };
  try {
    process.env.CLAUDE_CODE_ENABLE_CFC = '1';
    process.env.CLAUDE_CHROME_PAIRED_DEVICE_ID = 'dev-xyz';
    // buildAgentEnv reads process.env at call time, so no module cache-busting.
    const { buildAgentEnv } = await import('../workspace/lib/deroot.js');
    const env = buildAgentEnv();
    assert.equal(env.CLAUDE_CODE_ENABLE_CFC, '1');
    assert.equal(env.CLAUDE_CHROME_PAIRED_DEVICE_ID, 'dev-xyz');
  } finally {
    process.env = prev;
  }
});

// config.js builds its object once at module eval, reading process.env then, so
// each branch needs a fresh evaluation — a query-string specifier dodges the ESM
// module cache without touching the file.
async function loadConfig(tag) {
  return (await import(`../workspace/lib/config.js?cic=${tag}`)).config;
}

test('allowedTools includes claude-in-chrome only when CFC is on', async () => {
  const prev = { ...process.env };
  try {
    delete process.env.YODA_ALLOWED_TOOLS;

    process.env.CLAUDE_CODE_ENABLE_CFC = '1';
    const on = await loadConfig('on');
    assert.ok(
      on.claude.allowedTools.split(',').includes('mcp__claude-in-chrome'),
      'claude-in-chrome should be allow-listed when CFC=1',
    );

    delete process.env.CLAUDE_CODE_ENABLE_CFC;
    const off = await loadConfig('off');
    assert.ok(
      !off.claude.allowedTools.includes('mcp__claude-in-chrome'),
      'claude-in-chrome must NOT be allow-listed when CFC is off',
    );
    // The base toolset is untouched either way.
    assert.ok(off.claude.allowedTools.split(',').includes('Bash'));
  } finally {
    process.env = prev;
  }
});
