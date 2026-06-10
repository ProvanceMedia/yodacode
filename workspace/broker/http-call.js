// http_call — the generic "use any configured API naturally" tool (nanoclaw-style).
// The agent names a host + path; the broker looks it up in auth-hosts.json, injects the
// credential from the vault, and fetches host-side. Adding an API = one line of config;
// the agent never holds a key and can only reach allowlisted hosts (fail-closed).
import { lookupHost } from './auth-hosts.js';
import { getSecret } from './vault.js';
import { getAccessToken } from './oauth.js';
import { doFetch, ssrfCheck } from './http-fetch.js';

export async function httpCall(args) {
  const host = String(args.host ?? '')
    .trim()
    .toLowerCase();
  if (!host) return { ok: false, error: 'host required' };
  // Never let the agent reach Anthropic through here (the OAuth token must never be forwarded/logged).
  if (host === 'api.anthropic.com') return { ok: false, error: 'refused: api.anthropic.com is not callable via http_call' };

  const desc = lookupHost(host);
  if (!desc) return { ok: false, error: `host not configured — add "${host}" to broker/auth-hosts.json` };

  const method = String(args.method ?? 'GET').toUpperCase();
  let p = String(args.path ?? '');
  if (p.startsWith('/')) p = p.slice(1);
  let url;
  try {
    url = new URL(`https://${host}/${p}`);
  } catch {
    return { ok: false, error: 'bad path' };
  }

  // SSRF defence: this fetch runs as root on the host. Check the real hostname
  // (without any :port), resolved from the parsed URL.
  const blocked = await ssrfCheck(url.hostname);
  if (blocked) return { ok: false, error: `refused: ${blocked}` };
  if (args.query) {
    try {
      for (const [k, v] of new URLSearchParams(String(args.query))) url.searchParams.append(k, v);
    } catch {
      /* ignore malformed query */
    }
  }

  // Headers are host-controlled only — the agent cannot set them, so there is nothing to strip.
  const headers = { ...(desc.extraHeaders ?? {}) };
  // secretHeaders: {headerName: vaultKey} — additional secret-valued headers beyond the main
  // scheme (e.g. Google Ads' developer-token alongside its OAuth bearer).
  for (const [hName, vKey] of Object.entries(desc.secretHeaders ?? {})) {
    const v = getSecret(vKey);
    if (!v) return { ok: false, error: `vault has no key ${vKey} (secretHeaders for ${host})` };
    headers[hName] = v;
  }
  if (desc.scheme === 'oauth2') {
    const token = await getAccessToken(desc);
    if (!token) return { ok: false, error: `could not obtain an OAuth access token for ${host}` };
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    const secret = getSecret(desc.vaultKey ?? '');
    if (!secret) return { ok: false, error: `vault has no key ${desc.vaultKey} (for ${host})` };
    switch (desc.scheme) {
      case 'bearer':
        headers['Authorization'] = `Bearer ${secret}`;
        break;
      case 'header':
        headers[desc.headerName ?? 'Authorization'] = secret;
        break;
      case 'basic': {
        // Password is a literal (basicPassword, default empty) or itself a vault secret
        // (basicPasswordKey) for APIs where both halves are credentials.
        const pw = desc.basicPasswordKey ? (getSecret(desc.basicPasswordKey) ?? '') : (desc.basicPassword ?? '');
        headers['Authorization'] = 'Basic ' + Buffer.from(`${secret}:${pw}`).toString('base64');
        break;
      }
      case 'query':
        url.searchParams.set(desc.queryParam ?? 'api_key', secret);
        break;
      default:
        return { ok: false, error: `unknown auth scheme for ${host}` };
    }
  }

  const init = { method, headers };
  const body = args.body;
  if (body != null && method !== 'GET' && method !== 'HEAD') {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }

  return doFetch(url, init, 15_000);
}

export const httpCallDef = {
  name: 'http_call',
  description:
    'Make an authenticated HTTPS request to a configured API host — the broker injects the API key for you (you never see it). Use this for any host listed in auth-hosts.json instead of curl. Params: host (e.g. api.stripe.com), path (e.g. v1/events), method (default GET), query (without leading ?), body (JSON, for writes).',
  params: {
    host: { type: 'string', description: 'the API hostname, e.g. api.stripe.com' },
    path: { type: 'string', description: 'path after the host, e.g. crm/v3/objects/contacts' },
    method: { type: 'string', description: 'GET/POST/PATCH/DELETE (default GET)', optional: true },
    query: { type: 'string', description: 'querystring without the leading ? (optional)', optional: true },
    body: { type: 'string', description: 'JSON body for writes (optional)', optional: true },
  },
};
