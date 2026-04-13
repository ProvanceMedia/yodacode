// Surface-agnostic dispatcher. Receives normalised events from any surface
// adapter, runs the same reply pipeline for all of them:
//
//   1. Stop check (handled inline by stop-handler)
//   2. Authorisation check (delegated to surface.isAuthorized)
//   3. Per-conversation queue (serial within a lane, coalesces rapid messages)
//   4. Build context (delegated to surface.fetchContext)
//   5. Post placeholder (delegated to surface.postPlaceholder)
//   6. Build prompt (with surface-specific markdown hints)
//   7. Run claude with stream-translator → live updates via surface.updateMessage
//   8. Done — final text replaces the placeholder
//
// All shared modules: queue, claude-runner, stream-translator, conversation,
// reply-policy. Nothing here is Slack- or WhatsApp-specific.

import { tryHandleStop } from './stop-handler.js';
import { queue } from './queue.js';
import { runClaude } from './claude-runner.js';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * @param {object} event Normalised event (see lib/surface.js for shape)
 * @param {object} surface The surface adapter that produced the event
 */
export async function handleMessage(event, surface) {
  // 1. Stop command? Handle inline and short-circuit.
  if (await tryHandleStop(event)) return;

  // 2. Authorisation
  if (!surface.isAuthorized(event)) {
    logger.debug('not authorized, ignoring', {
      surface: event.surface,
      userId: event.userId,
      conversationId: event.conversationId,
    });
    return;
  }

  // 3. Queue per conversation. Rapid messages coalesce — the worker picks up
  // the most recent state when it next runs.
  queue.submit(event.conversationId, event, async (ev) => {
    try {
      await processReply(ev, surface);
    } catch (e) {
      logger.error('processReply threw', {
        err: e.message,
        stack: e.stack,
        surface: ev.surface,
      });
    }
  });
}

async function processReply(event, surface) {
  // 4. Build context
  const ctx = await surface.fetchContext(event);

  // 5. Post placeholder
  let placeholder;
  try {
    placeholder = await surface.postPlaceholder(event.replyTarget, '_💭 thinking…_');
  } catch (e) {
    logger.error('failed to post placeholder', {
      err: e.message,
      surface: event.surface,
      conversationId: event.conversationId,
    });
    return;
  }

  logger.info('replying', {
    surface: event.surface,
    conversationId: event.conversationId,
    userId: event.userId,
  });

  // 6. Build prompt with surface-specific hints
  const prompt = buildPrompt(event, ctx, surface);

  // 7. Run claude with model fallback chain. If the primary model is
  // throttled (Anthropic 529), automatically retry with the next model in
  // YODA_CLAUDE_FALLBACK_MODELS. User-initiated stops, timeouts, and
  // non-throttle errors do NOT trigger a fallback (they're not transient).
  const modelChain = [config.claude.model || null, ...config.claude.fallbackModels];
  let result = null;
  let modelUsed = null;
  for (let i = 0; i < modelChain.length; i++) {
    const model = modelChain[i];
    modelUsed = model || '(default)';
    if (i > 0) {
      // Tell the user we're falling back
      try {
        await surface.updateMessage(placeholder, `🔄 ${modelChain[i - 1] || 'default'} throttled, trying ${model}…`);
      } catch (_) {}
    }
    result = await runClaude({
      surface: event.surface,
      conversationId: event.conversationId,
      placeholder,
      prompt,
      model: model || undefined,
      onStatus: (text) => surface.updateMessage(placeholder, text),
      onFinal: (text) => surface.updateMessage(placeholder, text),
    });
    if (result.ok) break;
    // Only retry on transient throttle. Stops/timeouts/other errors → fail.
    if (!result.throttled) break;
    logger.warn('claude throttled, falling back', {
      surface: event.surface,
      from: model || '(default)',
      next: modelChain[i + 1] || '(none)',
    });
  }

  if (!result.ok && !result.killed) {
    logger.error('claude run failed', {
      surface: event.surface,
      model: modelUsed,
      error: result.error,
    });
    try {
      await surface.updateMessage(placeholder, `⚠️ Run failed: ${result.error || 'unknown'}`);
    } catch (_) {}
  } else if (result.throttled && !result.ok) {
    // All models in the chain were throttled
    try {
      await surface.updateMessage(placeholder,
        `⚠️ All models throttled. Anthropic is overloaded — try again in a minute.`);
    } catch (_) {}
  } else if (result.killed && result.error === 'timeout') {
    // Hard timeout — claude was killed for running too long. The translator
    // was still mid-stream so the placeholder is stuck on the last status.
    // Replace it with a clear timeout message.
    try {
      await surface.updateMessage(placeholder,
        `⏱️ Timed out after ${Math.round(config.claude.timeoutMs / 1000)}s of work. Probably stuck on a slow API call or running too many tool calls. Try a more focused request.`);
    } catch (_) {}
  } else if (result.killed && result.error === 'killed') {
    // User-initiated stop — the stop-handler already updated the placeholder
    // to "🛑 Stopped by user", nothing more to do.
  }
}

function buildPrompt(event, ctx, surface) {
  const transcript = formatTranscript(ctx.messages, ctx.replyTargetTs || event.messageId);
  const surfaceHints = surface.formatPromptHints ? surface.formatPromptHints() : '';
  const attachmentsBlock = formatAttachments(ctx.attachments || []);

  return `You are responding in real time to a ${event.surface} message.

Conversation: ${ctx.convName || event.conversationId}${event.isDirect ? ' (direct/IM)' : ' (channel)'}
Recent messages (chronological, last is most recent):
${transcript}
${attachmentsBlock}
${surfaceHints}

Instructions:
- Compose a single in-character reply to the marked message, taking the prior messages as context for continuity.
- Do whatever tool calls you need (curl, bash, browser-tools, subagents, etc.) to gather information.
- If the user attached files, USE THE Read TOOL on the local paths above to actually look at them. Images, PDFs, text files — Read can handle all of them. Don't refer to attachments without reading them first.
- Your FINAL message text becomes the user-visible reply. Do NOT call any bin/slack-tools.sh post/update yourself — the wrapper handles that automatically by editing a placeholder.
- Be concise, in Yoda voice (which is the same as Codi's voice — dry, witty, pragmatic). No preamble like "Sure, here's...". Just the reply.
- If there is genuinely nothing to say (e.g. the message wasn't really aimed at you), output the literal text NO_REPLY and nothing else.
`;
}

function formatAttachments(attachments) {
  if (!attachments.length) return '';
  const lines = ['', 'Attachments on the marked message (use the Read tool to view them):'];
  for (const a of attachments) {
    if (a.error) {
      lines.push(`  - ${a.name || a.id}: download failed (${a.error})`);
    } else {
      lines.push(`  - ${a.name} (${a.mimetype}, ${a.size} bytes) → ${a.path}`);
    }
  }
  return lines.join('\n');
}

function formatTranscript(messages, replyTargetId) {
  const lines = [];
  for (const m of messages || []) {
    const user = m.user || m.bot_id || '?';
    const id = m.ts || m.id || '';
    const text = (m.text || '').replace(/\n/g, ' ');
    const marker = id === replyTargetId ? ' <-- THIS IS THE NEW MESSAGE TO RESPOND TO' : '';
    lines.push(`  [${id}] <@${user}>: ${text}${marker}`);
  }
  return lines.join('\n');
}
