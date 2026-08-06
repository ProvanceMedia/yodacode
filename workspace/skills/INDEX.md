# Skills

Reusable procedures Yoda has learnt. Each pointer below maps to a `skills/<slug>.md` file with frontmatter + numbered steps.

Curated by the **skill-reflector** (background agent run after long/multi-tool ticks) and tidied by the nightly **skill-review** cron.

This file is `@-imported` into `CLAUDE.md` so Yoda always knows what skills exist. Skill *bodies* are NOT imported — read the file when you need the steps. Use `./bin/skill-tools.sh list` or `./bin/skill-tools.sh search <query>` to discover.

## Shipped defaults

*(ship with the framework — the skill-review cron never archives or dedupes these)*

- [Brainstorming (design before build)](brainstorming.md) — read BEFORE building or changing anything non-trivial with real design choices
- [Writing plans](writing-plans.md) — read AFTER a design is agreed, before any multi-task build; includes how to execute a plan
- [Verification before completion](verification-before-completion.md) — read BEFORE telling the user anything is done, fixed, sent, or deployed
- [Systematic debugging](systematic-debugging.md) — read BEFORE attempting to fix anything broken (crons, integrations, scripts)
- [Test-driven development](test-driven-development.md) — read BEFORE writing or changing code with observable behavior
- [Subagent-driven development](subagent-driven-development.md) — opt-in execution mode for significant multi-task builds; offer it, don't default to it

## Core

*(none yet — promoted here by the nightly skill-review cron when `use_count` ≥ 3 in 30d)*

## Active

- [Copywriting doctrine (house voice)](copywriting-doctrine.md) — read BEFORE drafting any letter, email, or marketing copy; read-aloud gate + ban-the-move rules + your voice anchors

