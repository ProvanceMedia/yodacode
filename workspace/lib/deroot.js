// De-rooted agent runs (optional credential-isolation mode). When
// YODA_DEROOT=1, every agent run gets a curated, secret-free environment —
// it reaches credentials only through the broker socket — and, when the
// supervisor runs as root (the bare-metal systemd install), the SDK child is
// additionally spawned as the unprivileged agent user via the SDK's custom
// spawn hook (see lib/agent-query.js), so root-only file permissions remain
// an effective boundary. When the flag is off (default), callers fall back
// to the legacy env (full env minus the API key). See docs/BROKER.md.

import { execFileSync } from 'node:child_process';

export function derootEnabled() {
  return process.env.YODA_DEROOT === '1';
}

// The ONLY env the de-rooted agent inherits. CLAUDE_CODE_OAUTH_TOKEN is the model's own
// auth (not a service secret — it must travel with the agent); every API key is withheld
// and reached via `broker call`. SLACK_TEST_CHANNEL_ID is a channel id, not a secret.
const ENV_ALLOWLIST = [
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'NODE_OPTIONS', 'TERM',
  'CLAUDE_CODE_OAUTH_TOKEN', 'SLACK_TEST_CHANNEL_ID', 'YODA_CLAUDE_MODEL',
];

export function buildAgentEnv() {
  // Env vars are read at call time (not import time) so values loaded late —
  // e.g. cron-runner's loadEnvFile('.env') — still make it into the agent env.
  const agentUser = process.env.YODA_AGENT_USER || 'yodacode-agent';
  const env = {};
  for (const k of ENV_ALLOWLIST) if (process.env[k] != null) env[k] = process.env[k];
  env.HOME = `/home/${agentUser}`;
  if (!env.PATH) env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  if (!env.LANG) env.LANG = 'C.UTF-8';
  env.ANTHROPIC_API_KEY = '';                // never API-key auth
  env.YODA_BROKER_SOCK = process.env.YODA_BROKER_SOCK || '/run/yodacode-broker.sock';
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH; // shared browser binaries
  }
  env.YODA_DEROOTED = '1';                   // marker tools/prompts can check
  return env;
}

let ids = null;       // {uid, gid} resolved once
let idsFailed = false;

/**
 * Resolve the agent user's uid + shared broker gid. Returns null (and caches
 * the failure) when the agent user/group doesn't exist — e.g. inside the
 * container, or on a host where setup-broker.sh never ran — so callers can
 * degrade gracefully instead of crashing every run.
 */
export function resolveAgentIds() {
  if (ids) return ids;
  if (idsFailed) return null;
  const agentUser = process.env.YODA_AGENT_USER || 'yodacode-agent';
  const agentGroup = process.env.YODA_AGENT_GROUP || 'yodacode';
  try {
    // stderr piped (not inherited) so a missing user doesn't spray "id: no
    // such user" onto the supervisor's stderr — the caller logs the outcome.
    const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    const uid = parseInt(execFileSync('id', ['-u', agentUser], opts).trim(), 10);
    // Primary gid for the child = the shared broker group: grants the broker socket
    // (0660 root:<group>) and the group-writable workspace, and stamps agent-created
    // files with the group the rest of the install shares.
    const groupLine = execFileSync('getent', ['group', agentGroup], opts).trim();
    const gid = parseInt(groupLine.split(':')[2], 10);
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
      throw new Error(`cannot resolve ${agentUser}/${agentGroup}`);
    }
    ids = { uid, gid };
    return ids;
  } catch {
    idsFailed = true;
    return null;
  }
}
