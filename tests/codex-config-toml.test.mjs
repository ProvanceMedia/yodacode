// The generated $CODEX_HOME/config.toml. What matters here is that each setting
// is present for a stated reason — every one of them fails silently if omitted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  renderConfigToml, writeConfigToml, PROJECT_DOC_MAX_BYTES,
} from '../workspace/lib/engine/codex/config-toml.js';

test('approvals are disabled — nobody is at a terminal to answer one', () => {
  // With approvals on, the engine waits for input that can never arrive and the
  // turn presents as a hang rather than as a refusal.
  assert.match(renderConfigToml(), /^approval_policy = "never"$/m);
});

test('the credential store is file, not the keyring', () => {
  // There is no keyring in the container, and "auto" falls back silently.
  assert.match(renderConfigToml(), /^cli_auth_credentials_store = "file"$/m);
});

test('the document limit is large enough for a real assembled persona', () => {
  // A workspace persona is past 50KB before the operator's own memory and
  // identity documents are counted, and it grows. Truncation is silent.
  assert.ok(PROJECT_DOC_MAX_BYTES >= 256 * 1024,
    'a limit near the default would cut the persona off mid-document');
  assert.match(renderConfigToml(), new RegExp(`^project_doc_max_bytes = ${PROJECT_DOC_MAX_BYTES}$`, 'm'));
});

test('the sandbox is wide by default, because the container is the boundary', () => {
  assert.match(renderConfigToml(), /^sandbox_mode = "danger-full-access"$/m);
});

test('the sandbox can be narrowed for callers that want it', () => {
  assert.match(renderConfigToml({ sandboxMode: 'workspace-write' }),
    /^sandbox_mode = "workspace-write"$/m);
});

test('it says it is generated, so nobody edits it by hand', () => {
  assert.match(renderConfigToml(), /Do not edit/i);
});

test('writes into CODEX_HOME, creating it when absent', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'codex-cfg-'));
  const home = path.join(base, 'nested', '.codex');
  try {
    const r = writeConfigToml({ codexHome: home });
    assert.equal(r.path, path.join(home, 'config.toml'));
    const written = readFileSync(r.path, 'utf8');
    assert.match(written, /approval_policy/);
    assert.equal(r.bytes, Buffer.byteLength(written, 'utf8'));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('rewriting is idempotent — a boot never accumulates duplicates', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'codex-cfg-'));
  try {
    writeConfigToml({ codexHome: home });
    const first = readFileSync(path.join(home, 'config.toml'), 'utf8');
    writeConfigToml({ codexHome: home });
    assert.equal(readFileSync(path.join(home, 'config.toml'), 'utf8'), first);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
