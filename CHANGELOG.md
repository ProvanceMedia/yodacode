# Changelog

All notable changes to YodaCode are documented here.
Versions follow [semver](https://semver.org/): `MAJOR.MINOR.PATCH`.

## v2.16.1 — 2026-07-17

- fix(update): auto-resolve persona-doc conflicts instead of wedging the repo

## v2.16.0 — 2026-07-17

- feat(surface): Google Chat via Pub/Sub pull
- feat(broker): supervisor-side JS broker client

## v2.15.2 — 2026-07-16

- fix(agent): neutral personal-preferences placeholder; place added default lines so installs merge cleanly

## v2.15.1 — 2026-07-16

- docs(agent): stronger default writing-style + pronouns + scoped-consent

## v2.15.0 — 2026-07-16

- feat(broker): slack_upload tool + slack-tools.sh upload for sending files

## v2.14.0 — 2026-07-16

- feat(broker): per-host request timeout for slow endpoints

## v2.13.0 — 2026-07-16

- feat(broker): binary file uploads via http_call (real .xlsx, images, PDFs)

## v2.12.3 — 2026-07-16

- docs(microsoft): name AADSTS500113 as the missing-redirect-URI error

## v2.12.2 — 2026-07-16

- chore: drop the unused pollers/ write-sandbox entry

## v2.12.1 — 2026-07-16

- fix(cron): let the de-rooted agent create and manage cron tasks

## v2.12.0 — 2026-07-16

- feat(connect): Microsoft 365 gains Excel and Teams meetings

## v2.11.0 — 2026-07-16

- feat(connect): Microsoft signs in with auth code + PKCE, not device code

## v2.10.2 — 2026-07-15

- fix(update): preserve in-place framework-doc customizations across updates

## v2.10.1 — 2026-07-15

- fix(update): keep the agent's service notes out of the tracked TOOLS.md

## v2.10.0 — 2026-07-15

- feat(connect): Microsoft 365 provider (Outlook Mail, Calendar, OneDrive, Contacts)
- feat(connect): device-code sign-in flow + public-client providers
- feat(broker): persist rotated OAuth refresh tokens; support public clients

## v2.9.1 — 2026-07-15

- fix(cli): restart recreates containers so .env changes actually load

## v2.9.0 — 2026-07-14

- feat(connect): add Google Search Console + Analytics (GA4) to the catalog
- fix(broker): apply the api.anthropic.com refusal to the parsed hostname
- fix(addkey): accept host:port for APIs on non-standard ports

## v2.8.0 — 2026-07-14

- fix(docker): agent-writable node_modules volume; broker mounts it read-only
- feat(capabilities): probe manifest key — tools report real availability
- fix(browser): make browser-tool runnable as CommonJS with portable module resolution
- feat(browser): headless Chromium via yodacode install-browsers

## v2.7.0 — 2026-07-14

- feat(watch): append a visible footer when a turn arms a background watch
- fix(broker): flush stdout before exit so large replies are not truncated
- fix(cron): translate weekday lists and day-of-month lists in on_calendar

## v2.6.0 — 2026-07-13

- feat(connect): guided OAuth sign-in for Google services via the broker

## v2.5.0 — 2026-07-10

- feat(watch): background watches that wake a thread on completion

## v2.4.0 — 2026-07-07

- feat(addkey): chat-guided API key setup via the broker

## v2.3.0 — 2026-07-03

- feat: tell the user when an update is available

## v2.2.2 — 2026-07-03

- fix: personalise slash-command descriptions in the printed manifest

## v2.2.1 — 2026-07-03

- fix(slack): never fail slash-command help silently; refresh its text

## v2.2.0 — 2026-07-03

- feat: catch out-of-memory hosts before they kill replies

## v2.1.1 — 2026-07-03

- fix: install the yodacode launcher onto a live PATH

## v2.1.0 — 2026-07-03

- feat(slack): muted status card for the working state

## v2.0.0 — 2026-07-03

- feat: per-thread session resume with delta prompts
- feat: run agents through the Claude Agent SDK

## v1.5.2 — 2026-06-14

- fix: point Opus references at claude-opus-4-8

## v1.5.1 — 2026-06-14

- fix: self-install the yodacode launcher on first use

## v1.5.0 — 2026-06-13

- feat: add maintainer release command to yodacode CLI
- docs: document the yodacode CLI and updating
- fix(slack): refine app description and command usage hint
- chore: remove bundled-node installer, standardize on Docker
- feat: add yodacode CLI and shared setup library

## v1.4.2 — 2026-06-12

- fix: cron run logs survive the unprivileged runner

## v1.4.1 — 2026-06-12

- docs: timeout guidance for heavy crons

## v1.4.0 — 2026-06-12

- feat: manual cron triggers — run any scheduled task on demand

## v1.3.4 — 2026-06-10

- docs: rewrite README and cron docs for the container model

## v1.3.3 — 2026-06-10

- fix(addkey): edit auth-hosts.json with python3, not node

## v1.3.2 — 2026-06-10

- fix: rename /help slash command to /yodacode (avoids Slack's built-in /help)

## v1.3.1 — 2026-06-10

- fix: agent docs describe the broker/container model, not the old host model

## v1.3.0 — 2026-06-10

- feat: guided onboarding, /help, addkey, and the no-reply fix

## v1.2.1 — 2026-06-10

- fix(quickstart): show the JSON manifest in the Slack step

## v1.2.0 — 2026-06-10

- feat(quickstart): fully guided installer

## v1.1.1 — 2026-06-10

- fix(quickstart): wait for the apt lock before installing Docker

## v1.1.0 — 2026-06-10

- fix: scheduler weekday ranges, container env handling
- feat: quickstart.sh — zero-to-running on a fresh server
- fix: structured reply tags so model deliberation can't reach the chat

## v1.0.0 — 2026-06-10

- docs: container-first quickstart and broker model
- feat: containerise — de-rooted by default

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
