// Pure decision logic for restart recovery (no imports, no side effects) —
// which orphaned ticks get a recovery wake and which are skipped. Split from
// orphan-recovery.js so tests can exercise it without pulling in the runner
// (whose module load resets the tick state files).

// A recovery run's own tick carries recoveryAttempt; if IT also dies, the
// next boot sees attempt 1 and may retry once. Beyond that the work itself is
// probably what kills the supervisor (crash loop) — resurrecting it a third
// time just crashes the box again.
export const MAX_RECOVERY_ATTEMPTS = 2;

/**
 * @param {Record<string, object>} orphans conversationId → tick record
 * @param {object} opts { now, maxAgeMs, hasSurface(name) → boolean,
 *   isBusy(conversationId) → boolean (lane already has fresh work) }
 * @returns {{ recover: Array<[string, object]>, skipped: Array<{ id, reason }> }}
 */
export function planOrphanRecovery(orphans, { now, maxAgeMs, hasSurface, isBusy }) {
  const recover = [];
  const skipped = [];
  for (const [id, o] of Object.entries(orphans || {})) {
    if (!o || !o.replyTarget || !o.surface) { skipped.push({ id, reason: 'no reply target' }); continue; }
    if (!hasSurface(o.surface)) { skipped.push({ id, reason: 'surface not running' }); continue; }
    const age = now - (o.startedAt || 0);
    if (!o.startedAt || age > maxAgeMs) { skipped.push({ id, reason: 'too old' }); continue; }
    if ((o.recoveryAttempt || 0) >= MAX_RECOVERY_ATTEMPTS) { skipped.push({ id, reason: 'recovery attempts exhausted' }); continue; }
    // The user already re-asked (their message beat the sweep into the lane):
    // that fresh turn supersedes recovery — answering twice is worse than
    // recovering late.
    if (isBusy && isBusy(id)) { skipped.push({ id, reason: 'conversation already active' }); continue; }
    recover.push([id, o]);
  }
  return { recover, skipped };
}
