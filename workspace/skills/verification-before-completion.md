---
name: verification-before-completion
description: Before any message that states or implies something is done, fixed, sent, deployed, scheduled, or working.
tags: verification,completion,discipline,quality
created: 2026-08-06
last_used: 2026-08-06
use_count: 0
source: yodacode default
---

# Verification Before Completion

## When to use
Before ANY reply that claims — or lets the user infer — that something is
done, fixed, sent, deployed, scheduled, healthy, or working. Applies to
everything you do: code, ops, comms, crons, research deliverables, and work
a subagent did for you. Not needed for statements of intent ("I'll do X
next") — only for statements of state.

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you did not run the probe in THIS turn, you cannot claim it holds.
Violating the letter of this rule is violating the spirit of this rule.

## The Gate
Before claiming any status:
1. IDENTIFY — what probe proves this exact claim?
2. RUN it fresh and in full. Never reuse an earlier run's output.
3. READ the whole output: exit code, counts, errors.
4. CHECK — does the output actually prove the claim? If not, report the
   real state instead, with the evidence.
5. ONLY THEN claim — and include the evidence in your reply.

Skipping a step is lying, not verifying.

## Claim → evidence
| Claim | Requires | Not sufficient |
|---|---|---|
| Tests pass | Fresh full run, zero failures | Earlier run, "should pass" |
| Bug fixed | Re-test the original symptom | Code changed, assumed fixed |
| Email/message sent | Sent record or message id | The API call you fired |
| Cron fixed | Trigger or await a run, read its log | Edited the task file |
| Service healthy | Probe endpoint/status NOW | It was up earlier |
| File/config deployed | Read it back from the target | Copy command exited 0 |
| Subagent finished | Inspect its output/diff yourself | Its "success" report |
| Schedule/reminder set | List the schedule, see the entry | Create call returned |
| Requirements met | Line-by-line check vs the plan | Tests passing |

For "requirements met", re-read the spec in memory/plans/ (see
skills/writing-plans.md) and tick each item against evidence.

## Red flags — STOP
- "should", "probably", "seems to", "likely"
- "Done!" / "Fixed!" / "Sent!" before running the probe
- Claiming from a stale earlier run
- Relaying a subagent's success claim unchecked
- Thinking "just this once" or wanting the task over

| Excuse | Reality |
|---|---|
| "Should work now" | Run the probe |
| "I'm confident" | Confidence is not evidence |
| "The agent said success" | Verify it yourself |
| "Partial check is enough" | Partial proves nothing |
| "Different words, so rule doesn't apply" | Spirit over letter |

The rule covers paraphrases, synonyms, and implications of success — any
wording the user would read as "it's handled" — not just the literal words.

## Steps
1. Draft the claim you are about to make.
2. Name the probe that proves it (see table above).
3. Run the probe fresh; read the full output.
4. Claim only what the output proves, quoting the evidence.
5. If part of a claim cannot be probed (e.g. third-party delivery), state
   exactly what WAS verified and what remains unverified — never round up
   to "done".
6. If only the user can confirm (e.g. "did it arrive on your phone?"), ask
   in your reply and end the turn; confirm when they answer.

*Adapted for yodacode from [obra/superpowers](https://github.com/obra/superpowers) (MIT, (c) 2025 Jesse Vincent). See THIRD-PARTY-NOTICES.md.*
