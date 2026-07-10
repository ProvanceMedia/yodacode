// Background-watch persistence. Each watch is one JSON file under
// state/watches/<id>.json describing a shell command to poll after an agent
// turn ends, the condition that means "done", and the conversation to wake when
// it fires (see lib/watcher.js for the poll loop and bin/watch.js for the CLI
// the agent uses to create them).
//
// The directory is resolved from THIS file's location (lib/ -> workspace ->
// state/watches), NOT from config.stateDir, on purpose: the writer
// (bin/watch.js) runs inside the de-rooted agent child with a curated env that
// deliberately strips YODA_STATE_DIR, while the reader (the supervisor's
// watcher) runs with the full env. Anchoring to the module path guarantees both
// sides resolve the SAME directory regardless of how the env differs.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WATCHES_DIR = path.join(WORKSPACE, 'state', 'watches');

// A watch id is a single path component with no separators or dots — anything
// else is rejected so a crafted id (e.g. "../../etc/systemd/system/x") can never
// steer unlink/write outside WATCHES_DIR. The supervisor runs these fs ops (as
// root on the bare-metal install), so this is a real privilege boundary, not
// cosmetics. bin/watch.js's generated ids (`w_<base36>`) satisfy it.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function fileFor(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new Error(`unsafe watch id: ${JSON.stringify(id)}`);
  }
  return path.join(WATCHES_DIR, `${id}.json`);
}

export const watchStore = {
  dir: WATCHES_DIR,

  /** Every valid watch descriptor on disk (malformed files are skipped). */
  list() {
    let files;
    try {
      files = readdirSync(WATCHES_DIR);
    } catch {
      return []; // dir not created yet = no watches
    }
    const out = [];
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue; // ignore *.json.tmp, dotfiles
      const id = f.slice(0, -'.json'.length);
      if (!SAFE_ID.test(id)) continue; // odd filename — skip rather than trust it
      try {
        const w = JSON.parse(readFileSync(path.join(WATCHES_DIR, f), 'utf8'));
        // The FILENAME is the authoritative id — never trust an `id` from file
        // content (it drives unlink/write paths). This severs the traversal.
        if (w && typeof w === 'object' && !Array.isArray(w)) { w.id = id; out.push(w); }
      } catch {
        // half-written or corrupt — leave it; a later save/remove will clear it
      }
    }
    return out;
  },

  get(id) {
    try {
      return JSON.parse(readFileSync(fileFor(id), 'utf8'));
    } catch {
      return null;
    }
  },

  /** Write atomically (tmp + rename) so the poller never reads a half file. */
  save(watch) {
    mkdirSync(WATCHES_DIR, { recursive: true });
    const tmp = `${fileFor(watch.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(watch, null, 2));
    renameSync(tmp, fileFor(watch.id));
  },

  remove(id) {
    try {
      unlinkSync(fileFor(id));
      return true;
    } catch {
      return false;
    }
  },
};
