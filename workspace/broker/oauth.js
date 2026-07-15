// OAuth2 token broker — for services that authenticate with a short-lived access token
// minted from a long-lived refresh token (Google, Microsoft, et al). The refresh token
// + client id (+ secret, when the provider issues one — public clients don't) live in
// the vault (host-side); this exchanges them for an access token, caches it until just
// before expiry, and hands back ONLY the access token to inject. Nothing here ever
// reaches the agent.
//
// Providers that ROTATE the refresh token on every use (Microsoft et al) are handled:
// each replacement is persisted via token-store.js in the broker's private state dir
// (.env itself is mounted read-only) and preferred over the .env value for as long as
// it descends from the same sign-in — a fresh `connect --renew` always wins.
//
// Failure contract: getAccessToken() returns { token } on success or { error } with an
// ACTIONABLE message. invalid_grant and interaction_required (the operator's sign-in
// expired, was revoked, or the provider demands a fresh interactive sign-in — e.g.
// Google's 7-day Testing-status expiry, a password change, or a Microsoft MFA /
// Conditional Access step-up) are terminal until the human re-consents, so they are
// negative-cached and the message names the fix (`yodacode connect <provider> --renew`).
// The agent is expected to relay that message to the user verbatim.
import { getSecret } from './vault.js';
import { currentRefreshToken, persistRotatedToken, dropRotatedToken, resetTokenStore } from './token-store.js';

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
  resetTokenStore(); // re-read persisted rotations; a renewed .env token outranks them
}

export async function getAccessToken(d) {
  if (!d.refreshTokenKey || !d.clientIdKey) {
    return { error: 'oauth2 host is missing clientIdKey/refreshTokenKey in auth-hosts.json' };
  }
  const cached = cache.get(d.refreshTokenKey);
  if (cached && cached.exp > Date.now() + 60_000) return { token: cached.token };
  const gone = dead.get(d.refreshTokenKey);
  if (gone) {
    if (gone.until > Date.now()) return { error: gone.error };
    dead.delete(d.refreshTokenKey);
  }

  const clientId = getSecret(d.clientIdKey);
  // Public clients (Microsoft device-code apps et al) have no secret at all: the host
  // entry declares no clientSecretKey and the refresh request must omit client_secret.
  const clientSecret = d.clientSecretKey ? getSecret(d.clientSecretKey) : undefined;
  const vaultRefreshToken = getSecret(d.refreshTokenKey);
  // For rotating providers the live token is the newest persisted descendant of the
  // .env value; for everyone else this IS the .env value.
  const refreshToken = currentRefreshToken(d.refreshTokenKey, vaultRefreshToken);
  if (!clientId || (d.clientSecretKey && !clientSecret) || !refreshToken) {
    const missing = [
      !clientId && d.clientIdKey,
      d.clientSecretKey && !clientSecret && d.clientSecretKey,
      !refreshToken && d.refreshTokenKey,
    ].filter(Boolean);
    return { error: `vault is missing ${missing.join(', ')}${d.provider ? ` — run: yodacode connect ${d.provider}` : ''}` };
  }

  const body = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (clientSecret) body.set('client_secret', clientSecret);
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
      if (code === 'invalid_grant' || code === 'interaction_required') {
        // If a ROTATED token was rejected but .env still holds the original sign-in
        // (e.g. broker state restored from an older backup), don't declare the
        // sign-in dead yet: drop the rotation and let the next call retry from .env.
        if (refreshToken !== vaultRefreshToken) {
          dropRotatedToken(d.refreshTokenKey, refreshToken);
          const error = 'rotated refresh token was rejected — retrying from the original sign-in on the next call';
          setHealth(d.refreshTokenKey, 'rotated-token-rejected', error);
          return { error };
        }
        // The sign-in itself is dead (expired, revoked, password change) or the
        // provider demands a fresh interactive sign-in (Microsoft delivers MFA and
        // Conditional Access step-ups as interaction_required) — no amount of
        // retrying fixes it. Back off and say what does.
        const error = `authorization has expired or been revoked — ${renewHint(d)}`;
        dead.set(d.refreshTokenKey, { until: Date.now() + DEAD_TTL_MS, error });
        setHealth(d.refreshTokenKey, code, error);
        return { error };
      }
      if (code === 'invalid_client') {
        const keys = [d.clientIdKey, d.clientSecretKey].filter(Boolean).join('/');
        const error = `OAuth client credentials rejected (invalid_client) — check ${keys}${d.provider ? `, or re-run: yodacode connect ${d.provider}` : ''}`;
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
    // Some providers rotate the refresh token on every use (Microsoft et al).
    // .env is read-only, so the replacement is persisted to the broker's private
    // state dir and preferred from now on. Persist failure is survivable (the
    // just-used token is not revoked on rotation) — token-store logs it loudly.
    if (j.refresh_token && j.refresh_token !== refreshToken) {
      persistRotatedToken(d.refreshTokenKey, vaultRefreshToken, j.refresh_token);
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
