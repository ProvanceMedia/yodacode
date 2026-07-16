// http_call — the generic "use any configured API naturally" tool (nanoclaw-style).
// The agent names a host + path; the broker looks it up in auth-hosts.json, injects the
// credential from the vault, and fetches host-side. Adding an API = one line of config;
// the agent never holds a key and can only reach allowlisted hosts (fail-closed).
import { lookupHost, hostTimeoutMs } from './auth-hosts.js';
import { getSecret } from './vault.js';
import { getAccessToken, invalidateAccessToken } from './oauth.js';
import { doFetch, ssrfCheck } from './http-fetch.js';

// Reject an upload body over ~8M base64 chars (≈ 6MB of binary) before the base64
// decode allocates the bytes again and before we forward it upstream. Bigger files
// need a resumable upload session (out of scope). (This bounds what the broker
// decodes/forwards, not the raw frame — the socket buffers that first.)
const MAX_BODY_B64 = 8_000_000;
// A bare MIME type is short; cap the length so a caller can't set a giant header.
const MAX_CONTENT_TYPE = 128;

/**
 * Shape the outbound request body from the agent's args. Returns { body, contentType }
 * (contentType is a default, applied only if the host didn't already set one), {} for
 * no body, or { error } on a bad payload. Exported for unit tests — the full httpCall
 * path can't be integration-tested because the SSRF guard blocks loopback.
 *
 * The agent can only send text over the broker socket, so a BINARY upload (a real
 * .xlsx, an image, a PDF) is passed base64-encoded via `bodyBase64` and decoded to
 * bytes here. `contentType` describes the agent's OWN body — safe for it to set, but
 * validated as a bare MIME type so it can't smuggle a second header.
 */
export function encodeRequestBody(args) {
  // Optional caller-set Content-Type describing the agent's OWN body — validated as a
  // bounded, bare MIME (type/subtype) so it can't smuggle a second header via CRLF.
  // Honoured on both the binary and the text path; each falls back to its own default.
  let ct = null;
  if (args.contentType != null) {
    ct = String(args.contentType);
    if (ct.length > MAX_CONTENT_TYPE || !/^[\w.+-]+\/[\w.+-]+$/.test(ct)) {
      return { error: 'contentType must be a plain MIME type, e.g. application/pdf' };
    }
  }
  if (args.bodyBase64 != null) {
    const b64 = String(args.bodyBase64).replace(/\s+/g, '');
    if (b64.length > MAX_BODY_B64) return { error: 'bodyBase64 too large (max ~6MB of binary) — use an upload session for bigger files' };
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return { error: 'bodyBase64 is not valid base64' };
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return { error: 'bodyBase64 decoded to nothing' };
    return { body: buf, contentType: ct ?? 'application/octet-stream' };
  }
  if (args.body != null) {
    return { body: typeof args.body === 'string' ? args.body : JSON.stringify(args.body), contentType: ct ?? 'application/json' };
  }
  return {};
}

export async function httpCall(args) {
  const host = String(args.host ?? '')
    .trim()
    .toLowerCase();
  if (!host) return { ok: false, error: 'host required' };

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
  // Never let the agent reach Anthropic through here (the OAuth token must never
  // be forwarded/logged). Compared against the PARSED hostname so host:port
  // spellings of the same endpoint are covered too.
  if (url.hostname === 'api.anthropic.com') {
    return { ok: false, error: 'refused: api.anthropic.com is not callable via http_call' };
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
    // getAccessToken's error strings are actionable (they name the renew
    // command on invalid_grant) — pass them through to the agent verbatim.
    const mint = await getAccessToken(desc);
    if (!mint.token) return { ok: false, error: mint.error ?? `could not obtain an OAuth access token for ${host}` };
    headers['Authorization'] = `Bearer ${mint.token}`;
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
  if (method !== 'GET' && method !== 'HEAD') {
    const enc = encodeRequestBody(args);
    if (enc.error) return { ok: false, error: enc.error };
    if (enc.body !== undefined) {
      init.body = enc.body;
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = enc.contentType;
    }
  }

  // Default 15s; a host entry can set `timeoutMs` for a slow endpoint (image
  // generation, large uploads). The outer hard-kill (handleMediatedCall) uses the
  // same figure + a small margin, so the two stay in step.
  const timeoutMs = hostTimeoutMs(desc);
  const started = Date.now();
  let res = await doFetch(url, init, timeoutMs);
  // A 401 under a cached OAuth token usually means it expired early or was
  // revoked upstream — invalidate the cache and retry once with a fresh mint.
  // Budgeted against the same window as the outer hard-kill, so a full
  // fetch+mint+fetch chain can't overrun it. A 401 means the request was rejected
  // before processing, so retrying writes is safe.
  if (!res.ok && desc.scheme === 'oauth2' && /^HTTP 401\b/.test(res.error ?? '')) {
    const remaining = () => timeoutMs + 2_000 - (Date.now() - started);
    if (remaining() > 4_000) {
      invalidateAccessToken(desc);
      const mint = await getAccessToken(desc);
      if (!mint.token) return { ok: false, error: mint.error ?? res.error };
      if (remaining() > 1_000) {
        headers['Authorization'] = `Bearer ${mint.token}`;
        res = await doFetch(url, init, remaining());
      }
    }
  }
  return res;
}

export const httpCallDef = {
  name: 'http_call',
  description:
    'Make an authenticated HTTPS request to a configured API host — the broker injects the API key for you (you never see it). Use this for any host listed in auth-hosts.json instead of curl. Params: host (e.g. api.stripe.com), path (e.g. v1/events), method (default GET), query (without leading ?), body (JSON/text, for writes). To upload a BINARY file (a real .xlsx, an image, a PDF), pass bodyBase64 (base64 of the bytes) instead of body, with contentType set to the file MIME type.',
  params: {
    host: { type: 'string', description: 'the API hostname, e.g. api.stripe.com' },
    path: { type: 'string', description: 'path after the host, e.g. crm/v3/objects/contacts' },
    method: { type: 'string', description: 'GET/POST/PUT/PATCH/DELETE (default GET)', optional: true },
    query: { type: 'string', description: 'querystring without the leading ? (optional)', optional: true },
    body: { type: 'string', description: 'JSON/text body for writes (optional)', optional: true },
    bodyBase64: { type: 'string', description: 'base64-encoded BINARY body for file uploads, e.g. a .xlsx or image (optional; use instead of body). Max ~6MB.', optional: true },
    contentType: { type: 'string', description: "MIME type for bodyBase64 uploads, e.g. 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' for .xlsx (optional; default application/octet-stream)", optional: true },
  },
};
