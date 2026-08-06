---
name: systematic-debugging
description: Anything broken — failing cron, misbehaving integration, script error, unexpected output — before any fix
tags: debugging,root-cause,process,reliability
created: 2026-08-06
last_used: 2026-08-06
use_count: 0
source: yodacode default
---

# Systematic Debugging

## When to use
Something is broken: a cron failed, an integration misbehaves, one of your own
scripts errors, output looks wrong. Work through this BEFORE attempting any
fix — especially under time pressure, when a "quick fix" seems obvious, or
when a previous fix didn't take. Don't skip it because the issue looks simple;
simple bugs have root causes too, and the process is fast when they do.

## The Iron Law

NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.

If you haven't finished steps 1-5, you may not propose a fix. Symptom patches
are failure, not progress.

## Red flags — any of these sends you back to step 1

| You catch yourself thinking            | Reality                             |
|----------------------------------------|-------------------------------------|
| "Just try changing X and see"          | Guessing. You don't know the cause. |
| "Quick fix for now, investigate later" | The quick fix becomes the fix.      |
| "It's probably the env / it's flaky"   | 95% of "environmental" = incomplete investigation. |
| "Stack a couple of changes, rerun"     | Can't isolate what worked; breeds new bugs. |
| "One more attempt" (already tried 2+)  | Three strikes — stop and write up (step 10). |

## Steps

1. Read the FULL error: whole stack trace, line numbers, paths, exit codes.
   It often already names the answer. Never skim past warnings.
2. Reproduce it reliably — exact command, exact input. Not reproducible yet?
   Gather more data; do not guess.
3. Check what changed recently: git diff/log, config edits, credential
   rotations, dependency bumps, schedule changes.
4. Multi-component path (cron -> script -> API -> broker)? Instrument every
   boundary: log what enters and exits each layer, run once, and see WHERE
   it breaks before touching anything.
5. Trace bad values backward to their origin: symptom -> immediate cause ->
   its caller -> the source. Log context (args, cwd, env) BEFORE the failing
   operation. Fix at the source, never where the error surfaces.
6. Pattern analysis: find the closest WORKING equivalent (a cron that runs,
   an integration that answers) and list every difference, however small.
   "That can't matter" is not allowed.
7. Form ONE hypothesis: "X is the root cause because Y." Test it with the
   smallest possible change, one variable at a time. Never stack speculative
   fixes. Wrong? Revert, then back to step 1 with the new data.
8. Fix: where a test harness exists, write the failing repro test first
   (read skills/test-driven-development.md), then make ONE change that
   addresses the root cause. No "while I'm here" refactors.
9. Verify: repro passes, the original symptom is gone, and nothing else
   broke. Read skills/verification-before-completion.md before claiming
   fixed.
10. Three strikes: after 3 failed fix attempts, STOP. Write up what you've
    established and what you've ruled out, post it in your reply, and end
    your turn — wait for the user's steer before attempt #4. Questioning
    the architecture beats a fourth patch.

## When there is truly no root cause

"No root cause found" is a legitimate conclusion only AFTER the full process.
Then mitigate deliberately — retry, timeout, extra logging for next time —
and say in your reply that you shipped a mitigation, not a fix.

*Adapted for yodacode from [obra/superpowers](https://github.com/obra/superpowers) (MIT, (c) 2025 Jesse Vincent). See THIRD-PARTY-NOTICES.md.*
