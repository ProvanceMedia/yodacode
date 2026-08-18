// Naming a model in a way that survives changing engine.
//
// A cron that says `model: claude-sonnet-4-6` is pinned to one engine. Switch
// engines and it keeps that value, the new engine rejects it, and the task fails
// on its next scheduled run — which is the worst time to find out, because
// nobody is watching at 3am and the failure looks like the cron itself breaking.
//
// So a task can name a TIER instead: fast, balanced or deep. Each engine says
// what a tier means for it — on Claude mostly a different model, on Codex mostly
// a different reasoning effort. Literal model names still work for anyone who
// wants an exact one; they simply do not survive an engine change, and both the
// switch command and the scheduler say so out loud rather than letting a task
// discover it alone at 3am.

export const TIERS = ['fast', 'balanced', 'deep'];

/**
 * What each tier means per engine.
 *
 * Codex entries deliberately do NOT name a model. Its model slugs churn and get
 * retired on a short cadence, so pinning one here would rot; effort is the axis
 * that keeps its meaning, and the engine's own default model is the one the
 * operator picked.
 */
const TIER_MAP = {
  claude: {
    fast: { model: 'claude-haiku-4-5' },
    balanced: { model: 'claude-sonnet-5' },
    deep: { model: 'claude-opus-5' },
  },
  codex: {
    fast: { effort: 'low' },
    balanced: { effort: 'medium' },
    deep: { effort: 'high' },
  },
};

/** Prefixes that identify which engine a literal model name belongs to. */
const MODEL_OWNER = [
  [/^claude[-.]/i, 'claude'],
  [/^(gpt|o[0-9])[-.]/i, 'codex'],
];

/** Which engine a literal model name belongs to, or null if unrecognised. */
export function modelEngine(model) {
  const s = String(model || '').trim();
  for (const [re, engine] of MODEL_OWNER) if (re.test(s)) return engine;
  return null;
}

export function isTier(value) {
  return TIERS.includes(String(value || '').trim().toLowerCase());
}

/**
 * Resolve a task's `model:` value for an engine.
 *
 * @param {string} engineId
 * @param {string} value        a tier, a literal model name, or empty
 * @param {string} [effort]     the task's own effort, which wins over the tier's
 * @returns {{model: string|undefined, effort: string|undefined, tier: string|null}}
 * @throws  when the value names a model belonging to a different engine — loudly,
 *          because the alternative is a task that quietly stops running.
 */
export function resolveModel(engineId, value, effort) {
  const raw = String(value || '').trim();

  if (isTier(raw)) {
    const spec = (TIER_MAP[engineId] || {})[raw.toLowerCase()] || {};
    return { model: spec.model, effort: effort || spec.effort, tier: raw.toLowerCase() };
  }

  if (raw) {
    const owner = modelEngine(raw);
    if (owner && owner !== engineId) {
      throw new Error(
        `model '${raw}' belongs to the ${owner} engine, but this install runs ${engineId}. ` +
        `Use a tier (${TIERS.join(', ')}) so it works on either, or name a ${engineId} model.`);
    }
    return { model: raw, effort, tier: null };
  }

  return { model: undefined, effort, tier: null };
}

/**
 * Check a set of tasks against an engine, without running them.
 *
 * Used before an engine change so the operator is told which tasks would break,
 * while it is still trivial to fix — rather than each one failing separately on
 * its own schedule afterwards.
 *
 * @param {Array<{name: string, model?: string, effort?: string}>} tasks
 * @param {string} engineId
 * @returns {{ok: Array, blocked: Array<{name: string, model: string, reason: string}>}}
 */
export function auditTasks(tasks, engineId) {
  const ok = [];
  const blocked = [];
  for (const t of tasks || []) {
    try {
      resolveModel(engineId, t.model, t.effort);
      ok.push(t.name);
    } catch (e) {
      blocked.push({ name: t.name, model: String(t.model || ''), reason: e.message });
    }
  }
  return { ok, blocked };
}
