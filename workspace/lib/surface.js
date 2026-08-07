// Surface contract — the interface every channel adapter must implement.
//
// A "surface" is a chat protocol that delivers messages from users and accepts
// replies. The dispatcher is surface-agnostic; all protocol-specific logic
// lives in lib/surfaces/<name>.js.
//
// To add a new surface (e.g. Telegram, Discord, iMessage):
//   1. Create lib/surfaces/<name>.js exporting a default object that conforms
//      to the contract below.
//   2. Add 'name' to the YODA_SURFACES env var.
//   3. Done. The dispatcher will pick it up automatically.
//
// ─── Normalised event shape ────────────────────────────────────────────────
// Surface adapters convert their native event shape into this normalised form
// before passing it to dispatcher.handleMessage:
//
//   {
//     surface: 'slack' | 'whatsapp' | ...,
//     userId:        string,        // stable user id (e.g. 'UXXXXXXXXXX' or '44XXXXXXXXXX')
//     conversationId:string,        // stable lane key for queueing (channel+thread or chat JID)
//     messageId:     string,        // stable id for this message (ts, key, etc)
//     text:          string,        // plain text body
//     isDirect:      boolean,       // true if 1:1 (DM/IM/individual chat)
//     isMention:     boolean,       // true if the bot is @mentioned
//     replyTarget:   any,           // surface-specific opaque payload (channel + threadTs, jid, ...)
//     raw:           any,           // the original native event for debug/access
//   }
//
// ─── The contract ──────────────────────────────────────────────────────────
//
// Each surface module exports a default object with these properties:
//
//   name: string
//
//   async start(onIncomingMessage):
//     Connect to the protocol. Wire incoming messages to onIncomingMessage(event)
//     where `event` is the normalised shape above. Return when ready.
//
//   async stop():
//     Disconnect cleanly. Should not throw.
//
//   isAuthorized(event): boolean
//     Surface-specific permission check. Return true if Yoda should consider
//     replying to this event. The dispatcher also runs the generic stop check
//     so this should NOT special-case "stop" messages.
//
//   async fetchContext(event): Promise<{ messages: object[], replyTargetTs: string }>
//     Build the conversation context that gets handed to Claude. messages is a
//     chronological list; the last entry is the user message we're responding to.
//     Each message should have: { user, ts, text } at minimum.
//
//   async postPlaceholder(replyTarget, text, opts): Promise<placeholderHandle>
//     Post the first thing the user sees for this turn, and return an opaque
//     handle that setStatus/updateMessage and the stop handler can use to
//     find/edit it later.
//     `opts.working === true` means text is a working state ("on it") — render
//     it as a muted status line (or a native typing indicator). Otherwise the
//     text is a real message (e.g. the stop handler's "Nothing to stop") and
//     must be posted verbatim. Never infer this from the wording: it used to be
//     sniffed from the literal word "thinking" and silently broke when the
//     status wording became human.
//
//   async updateMessage(placeholderHandle, text, opts): Promise<void>
//     Edit the placeholder in place with new text. Should be tolerant of rate
//     limits / failures (return rather than throw).
//     `opts.status === true` marks a progress update rather than the final
//     reply — only relevant to surfaces that have no setStatus and therefore
//     render both through this one call. Once the reply has been written, a
//     later status write must not overwrite it.
//
// OPTIONAL (feature-detected by the dispatcher — implement if the platform
// can do it well):
//
//   async setStatus(placeholderHandle, text): Promise<void>
//     Cheap re-render of the working state (an edited status card, a native
//     typing indicator). Implementing this is what earns a surface the
//     wall-clock heartbeat: without it the dispatcher will not re-render on a
//     timer, because status would mean editing the reply message itself.
//
//   async suppressPlaceholder(placeholderHandle): Promise<void>
//     Remove the placeholder without posting anything (a <silent/> final).
//
//   recordInbound(event) / recordReply(...)
//     For surfaces that cannot fetch their own history and must keep a local
//     transcript (see lib/surfaces/googlechat.js).
//
//   formatPromptHints(): string
//     A short hint string about surface-specific markdown / etiquette that gets
//     injected into the claude prompt. e.g. "Use Slack markdown (*bold*)..." vs
//     "Use WhatsApp markdown (no <@user> mentions, plain URLs)".
//
// That's the whole contract. Adding a new protocol is a single self-contained
// file plus an env var.

export const surfaces = new Map();

export function registerSurface(surface) {
  if (!surface || !surface.name) {
    throw new Error('registerSurface: surface must have a name');
  }
  surfaces.set(surface.name, surface);
}

export function getSurface(name) {
  return surfaces.get(name) || null;
}
