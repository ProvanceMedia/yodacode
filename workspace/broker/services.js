// Service registry — host-side execution of mediated service calls with secret
// injection. The secret is substituted ONLY here, just before the outbound fetch,
// and never logged or returned. ${VAULT:KEY} -> vault secret, ${ARG:name} -> tool arg.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSecret } from './vault.js';
import { doFetch } from './http-fetch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.join(HERE, 'services.policy.json');

let policy = {};

export function loadServices() {
  const file = process.env.YODA_SERVICES_FILE || (fs.existsSync(DEFAULT_FILE) ? DEFAULT_FILE : '');
  if (!file) {
    policy = {};
    return;
  }
  try {
    policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[broker] services: failed to parse ${file}: ${e?.message ?? e}`);
    policy = {};
  }
}

export function serviceManifest() {
  return Object.entries(policy).map(([name, s]) => ({ name, description: s.description, params: s.params }));
}

export function hasService(name) {
  return Object.prototype.hasOwnProperty.call(policy, name);
}

function subst(tmpl, args) {
  return tmpl
    .replace(/\$\{VAULT:([A-Z0-9_]+)\}/g, (_m, k) => getSecret(k) ?? '')
    .replace(/\$\{ARG:([a-zA-Z0-9_]+)\}/g, (_m, k) => String(args[k] ?? ''));
}

export async function executeService(name, args) {
  const s = policy[name];
  if (!s) return { ok: false, error: `unknown service: ${name}` };

  const method = (subst(s.method ?? 'GET', args) || 'GET').toUpperCase();
  let url;
  try {
    url = new URL(subst(s.url, args));
  } catch {
    return { ok: false, error: 'bad url' };
  }
  for (const [k, v] of Object.entries(s.query ?? {})) url.searchParams.set(k, subst(v, args));
  const headers = {};
  for (const [k, v] of Object.entries(s.headers ?? {})) headers[k] = subst(v, args);
  if (s.basicAuth) headers['Authorization'] = 'Basic ' + Buffer.from(subst(s.basicAuth, args)).toString('base64');

  const init = { method, headers };
  const body = args.body;
  if (body != null && method !== 'GET' && method !== 'HEAD') {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }

  return doFetch(url, init, s.timeoutMs ?? 15000);
}
