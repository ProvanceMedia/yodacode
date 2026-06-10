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

// ─── Final-reply parsing ─────────────────────────────────────────────────────
//
// The model is told to wrap ONLY the user-facing reply in <say>…</say> (or emit
// <silent/> to post nothing). Everything outside the tags is scratchpad — models
// sometimes narrate their decision ("just a casual greeting, light ack") and
// without a structural delimiter that narration gets posted verbatim. We extract
// the tagged part and drop the rest, so deliberation can never leak into chat.
// The legacy NO_REPLY sentinel is still honoured for back-compat.

/**
 * Classify the model's final output.
 * @param {string} text
 * @returns {{kind:'text', text:string} | {kind:'silent'}}
 */
export function parseFinalReply(text) {
  const t = (text || '').trim();
  if (!t) return { kind: 'silent' };

  const say = t.match(/<say>([\s\S]*?)<\/say>/i) || t.match(/<reply>([\s\S]*?)<\/reply>/i);
  if (say) {
    const inner = say[1].trim();
    return inner ? { kind: 'text', text: inner } : { kind: 'silent' };
  }
  // <react> is accepted from the model but this build has no reaction support on
  // its surfaces — treat an ack-without-text as silence rather than posting the tag.
  if (/<react>[^<]*<\/react>/i.test(t) || /<silent\s*\/?>/i.test(t)) return { kind: 'silent' };

  // Legacy sentinel: NO_REPLY on the first line silences even with trailing junk.
  if (/^NO_REPLY\b/i.test(t.split('\n')[0].trim())) return { kind: 'silent' };

  // No tags at all — treat the whole text as the reply (back-compat).
  return { kind: 'text', text: t };
}
