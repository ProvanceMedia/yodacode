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
import { sessionStore } from './session-store.js';
import { watchStore } from './watch-store.js';

/**
 * @param {object} event Normalised event (see lib/surface.js for shape)
 * @param {object} surface The surface adapter that produced the event
 */
export async function handleMessage(event, surface) {
  // Synthetic wake events (from the background watcher) are pre-trusted: the
  // watch was created by an authorised turn and only ever wakes that same
  // thread, so they skip the stop-check (a system wake is never "stop") and the
  // surface re-authorisation (which would reject a message with no @-mention).
  if (!event.synthetic) {
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
  }

  // A surface that keeps its own transcript (Google Chat, which can't fetch its
  // history) records every inbound message HERE — before the queue coalesces a
  // burst — so a mid-burst message whose worker never runs is still kept for
  // context. Skip synthetic wake events (not real user messages). Optional hook,
  // best-effort. Real user messages only reach here past the stop + authz checks.
  if (!event.synthetic && surface.recordInbound) {
    try { surface.recordInbound(event); }
    catch (e) { logger.debug('recordInbound failed', { err: e.message }); }
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
    placeholder = await surface.postPlaceholder(event.replyTarget, '_thinking…_');
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

  // 6. Per-thread session resume. If this conversation already has an SDK
  // session, resume it: the agent keeps its own prior turns and tool results,
  // and the prompt only carries messages that arrived since its last turn.
  // The store is an optimisation, never truth — a failed resume (session
  // file gone, e.g. recreated container) falls back to a fresh session with
  // the full transcript below.
  const sess = config.sessions.resumeEnabled ? sessionStore.get(event.conversationId) : null;

  // 6a. Build prompt with surface-specific hints (delta-only when resuming).
  // A watcher wake (event.wake) gets a tailored prompt describing what fired;
  // everything else — session resume, effort, delivery — is identical.
  let sel = selectContext(event, ctx, sess);
  let prompt = event.wake
    ? buildWakePrompt(event, ctx, surface, sel)
    : buildPrompt(event, ctx, surface, sel);

  // 6b. Thread-sticky effort escalation, re-derived from the fetched
  // transcript each tick (independent of session resume, which doesn't see
  // messages the agent wasn't invoked for): if the most recent deep-think
  // signal from a human ("ultrathink"/"xhigh") is newer than any "xhigh off"/
  // "normal effort" signal, run this tick at xhigh. Sticks while the trigger
  // message is still in the fetched window. The runner skips effort on Haiku
  // fallbacks automatically.
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

  const runChain = async (promptText, resumeId) => {
    let res = null;
    for (let i = 0; i < modelChain.length; i++) {
      const model = modelChain[i];
      modelUsed = model || '(default)';
      if (i > 0) {
        // Tell the user we're falling back
        try {
          await surface.updateMessage(placeholder, `_${modelChain[i - 1] || 'default'} is overloaded — switching to ${model}…_`);
        } catch (_) {}
      }
      res = await runClaude({
        surface: event.surface,
        conversationId: event.conversationId,
        userId: event.userId,
        replyTarget: event.replyTarget,
        placeholder,
        prompt: promptText,
        model: model || undefined,
        effort,
        resume: resumeId,
        onStatus: (text) => (surface.setStatus
          ? surface.setStatus(placeholder, text)
          : surface.updateMessage(placeholder, text)),
        onFinal: async (text, meta) => {
          // A failed resume must not flash its error at the user — the
          // dispatcher retries on a fresh session and that run delivers.
          // Gated on the translator's error flag so a GENUINE reply that
          // happens to contain the phrase can never be swallowed.
          if (resumeId && meta?.isError && isResumeFailure(text)) return;
          // Post ONLY the <say>-tagged part of the model's final output; everything
          // else is scratchpad (see parseFinalReply). <silent/> posts nothing —
          // unless this turn armed a background watch, which the user must be
          // able to see (an invisible "I'll get back to you" is a broken promise).
          const parsed = parseFinalReply(text);
          const footer = watchFooter(event.conversationId, tickStartMs);
          if (parsed.kind === 'text') {
            return surface.updateMessage(placeholder, footer ? `${parsed.text}\n\n${footer}` : parsed.text);
          }
          if (footer) return surface.updateMessage(placeholder, footer);
          if (surface.suppressPlaceholder) return surface.suppressPlaceholder(placeholder);
          return surface.updateMessage(placeholder, '·');
        },
      });
      if (res.ok) break;
      // Only retry on transient throttle. Stops/timeouts/other errors → fail.
      if (!res.throttled) break;
      logger.warn('claude throttled, falling back', {
        surface: event.surface,
        from: model || '(default)',
        next: modelChain[i + 1] || '(none)',
      });
    }
    return res;
  };

  result = await runChain(prompt, sess?.sessionId);

  // Resume failed (session file gone or pruned) → forget it, rebuild the
  // prompt with the full transcript, and run once more on a fresh session.
  if (!result.ok && sess && isResumeFailure(result.error)) {
    logger.warn('session resume failed — starting a fresh session', {
      surface: event.surface,
      conversationId: event.conversationId,
      sessionId: sess.sessionId,
    });
    sessionStore.clear(event.conversationId);
    sel = selectContext(event, ctx, null);
    prompt = event.wake
      ? buildWakePrompt(event, ctx, surface, sel)
      : buildPrompt(event, ctx, surface, sel);
    result = await runChain(prompt, undefined);
  }

  // Remember the session that served this thread (also on <silent/> — the
  // session still advanced) plus the delta cutoff for the next tick. When
  // the session's context has grown past the rotation threshold, retire it
  // instead: the next tick starts fresh with the full transcript (the store
  // is an optimisation, never truth), capping per-tick input cost and
  // pre-empting in-session auto-compaction quietly eating early context.
  if (config.sessions.resumeEnabled && result.ok && result.sessionId) {
    const u = result.usage || {};
    const inputTotal = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
      + (u.cache_creation_input_tokens || 0);
    if (config.sessions.rotateInputTokens > 0 && inputTotal >= config.sessions.rotateInputTokens) {
      logger.info('rotating thread session (context grew large)', {
        surface: event.surface,
        conversationId: event.conversationId,
        inputTokens: inputTotal,
      });
      sessionStore.clear(event.conversationId);
    } else {
      sessionStore.set(event.conversationId, {
        sessionId: result.sessionId,
        lastTs: nextLastTs(sess, sel, ctx, event),
      });
    }
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
    // Let a surface that can't fetch its own history (Google Chat) record the
    // reply into its rolling transcript, so the next tick sees both sides even
    // after the SDK session rotates. Optional hook, best-effort.
    if (surface.recordReply) {
      try { surface.recordReply(event, parsedFinal.text); }
      catch (e) { logger.debug('recordReply failed', { err: e.message }); }
    }
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

// True when a failed run's error indicates the SDK couldn't find the session
// we asked it to resume.
function isResumeFailure(error) {
  return /no conversation found with session id/i.test(error || '');
}

// "90000" -> "1m 30s" — coarse, for the watch footer only.
function humanMs(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

// One italic line per background watch this turn armed, so "I'll get back to
// you" is a visible, standard promise rather than something the model may or
// may not remember to say. Returns '' when the turn armed nothing.
function watchFooter(conversationId, tickStartMs) {
  let watches;
  try {
    watches = watchStore.list();
  } catch {
    return '';
  }
  const lines = watches
    .filter((w) => w.conversationId === conversationId
      && w.state === 'active'
      && (w.createdAt || 0) >= tickStartMs)
    .map((w) => {
      const every = humanMs(w.intervalMs || 30_000);
      const giveUp = humanMs((w.deadlineAt || w.createdAt) - w.createdAt);
      return `_⏳ Watching: ${w.label} — checking every ${every}; I'll post back in this thread when it's done (or give up after ${giveUp})._`;
    });
  return lines.join('\n');
}

// Strictly-orderable timestamp: only all-digit (optionally dotted) strings
// qualify. parseFloat alone is a trap — opaque ids like WhatsApp's
// "3EB0C767…" parse to a bogus finite 3, silently corrupting the cutoff.
function orderableTs(v) {
  const s = String(v ?? '');
  return /^\d+(\.\d+)?$/.test(s) ? parseFloat(s) : null;
}

// Pick which messages this tick sends. Fresh lane → the full fetched
// context. Resumed lane → only what's new since the stored cutoff: the
// agent already holds the earlier conversation, its own posts are dropped
// (it said them), messages EDITED since the cutoff are re-shown (Slack keeps
// the original ts on edits), and anything non-orderable is kept rather than
// guessed about. If the cutoff itself isn't orderable, fall back to the
// full transcript with a dedupe note.
function selectContext(event, ctx, sess) {
  const all = ctx.messages || [];
  if (!sess) return { resumed: false, messages: all, contextNote: '' };

  const repeatNote = 'The transcript below may repeat messages already in your context.';
  const cutoff = orderableTs(sess.lastTs);
  if (cutoff === null) return { resumed: true, messages: all, contextNote: repeatNote };

  const targetId = ctx.replyTargetTs || event.messageId;
  const isSelf = (m) => config.botUserId && m.user === config.botUserId;
  const delta = all.filter((m) => {
    if (isSelf(m)) return false;
    if ((m.ts || m.id) === targetId) return true; // always keep the marked message
    const ts = orderableTs(m.ts || m.id);
    if (ts === null || ts > cutoff) return true;
    const editedTs = orderableTs(m.edited?.ts);
    return editedTs !== null && editedTs > cutoff; // edited since last turn → re-show
  });
  if (delta.length) {
    return {
      resumed: true,
      messages: delta,
      contextNote: 'Only messages since your last turn are shown — the earlier conversation is already in your context.',
    };
  }
  return { resumed: true, messages: all, contextNote: repeatNote };
}

// Cutoff for the NEXT tick's delta. First tick of a lane anchors to the
// marked message — not the max of the fetched view, because a root tick sees
// channel history while later ticks see thread replies, and a channel-wide
// max would silently skip replies that landed in between. Resumed ticks
// advance to the newest orderable ts (message or edit) actually SENT this
// tick, and never regress (a >fetch-limit thread returns its oldest page,
// whose max is older than what the agent has already seen).
function nextLastTs(sess, sel, ctx, event) {
  if (!sess) {
    const target = String(ctx.replyTargetTs || event.messageId || '');
    return orderableTs(target) !== null ? target : null;
  }
  let bestVal = orderableTs(sess.lastTs);
  let bestStr = bestVal !== null ? String(sess.lastTs) : null;
  for (const m of sel.messages) {
    for (const v of [m.ts || m.id, m.edited?.ts]) {
      const ts = orderableTs(v);
      if (ts !== null && (bestVal === null || ts > bestVal)) {
        bestVal = ts;
        bestStr = String(v);
      }
    }
  }
  return bestStr;
}

// Prompt for a background-watch wake (event.wake). Not driven by a new user
// message — the trigger is the watch firing — so it frames the outcome and asks
// for a single in-thread report. Reuses the same <say>/<silent/> contract,
// surface hints, and resumed-session continuity as buildPrompt.
function buildWakePrompt(event, ctx, surface, sel) {
  const w = event.wake || {};
  const transcript = formatTranscript(sel.messages, ctx.replyTargetTs || event.messageId);
  const surfaceHints = surface.formatPromptHints ? surface.formatPromptHints() : '';
  const resumedLine = sel.resumed
    ? 'You are resuming the session in which you set this watch — you already hold the earlier conversation and your own tool results; build on them.'
    : 'You do NOT have the original session (it expired or rotated). Reconstruct what you need from the watch details and the recent thread below.';
  const outcomeLine = {
    met: 'The condition you were waiting for is now TRUE.',
    timeout: `The watch hit its deadline (${Math.round((w.elapsedMs || 0) / 1000)}s) WITHOUT the condition becoming true — the thing may have failed, stalled, or just be slow.`,
    error: `The watch's check command kept erroring (${w.errorCount || 0}×) and was given up on — treat the state as unknown and verify directly.`,
  }[w.outcome] || 'The watch fired.';
  const outputBlock = w.outputTail
    ? `\nLast output from the check:\n\`\`\`\n${w.outputTail}\n\`\`\``
    : '';

  return `You are responding on ${event.surface}, woken by a BACKGROUND WATCH you set earlier — not by a new user message. ${resumedLine}

Watch: ${w.label || w.id}
Outcome: ${outcomeLine}
Check command: \`${w.command || '(unknown)'}\` → exit ${w.exitCode ?? '?'}${outputBlock}

Conversation: ${ctx.convName || event.conversationId}${event.isDirect ? ' (direct/IM)' : ' (channel)'}
Recent messages (chronological, last is most recent):
${transcript}
${surfaceHints}

Instructions:
- Report back to THIS thread about what you were watching.${w.report ? ` Specifically: ${w.report}` : ''}
- The one-line condition above is a trigger, not the whole story — do any quick verification you need (re-run a check, curl the endpoint, read a log) before you report.
- **Output contract:** the user ONLY sees text inside \`<say>…</say>\`; everything else is private scratchpad. Emit exactly ONE \`<say>…</say>\` with your update, in character, using the surface's markdown.
- If the watcher is now stale and there is genuinely nothing worth saying (e.g. you already reported this, or the user cancelled), emit \`<silent/>\` and nothing else.
`;
}

function buildPrompt(event, ctx, surface, sel) {
  const transcript = formatTranscript(sel.messages, ctx.replyTargetTs || event.messageId);
  const surfaceHints = surface.formatPromptHints ? surface.formatPromptHints() : '';
  const attachmentsBlock = formatAttachments(ctx.attachments || []);
  const resumedIntro = sel.resumed
    ? `, continuing a conversation you already hold in session memory. ${sel.contextNote}`
    : '.';
  const resumedInstruction = sel.resumed
    ? '\n- You already have the earlier conversation and your own previous tool results in context — build on them instead of re-deriving; still re-check anything time-sensitive or likely to have changed since. A message marked (edited) was changed after you last saw it — the version here supersedes your memory of it.'
    : '';

  return `You are responding in real time to a ${event.surface} message${resumedIntro}

Conversation: ${ctx.convName || event.conversationId}${event.isDirect ? ' (direct/IM)' : ' (channel)'}
Recent messages (chronological, last is most recent):
${transcript}
${attachmentsBlock}
${surfaceHints}

Instructions:
- Compose a single in-character reply to the marked message, taking the prior messages as context for continuity.${resumedInstruction}
- Do whatever tool calls you need (curl, bash, browser-tools, subagents, etc.) to gather information.
- Need to report back only once something finishes LATER (a deploy, a build, a long job, a webhook)? Don't background it and promise to return — this turn ends when you stop and nothing you started survives it. Set a background watch instead: \`./bin/watch.js create --label "<what>" --command "<bash that exits 0 when done>" --every 30s --timeout 20m\`. The supervisor polls it after your turn and wakes this thread when it's ready. Run \`./bin/watch.js\` (no args) for usage.
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
    if (a.path) {
      lines.push(`  - ${a.name} (${a.mimetype}, ${a.size} bytes) → ${a.path}`);
    } else if (a.note) {
      lines.push(`  - ${a.name}: ${a.note}`);
    } else {
      lines.push(`  - ${a.name || a.id}: download failed (${a.error || 'unknown'})`);
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
    const edited = m.edited ? ' (edited)' : '';
    const marker = id === replyTargetId ? ' <-- THIS IS THE NEW MESSAGE TO RESPOND TO' : '';
    lines.push(`  [${id}] <@${user}>: ${text}${edited}${marker}`);
  }
  return lines.join('\n');
}
