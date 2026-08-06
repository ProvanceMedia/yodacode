// Restart recovery for runs killed mid-task. When the supervisor dies with a
// reply in flight — an update rebuilding the containers, an OOM kill, a crash —
// the user is left staring at silence: the shimmer/status card vanishes and the
// finished (or half-finished) work sits on disk with nobody to deliver it.
//
// The runner leaves a record of every interrupted tick (see claude-runner.js:
// killAllTicks writes ORPHANS_FILE on graceful shutdown; a hard kill leaves the
// entries in current-ticks.json). On boot, AFTER surfaces are registered, this
// sweep turns each fresh-enough orphan into a synthetic wake event — the same
// mechanism background watches use — so the agent resumes the thread, checks
// what already got done, finishes the task, and replies.

import { config } from './config.js';
import { logger } from './logger.js';
import { takeOrphanTicks } from './claude-runner.js';
import { getSurface } from './surface.js';
import { handleMessage } from './dispatcher.js';
import { planOrphanRecovery } from './orphan-plan.js';
import { queue } from './queue.js';

function buildRecoveryEvent(conversationId, o, now) {
  return {
    surface: o.surface,
    userId: o.userId || null,
    conversationId,
    messageId: `wake-restart-${now}`,   // non-numeric so it can't corrupt ts cutoffs
    text: '',
    files: [],
    isDirect: !!(o.replyTarget && o.replyTarget.isIm),
    isMention: false,
    synthetic: true,                    // dispatcher skips stop-check + re-authz
    noCoalesce: true,                   // queue must NOT drop this — it carries unique state
    wake: {
      kind: 'restart',
      startedAt: o.startedAt,
      elapsedMs: o.startedAt ? now - o.startedAt : 0,
      textExcerpt: o.textExcerpt || '',
      reason: o.reason || 'killed',
      // The recovery run's own tick records attempt+1, so a crash-looping
      // recovery is capped (MAX_RECOVERY_ATTEMPTS in orphan-plan.js).
      attempt: (o.recoveryAttempt || 0) + 1,
    },
    replyTarget: o.replyTarget,
    raw: {
      thread_ts: o.replyTarget?.threadTs,
      channel: o.replyTarget?.channel,
      ts: `wake-restart-${now}`,
      user: o.userId || null,
    },
  };
}

/**
 * Run the recovery sweep. Call once at boot, after surfaces are registered
 * (a wake dispatches back through them). Never throws.
 */
export async function sweepOrphanTicks() {
  if (!config.orphanRecovery.enabled) return;
  let orphans;
  try { orphans = takeOrphanTicks(); } catch (_) { return; }
  if (!Object.keys(orphans || {}).length) return;

  const { recover, skipped } = planOrphanRecovery(orphans, {
    now: Date.now(),
    maxAgeMs: config.orphanRecovery.maxAgeMs,
    hasSurface: (name) => !!getSurface(name),
    isBusy: (conversationId) => queue.isBusy(conversationId),
  });
  for (const s of skipped) {
    logger.warn('orphaned run not recovered', { conversationId: s.id, reason: s.reason });
  }
  for (const [id, o] of recover) {
    logger.info('recovering orphaned run', {
      conversationId: id, surface: o.surface,
      interruptedAfterMs: Date.now() - o.startedAt,
    });
    try {
      await handleMessage(buildRecoveryEvent(id, o, Date.now()), getSurface(o.surface));
    } catch (e) {
      logger.error('orphan recovery dispatch failed', { conversationId: id, err: e.message });
    }
  }
}
