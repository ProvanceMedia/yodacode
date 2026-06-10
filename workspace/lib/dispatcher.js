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
import { parseFinalReply } from './reply-policy.js';
import { maybeReflect } from './skill-reflector.js';
import { maybeReflectMemory } from './memory-reflector.js';

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

  // 6b. Thread-sticky effort escalation. There's no persistent session (each
  // tick is a fresh `claude -p`), so "stay in deep mode for this thread" is
  // simulated by re-scanning the conversation each tick: if the most recent
  // deep-think signal from a human ("ultrathink"/"xhigh") is newer than any
  // "xhigh off"/"normal effort" signal, run this tick at xhigh. Sticks while
  // the trigger message is still in the fetched window. The runner skips effort
  // on Haiku fallbacks automatically.
  const effort = resolveEffort(event, ctx);
  if (effort === 'xhigh') {
    logger.info('effort escalated to xhigh (thread-sticky)', {
      surface: event.surface,
      conversationId: event.conversationId,
    });
  }

  // 7. Run claude with model fallback chain. If the primary model is
  // throttled (Anthropic 529), automatically retry with the next model in
  // YODA_CLAUDE_FALLBACK_MODELS. User-initiated stops, timeouts, and
  // non-throttle errors do NOT trigger a fallback (they're not transient).
  const modelChain = event.modelOverride
    ? [event.modelOverride, ...config.claude.fallbackModels]
    : [config.claude.model || null, ...config.claude.fallbackModels];
  let result = null;
  let modelUsed = null;
  const tickStartMs = Date.now();
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
      effort,
      onStatus: (text) => (surface.setStatus
        ? surface.setStatus(placeholder, text)
        : surface.updateMessage(placeholder, text)),
      onFinal: async (text) => {
        // Post ONLY the <say>-tagged part of the model's final output; everything
        // else is scratchpad (see parseFinalReply). <silent/> posts nothing.
        const parsed = parseFinalReply(text);
        if (parsed.kind === 'text') return surface.updateMessage(placeholder, parsed.text);
        if (surface.suppressPlaceholder) return surface.suppressPlaceholder(placeholder);
        return surface.updateMessage(placeholder, '·');
      },
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
        `⚠️ All models throttled. Anthropic is overloaded, try again in a minute.`);
    } catch (_) {}
  } else if (result.killed && result.error === 'timeout') {
    // Idle timeout — claude went silent for the whole watchdog window, so it
    // was almost certainly stuck (hung API call or tool), not just busy. The
    // translator was mid-stream, so the placeholder is frozen on the last
    // status. Replace it with a clear message.
    try {
      await surface.updateMessage(placeholder,
        `⏱️ No activity for ${Math.round(config.claude.timeoutMs / 1000)}s, looked stuck on a hung API call or tool, so I stopped. Try again, or break it into smaller steps.`);
    } catch (_) {}
  } else if (result.killed && result.error === 'hard_timeout') {
    // Hard ceiling — claude was still ACTIVE but ran past the absolute cap, so
    // it was stopped to bound usage (not because it looked stuck).
    try {
      await surface.updateMessage(placeholder,
        `⏱️ Hit the ${Math.round(config.claude.hardTimeoutMs / 1000)}s hard limit while still working, so I stopped to cap usage. Try breaking it into smaller steps.`);
    } catch (_) {}
  } else if (result.killed && result.error === 'iteration_cap') {
    try {
      await surface.updateMessage(placeholder,
        result.guardrailMessage || '🛑 Iteration cap hit, claude was looping.');
    } catch (_) {}
  } else if (result.killed && result.error === 'killed') {
    // User-initiated stop — the stop-handler already updated the placeholder
    // to "🛑 Stopped by user", nothing more to do.
  }

  // Skill + memory self-generation. Fire-and-forget background reflections
  // after a successful tick. Skills capture reusable PROCEDURES, memory
  // captures durable FACTS — they look at the same transcript but produce
  // different artefacts. Both opt-in via env vars. Never blocks the response.
  const parsedFinal = result.ok && result.finalText ? parseFinalReply(result.finalText) : null;
  if (parsedFinal && parsedFinal.kind === 'text') {
    const reflectionArgs = {
      surface: event.surface,
      conversationId: event.conversationId,
      userText: event.text || '',
      replyText: parsedFinal.text,
      tracker: result.tracker,
      durationMs: Date.now() - tickStartMs,
    };
    try { maybeReflect(reflectionArgs); }
    catch (e) { logger.warn('skill-reflector dispatch failed', { err: e.message }); }
    try { maybeReflectMemory(reflectionArgs); }
    catch (e) { logger.warn('memory-reflector dispatch failed', { err: e.message }); }
  }
}

// Resolve the effort level for a tick. Scans the triggering message + recent
// human messages (newest first) for an escalate ("xhigh"/"ultrathink") or
// de-escalate ("xhigh off"/"normal effort") signal; the most recent wins. Bot
// and the agent's own messages are skipped so it can't self-trigger by quoting
// the keyword. Falls back to the global YODA_CLAUDE_EFFORT default.
function resolveEffort(event, ctx) {
  let onRe, offRe;
  try {
    onRe = new RegExp(config.claude.effortEscalatePattern, 'i');
    offRe = new RegExp(config.claude.effortDeescalatePattern, 'i');
  } catch (e) {
    logger.warn('bad effort escalate/deescalate pattern, escalation off', { err: e.message });
    return config.claude.effort || undefined;
  }
  // Newest-first: the current message, then recent history (skip bots + self).
  const texts = [event.text || ''];
  for (const m of [...(ctx.messages || [])].reverse()) {
    if (m.bot_id || (config.botUserId && m.user === config.botUserId)) continue;
    texts.push(m.text || '');
  }
  for (const text of texts) {
    if (offRe.test(text)) return config.claude.effort || undefined;  // explicit off wins
    if (onRe.test(text)) return 'xhigh';
  }
  return config.claude.effort || undefined;
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
- **Output contract (important):** Think, plan, and decide as much as you like — the user ONLY ever sees the text you put inside \`<say>…</say>\` tags. Everything outside those tags is private scratchpad and is never shown. Wrap just the user-facing reply in \`<say>…</say>\`, e.g. \`<say>hey, what's up?</say>\`. Do NOT call any bin/slack-tools.sh post/update yourself — the wrapper handles delivery.
- Be concise, in character. No preamble like "Sure, here's...". Put just the reply inside \`<say>\`.
- If there is genuinely nothing to say (the message wasn't aimed at you, or it's banter between others), emit \`<silent/>\` and nothing else — nothing is posted.
- Emit exactly ONE \`<say>…</say>\` (or \`<silent/>\`). NEVER put reasoning, your decision process, or a description of the message inside \`<say>\` — only the reply text the user should read. For a greeting, just greet back inside \`<say>\`.
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
