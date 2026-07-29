// Agent SDK lifecycle hooks. These run HERE, in the supervisor process — not in
// the model's context window. That is the whole point: a rule enforced by a hook
// costs no tokens, survives compaction, and cannot be talked out of by anything
// the model reads (a poisoned web page, a crafted email, its own drift).
//
// Three hooks are installed:
//
//   PreToolUse   — the outbound-action gate. Classifies Bash commands that would
//                  act on the outside world (send a message, upload a file, run a
//                  remote command, POST to an API) and denies them unless THIS turn
//                  was authorised to act externally. See classifyExternalWrite().
//   PostToolUse  — append-only audit of every external attempt and its outcome.
//   PreCompact   — checkpoint to memory/ before the context window is summarised,
//                  so a long thread keeps its thread of thought across compaction.
//
// Wiring lives in lib/agent-query.js (buildAgentOptions). Deliberately NOT in
// .claude/settings.json — yoda.js regenerates that file from YODA_SANDBOX on
// every boot and would clobber it.

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

// ─── outbound-action classification ────────────────────────────────────────

// Broker tools that ALWAYS act on the outside world, whatever their arguments.
const BROKER_ALWAYS_EXTERNAL = new Set(['slack_post', 'slack_upload', 'ssh_exec']);

// HTTP verbs that only read. Anything else changes state somewhere.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Slack Web API methods that only read. slack_api can call anything, so the
// safe default is "external" and this is the explicit read allowlist.
const SLACK_API_READ = new Set([
  'auth.test', 'conversations.history', 'conversations.info', 'conversations.list',
  'conversations.members', 'conversations.replies', 'emoji.list', 'files.info',
  'reactions.get', 'search.messages', 'team.info', 'users.conversations',
  'users.info', 'users.list', 'users.lookupByEmail', 'usergroups.list',
]);

// bin/slack-tools.sh subcommands that put something in front of a human.
// react/unreact/mark are visible but harmless, so they stay ungated.
const SLACK_TOOL_EXTERNAL = new Set(['post', 'update', 'reply', 'upload']);

// Named services (services.policy.json) are operator-defined API calls whose
// verb we cannot see from the command line. Fall back to the name: a service
// called "send_invoice" is a send.
const SERVICE_NAME_EXTERNAL = /(^|[_-])(send|post|create|update|delete|upload|write|put|patch|notify|email|sms|message|dm|reply|publish|invite|charge|pay)([_-]|$)/i;

/** Strip one layer of shell quoting from a token. */
function unquote(s) {
  if (!s) return '';
  const m = s.match(/^'([\s\S]*)'$/) || s.match(/^"([\s\S]*)"$/);
  return m ? m[1] : s;
}

/**
 * Pull an argument out of a `broker call` tail, which accepts either form:
 *   broker call http_call '{"host":"…","method":"POST"}'
 *   broker call http_call --host … --method POST
 */
function brokerArg(tail, name) {
  const flag = tail.match(new RegExp(`--${name}[=\\s]+(['"][^'"]*['"]|\\S+)`, 'i'));
  if (flag) return unquote(flag[1]);
  const jsonStart = tail.indexOf('{');
  if (jsonStart !== -1) {
    // Quote-tolerant scan rather than JSON.parse — the tail is a shell fragment
    // and may be truncated, concatenated, or carry unbalanced quotes.
    const re = new RegExp(`["']${name}["']\\s*:\\s*["']([^"']*)["']`, 'i');
    const m = tail.slice(jsonStart).match(re);
    if (m) return m[1];
  }
  return '';
}

/**
 * Decide whether a Bash command would act on the outside world.
 *
 * Conservative by design: when a call's verb can't be determined it counts as
 * external. A false positive costs one clarifying question; a false negative
 * sends something irreversible.
 *
 * @param {string} command  The Bash tool's `command` input
 * @returns {{ kind: string, detail: string } | null}  null = purely local
 */
export function classifyExternalWrite(command) {
  const cmd = String(command || '');

  // ── broker calls ─────────────────────────────────────────────────────────
  // Matches `broker call <tool> …`, with or without a ./bin/ or bin/ prefix.
  const broker = cmd.match(/(?:^|[\s;&|(])(?:\.?\/?bin\/)?broker\s+call\s+([A-Za-z0-9_.-]+)([\s\S]*)/);
  if (broker) {
    const tool = broker[1];
    const tail = broker[2] || '';

    if (BROKER_ALWAYS_EXTERNAL.has(tool)) {
      return { kind: `broker:${tool}`, detail: tool === 'ssh_exec' ? 'remote command execution' : 'sends to Slack' };
    }

    if (tool === 'slack_api') {
      const method = brokerArg(tail, 'method');
      if (method && SLACK_API_READ.has(method)) return null;
      return { kind: 'broker:slack_api', detail: `Slack API ${method || '(method unread)'}` };
    }

    if (tool === 'http_call') {
      const method = (brokerArg(tail, 'method') || 'GET').toUpperCase();
      if (READ_METHODS.has(method)) return null;
      const host = brokerArg(tail, 'host');
      return { kind: 'broker:http_call', detail: `${method} ${host || 'an API'}` };
    }

    // Named service from services.policy.json.
    const method = brokerArg(tail, 'method');
    if (method && READ_METHODS.has(method.toUpperCase())) return null;
    if (method || SERVICE_NAME_EXTERNAL.test(tool)) {
      return { kind: `broker:${tool}`, detail: `${method || 'call'} via the ${tool} service` };
    }
    return null;
  }

  // ── slack-tools.sh ───────────────────────────────────────────────────────
  const slackTool = cmd.match(/(?:^|[\s;&|(])(?:\.?\/?bin\/)?slack-tools\.sh\s+([a-z]+)/i);
  if (slackTool && SLACK_TOOL_EXTERNAL.has(slackTool[1].toLowerCase())) {
    return { kind: `slack-tools:${slackTool[1]}`, detail: `Slack ${slackTool[1]}` };
  }

  return null;
}

// ─── turn authorisation ────────────────────────────────────────────────────

// The user asking for an outbound action IS the authorisation — "email Bob the
// summary" should not need a second yes. What the gate exists to catch is an
// external action nobody asked for: a poisoned web page telling the agent to
// forward a document, or a watch wake deciding on its own to message someone.
const ASKED_FOR_ACTION = /\b(send|email|e-mail|reply|respond|post|publish|message|dm|text|notify|tell|forward|share|upload|invite|schedule|book|submit|push|deploy|ssh|run\s+on)\b/i;

// Plain assent to whatever was just proposed.
const CONFIRMED = /^\s*(y|yes|yep|yeah|yup|ok|okay|sure|go|go ahead|do it|send it|please do|confirmed?|approved?|sounds good|go for it|fire away|ship it)\b/i;

/**
 * Whether this turn may act on the outside world, judged from what the human
 * actually said. Errs toward allowing: the gate should stop the unrequested,
 * not interrogate the obvious.
 *
 * @param {string} text  The message that triggered this turn
 */
export function isExternalActionAuthorized(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return CONFIRMED.test(t) || ASKED_FOR_ACTION.test(t);
}

// ─── audit trail ───────────────────────────────────────────────────────────

const AUDIT_FILE = () => path.join(config.stateDir, 'external-calls.jsonl');

function audit(entry) {
  try {
    mkdirSync(config.stateDir, { recursive: true });
    appendFileSync(AUDIT_FILE(), JSON.stringify(entry) + '\n');
  } catch (e) {
    // Never let auditing break a turn — log and carry on.
    logger.warn('external audit write failed', { error: e?.message ?? String(e) });
  }
}

// ─── hook construction ─────────────────────────────────────────────────────

const DENY_REASON = [
  'BLOCKED: this command acts on the outside world and nothing in this turn authorised that.',
  'Do not retry it and do not try to route around it.',
  'Tell the user plainly in <say> what you want to send, to whom, and ask them to confirm.',
  'If they confirm, the same command will go through on the next turn.',
].join(' ');

/**
 * Build the hooks object for a run.
 *
 * @param {object}  args
 * @param {boolean} [args.authorized]  This turn may act externally: the user asked
 *   for an outbound action, or confirmed one. Crons pass true — an operator-written
 *   task file is itself a standing authorisation.
 * @param {string}  [args.conversationId] For audit correlation.
 * @param {string}  [args.surface]        For audit correlation.
 * @param {(info: {kind: string, detail: string}) => void} [args.onBlocked]
 *   Notified when a call is denied, so the surface can show it in the status card.
 * @param {'off'|'audit'|'confirm'} [args.mode]  Override the configured gate mode.
 *   config is a load-time snapshot of the environment, so this is the seam that
 *   makes the gate testable — and lets a caller tighten the gate for one run.
 * @returns {object|undefined}  SDK `hooks` option, or undefined when fully disabled.
 */
export function buildHooks({
  authorized = false, conversationId = null, surface = null, onBlocked, mode: modeOverride,
} = {}) {
  const mode = modeOverride ?? config.claude.confirmExternal; // 'off' | 'audit' | 'confirm'
  if (mode === 'off') return undefined;

  const base = { surface, conversationId };

  const preToolUse = async (input) => {
    if (input.tool_name !== 'Bash') return {};
    const hit = classifyExternalWrite(input.tool_input?.command);
    if (!hit) return {};

    // A subagent acting externally is the same risk as the main thread —
    // agent_id only tells us WHERE it came from, it doesn't earn an exemption.
    const via = input.agent_id ? `subagent ${input.agent_id}` : 'main';
    const blocked = mode === 'confirm' && !authorized;

    audit({ at: new Date().toISOString(), ...base, event: 'attempt', ...hit, via, blocked });

    if (!blocked) return {};

    logger.warn('blocked unauthorised external action', { ...base, ...hit, via });
    if (onBlocked) { try { onBlocked(hit); } catch (_) {} }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${DENY_REASON} (blocked: ${hit.detail})`,
      },
    };
  };

  // Close the audit pair. A Bash command that exits NON-ZERO fires
  // PostToolUseFailure, not PostToolUse — so both have to be registered or the
  // log silently loses every failed send, which is the half you most want to
  // see (did that email actually go out, or did it bounce off a dead socket?).
  const postToolUse = (ok) => async (input) => {
    if (input.tool_name !== 'Bash') return {};
    const hit = classifyExternalWrite(input.tool_input?.command);
    if (!hit) return {};
    audit({ at: new Date().toISOString(), ...base, event: 'result', ...hit, ok, ms: input.duration_ms ?? null });
    return {};
  };

  // Checkpoint before the window is summarised. AGENTS.md asks the model to do
  // this by hand every ~10 tool calls; doing it here makes it a guarantee rather
  // than a habit the model has to remember while it is running out of room.
  const preCompact = async (input) => {
    const stamp = new Date().toISOString();
    try {
      const dir = path.join(config.workspace, 'memory');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `compaction-${stamp.slice(0, 10)}.md`);
      appendFileSync(file, [
        ``,
        `## Compaction checkpoint — ${stamp}`,
        ``,
        `- Trigger: ${input.trigger}`,
        `- Surface: ${surface ?? 'unknown'} / conversation: ${conversationId ?? 'unknown'}`,
        `- Session: ${input.session_id}`,
        `- Full transcript (pre-summary): ${input.transcript_path}`,
        ``,
      ].join('\n'));
      logger.info('context compaction — checkpoint written', { ...base, trigger: input.trigger, file });
    } catch (e) {
      logger.warn('compaction checkpoint failed', { error: e?.message ?? String(e) });
    }
    return {};
  };

  return {
    PreToolUse: [{ matcher: 'Bash', hooks: [preToolUse] }],
    PostToolUse: [{ matcher: 'Bash', hooks: [postToolUse(true)] }],
    PostToolUseFailure: [{ matcher: 'Bash', hooks: [postToolUse(false)] }],
    PreCompact: [{ hooks: [preCompact] }],
  };
}

// Exported for tests and for the dispatcher's intent check.
export const _internals = { BROKER_ALWAYS_EXTERNAL, SLACK_API_READ, SLACK_TOOL_EXTERNAL, brokerArg };
