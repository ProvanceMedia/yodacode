---
name: writing-plans
description: After a design is agreed and the build spans multiple tasks, files, or live services/crons
tags: planning,plans,execution,implementation,workflow
created: 2026-08-06
last_used: 2026-08-06
use_count: 0
source: yodacode default
---

# Writing Plans

## When to use
A design is agreed (usually via skills/brainstorming.md) and the build is big
enough to lose track of: multiple tasks, multiple files, or anything touching
live services or crons. Skip it for one-file tweaks verifiable in one step.
The plan doubles as the execution record — this skill covers both writing it
and executing it.

## Writing the plan
Iron Law: write for an implementer with zero context and questionable taste.
Every task must be doable by someone who has read nothing but that task and
the header.

Save to `memory/plans/YYYY-MM-DD-<topic>-plan.md` (create the dir if needed).

Header, first thing in the file:
- **Goal:** one sentence — what this builds.
- **Approach:** 2-3 sentences.
- **Constraints:** project-wide requirements copied verbatim from the spec
  (versions, naming, limits). Every task implicitly includes these.

Tasks — bite-sized, each independently verifiable:
- Exact file paths to create/modify (line ranges if known).
- Concrete steps with real code/commands — one action per step.
- Its OWN verification step: the exact command or check plus expected result.
- Where tasks interlock, an **Interfaces** block: what this task consumes
  from earlier tasks and what later tasks rely on — exact names, signatures,
  types. This block is how a task learns what its neighbours use.

### No Placeholders
These are plan failures — never write them:

| Red flag                          | Why it fails                          |
|-----------------------------------|---------------------------------------|
| "TBD" / "TODO" / "fill in later"  | Implementer invents; taste is suspect |
| "Add error handling / edge cases" | Says what, not how — show the code    |
| "Write tests for the above"       | No test content = no test             |
| "Similar to Task N"               | Tasks are read alone — repeat it      |
| Names not defined in any task     | Implementer guesses the interface     |

### Self-review
Before saving, check the plan against the spec: every requirement maps to a
task; no red flags from the table above; names and signatures used in later
tasks match where earlier tasks defined them. Fix inline and move on.

## Executing a plan
- Read the whole plan critically before touching anything. If you have
  concerns, raise them in your reply and stop — resume when answered.
- Execute tasks in order. Follow the steps exactly.
- Run each task's verification before moving to the next. Never skip it.
- STOP and ask on any blocker, unclear step, or verification that keeps
  failing: end your turn with the question; the reply resumes the session.
  Never guess past a gap in the plan.
- On long builds, post a short progress note at sensible checkpoints so the
  user can steer.
- When every task verifies, apply skills/verification-before-completion.md
  to the whole deliverable before reporting done.

## Choosing execution mode
For plans of roughly 4+ tasks, or anything high-stakes (live services,
crons, data), OFFER subagent-driven execution — read
skills/subagent-driven-development.md — noting it costs meaningfully more
tokens but adds a fresh review per task. Otherwise execute inline yourself.
Default to inline if the user doesn't care.

## Steps
1. Confirm the design is settled; if not, back to skills/brainstorming.md.
2. Draft memory/plans/YYYY-MM-DD-<topic>-plan.md: header, then bite-sized
   tasks with exact paths, real code, own verification.
3. Self-review against the spec; purge placeholders; align names.
4. For 4+ tasks or high stakes, offer subagent vs inline in your reply and
   stop; otherwise proceed inline.
5. Execute in order; verify each task; stop and ask on any blocker.
6. Post progress notes at checkpoints on long builds.
7. Run skills/verification-before-completion.md, then report done.

*Adapted for yodacode from [obra/superpowers](https://github.com/obra/superpowers) (MIT, (c) 2025 Jesse Vincent). See THIRD-PARTY-NOTICES.md.*
