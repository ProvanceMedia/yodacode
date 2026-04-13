// Surface-agnostic stop handler.
//
// When an authorised user posts a "stop" message via any surface, find the
// in-flight tick (across any surface), kill its claude process group, and
// edit the placeholder via the right surface adapter.

import { isStopMessage } from './reply-policy.js';
import { findTick, findTickWhere, killTick } from './claude-runner.js';
import { getSurface } from './surface.js';
import { logger } from './logger.js';

/**
 * Try to handle the event as a stop command. Returns true if it was handled
 * (and the caller should NOT also dispatch it as a normal reply).
 *
 * @param {object} event Normalised event from a surface adapter
 */
export async function tryHandleStop(event) {
  if (!isStopMessage(event)) return false;

  // First try to find a tick for the same conversation. If none, fall back
  // to any in-flight tick from the same surface (e.g. Stu typed "stop" at
  // the top level while a threaded reply is in flight).
  let tick = findTick(event.conversationId);
  if (!tick) {
    tick = findTickWhere((id, t) => t.surface === event.surface);
  }

  const sourceSurface = getSurface(event.surface);

  if (!tick) {
    logger.info('stop received but no in-flight tick', {
      surface: event.surface,
      conversationId: event.conversationId,
    });
    if (sourceSurface) {
      try {
        const placeholder = await sourceSurface.postPlaceholder(event.replyTarget, '🛑 Nothing to stop — I\'m idle.');
        // No further action needed; the user just gets the ack.
        // eslint-disable-next-line no-unused-vars
        const _ = placeholder;
      } catch (e) {
        logger.warn('failed to ack idle stop', { err: e.message });
      }
    }
    return true;
  }

  killTick(tick);

  // Update the placeholder of the killed tick via its OWN surface (which may
  // differ from the surface that received the stop command — e.g. you could
  // type "stop" in Slack to kill an in-flight WhatsApp reply, though in
  // practice that's unlikely).
  const tickSurface = getSurface(tick.surface);
  if (tickSurface && tick.placeholder) {
    try {
      await tickSurface.updateMessage(tick.placeholder, '🛑 *Stopped by user.*');
    } catch (e) {
      logger.warn('failed to update placeholder after stop', { err: e.message });
    }
  }

  // If the stop was posted in a different conversation than the in-flight
  // one, also acknowledge in the original location.
  if (sourceSurface && event.conversationId !== tick.placeholder?.conversationId) {
    try {
      await sourceSurface.postPlaceholder(event.replyTarget, '🛑 Stopped the in-flight task.');
    } catch (_) {}
  }

  logger.info('stop handled', {
    surface: event.surface,
    killedSurface: tick.surface,
    conversationId: event.conversationId,
  });
  return true;
}
