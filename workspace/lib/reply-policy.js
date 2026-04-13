// Generic reply policy helpers shared across all surfaces.
//
// The "should I reply?" decision is **surface-specific** and lives in each
// adapter's isAuthorized() method (lib/surfaces/<name>.js). What stays
// generic here is detecting "stop" commands, since stop semantics are
// universal across surfaces.

import { config } from './config.js';

const STOP_RE = new RegExp(config.stop.pattern, 'i');

/**
 * Detect a stop command in a normalised event.
 */
export function isStopMessage(event) {
  if (!event || !event.text || !event.userId) return false;
  if (!config.stop.authorizedUsers.has(event.userId)) return false;
  return STOP_RE.test(event.text.trim());
}
