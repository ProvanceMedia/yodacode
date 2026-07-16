// auth-hosts — a flat hostname -> credential map so adding an authenticated API is ONE
// line (host + scheme + vault key) instead of a full service definition. Powers the
// generic `http_call` tool: the agent names a host, the broker injects the credential.
// The secret stays in the vault, host-side; only the key NAME lives here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSecret } from './vault.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.join(HERE, 'auth-hosts.json');

let hosts = {};

export function loadAuthHosts() {
  const file = process.env.YODA_AUTH_HOSTS_FILE || (fs.existsSync(DEFAULT_FILE) ? DEFAULT_FILE : '');
  if (!file) {
    hosts = {};
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    hosts = Object.fromEntries(Object.entries(raw).map(([h, d]) => [h.toLowerCase(), d]));
  } catch (e) {
    console.error(`[broker] auth-hosts: failed to parse ${file}: ${e?.message ?? e}`);
    hosts = {};
    return;
  }
  // Loud warning (no values) if a configured host points at a missing vault key.
  for (const [h, d] of Object.entries(hosts)) {
    if (d?.vaultKey && !getSecret(d.vaultKey)) console.error(`[broker] auth-hosts: "${h}" needs vault key ${d.vaultKey}, which is not set`);
  }
}

// Normalise the host the same way everywhere (trim + lowercase) so no caller can
// desync — e.g. a padded "api.example.com\n" must resolve to the same entry (and thus
// the same timeout) whether it's the URL builder or the outer-timeout resolver asking.
export function lookupHost(hostname) {
  return hosts[String(hostname ?? '').trim().toLowerCase()];
}

// Per-host request timeout. Everything is on a tight 15s/18s leash by default; a host
// entry may set `timeoutMs` to give a genuinely slow endpoint (image generation, large
// uploads) a longer budget. The broker applies it as BOTH the outbound fetch timeout
// and the outer hard-kill, so raising one field lifts both. Clamped so a typo can't
// pin a call open indefinitely, and never shorter than the default.
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_TIMEOUT_MS = 300_000;
export function hostTimeoutMs(desc) {
  const t = Number(desc?.timeoutMs);
  if (!Number.isFinite(t) || t <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(t, DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

export function authHostsCount() {
  return Object.keys(hosts).length;
}

export function authHostsList() {
  return Object.entries(hosts).map(([host, d]) => ({ host, note: d.note }));
}
