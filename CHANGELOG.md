# Changelog

All notable changes to YodaCode are documented here.
Versions follow [semver](https://semver.org/): `MAJOR.MINOR.PATCH`.

## v0.1.0 — initial public version

First tagged release. Highlights:

- **One-line install** (`./install.sh`) that fetches Node 22 LTS into `~/.yodacode/node/` — no sudo, no NodeSource apt step. Works in containers and restricted hosts.
- **CLI** (`yodacode <command>`) installed to `~/.local/bin/`:
  - `yodacode setup [<step>]` — full wizard or one step (auth/persona/slack/dashboard/systemd)
  - `yodacode add <surface>` — add a chat surface (whatsapp, etc.)
  - `yodacode update` — `git pull` + npm install + restart
  - `yodacode status` — summary of current config
  - `yodacode version` — installed version
  - `yodacode help`
- **Declarative cron tasks** — drop a YAML in `cron-tasks/`, run `gen-units.sh`, done. A shared `cron-runner.js` reads the YAML, invokes claude, posts output, fires reflectors.
- **Closed-loop self-improvement (opt-in)** — skill + memory reflectors that turn long conversations into `SKILL.md` / `MEMORY.md` entries.
- **Loop guardrails** — repeat-failure + no-progress + iteration-cap detection on every claude run.
- **Memory search** — `./bin/memory-search.sh "<query>"` (SQLite FTS5 over `MEMORY.md`, `memory/`, `skills/`, `legacy-memory/`).
- **Auto-discovered tools** — `@yoda-tool` manifest blocks in `workspace/bin/*` get listed in `CAPABILITIES.md` on each restart.
- **Model fallback** — Sonnet → Haiku on 529s; per-thread overrides via `/opus`, `/sonnet`, `/haiku` slash commands.
- **Web dashboard** — status, logs, cron management. Basic auth.
- **Sandbox** — bubblewrap available as opt-in (`YODA_SANDBOX=auto`); default is `off` for ergonomics.
