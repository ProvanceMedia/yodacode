// Per-conversation Agent SDK session tracking. Maps a conversation lane
// (thread) to the SDK session that has been serving it, so each new tick can
// `resume` the agent's own session — prior turns, tool results, and working
// memory carry over instead of being rebuilt from the transcript every time.
//
// Persisted to state/sessions.json so resume survives supervisor restarts.
// The underlying session transcripts live in the agent's ~/.claude; if one
// vanishes (container recreated without the home volume, pruned by Claude
// Code), the dispatcher detects the failed resume and falls back to a fresh
// session — this store is an optimisation, never a source of truth.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

const FILE = path.join(config.stateDir, 'sessions.json');
// Generous: every top-level message opens a lane, so busy installs create
// many one-shot entries; the cap only exists to bound the file, and eviction
// is newest-first so live threads are the last to go.
const MAX_ENTRIES = 5000;

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
  } catch {
    cache = {};
  }
  // Drop entries past the max age so dead threads don't accumulate forever.
  const now = Date.now();
  for (const [k, v] of Object.entries(cache)) {
    if (!v || !v.sessionId || now - (v.updatedAt || 0) > config.sessions.maxAgeMs) {
      delete cache[k];
    }
  }
  return cache;
}

function persist() {
  try {
    const entries = Object.entries(cache);
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
      cache = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
    }
    mkdirSync(config.stateDir, { recursive: true });
    writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    logger.warn('session store persist failed', { err: e.message });
  }
}

export const sessionStore = {
  /** @returns {{ sessionId: string, lastTs: string|null, updatedAt: number }|null} */
  get(conversationId) {
    const v = load()[conversationId];
    if (!v) return null;
    if (Date.now() - (v.updatedAt || 0) > config.sessions.maxAgeMs) {
      delete cache[conversationId];
      persist();
      return null;
    }
    return v;
  },

  /** Record the session serving a conversation and the newest context ts seen. */
  set(conversationId, { sessionId, lastTs }) {
    load()[conversationId] = { sessionId, lastTs: lastTs ?? null, updatedAt: Date.now() };
    persist();
  },

  /** Forget a conversation's session (e.g. after a failed resume). */
  clear(conversationId) {
    if (load()[conversationId]) {
      delete cache[conversationId];
      persist();
    }
  },
};
