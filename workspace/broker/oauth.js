// OAuth2 token broker — for services that authenticate with a short-lived access token
// minted from a long-lived refresh token (Google et al). The refresh token + client
// id/secret live in the vault (host-side); this exchanges them for an access token,
// caches it until just before expiry, and hands back ONLY the access token to inject.
// Nothing here ever reaches the agent.
import { getSecret } from './vault.js';

const cache = new Map();

export async function getAccessToken(d) {
  if (!d.refreshTokenKey || !d.clientIdKey || !d.clientSecretKey) return null;
  const cached = cache.get(d.refreshTokenKey);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;

  const clientId = getSecret(d.clientIdKey);
  const clientSecret = getSecret(d.clientSecretKey);
  const refreshToken = getSecret(d.refreshTokenKey);
  if (!clientId || !clientSecret || !refreshToken) return null;

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
      console.error(`[oauth] refresh failed for ${d.refreshTokenKey}: HTTP ${r.status}`);
      return null;
    }
    const j = await r.json();
    if (!j.access_token) return null;
    cache.set(d.refreshTokenKey, { token: j.access_token, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000 });
    return j.access_token;
  } catch (e) {
    console.error('[oauth] refresh error:', e?.message ?? e);
    return null;
  } finally {
    clearTimeout(to);
  }
}
