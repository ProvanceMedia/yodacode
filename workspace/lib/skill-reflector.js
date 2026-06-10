// Skill self-generation. After a notable surface tick (≥ minDurationMs OR
// ≥ minToolCount tool calls), spawn a detached background `claude -p` that
// reviews the conversation and decides whether to write a SKILL.md.
//
// Fire-and-forget: never blocks the reply path, never affects the response
// the user sees. If the reflector spawn fails, we log and move on.
//
// Cost: each reflection burns one `claude -p` invocation against the Max
// sub. Default model is haiku-4-5 (cheap). Disabled by default —
// opt in via YODA_SKILL_REFLECTOR_ENABLED=1.

import { spawn } from 'node:child_process';
import { config } from './config.js';
import { logger } from './logger.js';
import { agentSpawnOpts } from './deroot.js';

function buildPrompt({ surface, conversationId, userText, replyText, tracker, durationMs }) {
  const toolCount = tracker?.useCount || 0;
  const toolList = (tracker?.events || [])
    .slice(0, 50)
    .map((e) => `- ${e.name}${e.ok ? '' : ' (ERROR)'}`)
    .join('\n') || '(none)';
  const today = new Date().toISOString().slice(0, 10);
  const source = `${surface}-${conversationId}`;

  return `You are the skill librarian for a personal AI agent.

A conversation just completed that ran ${Math.round(durationMs / 1000)}s and used ${toolCount} tool calls.

USER REQUEST:
${userText || '(empty)'}

REPLY:
${replyText || '(empty)'}

TOOLS USED:
${toolList}

## Your decision

Decide whether this conversation discovered a *reusable procedure* worth recording as a SKILL.md. Be conservative — better to write one excellent skill per week than five mediocre ones per day.

**GOOD candidates** (write a skill):
- A multi-step API workflow that worked end-to-end
- A diagnostic recipe ("how to check whether X is firing")
- A non-obvious tool combination that solved a recurring class of problem
- Something the agent will likely be asked to do again

**BAD candidates** (skip — output \`NO_SKILL\`):
- One-off lookups, chitchat, debugging dead-ends
- Anything already covered in CLAUDE.md, MEMORY.md, TOOLS.md, or an existing skill (check via \`./bin/memory-search.sh "<query>" --scope all\` and \`./bin/skill-tools.sh search "<query>"\` if unsure)
- Conversations that revealed pain or unresolved failure
- Trivial single-tool tasks

## If you write a skill

1. Pick a slug (lowercase, hyphens, ≤ 5 words).
2. Read \`workspace/skills/INDEX.md\` to confirm the slug isn't taken.
3. \`Write\` \`workspace/skills/<slug>.md\` with this format:

\`\`\`
---
name: <slug>
description: <one-line summary, ≤ 80 chars>
tags: <comma,separated,tags>
created: ${today}
last_used: ${today}
use_count: 1
source: ${source}
---

# <Human title>

## When to use
<one paragraph: what problem this solves, when the agent should reach for it>

## Steps
1. <terse step>
2. <terse step>
...

## Gotchas
- <pitfalls that came up during the originating conversation>
\`\`\`

   Keep the body ≤ 30 lines. Procedural, not chatty.

4. \`Edit\` \`workspace/skills/INDEX.md\` to append a one-line pointer under the **Active** section:
   \`- [<title>](<slug>.md) — <one-line summary>\`

5. Emit \`SKILL_OK <slug>\` on stdout.

## If you skip

Emit the literal text \`NO_SKILL\` and exit.

This is a CRON-style invocation. Run exactly one pass and stop.`;
}

export function maybeReflect({ surface, conversationId, userText, replyText, tracker, durationMs }) {
  const cfg = config.skills || {};
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
    logger.warn('skill-reflector spawn failed', { err: e.message });
    return;
  }

  // Don't keep yoda alive on shutdown waiting for the reflector
  child.unref();

  // Hard timeout — reflector should complete in < 2 minutes
  const timeout = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {}
    logger.warn('skill-reflector timed out', { surface, conversationId, ms: cfg.reflectorTimeoutMs });
  }, cfg.reflectorTimeoutMs);
  timeout.unref();

  child.on('exit', (code) => {
    clearTimeout(timeout);
    // Refresh FTS5 index so a newly-written skill is searchable immediately
    // rather than waiting for the nightly skill-review cron.
    if (code === 0) {
      try {
        const re = spawn('python3', ['./bin/memory-reindex.py'], {
          cwd: config.workspace, stdio: 'ignore', detached: true,
        });
        re.unref();
      } catch (_) {}
    }
    logger.info('skill-reflector finished', { surface, conversationId, code });
  });
  child.on('error', (e) => {
    clearTimeout(timeout);
    logger.warn('skill-reflector error', { err: e.message });
  });

  logger.info('skill-reflector spawned', { surface, conversationId, toolCount, durationMs });
}
