---
name: brainstorming
description: Use when asked to build or change something non-trivial — a new feature, integration, or automation.
tags: design,planning,requirements,workflow
created: 2026-08-06
last_used: 2026-08-06
use_count: 0
source: yodacode default
---

# Brainstorming Ideas Into Designs

## When to use
The user wants something built or changed and there are real design choices:
a new feature, a new integration, a cron/automation, anything with more than
one sensible shape. NOT for quick fixes, direct questions, or routine ops —
just do those. Scale the process to the task: a small build may need one
question and a one-line restatement; a significant one gets the full flow.

**Iron law: on multi-step work, get an explicit go-ahead on the design
before building anything.**

## Red flags — you are under-planning when you think:

| Rationalization                    | Reality                                  |
|------------------------------------|------------------------------------------|
| "It's just a quick script"         | Touches creds/crons/data → choices exist |
| "I already know what they want"    | You know what they said; ambiguity hides in what they didn't |
| "Questions make me look slow"      | One good question beats one rebuild      |
| "I'll settle the design as I code" | Mid-run pivots burn the whole run        |
| "The request was detailed"         | Detailed on WHAT is not decided on HOW   |

## Method

**Explore before you ask.** Search memory, check skills, read the relevant
files. Never ask the user something you can look up — questions spend their
patience; spend it only on real decisions.

**One question per reply.** You cannot pause mid-run: ask the single most
important open question, end your turn, and resume when they answer. Prefer
multiple choice. Cover purpose, constraints, and success criteria. Typically
2-4 questions total; stop as soon as the shape is clear.

**Don't interrogate.** If the user answers vaguely twice, or says "just do
it", stop asking: make sensible assumptions, state them all in ONE message,
and proceed. They can correct you mid-flight.

**Propose 2-3 approaches** with trade-offs; lead with your recommendation
and why. YAGNI ruthlessly — strip anything nobody asked for. If the request
is really several independent projects, say so and design the first slice.

**Get the go-ahead.** Explicit approval of the recommended design before
any implementation.

**Write it down (significant builds only).** Save the agreed design to
memory/plans/YYYY-MM-DD-<topic>-spec.md (create the dir if needed) — a few
sections: goal, shape, components, risks, success criteria. Not a novel.
Scan it once for TBDs, contradictions, and two-way-interpretable lines; fix
inline. Then read skills/writing-plans.md and continue there. For small
tasks skip the file: restate the agreed shape in the thread and build.

## Steps
1. Explore context first: memory, skills, relevant files, existing patterns.
2. Judge the scale: trivial → just build; real design choices → continue.
3. Ask clarifying questions, one per reply, multiple choice where possible;
   end your turn to ask, resume on the answer.
4. Two vague answers or "just do it" → state assumptions in one message and
   proceed on them.
5. Propose 2-3 approaches with trade-offs; recommend one.
6. Get explicit approval of the design.
7. Significant build: write memory/plans/YYYY-MM-DD-<topic>-spec.md, then
   read skills/writing-plans.md and continue there.
8. Small build: restate the agreed shape in the thread and start.

*Adapted for yodacode from [obra/superpowers](https://github.com/obra/superpowers) (MIT, (c) 2025 Jesse Vincent). See THIRD-PARTY-NOTICES.md.*
