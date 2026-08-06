---
name: test-driven-development
description: Use before writing or changing any code with observable behavior — features, bug fixes, cron logic, scripts.
tags: coding,testing,tdd,quality
created: 2026-08-06
last_used: 2026-08-06
use_count: 0
source: yodacode default
---

# Test-Driven Development

## When to use
Coding work only: writing or changing code with observable behavior — lib
code, bin scripts, cron logic, integrations, anything in a repo with a test
setup. Features, bug fixes, and refactors alike. Does NOT apply to comms or
ops tasks (messages, research, file shuffling) — there is no production code.

## The Iron Law

**NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST**

Wrote code before the test? Delete it and start over. Don't keep it as
"reference", don't adapt it while writing tests. Delete means delete.

**Standing exceptions (no permission needed):** throwaway one-off scripts,
generated code, pure configuration. When one applies, say so in your reply
in one line — e.g. "Skipped TDD: one-off script."

## Red-green-refactor
Each color has a MANDATORY verification step. Never skip one.

1. **RED** — write one minimal test for the next behavior.
2. **Verify RED** — run it; watch it fail for the RIGHT reason: feature
   missing, not a typo or import error. Passes immediately? It tests
   existing behavior — fix the test. Errors out? Fix until it fails cleanly.
3. **GREEN** — simplest code that passes. No extra options, no speculative
   flexibility, nothing beyond the test.
4. **Verify GREEN** — run it; this test passes, the whole suite stays
   green, output pristine. Test fails? Fix the code, not the test.
5. **REFACTOR** — only while green: remove duplication, improve names,
   extract helpers. No new behavior. Re-run the suite after.
6. Repeat with the next failing test.

## Bug fixes
Write a failing test that reproduces the bug BEFORE touching the fix. The
test proves the fix and blocks regression. Never fix a bug without one.

## No test harness?
If the codebase has no test setup, don't build one unprompted for a small
change. Keep the verification-first spirit: write the probe command first
(a run that should fail until the change exists), watch it fail, implement,
re-run the probe, and show it passing in your reply. See
skills/verification-before-completion.md.

## Writing good tests
- Test behavior, not implementation: assert outputs and side effects, not
  constants, exact wording, or private structure.
- Real code over mocks wherever possible; mock only the slow or external
  layer, and never assert on the mock itself.
- One behavior per test, with a name that states it. "and" in the name?
  Split it.
- A test you never watched fail proves nothing — it may pass no matter
  what the code does.

## Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'll test after" | After-tests pass immediately — proves nothing. |
| "Too simple to test" | Simple code breaks. The test takes 30 seconds. |
| "Already manually tested" | Ad-hoc, unrepeatable, forgets edge cases. |
| "Keep the old code as reference" | You'll adapt it. Delete means delete. |
| "Deleting X hours is wasteful" | Sunk cost. Untrusted code is the waste. |
| "Test is hard to write" | Design is unclear. Simplify the interface. |

## Steps
1. Confirm this is coding work with observable behavior; if a standing
   exception applies, note it in one line in your reply and implement.
2. No harness? Use the probe fallback above.
3. RED: write one minimal failing test.
4. Verify RED: run it; confirm it fails for the right reason.
5. GREEN: simplest code to pass. Verify GREEN: run the full suite.
6. REFACTOR while green; re-run the suite.
7. Repeat 3–6 per behavior; bugs get a repro test first.
8. Before reporting done: every new behavior has a test you watched fail,
   suite green, output clean.

*Adapted for yodacode from [obra/superpowers](https://github.com/obra/superpowers) (MIT, (c) 2025 Jesse Vincent). See THIRD-PARTY-NOTICES.md.*
