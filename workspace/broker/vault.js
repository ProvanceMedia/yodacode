// Secret vault — the ONLY place plaintext service secrets live, host-side, in
// memory inside the broker daemon (which runs as root). Never readable by the
// de-rooted agent; never returned to the agent.
//
// Sources, in order:
//   1. an explicit JSON file at $YODA_VAULT_FILE (flat {KEY: value} map), and/or
//   2. the project .env (KEY=value lines), and/or
//   3. YODA_VAULT_<KEY> env vars.
// The broker daemon owns these; the agent's scrubbed env never contains them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// workspace/broker -> project root (.env lives at the project root, beside workspace/)
const PROJECT_ROOT = path.resolve(HERE, '../..');

const secrets = new Map();
let unsealed = false;

// Parse a dotenv-style file into [key, value] pairs. Tolerates comments, blank
// lines, `export ` prefixes, and single/double quotes. No interpolation.
function parseEnvFile(text) {
  const out = [];
  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out.push([key, val]);
  }
  return out;
}

export function unsealVault() {
  if (unsealed) return;
  unsealed = true;

  // JSON vault files (flat {KEY: value}).
  const jsonFiles = [process.env.YODA_VAULT_FILE].filter(Boolean);
  for (const file of jsonFiles) {
    if (!fs.existsSync(file)) continue;
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') secrets.set(k, v);
    } catch {
      /* ignore malformed vault file */
    }
  }

  // the project .env (KEY=value). This is where service secrets already live;
  // the broker reads it host-side so the agent no longer has to.
  const envFile = process.env.YODA_ENV_FILE || path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envFile)) {
    try {
      for (const [k, v] of parseEnvFile(fs.readFileSync(envFile, 'utf8'))) secrets.set(k, v);
    } catch {
      /* ignore unreadable env file */
    }
  }

  // YODA_VAULT_<KEY> env vars (e.g. from a unit's Environment=).
  const prefix = 'YODA_VAULT_';
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith(prefix) && v) secrets.set(k.slice(prefix.length), v);
  }
}

export function getSecret(key) {
  return secrets.get(key);
}

export function vaultSize() {
  return secrets.size;
}

/** Re-read the vault from disk/env without a restart (e.g. after rotating a key). */
export function reloadVault() {
  unsealed = false;
  secrets.clear();
  unsealVault();
}
