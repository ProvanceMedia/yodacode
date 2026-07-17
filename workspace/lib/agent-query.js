// Shared Claude Agent SDK plumbing. The single place that knows how to turn
// yoda's config knobs into @anthropic-ai/claude-agent-sdk query() options, so
// the surface runner (lib/claude-runner.js), the cron runner
// (bin/cron-runner.js) and the reflectors all launch agents the same way.
//
// This replaces the old `spawn('claude', ['-p', …])` subprocess plumbing: the
// SDK spawns its own bundled Claude Code runtime as a child process and hands
// us parsed message objects instead of stream-json lines to parse.

import { spawn } from 'node:child_process';
import os from 'node:os';
import { query, AbortError } from '@anthropic-ai/claude-agent-sdk';
import { logger } from './logger.js';
import { buildAgentEnv, derootEnabled, resolveAgentIds } from './deroot.js';

/**
 * Curated secret-free environment for a de-rooted run that does NOT switch
 * uid (non-root supervisor, e.g. the container): the child runs as THIS
 * process's user, so its Claude state belongs in this user's home rather
 * than the legacy agent user's.
 */
export function curatedAgentEnv() {
  const env = buildAgentEnv();
  env.HOME = process.env.HOME || os.homedir();
  return env;
}

/** Legacy (non-deroot) child env: full env minus the API key — OAuth/sub auth only. */
function legacyEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  // A surface transport secret the supervisor holds but the model never needs:
  // strip the Google Chat service-account private key so a non-deroot SDK child
  // can't read it. (Under YODA_DEROOT=1 it's already excluded by deroot.js's
  // ENV_ALLOWLIST; this closes the same gap in legacy/non-deroot mode.)
  delete env.GOOGLE_CHAT_SA_KEY;
  return env;
}

let derootNoticeLogged = false;

/**
 * Resolve the env + spawn hook for a run. De-root mirrors the old spawner:
 * a curated secret-free env AND (when the supervisor is root, i.e. the
 * bare-metal systemd install) the child switched to the unprivileged agent
 * user via the SDK's custom spawn hook — file permissions stay an effective
 * boundary (root-only .env, broker secrets). If the agent user is missing,
 * fail SAFE for availability like the old spawner did: log loudly and fall
 * back to the legacy env rather than taking the bot down.
 *
 * @param {boolean|undefined} deroot  Explicit per-run override; undefined = global YODA_DEROOT
 */
function resolveRunIsolation(deroot) {
  const wantDeroot = deroot ?? derootEnabled();
  if (!wantDeroot) return { env: legacyEnv(), spawnHook: null };

  const ids = resolveAgentIds();
  if (!ids) {
    logger.error('deroot requested but agent user unavailable — falling back to legacy env');
    return { env: legacyEnv(), spawnHook: null };
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    // Full de-root: curated env (HOME = the agent user's own home) + child
    // spawned with the agent uid/gid. `signal` is the SDK's forwarded abort
    // signal — it fires only after the graceful stdin-EOF window, so wiring
    // it to spawn() is the sanctioned force-kill path.
    return {
      env: buildAgentEnv(),
      spawnHook: (o) => spawn(o.command, o.args, {
        cwd: o.cwd,
        env: o.env,
        uid: ids.uid,
        gid: ids.gid,
        signal: o.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    };
  }
  // Non-root supervisor (e.g. the container): already unprivileged, no uid
  // switch possible or needed — env curation is the whole mechanism.
  if (!derootNoticeLogged) {
    derootNoticeLogged = true;
    logger.info('deroot: non-root supervisor — curated env only (no uid switch needed)');
  }
  return { env: curatedAgentEnv(), spawnHook: null };
}

/** Normalise an allowed-tools knob (CSV string or array) to the SDK's array. */
export function toolList(tools) {
  if (Array.isArray(tools)) return tools.map((s) => String(s).trim()).filter(Boolean);
  return String(tools || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Build query() options equivalent to the old `claude -p` flag set. The
 * claude_code system-prompt preset + full settingSources preserve CLI
 * behaviour: workspace CLAUDE.md persona, .claude/settings.json sandbox
 * config, and the user's auth state are all still honoured (the SDK loads
 * none of them by default).
 *
 * @param {boolean} [args.deroot]   Per-run de-root override (default: YODA_DEROOT)
 * @param {object}  [args.env]      Explicit child env (skips de-root resolution)
 * @param {string}  [args.resume]   SDK session id to resume (persistent threads)
 * @param {object}  [args.extraEnv] Non-secret vars merged on top of the resolved
 *   env AFTER de-root curation — used to hand the child its conversation
 *   identity (YODA_CONVERSATION_ID/SURFACE/USER_ID/REPLY_TARGET) so a tool it
 *   runs, e.g. bin/watch.js, knows which thread to wake later. Must never carry
 *   secrets: it deliberately bypasses the allowlist that strips them.
 */
export function buildAgentOptions({
  model, effort, allowedTools, permissionMode, cwd, abortController, env, stderr, deroot, resume, extraEnv,
}) {
  const isolation = env ? { env, spawnHook: null } : resolveRunIsolation(deroot);
  const options = {
    cwd,
    permissionMode,
    allowedTools: toolList(allowedTools),
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
    env: extraEnv ? { ...isolation.env, ...extraEnv } : isolation.env,
  };
  if (isolation.spawnHook) options.spawnClaudeCodeProcess = isolation.spawnHook;
  if (resume) options.resume = resume;
  if (model) options.model = model;
  // Reasoning effort. Skip for Haiku (no effort levels); other models clamp
  // an unsupported level themselves (e.g. xhigh → high on Sonnet 4.6).
  if (effort && !/haiku/i.test(model || '')) options.effort = effort;
  if (abortController) options.abortController = abortController;
  if (stderr) options.stderr = stderr;
  return options;
}

/** True for the abort the SDK throws when its AbortController fires. */
export function isAbortError(e) {
  // The SDK's AbortError doesn't set .name; the name check additionally
  // catches Node/DOMException-style aborts. No message matching — a real
  // failure whose text mentions "abort" must not read as a clean stop.
  return e instanceof AbortError || (!!e && e.name === 'AbortError');
}

/**
 * One-shot agent run → final text. The SDK equivalent of
 * `claude -p "<prompt>" --output-format text`, used by the cron runner and
 * the reflectors. Applies its own wall-clock timeout via AbortController.
 *
 * @returns {Promise<{ ok: boolean, text: string, error?: string, timedOut?: boolean, usage?: object }>}
 */
export async function runAgentText({
  prompt, model, effort, allowedTools, permissionMode = 'acceptEdits',
  cwd, timeoutMs, env, stderr, deroot,
}) {
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    timer.unref();
  }

  const chunks = [];
  let resultText = '';
  let errorText = null;
  let usage = null;

  try {
    const q = query({
      prompt,
      options: buildAgentOptions({
        model, effort, allowedTools, permissionMode, cwd,
        abortController: controller, env, stderr, deroot,
      }),
    });
    for await (const m of q) {
      if (m.type === 'assistant') {
        if (m.parent_tool_use_id) continue; // subagent chatter isn't the reply
        for (const b of m.message?.content || []) {
          if (b.type === 'text' && b.text) chunks.push(b.text);
        }
      } else if (m.type === 'result') {
        if (m.usage) usage = m.usage;
        if (m.is_error) {
          errorText = (m.subtype === 'success' ? m.result : (m.errors || []).join('; '))
            || m.subtype || 'unknown error';
        } else if (m.subtype === 'success') {
          resultText = (m.result || '').trim();
        } else {
          errorText = (m.errors || []).join('; ') || m.subtype;
        }
      }
    }
  } catch (e) {
    if (!isAbortError(e)) {
      if (timer) clearTimeout(timer);
      return { ok: false, text: chunks.join('\n').trim(), error: e.message };
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (timedOut) {
    return {
      ok: false,
      text: chunks.join('\n').trim(),
      error: `timed out after ${Math.round(timeoutMs / 1000)}s`,
      timedOut: true,
      usage,
    };
  }
  const text = resultText || chunks.join('\n').trim();
  return { ok: !errorText, text, error: errorText || undefined, usage };
}
