// OAuth2 token broker — for services that authenticate with a short-lived access token
// minted from a long-lived refresh token (Google et al). The refresh token + client
// id/secret live in the vault (host-side); this exchanges them for an access token,
// caches it until just before expiry, and hands back ONLY the access token to inject.
// Nothing here ever reaches the agent.
//
// Failure contract: getAccessToken() returns { token } on success or { error } with an
// ACTIONABLE message. invalid_grant (the operator's sign-in expired or was revoked —
// e.g. Google's 7-day Testing-status expiry, a password change, or manual revocation)
// is terminal until the human re-consents, so it is negative-cached and the message
// names the fix (`yodacode connect <provider> --renew`). The agent is expected to
// relay that message to the user verbatim.
import { getSecret } from './vault.js';

const cache = new Map(); // refreshTokenKey -> { token, exp }
const dead = new Map(); // refreshTokenKey -> { until, error }  (invalid_grant backoff)
const health = new Map(); // refreshTokenKey -> { state, error?, checkedAt }
const DEAD_TTL_MS = 10 * 60_000;

function renewHint(d) {
  return d.provider
    ? `tell the user to run: yodacode connect ${d.provider} --renew  (on the server, ~2 minutes)`
    : 'the refresh token must be re-minted and updated in the vault';
}

function setHealth(key, state, error) {
  health.set(key, { state, ...(error ? { error: String(error).slice(0, 200) } : {}), checkedAt: new Date().toISOString() });
}

/** Drop a cached access token (e.g. after a downstream 401) so the next call re-mints. */
export function invalidateAccessToken(d) {
  if (d?.refreshTokenKey) cache.delete(d.refreshTokenKey);
}

/** Per-refresh-token mint health for `broker status` / doctor — never includes token values. */
export function oauthHealth() {
  return Object.fromEntries(health);
}

/** Clear caches so a renewed refresh token takes effect on reload. */
export function resetOauthState() {
  cache.clear();
  dead.clear();
}

export async function getAccessToken(d) {
  if (!d.refreshTokenKey || !d.clientIdKey || !d.clientSecretKey) {
    return { error: 'oauth2 host is missing clientIdKey/clientSecretKey/refreshTokenKey in auth-hosts.json' };
  }
  const cached = cache.get(d.refreshTokenKey);
  if (cached && cached.exp > Date.now() + 60_000) return { token: cached.token };
  const gone = dead.get(d.refreshTokenKey);
  if (gone) {
    if (gone.until > Date.now()) return { error: gone.error };
    dead.delete(d.refreshTokenKey);
  }

  const clientId = getSecret(d.clientIdKey);
  const clientSecret = getSecret(d.clientSecretKey);
  const refreshToken = getSecret(d.refreshTokenKey);
  if (!clientId || !clientSecret || !refreshToken) {
    const missing = [!clientId && d.clientIdKey, !clientSecret && d.clientSecretKey, !refreshToken && d.refreshTokenKey].filter(Boolean);
    return { error: `vault is missing ${missing.join(', ')}${d.provider ? ` — run: yodacode connect ${d.provider}` : ''}` };
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(d.tokenUrl ?? 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: ctrl.signal,
    });
    if (!r.ok) {
      let ej = {};
      try {
        ej = JSON.parse(await r.text());
      } catch {
        /* non-JSON error body */
      }
      const code = String(ej.error ?? `HTTP ${r.status}`);
      console.error(`[oauth] refresh failed for ${d.refreshTokenKey}: HTTP ${r.status} ${code}`);
      if (code === 'invalid_grant') {
        // The sign-in itself is dead (expired, revoked, or password change) —
        // no amount of retrying fixes it. Back off and say what does.
        const error = `authorization has expired or been revoked — ${renewHint(d)}`;
        dead.set(d.refreshTokenKey, { until: Date.now() + DEAD_TTL_MS, error });
        setHealth(d.refreshTokenKey, 'invalid_grant', error);
        return { error };
      }
      if (code === 'invalid_client') {
        const error = `OAuth client credentials rejected (invalid_client) — check ${d.clientIdKey}/${d.clientSecretKey}${d.provider ? `, or re-run: yodacode connect ${d.provider}` : ''}`;
        setHealth(d.refreshTokenKey, 'invalid_client', error);
        return { error };
      }
      setHealth(d.refreshTokenKey, 'error', code);
      return { error: `could not refresh the OAuth access token (${code})` };
    }
    const j = await r.json();
    if (!j.access_token) {
      setHealth(d.refreshTokenKey, 'error', 'no access_token in response');
      return { error: 'token endpoint returned no access token' };
    }
    // Some providers rotate the refresh token on every use (Strava et al).
    // The broker mounts .env read-only and CANNOT persist the new one — the
    // stored token is now one use from death. Such providers are deliberately
    // not in the catalog; be loud if one sneaks in via a hand-written entry.
    if (j.refresh_token && j.refresh_token !== refreshToken) {
      console.error(`[oauth] WARNING: ${d.refreshTokenKey}: provider rotated the refresh token — the broker cannot persist it; this provider will break shortly. Rotating-token providers are unsupported.`);
    }
    cache.set(d.refreshTokenKey, { token: j.access_token, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000 });
    setHealth(d.refreshTokenKey, 'ok');
    return { token: j.access_token };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e);
    console.error('[oauth] refresh error:', msg);
    setHealth(d.refreshTokenKey, 'error', msg);
    return { error: `could not reach the OAuth token endpoint (${msg})` };
  } finally {
    clearTimeout(to);
  }
}
