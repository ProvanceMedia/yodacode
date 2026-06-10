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

export function lookupHost(hostname) {
  return hosts[String(hostname).toLowerCase()];
}

export function authHostsCount() {
  return Object.keys(hosts).length;
}

export function authHostsList() {
  return Object.entries(hosts).map(([host, d]) => ({ host, note: d.note }));
}
