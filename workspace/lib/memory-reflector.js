// Memory self-generation. After a notable surface tick, spawn a detached
// background `claude -p` that reviews the conversation and decides whether
// a durable FACT emerged worth appending to MEMORY.md (or memory/<slug>.md).
//
// Mirrors lib/skill-reflector.js but with a different prompt: skills capture
// reusable PROCEDURES, memory captures durable FACTS (about the user,
// projects, references, feedback rules).
//
// After the child writes, kick off an FTS5 reindex so the new fact is
// searchable immediately rather than waiting for the 03:00 cron.
//
// Fire-and-forget: never blocks the reply path. Disabled by default —
// opt in via YODA_MEMORY_REFLECTOR_ENABLED=1.

import { spawn } from 'node:child_process';
import { config } from './config.js';
import { logger } from './logger.js';
import { agentSpawnOpts } from './deroot.js';

function buildPrompt({ surface, conversationId, userText, replyText, tracker, durationMs }) {
  const today = new Date().toISOString().slice(0, 10);
  const toolCount = tracker?.useCount || 0;

  return `You are the memory librarian for a personal AI agent.

A conversation just completed (${Math.round(durationMs / 1000)}s, ${toolCount} tool calls).

USER REQUEST:
${userText || '(empty)'}

REPLY:
${replyText || '(empty)'}

## Your decision

Did this conversation reveal a *durable fact* worth saving to MEMORY.md or memory/? Look for one of these categories:

- **user-fact**: A new fact about the user, their team, or a customer/contact
- **feedback**: The user corrected your approach, OR confirmed a non-obvious approach worked. Include the WHY.
- **project-state**: A decision, deadline, milestone, or change in ongoing work. Convert relative dates ("next Tuesday") to absolute (use today: ${today}).
- **reference**: A new external resource (channel, dashboard, URL, file path) and its purpose.

## Skip (output NO_MEMORY) when:

- Chitchat, one-off lookups, transient task state
- Anything already in MEMORY.md or memory/ (run \`./bin/memory-search.sh "<keywords>"\` to check)
- Code patterns, file paths, anything derivable by reading the codebase
- Trivial timestamps
- The conversation revealed pain or unresolved failure

Be conservative. Better to skip than write noise.

## If you write

1. **De-dupe first**: \`./bin/memory-search.sh "<keywords>" --scope all\`. If a close match exists, prefer to UPDATE the existing entry (Edit tool) rather than append a duplicate.

2. **Append to MEMORY.md** under the right section per the rules already in CLAUDE.md/AGENTS.md:
   - feedback → \`## Feedback\` → relevant \`###\` subsection (or create one)
   - user-fact / reference / project-state → \`## About\` (or a new \`##\` section if it really doesn't fit)

3. **Format**: \`- **${today}** <the fact>\`. For feedback include inline \`**Why:**\` and \`**How to apply:**\`. ≤ 3 sentences.

4. **Topic too big for inline?** If the new context would be > 30 lines, write \`memory/<slug>.md\` instead and leave a one-line pointer in MEMORY.md.

5. Emit \`MEMORY_OK <category>\` on stdout.

## If you skip

Emit the literal text \`NO_MEMORY\` and exit.

This is a CRON-style invocation. Run exactly one pass and stop.`;
}

function triggerReindex() {
  try {
    const child = spawn('python3', ['./bin/memory-reindex.py'], {
      cwd: config.workspace,
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
  } catch (_) {
    // Nightly cron will catch up.
  }
}

export function maybeReflectMemory({ surface, conversationId, userText, replyText, tracker, durationMs }) {
  const cfg = config.memory || {};
  if (!cfg.reflectorEnabled) return;

  const toolCount = tracker?.useCount || 0;
  if (durationMs < cfg.minDurationMs && toolCount < cfg.minToolCount) return;
  if (!replyText || replyText.trim().startsWith('NO_REPLY')) return;

  const prompt = buildPrompt({ surface, conversationId, userText, replyText, tracker, durationMs });

  const args = [
    '-p', prompt,
    '--output-format', 'text',
    '--permission-mode', 'acceptEdits',
    '--allowed-tools', 'Read,Write,Edit,Bash,Glob,Grep',
  ];
  if (cfg.reflectorModel) args.push('--model', cfg.reflectorModel);

  let child;
  try {
    child = spawn(config.claude.bin, args, {
      cwd: config.workspace,
      ...agentSpawnOpts(),
      stdio: 'ignore',
      detached: true,
    });
  } catch (e) {
    logger.warn('memory-reflector spawn failed', { err: e.message });
    return;
  }
  child.unref();

  const timeout = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {}
    logger.warn('memory-reflector timed out', { surface, conversationId, ms: cfg.reflectorTimeoutMs });
  }, cfg.reflectorTimeoutMs);
  timeout.unref();

  child.on('exit', (code) => {
    clearTimeout(timeout);
    if (code === 0) triggerReindex();
    logger.info('memory-reflector finished', { surface, conversationId, code });
  });
  child.on('error', (e) => {
    clearTimeout(timeout);
    logger.warn('memory-reflector error', { err: e.message });
  });

  logger.info('memory-reflector spawned', { surface, conversationId, toolCount, durationMs });
}
