// Surface-agnostic message translator. Consumes the Claude Agent SDK's
// message stream (an async iterable of parsed message objects from query())
// and turns it into:
//   - throttled live status updates (called via onStatus(text))
//   - a final reply text (called once via onFinal(text))
//
// The SDK message shapes mirror the old `claude -p --output-format
// stream-json` events one-to-one (system/init, system/api_retry, assistant,
// user, result, rate_limit_event), so the translation logic is unchanged —
// only the transport moved from stdout-line parsing to SDK objects.
//
// Status text examples it produces (plain lowercase verb phrases — surfaces
// decide presentation: Slack renders them in a muted context-block card or
// the native DM shimmer, WhatsApp as message edits):
//   "thinking…"
//   "slack post"
//   "calling api.hubapi.com"
//   "reading SOUL.md"
//   "drafting: Final reply preview…"
// Final text is the result message's text (or the assistant's text blocks).

import path from 'node:path';
import { ToolTracker } from './tool-tracker.js';
import { isAbortError } from './agent-query.js';

const THROTTLE_MS = 800;

/**
 * Translate an Agent SDK message stream into live status + final text.
 *
 * @param {AsyncIterable<object>} messages   The query() message stream
 * @param {object}   handlers
 * @param {() => void} [handlers.onActivity] Called on every message, before the status throttle/dedupe — pure liveness signal (e.g. to reset an idle watchdog)
 * @param {(text: string) => Promise<void>} handlers.onStatus  Called for live updates (throttled)
 * @param {(text: string, meta: { isError: boolean }) => Promise<void>} handlers.onFinal  Called once with final text; meta.isError distinguishes a run-failure message from a genuine reply
 * @param {number}   [handlers.maxRetries] Bail when Claude reports this many consecutive api_retry events
 * @param {() => void} [handlers.onMaxRetries] Called once when retry threshold is exceeded
 * @param {number}   [handlers.maxIterations] Cap on total tool_use events (Infinity = off)
 * @param {object}   [handlers.guardrails]   { enabled, repeatFailureThreshold, noProgressThreshold }
 * @param {(g: object) => void} [handlers.onGuardrail] Called when a guardrail trips (warning OR cap)
 * @returns {Promise<{ ok: boolean, finalText: string, error?: string, throttled?: boolean, tracker?: object, usage?: object, sessionId?: string|null }>}
 */
export async function translateMessages(messages, {
  onActivity,
  onStatus,
  onFinal,
  maxRetries = Infinity,
  onMaxRetries,
  maxIterations = Infinity,
  guardrails = { enabled: true, repeatFailureThreshold: 2, noProgressThreshold: 3 },
  onGuardrail,
}) {
  let lastUpdateAt = 0;
  let lastTextSent = '';
  const finalChunks = [];
  let finalText = '';
  let errorText = null;
  let currentStatus = 'thinking…';
  let retryCount = 0;
  let throttled = false;
  let usage = null;
  let model = null;
  let sessionId = null;
  let stop = false;
  let truncated = false;  // stop_reason 'max_tokens' — the reply got cut off
  let refused = false;    // stop_reason 'refusal' — the model declined
  let compacted = false;  // the context window was summarised mid-run

  const send = async (text, force = false) => {
    if (text === lastTextSent && !force) return;
    const now = Date.now();
    if (!force && now - lastUpdateAt < THROTTLE_MS) return;
    try {
      await onStatus(text);
      lastUpdateAt = now;
      lastTextSent = text;
    } catch (_) {
      // Swallow status update errors so the stream keeps flowing.
      // The final update is what matters.
    }
  };

  // Tool-loop guardrails. Warnings surface as transient status lines;
  // iteration_cap is escalated to the runner via onGuardrail so it can abort.
  const tracker = guardrails && guardrails.enabled !== false
    ? new ToolTracker({
        maxIterations,
        repeatFailureThreshold: guardrails.repeatFailureThreshold ?? 2,
        noProgressThreshold: guardrails.noProgressThreshold ?? 3,
        onGuardrail: (g) => {
          if (g.type === 'repeat_failure') {
            send(`⚠️ ${g.tool} failed ${g.count}× in a row — may be stuck`, true);
          } else if (g.type === 'no_progress') {
            send(`⚠️ ${g.tool} no progress (${g.count}× identical) — may be looping`, true);
          } else if (g.type === 'iteration_cap') {
            send(`🛑 Iteration cap hit (${g.count}/${g.max})`, true);
          }
          if (onGuardrail) {
            try { onGuardrail(g); } catch (_) {}
          }
        },
      })
    : null;

  // Send the initial "thinking" status immediately
  await send(currentStatus, true);

  try {
    for await (const ev of messages) {
      // Any message on the stream is proof of life — signal liveness before
      // the throttle/dedupe in send() can swallow the resulting status update.
      if (onActivity) { try { onActivity(); } catch (_) {} }
      if (ev.session_id) sessionId = ev.session_id;

      switch (ev.type) {
        case 'system':
          if (ev.subtype === 'init') {
            model = ev.model || null;
            currentStatus = 'starting up…';
            await send(currentStatus);
          } else if (ev.subtype === 'api_retry') {
            // Anthropic throttled us — show progress so the user knows we're
            // not silently dead. Force the update through the throttle.
            retryCount++;
            const attempt = ev.attempt || retryCount;
            // Prefer the HTTP status, then the SDK's error classification
            // ('overloaded', 'rate_limit', …); its 'unknown' is less useful
            // than saying it was a connection-level failure.
            const status = ev.error_status
              ?? (ev.error && ev.error !== 'unknown' ? ev.error : 'connection error');
            currentStatus = `retrying — Anthropic throttled (${status}), attempt ${attempt}`;
            await send(currentStatus, true);

            // Bail out if we've exceeded our local cap. Continuing past this
            // point just deepens the cooldown without helping.
            if (retryCount >= maxRetries) {
              throttled = true;
              errorText = `Anthropic is overloaded (${status}). Bailed after ${retryCount} retries — try again in a minute or two.`;
              if (onMaxRetries) {
                try { onMaxRetries(); } catch (_) {}
              }
              stop = true;
            }
          } else if (ev.subtype === 'model_refusal_no_fallback') {
            // Refused with nowhere to fall back to — the turn ends here.
            refused = true;
          } else if (ev.subtype === 'compact_boundary') {
            // The window filled and older turns were summarised. The run
            // continues — this is a progress note, not an error — but it's
            // worth surfacing: the agent's recall of early context just got
            // lossier, and the PreCompact hook (lib/hooks.js) has written a
            // checkpoint to memory/ by the time this arrives.
            compacted = true;
            currentStatus = 'condensing context…';
            await send(currentStatus, true);
          }
          break;

        case 'assistant': {
          // Subagent frames (Task tool internals) arrive on the same stream
          // with parent_tool_use_id set. They already counted as liveness via
          // onActivity above, but must not feed the reply text, the status
          // line, or the guardrail tracker — a busy subagent would otherwise
          // burn the top-level iteration cap.
          if (ev.parent_tool_use_id) break;
          const content = ev.message?.content || [];
          for (const block of content) {
            if (block.type === 'text') {
              const txt = (block.text || '').trim();
              if (txt) {
                finalChunks.push(txt);
                // Preview only the user-facing part of the draft (the reply
                // contract wraps it in <say>…</say>; everything else is
                // private scratchpad and must not flash up in the status).
                const say = txt.match(/<say>([\s\S]*?)(?:<\/say>|$)/i);
                const preview = say ? say[1].trim() : '';
                currentStatus = preview ? `drafting: ${shorten(preview, 80)}` : 'drafting reply…';
                await send(currentStatus);
              }
            } else if (block.type === 'tool_use') {
              if (tracker) tracker.recordUse(block.id, block.name, block.input);
              currentStatus = describeToolUse(block.name, block.input || {});
              // Step counter: on long runs the moving number is the cheapest
              // proof of forward progress ("step 24" vs a frozen verb).
              if (tracker && tracker.useCount > 1) currentStatus += ` · step ${tracker.useCount}`;
              await send(currentStatus);
            }
          }
          break;
        }

        case 'user': {
          // tool_result event(s) — parse for guardrail tracking, then append a
          // tick to current status to indicate the tool returned. Subagent
          // results are skipped for the same reason as above.
          if (ev.parent_tool_use_id) break;
          const blocks = ev.message?.content;
          if (tracker && Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b.type === 'tool_result') {
                tracker.recordResult(b.tool_use_id, !!b.is_error, b.content);
              }
            }
          }
          await send(`${currentStatus} ✓`);
          break;
        }

        case 'result':
          if (ev.is_error) {
            errorText = (ev.subtype === 'success' ? ev.result : (ev.errors || []).join('; '))
              || explainSubtype(ev.subtype) || '(unknown error)';
          } else if (ev.subtype === 'success') {
            finalText = (ev.result || '').trim();
            // stop_reason 'max_tokens' means the model was CUT OFF mid-sentence,
            // but the run still reports success — so a truncated reply is
            // otherwise indistinguishable from a finished one and lands looking
            // complete. Say so rather than passing off a half-answer.
            if (ev.stop_reason === 'max_tokens') truncated = true;
            else if (ev.stop_reason === 'refusal') refused = true;
          } else {
            errorText = (ev.errors || []).join('; ') || explainSubtype(ev.subtype) || '(unknown error)';
          }
          if (ev.usage) {
            usage = {
              input_tokens: ev.usage.input_tokens || 0,
              output_tokens: ev.usage.output_tokens || 0,
              cache_creation_input_tokens: ev.usage.cache_creation_input_tokens || 0,
              cache_read_input_tokens: ev.usage.cache_read_input_tokens || 0,
              model,
            };
          }
          // The result message marks the end of the stream
          stop = true;
          break;

        case 'rate_limit_event': {
          const info = ev.rate_limit_info || {};
          if (info.status && info.status !== 'allowed') {
            currentStatus = `⚠️ rate limited (${info.status})`;
            await send(currentStatus, true);
          }
          break;
        }

        default:
          break;
      }

      if (stop) break;
    }
  } catch (e) {
    // The runner aborts the query on stop/timeout/guardrail — treat that as
    // end-of-stream and return the partial result (tracker + usage intact);
    // the runner classifies via its own flags. Real errors propagate.
    if (!isAbortError(e)) throw e;
  }

  // Compose the final text
  let final;
  if (errorText) {
    final = `⚠️ ${shorten(errorText, 500)}`;
  } else if (finalText) {
    final = finalText;
  } else if (finalChunks.length) {
    final = finalChunks.join('\n').trim();
  } else if (refused) {
    final = "⚠️ I declined to answer that one — try rephrasing, or tell me more about what you're after.";
  } else {
    final = '_(no output)_';
  }

  // NB: the truncated/refused flags are returned rather than appended here.
  // The dispatcher adds the user-facing note AFTER parseFinalReply() has
  // extracted the <say> interior — anything appended at this point would be
  // outside the tags and would be stripped as scratchpad.

  try {
    await onFinal(final, {
      isError: !!errorText,
      // The surface appends this AFTER the <say> interior is extracted.
      truncatedNote: truncated && !errorText
        ? "_(cut off — I hit the output limit. Ask me to carry on and I'll pick up where I stopped.)_"
        : undefined,
    });
  } catch (_) {
    // Final update failure is logged by the caller
  }

  return {
    ok: !errorText,
    finalText: final,
    error: errorText || undefined,
    throttled,
    truncated,
    refused,
    compacted,
    tracker: tracker ? tracker.summary() : null,
    usage,
    sessionId,
  };
}

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Turn an SDK result subtype into something a human would actually say.
 * Without this the user sees the raw enum ("error_during_execution").
 */
function explainSubtype(subtype) {
  switch (subtype) {
    case 'error_max_turns':
      return 'I hit my tool-use limit before finishing. Ask me to continue and I\'ll carry on.';
    case 'error_max_budget_usd':
      return 'I hit the spend limit for this run.';
    case 'error_max_structured_output_retries':
      return "I couldn't produce a valid structured result after several tries.";
    case 'error_during_execution':
      return 'Something broke mid-run — check logs/yoda.log.';
    default:
      return subtype || '';
  }
}

function shorten(s, n = 80) {
  s = (s || '').replace(/\n/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function describeToolUse(name, input) {
  if (name === 'Bash') {
    const cmd = input.command || '';
    const slackMatch = cmd.match(/\.\/slack-tools\.sh\s+(\S+)/);
    if (slackMatch) return `slack ${slackMatch[1]}`;
    if (cmd.startsWith('curl')) {
      const urlMatch = cmd.match(/https?:\/\/[^\s'"]+/);
      const host = urlMatch ? urlMatch[0].replace(/^https?:\/\//, '').split('/')[0] : '';
      return host ? `calling ${host}` : 'calling an API';
    }
    if (cmd.startsWith('sudo ')) {
      const rest = cmd.replace(/^sudos+-us+S+s+/, ''); return `running: ${shorten(rest, 60)}`;
    }
    if (cmd.includes('./bin/browser-tools.sh')) {
      const m = cmd.match(/\.\/browser-tools\.sh\s+(\S+)/);
      return m ? `browser ${m[1]}` : 'using the browser';
    }
    return `running: ${shorten(cmd, 60)}`;
  }
  if (name === 'Read') {
    const p = input.file_path || '';
    return `reading ${path.basename(p) || p}`;
  }
  if (name === 'Write') {
    const p = input.file_path || '';
    return `writing ${path.basename(p) || p}`;
  }
  if (name === 'Edit') {
    const p = input.file_path || '';
    return `editing ${path.basename(p) || p}`;
  }
  if (name === 'Glob') return `scanning files: ${input.pattern || ''}`;
  if (name === 'Grep') return `searching files: ${shorten(input.pattern || '', 40)}`;
  if (name === 'WebFetch') return `fetching ${shorten(input.url || '', 60)}`;
  if (name === 'WebSearch') return `searching the web: ${shorten(input.query || '', 50)}`;
  if (name === 'Task') {
    const subagent = input.subagent_type || 'agent';
    return `delegating to ${subagent}`;
  }
  return `using ${name}`;
}
