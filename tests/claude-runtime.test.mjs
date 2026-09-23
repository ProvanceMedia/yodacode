import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(new URL('../workspace/package.json', import.meta.url));

// Exercise the SDK's native runtime, not a separately installed global CLI.
// CI and the production Docker image both use glibc Linux.
test('bundled Claude Code meets the Opus 5.5 minimum version', {
  skip: process.platform !== 'linux' || !process.report.getReport().header.glibcVersionRuntime,
}, () => {
  const binary = require.resolve(`@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude`);
  const output = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 15000 });
  const match = output.match(/^(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, `Unrecognised Claude Code version: ${output}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  assert.ok(major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 280))),
    `Opus 5.5 requires Claude Code >=2.1.280; found ${match[0]}`);
});
