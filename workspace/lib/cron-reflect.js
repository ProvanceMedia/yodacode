// Cron reflection — Agent SDK port of the old cron-tasks/lib/reflect-after.sh.
// Called by bin/cron-runner.js after a cron with `reflect: true` finishes:
// runs the background skill + memory reflectors with the cron's prompt +
// output so scheduled tasks contribute to yoda's closed-loop learning the
// same way surface ticks do.
//
// Both reflectors are opt-in via the same env vars used for surface ticks:
//   YODA_SKILL_REFLECTOR_ENABLED=1
//   YODA_MEMORY_REFLECTOR_ENABLED=1
//
// Unlike the old detached-shell version, the reflections are awaited by the
// cron runner (run in parallel, bounded by YODA_CRON_REFLECTOR_TIMEOUT_MS,
// default 10 min each — crons are batch context, so the budget is generous;
// 0 = unbounded), so their outcome lands in the cron's own log instead of
// vanishing into a detached child. Reflector exit doesn't trigger a reindex;
// the nightly memory-consolidate cron and yoda startup both rebuild the
// FTS5 index.

import { runAgentText } from './agent-query.js';

// Librarian crons don't reflect on themselves.
const LIBRARIAN_TASKS = new Set(['memory-consolidate', 'skill-review']);

function skillPrompt(task, cronPrompt, cronOutput, today) {
  return `You are the skill librarian for Yoda, a personal AI agent.

A scheduled CRON task just finished.

TASK: ${task}
SOURCE: cron-${task}
DATE: ${today}

THE CRON'S PROMPT TO CLAUDE:
${cronPrompt}

CLAUDE'S OUTPUT:
${cronOutput}

## Your decision

Did this cron run reveal a *reusable procedure* worth recording as a SKILL.md?
Crons run the same workflow repeatedly, so any genuine insight here is
high-leverage. Be conservative — better one excellent skill per week than
five mediocre ones per day.

GOOD candidates (write a skill):
- A non-obvious tool combination that solved a recurring problem
- A diagnostic recipe Yoda will reach for again
- A workflow that varied from the cron prompt in a useful way

SKIP (output NO_SKILL):
- The cron just did what its prompt said — no novel insight
- Already covered in CLAUDE.md, MEMORY.md, or an existing skill
  (check via ./bin/skill-tools.sh search "<topic>")
- Failures or unresolved errors

If YES:
1. Pick a slug (lowercase, hyphens, ≤ 5 words). Confirm it's not in skills/INDEX.md.
2. Write workspace/skills/<slug>.md with frontmatter:
   name, description, tags, created: ${today}, last_used: ${today}, use_count: 1, source: cron-${task}
3. Body: short procedure in numbered steps, ≤ 30 lines.
4. Append a one-line pointer to workspace/skills/INDEX.md under Active.
5. Emit \`SKILL_OK <slug>\` on stdout.

If NO: emit \`NO_SKILL\` and exit.

This is a CRON-style invocation. One pass, then stop.`;
}

function memoryPrompt(task, cronPrompt, cronOutput, today) {
  return `You are the memory librarian for Yoda, a personal AI agent.

A scheduled CRON task just finished.

TASK: ${task}
SOURCE: cron-${task}
DATE: ${today}

THE CRON'S PROMPT TO CLAUDE:
${cronPrompt}

CLAUDE'S OUTPUT:
${cronOutput}

## Your decision

Did this cron reveal a *durable fact* worth saving to MEMORY.md or memory/?

Categories:
- user-fact: a new fact about the user or their team
- feedback: a corrected approach or validated pattern (include WHY)
- project-state: a decision, deadline, or milestone (convert dates to absolute, today = ${today})
- reference: a new external resource (channel, dashboard, URL) and its purpose

Skip (output NO_MEMORY):
- Routine cron digest output
- Already-known facts
- Transient task state
- Unresolved failures

Be conservative. First dedupe:
  ./bin/memory-search.sh "<keywords>" --scope all
Prefer UPDATING an existing entry over appending a duplicate.

If YES:
- Append a dated bullet under the right section of MEMORY.md
  (format: \`- **${today}** <fact>\`, include WHY for feedback entries)
- If > 30 lines of new context, write memory/<slug>.md instead and leave
  a one-line pointer in MEMORY.md.
- Emit \`MEMORY_OK <category>\` on stdout.

If NO: emit \`NO_MEMORY\` and exit.

This is a CRON-style invocation. One pass, then stop.`;
}

/**
 * Run the opted-in reflectors for a finished cron. Resolves when both are
 * done (or timed out); never throws.
 *
 * @param {object} args
 * @param {string} args.taskName    Cron task name
 * @param {string} args.cronPrompt  The prompt the cron sent to Claude
 * @param {string} args.cronOutput  Claude's output from the cron run
 * @param {string} args.cwd         Workspace directory to run the reflectors in
 * @param {boolean} [args.deroot]   Run the reflectors de-rooted (curated env)
 * @param {(line: string) => void} [args.log]  Log sink (defaults to console.error)
 */
export async function reflectAfterCron({ taskName, cronPrompt, cronOutput, cwd, deroot, log }) {
  const logLine = log || ((l) => console.error(l));
  if (!taskName || LIBRARIAN_TASKS.has(taskName)) {
    logLine(`reflection skipped (${taskName ? 'librarian task' : 'missing task name'})`);
    return;
  }

  const skillOn = process.env.YODA_SKILL_REFLECTOR_ENABLED === '1';
  const memoryOn = process.env.YODA_MEMORY_REFLECTOR_ENABLED === '1';
  if (!skillOn && !memoryOn) {
    logLine('reflection skipped (both reflectors disabled)');
    return;
  }
  logLine(`reflection triggered (skill=${skillOn} memory=${memoryOn})`);

  const model = process.env.YODA_SKILL_REFLECTOR_MODEL || 'claude-haiku-4-5';
  // Crons are batch context: give reflections far more room than the surface
  // ticks' 2-minute default (the old detached version was unbounded).
  // YODA_CRON_REFLECTOR_TIMEOUT_MS overrides both kinds; 0 = unbounded.
  const timeoutFor = (kindKnob) => parseInt(
    process.env.YODA_CRON_REFLECTOR_TIMEOUT_MS ?? process.env[kindKnob] ?? '600000', 10);
  const today = new Date().toISOString().slice(0, 10);

  const runOne = async (kind, prompt, timeoutMs) => {
    logLine(`${kind} reflector starting (task=${taskName}, model=${model})`);
    try {
      const res = await runAgentText({
        prompt,
        model,
        allowedTools: 'Bash,Read,Write,Edit,Glob,Grep',
        permissionMode: 'acceptEdits',
        cwd,
        deroot,
        timeoutMs,
      });
      const tail = (res.text || '').split('\n').filter(Boolean).slice(-1)[0] || '(no output)';
      logLine(`${kind} reflector finished (ok=${res.ok}${res.error ? `, error=${res.error}` : ''}): ${tail}`);
    } catch (e) {
      logLine(`${kind} reflector error: ${e.message}`);
    }
  };

  const jobs = [];
  if (skillOn) {
    jobs.push(runOne('skill', skillPrompt(taskName, cronPrompt, cronOutput, today),
      timeoutFor('YODA_SKILL_REFLECTOR_TIMEOUT_MS')));
  }
  if (memoryOn) {
    jobs.push(runOne('memory', memoryPrompt(taskName, cronPrompt, cronOutput, today),
      timeoutFor('YODA_MEMORY_REFLECTOR_TIMEOUT_MS')));
  }
  await Promise.allSettled(jobs);
}
