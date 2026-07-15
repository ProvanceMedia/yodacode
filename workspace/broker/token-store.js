// Rotated-refresh-token overlay — for OAuth providers that REPLACE the refresh token
// on every refresh (Microsoft et al). The human-minted token from `yodacode connect`
// lives in .env, which the broker mounts read-only and can never update; each rotated
// replacement is persisted here instead, in the broker's private state dir, and wins
// over the .env value for as long as it descends from the same sign-in.
//
// "Descends from" is a fingerprint check, not a timestamp race: every entry records a
// hash of the .env token it was rotated away from. When `connect --renew` writes a NEW
// token to .env, the fingerprint no longer matches, the stale entry is ignored, and
// the fresh human sign-in wins — no coordination with the wizard needed.
//
// The state dir must be invisible to the agent (rotated tokens are live credentials):
// in containers it is a broker-only volume (compose.yaml); on bare metal a root-only
// 0700 dir (setup-broker.sh). It must NOT live under workspace/ — the agent mounts
// workspace read-write and workspace/broker read-only-but-readable.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// workspace/broker -> project root, same resolution as vault.js. In the broker
// container this lands on /app/broker-state (the dedicated volume's mount point).
const PROJECT_ROOT = path.resolve(HERE, '../..');

let store = null; // vault key name -> { token, base, rotatedAt }

function storeFile() {
  const dir = process.env.YODA_BROKER_STATE_DIR || path.join(PROJECT_ROOT, 'broker-state');
  return path.join(dir, 'rotated-tokens.json');
}

// First 16 hex chars of SHA-256 — plenty to tie an entry to its .env ancestor
// without writing anything derivable back to a usable token.
function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function load() {
  if (store) return store;
  store = new Map();
  try {
    const obj = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v.token === 'string' && typeof v.base === 'string') store.set(k, v);
    }
  } catch {
    /* missing or malformed — start empty; the .env token still works */
  }
  return store;
}

function save() {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const obj = Object.fromEntries(load());
  // Atomic replace so a crash mid-write can't corrupt the previous state.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * The refresh token to USE for `key`: the rotated replacement if it descends from the
 * current vault value, else the vault value itself (a fresh sign-in always wins).
 */
export function currentRefreshToken(key, vaultValue) {
  if (!vaultValue) return vaultValue;
  const entry = load().get(key);
  if (entry && entry.base === fingerprint(vaultValue)) return entry.token;
  return vaultValue;
}

/**
 * Persist a rotated replacement token. A failed write is survivable — the provider
 * does not revoke the just-used token on rotation, so we log loudly and carry on;
 * the stored chain just ages until a write succeeds or the human renews.
 */
export function persistRotatedToken(key, vaultValue, newToken) {
  load().set(key, { token: newToken, base: fingerprint(vaultValue), rotatedAt: new Date().toISOString() });
  try {
    save();
    return true;
  } catch (e) {
    console.error(
      `[oauth] WARNING: ${key}: provider rotated the refresh token but persisting it failed ` +
        `(${e?.message ?? e}) — check the broker state dir; the previous token keeps working ` +
        `for providers that don't revoke on rotation`
    );
    return false;
  }
}

/**
 * Drop one entry (the provider rejected it) so the vault token gets retried. Only the
 * token that was ACTUALLY rejected is dropped: a stale in-flight mint must not rewind
 * a newer, valid replacement that a concurrent sibling mint persisted meanwhile.
 */
export function dropRotatedToken(key, rejectedToken) {
  const s = load();
  const entry = s.get(key);
  if (!entry) return;
  if (rejectedToken !== undefined && entry.token !== rejectedToken) return;
  s.delete(key);
  try {
    save();
  } catch {
    /* in-memory drop still applies for this process */
  }
}

/**
 * Drop entries whose vault key no longer resolves — a disconnected provider must not
 * leave live credentials behind on disk. Entries whose fingerprint merely mismatches
 * the current vault value are KEPT: currentRefreshToken() already ignores them, and
 * a .env restored from an older backup relies on its matching chain still existing.
 */
export function pruneRotatedTokens(hasVaultKey) {
  const s = load();
  let changed = false;
  for (const key of [...s.keys()]) {
    if (!hasVaultKey(key)) {
      s.delete(key);
      changed = true;
    }
  }
  if (!changed) return;
  try {
    save();
  } catch {
    /* next successful save persists the prune */
  }
}

/** Forget in-memory state so the next use re-reads the store file (used on reload). */
export function resetTokenStore() {
  store = null;
}
