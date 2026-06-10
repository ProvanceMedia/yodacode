// De-rooted agent spawning (optional credential-isolation mode). When YODA_DEROOT=1,
// every `claude -p` child runs as an unprivileged agent user with a curated, secret-free
// environment: it reaches credentials only through the broker socket. When the flag is
// off (default), callers fall back to the legacy spawn (full env minus the API key), so
// existing installs are byte-for-byte unchanged.
//
// The supervisor process stays as-is (it needs the Slack socket-mode tokens and signs
// process-group kills); only the agent children are de-rooted. See docs/BROKER.md.
import { execFileSync } from 'node:child_process';
import { logger } from './logger.js';

const AGENT_USER = process.env.YODA_AGENT_USER || 'yodacode-agent';
const AGENT_GROUP = process.env.YODA_AGENT_GROUP || 'yodacode';
const BROKER_SOCK = process.env.YODA_BROKER_SOCK || '/run/yodacode-broker.sock';
const BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '';

export function derootEnabled() {
  return process.env.YODA_DEROOT === '1';
}

let ids = null; // {uid, gid} resolved once
function resolveIds() {
  if (ids) return ids;
  const uid = parseInt(execFileSync('id', ['-u', AGENT_USER], { encoding: 'utf8' }).trim(), 10);
  // Primary gid for the child = the shared broker group: grants the broker socket
  // (0660 root:<group>) and the group-writable workspace, and stamps agent-created
  // files with the group the rest of the install shares.
  const groupLine = execFileSync('getent', ['group', AGENT_GROUP], { encoding: 'utf8' }).trim();
  const gid = parseInt(groupLine.split(':')[2], 10);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error(`cannot resolve ${AGENT_USER}/${AGENT_GROUP}`);
  ids = { uid, gid };
  return ids;
}

// The ONLY env the de-rooted agent inherits. CLAUDE_CODE_OAUTH_TOKEN is the model's own
// auth (not a service secret — it must travel with the agent); every API key is withheld
// and reached via `broker call`. SLACK_TEST_CHANNEL_ID is a channel id, not a secret.
const ENV_ALLOWLIST = [
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'NODE_OPTIONS', 'TERM',
  'CLAUDE_CODE_OAUTH_TOKEN', 'SLACK_TEST_CHANNEL_ID', 'YODA_CLAUDE_MODEL',
];

export function buildAgentEnv() {
  const env = {};
  for (const k of ENV_ALLOWLIST) if (process.env[k] != null) env[k] = process.env[k];
  env.HOME = `/home/${AGENT_USER}`;
  if (!env.PATH) env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  if (!env.LANG) env.LANG = 'C.UTF-8';
  env.ANTHROPIC_API_KEY = '';                // never API-key auth
  env.YODA_BROKER_SOCK = BROKER_SOCK;        // how the agent reaches credentials
  if (BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH; // shared browser binaries
  env.YODA_DEROOTED = '1';                   // marker tools/prompts can check
  return env;
}

/**
 * Spawn options for a `claude -p` child. De-rooted when YODA_DEROOT=1, legacy otherwise.
 * Merge over the caller's own options (cwd, stdio, detached…).
 */
export function agentSpawnOpts() {
  if (!derootEnabled()) {
    return { env: { ...process.env, ANTHROPIC_API_KEY: '' } };
  }
  try {
    const { uid, gid } = resolveIds();
    return { env: buildAgentEnv(), uid, gid };
  } catch (e) {
    // Fail SAFE for availability: if the agent user is missing, log loudly and fall
    // back to the legacy spawn rather than taking the bot down.
    logger.error('deroot requested but unavailable — falling back to legacy spawn', { err: e.message });
    return { env: { ...process.env, ANTHROPIC_API_KEY: '' } };
  }
}
