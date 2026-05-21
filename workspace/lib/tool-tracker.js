// Tool-loop guardrails. Watches the stream of tool_use / tool_result events
// in a single claude run and detects three failure modes:
//
//   - repeat_failure: same (tool, input) errored repeatedly
//   - no_progress:    same (tool, input) succeeded with identical output repeatedly
//   - iteration_cap:  total tool_use count exceeded the configured budget
//
// Warnings (repeat_failure, no_progress) are emitted via the onGuardrail
// callback but don't kill the run. iteration_cap is a hard stop — the runner
// is responsible for SIGTERMing claude when it fires.
//
// Inspired by Hermes' /agent/tool_guardrails.py + /agent/iteration_budget.py.

import crypto from 'node:crypto';

function hash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

function safeStringify(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function shorten(s, n) {
  s = (s || '').toString().replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

export class ToolTracker {
  constructor({
    maxIterations = Infinity,
    repeatFailureThreshold = 2,
    noProgressThreshold = 3,
    onGuardrail = () => {},
  } = {}) {
    this.maxIterations = maxIterations;
    this.repeatFailureThreshold = repeatFailureThreshold;
    this.noProgressThreshold = noProgressThreshold;
    this.onGuardrail = onGuardrail;

    this.useCount = 0;
    this.iterationCapped = false;
    // tool_use_id → { name, inputHash, ts }
    this.uses = new Map();
    // `${name}:${inputHash}` → counters
    this.callStats = new Map();
    // append-only event log for state-file persistence
    this.events = [];
    // tripped guardrails
    this.guardrails = [];
  }

  recordUse(toolUseId, name, input) {
    const inputJson = safeStringify(input);
    const inputHash = hash(inputJson);
    this.useCount++;
    this.uses.set(toolUseId, { name, inputHash, ts: Date.now() });
    if (!this.iterationCapped && this.useCount > this.maxIterations) {
      this.iterationCapped = true;
      const g = {
        type: 'iteration_cap',
        count: this.useCount,
        max: this.maxIterations,
        ts: Date.now(),
      };
      this.guardrails.push(g);
      this._emit(g);
    }
  }

  recordResult(toolUseId, isError, content) {
    const use = this.uses.get(toolUseId);
    if (!use) return;
    const outputHash = hash(safeStringify(content));
    const key = `${use.name}:${use.inputHash}`;
    const stats = this.callStats.get(key) || {
      errors: 0,
      lastErrorWarnedAt: 0,
      successes: 0,
      consecutiveIdentical: 0,
      lastOutputHash: null,
      noProgressWarned: false,
    };

    this.events.push({
      name: use.name,
      inputHash: use.inputHash,
      ts: Date.now(),
      ok: !isError,
      outputHash,
      error: isError ? shorten(safeStringify(content), 200) : null,
    });

    if (isError) {
      stats.errors++;
      if (
        stats.errors >= this.repeatFailureThreshold &&
        stats.errors > stats.lastErrorWarnedAt
      ) {
        const g = {
          type: 'repeat_failure',
          tool: use.name,
          inputHash: use.inputHash,
          count: stats.errors,
          ts: Date.now(),
        };
        this.guardrails.push(g);
        this._emit(g);
        stats.lastErrorWarnedAt = stats.errors;
      }
    } else {
      stats.successes++;
      if (stats.lastOutputHash === outputHash) {
        stats.consecutiveIdentical++;
      } else {
        stats.consecutiveIdentical = 1;
      }
      if (
        stats.consecutiveIdentical >= this.noProgressThreshold &&
        !stats.noProgressWarned
      ) {
        const g = {
          type: 'no_progress',
          tool: use.name,
          inputHash: use.inputHash,
          count: stats.consecutiveIdentical,
          ts: Date.now(),
        };
        this.guardrails.push(g);
        this._emit(g);
        stats.noProgressWarned = true;
      }
      stats.lastOutputHash = outputHash;
    }

    this.callStats.set(key, stats);
  }

  summary() {
    return {
      useCount: this.useCount,
      iterationCapped: this.iterationCapped,
      events: this.events,
      guardrails: this.guardrails,
    };
  }

  _emit(g) {
    try {
      this.onGuardrail(g);
    } catch (_) {
      // never let a handler error break the stream
    }
  }
}
