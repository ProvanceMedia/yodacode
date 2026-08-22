// Spawns the Codex CLI and turns its JSONL stream into the messages the rest of
// the supervisor understands. Everything odd in here is a recorded observation,
// not a precaution — see docs/ENGINES.md and the notes at each site.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTranslatorState, translateEvent } from './translate.js';
import { stripAgentSecrets } from '../../agent-query.js';

const FLOCK_BIN = '/usr/bin/flock';
/** Refresh the credential under a lock when it expires within this window. */
const REFRESH_GRACE_MS = 5 * 60 * 1000;
/** Cap on buffered stderr. Load-bearing: a healthy turn can emit >1MB of
 *  non-fatal catalogue JSON, so this is what stops it reaching a log or a
 *  chat message. */
const STDERR_CAP = 16 * 1024;

/**
 * Milliseconds until the stored access token expires, or 0 if that can't be
 * determined. Reads and base64-decodes the JWT payload locally — no network,
 * no quota, and deliberately NOT `codex login status`, which reports a healthy
 * login for a credential that is already dead.
 */
export function tokenExpiryMs(codexHome, now = Date.now()) {
  try {
    const raw = readFileSync(path.join(codexHome, 'auth.json'), 'utf8');
    const token = JSON.parse(raw)?.tokens?.access_token || '';
    const parts = token.split('.');
    if (parts.length !== 3) return 0;
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload.exp ? (payload.exp * 1000) - now : 0;
  } catch {
    return 0;
  }
}

/**
 * Does this invocation need the refresh lock?
 *
 * Refresh is lazy — a run with a valid access token never rewrites auth.json —
 * so the single-use-refresh-token race only exists in the window around expiry.
 * Locking only in that window means concurrent conversations run in parallel
 * essentially always, and serialise for the one turn where racing would burn
 * the credential.
 */
export function needsRefreshLock(codexHome, now = Date.now()) {
  const remaining = tokenExpiryMs(codexHome, now);
  return remaining <= REFRESH_GRACE_MS;
}

/** codex exec and codex exec resume accept DIFFERENT flags: resume has no
 *  --sandbox, no --cd, no --add-dir, no --color. Anything unavailable there is
 *  expressed as a -c override, and the working directory comes from the spawn's
 *  cwd. Reusing one argument list across both breaks every resumed turn at argv
 *  parsing while fresh turns keep working.
 *
 *  The sandbox default matches the generated config.toml, and for the same
 *  reason: the CONTAINER is the boundary. Asking Codex for its own sandbox on
 *  top does not add protection — it tries to create a user namespace with
 *  bubblewrap, which is not permitted inside the container, so every shell
 *  command fails with a namespace error while the turn itself reports success.
 *  The agent then explains that it could not run the command, which reads as
 *  the model being unable rather than as a misconfiguration. */
export function buildArgs({ prompt, model, effort, resume, cwd, lastMessageFile, sandbox = 'danger-full-access' }) {
  const common = ['--json', '--skip-git-repo-check', '-o', lastMessageFile];
  if (model) common.push('--model', model);
  if (effort) common.push('-c', `model_reasoning_effort="${effort}"`);

  if (resume) {
    return ['exec', 'resume', resume, ...common, '-c', `sandbox_mode="${sandbox}"`, prompt];
  }
  return ['exec', ...common, '--sandbox', sandbox, '--color', 'never', '-C', cwd, prompt];
}

/**
 * Run one Codex turn. Yields Anthropic stream-json messages.
 *
 * @returns {AsyncGenerator<object>}
 */
export async function* runCodex({
  prompt, model, effort, cwd, abortController, env, stderr: onStderr, resume, extraEnv,
}) {
  const codexHome = (env || process.env).CODEX_HOME || path.join(process.env.HOME || '/root', '.codex');
  const tmp = mkdtempSync(path.join(tmpdir(), 'yoda-codex-'));
  const lastMessageFile = path.join(tmp, 'last-message.txt');

  const args = buildArgs({ prompt, model, effort, resume, cwd, lastMessageFile });
  const useLock = existsSync(FLOCK_BIN) && needsRefreshLock(codexHome);
  const cmd = useLock ? FLOCK_BIN : 'codex';
  const argv = useLock
    ? ['-w', '120', path.join(codexHome, '.yoda-auth.lock'), 'codex', ...args]
    : args;

  const child = spawn(cmd, argv, {
    cwd,
    // The `env` the runner resolves is already curated. The fallback is not —
    // a bare process.env would hand the turn the supervisor's whole
    // environment, including the model credential and the surface transport
    // secrets the Claude path strips. Same stripper, so the two engines can't
    // disagree about what a turn may read.
    env: { ...(env || stripAgentSecrets({ ...process.env })), ...(extraEnv || {}), CODEX_HOME: codexHome },
    // stdin MUST be closed. codex exec reads stdin as ADDITIONAL prompt input
    // even when the prompt is an argument, and with stdin left open it waits
    // forever, produces nothing, and never starts the turn.
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group, so aborting kills the whole tree rather than orphaning
    // whatever tool the model happened to be running.
    detached: true,
  });

  const state = createTranslatorState();
  let stderrBuf = '';
  let terminalEvent = null;   // turn.completed / turn.failed, held until exit
  let sawTerminal = false;
  // Open delegations, by item id. While one is in flight the parent emits
  // NOTHING — the subagent works in its own thread and its frames never reach
  // this stream — so a long delegation is indistinguishable from a hung turn,
  // and the runner's idle watchdog would kill it. A heartbeat keeps the run
  // visibly alive without inventing progress.
  const openDelegations = new Set();

  child.stderr.on('data', (d) => {
    // Buffered for diagnostics only. Codex writes ERROR lines to stderr on
    // completely successful turns, so stderr content must never be used to
    // decide whether a turn failed.
    if (stderrBuf.length < STDERR_CAP) stderrBuf += String(d).slice(0, STDERR_CAP - stderrBuf.length);
    if (onStderr) { try { onStderr(d); } catch { /* diagnostics only */ } }
  });

  const onAbort = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };
  abortController?.signal.addEventListener('abort', onAbort, { once: true });

  const exited = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', (err) => resolve({ code: null, signal: null, err }));
  });

  try {
    let buf = '';
    // Read stdout as an async iterator we can race a timer against, so a silent
    // delegation still produces liveness frames.
    for await (const chunk of heartbeat(child.stdout, openDelegations)) {
      if (chunk === HEARTBEAT) {
        // A liveness-only frame: an unrecognised system subtype changes no
        // status and adds no text, but the translator signals activity on every
        // message it receives — which is exactly what the idle watchdog needs.
        yield { type: 'system', subtype: 'delegation_wait', session_id: state.threadId };
        continue;
      }
      buf += String(chunk);
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';       // keep the partial line for the next chunk
      for (const line of lines) {
        const ev = parseLine(line);
        if (!ev) continue;
        if (ev.type === 'turn.completed' || ev.type === 'turn.failed' || ev.type === 'error') {
          // Held back: the authoritative reply is written to the
          // --output-last-message file, which isn't guaranteed to be flushed
          // until the process exits. Emitting the result now would race it.
          terminalEvent = ev;
          sawTerminal = true;
          continue;
        }
        trackDelegation(ev, openDelegations);
        yield* translateEvent(ev, state);
      }
    }
    if (buf.trim()) {
      const ev = parseLine(buf);
      if (ev) {
        if (ev.type === 'turn.completed' || ev.type === 'turn.failed' || ev.type === 'error') {
          terminalEvent = ev; sawTerminal = true;
        } else yield* translateEvent(ev, state);
      }
    }

    const { code, signal, err } = await exited;

    state.finalText = readLastMessage(lastMessageFile);

    if (sawTerminal) {
      yield* translateEvent(terminalEvent, state);
      return;
    }

    // No terminal event. Without synthesising one the stream just ends and the
    // runner reports "no result", which reads as a hang rather than a failure.
    if (abortController?.signal.aborted) {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    yield {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [describeExit({ code, signal, err, stderrBuf })],
      session_id: state.threadId,
    };
  } finally {
    abortController?.signal.removeEventListener('abort', onAbort);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Sentinel yielded by heartbeat() in place of a stdout chunk. */
const HEARTBEAT = Symbol('heartbeat');
/** How often to prove a silent delegation is still alive. */
const HEARTBEAT_MS = 30_000;

/** Track which delegations are open, so the heartbeat only runs when one is. */
export function trackDelegation(ev, open) {
  const item = ev.item || {};
  if (item.type !== 'collab_tool_call') return;
  if (ev.type === 'item.started') open.add(item.id);
  else if (ev.type === 'item.completed' || ev.type === 'item.failed') open.delete(item.id);
}

/**
 * Yield stdout chunks, plus a HEARTBEAT sentinel every HEARTBEAT_MS while a
 * delegation is open. Only while one is open: a genuinely stuck engine must
 * still look stuck, or the watchdog stops protecting anything.
 */
async function* heartbeat(stdout, open) {
  const it = stdout[Symbol.asyncIterator]();
  for (;;) {
    let timer;
    const tick = new Promise((resolve) => {
      timer = setTimeout(() => resolve(HEARTBEAT), HEARTBEAT_MS);
      timer.unref?.();
    });
    const next = it.next();
    const winner = await Promise.race([next, tick]);
    clearTimeout(timer);
    if (winner === HEARTBEAT) {
      if (open.size > 0) yield HEARTBEAT;
      // The stdout read is still outstanding; await it rather than dropping it.
      const r = await next;
      if (r.done) return;
      yield r.value;
      continue;
    }
    if (winner.done) return;
    yield winner.value;
  }
}

function parseLine(line) {
  const s = line.trim();
  if (!s || s[0] !== '{') return null;   // codex also prints non-JSON preamble
  try { return JSON.parse(s); } catch { return null; }
}

function readLastMessage(file) {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return text || null;
  } catch {
    return null;   // fall back to the last agent_message
  }
}

function describeExit({ code, signal, err, stderrBuf }) {
  if (err) return `codex failed to start: ${err.message}`;
  if (signal) return `codex was killed (${signal})`;
  const tail = stderrBuf.split('\n').filter((l) => l.trim()).slice(-1)[0] || '';
  return `codex exited ${code} without completing the turn${tail ? ` — ${tail.slice(0, 200)}` : ''}`;
}
