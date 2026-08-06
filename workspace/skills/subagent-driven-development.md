---
name: subagent-driven-development
description: Opt-in mode for executing a written plan of ~4+ tasks, or builds where mistakes are expensive
tags: coding,plans,subagents,review
created: 2026-08-06
last_used: 2026-08-06
use_count: 0
source: yodacode default
---

# Subagent-Driven Development

## When to use
Significant builds only: you have a written plan (skills/writing-plans.md)
of roughly 4+ tasks, or the work is expensive to get wrong. Not for quick
edits, one-file fixes, or exploration — do those directly.

**Offer gate.** Before using this mode, tell the user in one or two lines
what it buys (a fresh-context implementer plus an independent review for
every task) and that it uses meaningfully more of their plan's token
budget — then end your turn and wait for the go-ahead. Skip the ask only
if they already chose it for this build (e.g. at plan time via
skills/writing-plans.md).

**Iron Law: fresh subagent per task + review per task + one final
whole-deliverable review.** You are the CONTROLLER: you brief, dispatch,
verify, and keep the ledger. You never implement or fix code yourself —
controller fixes skip review and burn the context you need to coordinate.

Hand artifacts to subagents as files, never as pasted session history. A
brief is self-contained when a fresh agent with zero context can do the
task from it alone.

## Steps
1. Read the plan. Create memory/plans/<plan>-briefs/ and the ledger
   memory/plans/<plan>-progress.md. If the ledger already exists you are
   resuming: read it first, trust it over your session memory, and start
   at the first task it does not mark complete.
2. Per task, write a brief to <plan>-briefs/task-N.md: task text, exact
   files to touch, interfaces consumed/produced, binding constraints, and
   rulings from earlier tasks it depends on. Never the whole plan; never
   chat history. Exact values (names, signatures, test cases) go here.
3. Dispatch a fresh Task-tool subagent (general-purpose): "Read <brief
   path> first — it is your complete requirements." Report contract: DONE
   or BLOCKED plus a summary of changes. One implementer at a time —
   never parallel implementers.
4. BLOCKED: missing context → add it to the brief, re-dispatch. Task too
   big → split it. Plan itself wrong → post the problem in your reply and
   end your turn; the user's next message resumes you.
5. DONE: verify yourself — inspect the diff / changed files; never relay
   a subagent's success claim (skills/verification-before-completion.md).
   Then dispatch a REVIEWER subagent with the brief, the relevant plan
   excerpt, and the actual diff or changed files. Require two verdicts —
   spec compliance AND code quality — findings ranked Critical/Important/
   Minor with file:line. "Looks good" without both verdicts is no review.
6. Findings: Minor → record in the ledger as deferred, never loop on
   them. Critical/Important → fix loop: dispatch a fix subagent with the
   open findings verbatim plus the brief, then a scoped re-review of the
   fix diff against those findings only. Max 3 rounds per task.
7. Still failing at round 3: STOP. Post the open findings in the thread,
   end your turn, and wait for the user's steer. Never silently drop a
   finding; never keep looping past the cap.
8. Task clean (or residue deferred with a ruling): append to the ledger —
   task, status, commit SHA or files touched, deferred findings — then
   move straight to the next task. Do not pause to ask "continue?"; stop
   only for BLOCKED, the cap, or genuine ambiguity. The ledger is the
   crash/compaction recovery point: sessions without one have re-run
   entire completed tasks.
9. After the last task: one whole-deliverable review pass (fresh
   reviewer, full diff, the plan, the ledger's deferred list). If it
   finds issues: ONE batched fix dispatch with the complete list, one
   scoped re-review, then done. Report the outcome and anything still
   deferred in your reply.

## Red flags
| Excuse | Reality |
|--------|---------|
| "I'll fix it myself, dispatching is overhead" | Controller fixes skip review and pollute your context. Dispatch. |
| "Close enough on spec" | Reviewer found gaps = not done. Fix, or hit the cap and ask the user. |
| "One more round will converge" | Past 3 rounds the failure is structural. Stop and surface it. |
| "The fix was tiny, skip the re-review" | Unreviewed fixes are how regressions land. Every round ends reviewed. |
| "Subagent says it passed, mark it done" | Their claim is not evidence — the diff is. Verify yourself. |
| "Ledger is overhead" | The ledger is what survives a crash. Without it you re-run finished work. |

*Adapted for yodacode from [obra/superpowers](https://github.com/obra/superpowers) (MIT, (c) 2025 Jesse Vincent). See THIRD-PARTY-NOTICES.md.*
