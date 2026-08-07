// Human wording for the working state.
//
// The agent's raw stream statuses are machine phases — "thinking…",
// "starting up…", "working…" — and a long run repeats one of them for
// minutes. Read aloud, none of them is something a person would say. These
// pools replace the generic phases with plain speech, and give a long run a
// "still on it" that visibly changes instead of a frozen label.
//
// Specific statuses are NOT touched: "reading config.js" or "calling
// api.hubapi.com" already say something true and useful, and inventing
// chatter over them would hide real information.
//
// Adapted from the status-phrase idea in NousResearch/hermes-agent.

// Nothing here may claim progress the agent can't vouch for ("nearly done").
// Being vague is fine; being wrong is not.
const POOLS = {
  // First moments of a turn.
  start: [
    'on it',
    'one sec',
    'having a look',
    'getting started',
  ],
  // Re-said while a long step runs on (the heartbeat).
  still: [
    'still on it',
    'still working through it',
    'still going',
    'still at it',
  ],
  // Past the patience threshold — acknowledge the wait honestly.
  slow: [
    'this one is taking a while',
    'still going — no news yet',
    'still working — this one is slow',
  ],
};

const RECENT_MAX = 6;

/** Generic machine phases that carry no information of their own. */
export function isGenericStatus(text) {
  return /^(thinking|starting up|working)\b/i.test(String(text || '').trim());
}

/**
 * Pick a phrase, avoiding anything said recently.
 *
 * @param {'start'|'still'|'slow'} kind
 * @param {string[]} recent  Mutated: the choice is appended (capped).
 * @param {() => number} [rand]  Injectable for tests.
 */
export function pickPhrase(kind, recent = [], rand = Math.random) {
  const pool = POOLS[kind] || POOLS.start;
  const fresh = pool.filter((p) => !recent.includes(p));
  // Exhausted pool: still never say the same thing twice in a row — that
  // happens on the longest runs, which is exactly when a frozen-looking
  // repeat is least reassuring.
  const last = recent[recent.length - 1];
  const candidates = fresh.length ? fresh : pool.filter((p) => p !== last);
  const usable = candidates.length ? candidates : pool;
  const choice = usable[Math.floor(rand() * usable.length) % usable.length];
  recent.push(choice);
  while (recent.length > RECENT_MAX) recent.shift();
  return choice;
}

/**
 * Which pool a heartbeat should draw from, given how long the run has gone.
 * @param {number} elapsedMs
 * @param {number} slowAfterMs
 */
export function heartbeatKind(elapsedMs, slowAfterMs) {
  return elapsedMs >= slowAfterMs ? 'slow' : 'still';
}
