# Changelog

All notable changes to YodaCode are documented here.
Versions follow [semver](https://semver.org/): `MAJOR.MINOR.PATCH`.

## v0.4.0 — 2026-06-10

- docs: use placeholder ids in cron examples
- feat(broker): optional host-side credential isolation
- docs: add star history chart to README
- docs: tidy README

## v0.3.0 — 2026-06-03

- feat(effort): add reasoning effort levels + thread-sticky ultrathink/xhigh

## v0.2.12 — 2026-06-02

- fix(runner): idle-watchdog timeout so long-but-active runs aren't killed
- docs: fix README to state sandbox is off by default

## v0.2.11 — 2026-06-02

- docs: add Server requirements section, note web search capability
- Enable native WebSearch tool in default allowlists

## v0.2.10 — 2026-05-22

- release: hide from help + gate to the canonical upstream repo

## v0.2.9 — 2026-05-22

- install: print 'source ~/.bashrc' hint when bashrc was just touched

## v0.2.8 — 2026-05-22

- wizard: warn at end if ~/.local/bin isn't on the current shell's PATH

## v0.2.7 — 2026-05-22

- wizard: skip persona + dashboard prompts when already configured

## v0.2.6 — 2026-05-22

- install: pin CLAUDE_BIN to the absolute claude path in .env

## v0.2.5 — 2026-05-22

- systemd: prepend ~/.local/bin to PATH so the unit can find claude

## v0.2.4 — 2026-05-22

- systemd: substitute the actual node binary path, not /usr/bin/node

## v0.2.3 — 2026-05-22

- slack manifest: add assistant:write so fresh installs get the typing-indicator shimmer

## v0.2.2 — 2026-05-22

- install: target ~/.local prefix for global npm installs so binaries land on PATH

## v0.2.1 — 2026-05-22

- install.sh: persist PATH before need_node check, not after

## v0.2.0 — 2026-05-22

- release: --yes flag + sync-probe /dev/tty so piped input works
- release: don't require unpushed commits — only check 'commits since last tag'
- Add yodacode release <patch|minor|major>
- Make yodacode update tolerant of per-install drift
- Always persist ~/.local/bin on PATH + self-heal wrapper on update
- Add yodacode model/tools/usage subcommands + per-run usage tracking

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
