// Codex JSONL events → the Anthropic stream-json shapes lib/stream-translator.js
// already consumes. Doing the conversion here means the translator, the tool
// tracker, the guardrails and every surface stay engine-agnostic: they only ever
// see one vocabulary.
//
// The mapping was derived from recorded turns, not from documentation — the
// fixtures in tests/fixtures/codex-*.jsonl are those recordings, and the notes
// below cite what was observed.

/** Codex reports shell commands wrapped: `/bin/bash -lc 'wc -l sample.txt'`.
 *  Status lines should show the command, not the wrapper. */
export function stripShellWrapper(command) {
  const s = String(command || '');
  const m = s.match(/^\/bin\/(?:ba)?sh\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/);
  return m ? m[2] : s;
}

/** A readable name for a collaboration call, used as the status line's subject.
 *  `wait` is the common one and the one that takes time — it is the parent
 *  sitting idle while a subagent works. */
function describeCollab(item) {
  const n = (item.receiver_thread_ids || []).length;
  if (item.tool === 'wait') return n > 1 ? `${n} subagents` : 'a subagent';
  return `a subagent (${item.tool || 'collab'})`;
}

/** file_change kinds → the tool names describeToolUse() knows how to render. */
function fileChangeTool(kind) {
  if (kind === 'add') return 'Write';
  if (kind === 'delete') return 'Delete';
  return 'Edit';
}

/**
 * Codex usage → Anthropic usage.
 *
 * The two vendors count input differently, and getting this wrong inflates every
 * figure we report. Anthropic's `input_tokens` EXCLUDES cache reads — the cached
 * portion is a separate field, and the true total is the sum. OpenAI's
 * `input_tokens` INCLUDES the cached portion, with `cached_input_tokens` naming
 * the subset. Copying one field to the other therefore counts the cached tokens
 * twice, which on a typical turn overstates the cost by more than half.
 *
 * So the cached part is subtracted here to leave the fresh part, matching what
 * the rest of the supervisor means by `input_tokens`.
 *
 * `reasoning_output_tokens` has no Anthropic counterpart and is carried through
 * for the usage log. Codex reports no cache-CREATION figure, so that stays 0
 * rather than being invented.
 */
export function mapUsage(u) {
  if (!u) return undefined;
  const cached = u.cached_input_tokens || 0;
  return {
    input_tokens: Math.max(0, (u.input_tokens || 0) - cached),
    output_tokens: u.output_tokens || 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    reasoning_output_tokens: u.reasoning_output_tokens || 0,
  };
}

export function createTranslatorState() {
  return {
    threadId: null,
    /** Text of the most recent agent_message — the fallback reply when the
     *  --output-last-message file hasn't been written or read yet. */
    lastMessage: '',
    /** Set by the adapter from --output-last-message; authoritative when present. */
    finalText: null,
  };
}

/**
 * Translate one Codex event into zero or more Anthropic stream-json messages.
 *
 * Pure: no I/O, no clock, no config. `state` is mutated for the small amount of
 * cross-event context the mapping needs (thread id, last message text), which is
 * what makes the whole thing testable against a recorded stream.
 *
 * @param {object} ev    a parsed Codex JSONL event
 * @param {object} state from createTranslatorState()
 * @returns {object[]}   messages to yield, in order
 */
export function translateEvent(ev, state) {
  if (!ev || typeof ev !== 'object') return [];
  const item = ev.item || {};

  switch (ev.type) {
    // ── thread.started ─────────────────────────────────────────────────────
    // Carries the thread id, which is stable across resume and is what gets
    // stored for session continuity.
    case 'thread.started':
      state.threadId = ev.thread_id || null;
      return [{
        type: 'system',
        subtype: 'init',
        session_id: state.threadId,
        model: ev.model || null,
      }];

    // turn.started carries nothing the supervisor acts on; the translator has
    // already posted its opening status by this point.
    case 'turn.started':
      return [];

    // ── item.started → the tool CALL ───────────────────────────────────────
    case 'item.started': {
      const call = toolUseFor(item);
      return call ? [assistantMessage([call], state.threadId)] : [];
    }

    // ── item.completed → the tool RESULT, or assistant text ────────────────
    case 'item.completed': {
      // Codex emits several agent_message items per turn: narration while it
      // works, then the reply. Both become assistant text, which drives the
      // status line; the authoritative reply comes from the result message
      // below, so mid-turn narration can never be mistaken for the answer.
      if (item.type === 'agent_message') {
        const text = (item.text || '').trim();
        if (!text) return [];
        state.lastMessage = text;
        return [assistantMessage([{ type: 'text', text }], state.threadId)];
      }

      // Reasoning summaries are deliberately dropped. They have no Anthropic
      // counterpart, and emitting them as assistant text would put private
      // scratchpad into the reply's fallback path.
      if (item.type === 'reasoning') return [];

      const result = toolResultFor(item);
      return result ? [userMessage([result], state.threadId)] : [];
    }

    // ── turn.completed → the end of the stream ─────────────────────────────
    case 'turn.completed':
      return [{
        type: 'result',
        subtype: 'success',
        result: state.finalText != null ? state.finalText : state.lastMessage,
        is_error: false,
        session_id: state.threadId,
        usage: mapUsage(ev.usage),
      }];

    // ── failures ───────────────────────────────────────────────────────────
    // turn.failed and error are the two shapes a failed turn arrives as. Both
    // must produce a result message: without one the stream ends silently and
    // the runner reports "no result", which reads as a hang rather than an
    // error. (baby-yoda's translator drops both, so a failed turn there is
    // indistinguishable from an empty reply.)
    case 'turn.failed':
    case 'error': {
      const detail = ev.error?.message || ev.message || ev.error || 'unknown error';
      return [{
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: [String(detail)],
        session_id: state.threadId,
        usage: mapUsage(ev.usage),
      }];
    }

    default:
      return [];
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function assistantMessage(content, sessionId) {
  return { type: 'assistant', message: { role: 'assistant', content }, session_id: sessionId };
}

function userMessage(content, sessionId) {
  return { type: 'user', message: { role: 'user', content }, session_id: sessionId };
}

/** The tool_use block for an item that represents work being started. */
function toolUseFor(item) {
  // Delegation to a subagent. Unlike the Claude engine, the child's own frames
  // never appear on this stream — the parent only reports the collaboration call
  // itself, and the subagent works in its own thread. So there is no child
  // chatter to keep out of the reply; the whole job here is making the wait
  // visible, because otherwise a delegation looks like a frozen turn.
  if (item.type === 'collab_tool_call') {
    return {
      type: 'tool_use',
      id: item.id,
      name: 'Task',
      input: { subagent_type: describeCollab(item) },
    };
  }
  if (item.type === 'command_execution') {
    return {
      type: 'tool_use',
      id: item.id,
      name: 'Bash',
      input: { command: stripShellWrapper(item.command) },
    };
  }
  if (item.type === 'file_change') {
    const changes = item.changes || [];
    const first = changes[0] || {};
    return {
      type: 'tool_use',
      id: item.id,
      name: fileChangeTool(first.kind),
      // Only the first path is named. A multi-file change still shows one file
      // in the status line, which is honest about the shape of the event.
      input: { file_path: first.path || '' },
    };
  }
  return null;
}

/** The tool_result block pairing with a completed item.
 *  Item ids are stable across item.started/item.completed, so results pair by
 *  id and the repeat-failure / no-progress guardrails keep working. */
function toolResultFor(item) {
  if (item.type === 'collab_tool_call') {
    return {
      type: 'tool_result',
      tool_use_id: item.id,
      is_error: item.status === 'failed',
      content: `${item.tool || 'collab'} ${item.status || 'completed'}`,
    };
  }
  if (item.type === 'command_execution') {
    return {
      type: 'tool_result',
      tool_use_id: item.id,
      is_error: item.exit_code !== 0,
      content: item.aggregated_output || '',
    };
  }
  if (item.type === 'file_change') {
    return {
      type: 'tool_result',
      tool_use_id: item.id,
      is_error: item.status === 'failed',
      content: (item.changes || []).map((c) => `${c.kind} ${c.path}`).join('\n'),
    };
  }
  return null;
}
