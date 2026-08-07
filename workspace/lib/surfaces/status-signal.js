// Which progress signal owns a Slack DM right now.
//
// INVARIANT: exactly one visible signal at a time.
//
// By default a DM uses the same status card as a channel, so every
// conversation shows the same thing. In the opt-in 'shimmer' mode a DM starts
// on Slack's native indicator (lightweight, but ephemeral: it dies with the
// process leaving no trace) and HANDS OVER to a posted card once the run
// outlives the threshold. Showing both at once reads as the bot talking over
// itself.
//
// Pure so the rule can be tested without a Slack client.

/**
 * @param {object} h Placeholder handle state
 *   { shimmer, handedOver, ts (card id|null), cardPending, startedAt, finished }
 * @param {object} opts { now, cardAfterMs }
 * @returns {'none'|'shimmer'|'create-card'|'card'}
 */
export function statusTarget(h, { now, cardAfterMs }) {
  if (!h || h.finished) return 'none';
  // Channel-style handle (no shimmer): the card is the only signal.
  if (!h.shimmer) return h.ts ? 'card' : 'none';
  // Handed over already — the card owns the DM.
  if (h.handedOver) return h.ts ? 'card' : 'none';
  // Time to take over? (Not while a creation is already in flight.)
  if (!h.ts && !h.cardPending && cardAfterMs > 0 && h.startedAt
      && now - h.startedAt >= cardAfterMs) return 'create-card';
  // Still early (or a card creation is in flight elsewhere): shimmer only.
  return 'shimmer';
}
