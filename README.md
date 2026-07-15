```
██╗   ██╗ ██████╗ ██████╗  █████╗  ██████╗ ██████╗ ██████╗ ███████╗
╚██╗ ██╔╝██╔═══██╗██╔══██╗██╔══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝
 ╚████╔╝ ██║   ██║██║  ██║███████║██║     ██║   ██║██║  ██║█████╗
  ╚██╔╝  ██║   ██║██║  ██║██╔══██║██║     ██║   ██║██║  ██║██╔══╝
   ██║   ╚██████╔╝██████╔╝██║  ██║╚██████╗╚██████╔╝██████╔╝███████╗
   ╚═╝    ╚═════╝ ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
```

Your own Claude-powered assistant for Slack, running on your server.

Runs on your **Claude subscription** (Max recommended) — no API key, no per-request billing.
One guided command installs everything; DM your bot a few minutes later.

## What is this?

YodaCode is a self-hosted personal AI agent that lives on your own server and replies to you in
Slack. Every reply runs through the Claude Agent SDK (Claude Code's engine), so the agent has real tools: Read,
Write, Edit, web search, browser automation, subagents, and a full Bash shell. It runs as two
Docker containers — a **broker** that holds your API keys, and the **agent** itself, which never
sees them (see [Security](#security-de-rooted-by-default)).

It also remembers. A structured file-based memory system with daily consolidation and full-text
search means the agent builds up context over time instead of starting cold every conversation.
The full feature list is in the [table below](#features).

## What you need

- **A small always-on Linux server** — a cheap VPS, cloud droplet, or home server. (A laptop that
  sleeps won't do; the bot needs to stay connected.) **1 GB RAM minimum, 2 GB comfortable** —
  under that, the kernel kills replies mid-run (the installer offers to add swap on small boxes).
- **Docker** — if it's missing, the installer offers to install it for you.
- **A Claude subscription** — Max recommended, Pro works with tighter limits. The installer signs
  you in; no API key.
- **A Slack workspace** where you can add an app — the installer walks you through creating it.

You do **not** need Node, systemd, or any other tooling on the host — everything the bot needs is
baked into the Docker image. Outbound HTTPS only; Slack runs over Socket Mode, so no inbound ports
and nothing exposed to the internet.

## Quickstart

```bash
git clone https://github.com/ProvanceMedia/yodacode.git
cd yodacode
./quickstart.sh
```

`quickstart.sh` is a fully guided, 6-step installer — no config files to edit, no prior tooling.
It installs Docker if missing, builds the image, signs you in to Claude (open a URL on your
laptop), lets you **name your assistant and tell it about yourself**, walks you through creating
the Slack app click-by-click (verifying each token live as you paste it), writes the config for
you, launches the stack, and prints your assistant introducing itself so you can see it working.
A few minutes later, DM your bot in Slack.

Adding API keys is optional and explained at the end. Re-running `./quickstart.sh` offers
start-or-reconfigure.

> On a 512 MB box the build stalls and replies get OOM-killed — use 1 GB+, or accept the
> installer's swapfile offer.

## You don't need to be technical

You *can* edit files and write configs by hand, but you usually don't need to. The agent knows its
own workspace. Just ask it in Slack:

- *"Remember I prefer bullet points over paragraphs"* → appends to its own memory.
- *"Change your name to Jarvis"* → edits its identity files.
- *"Write a cron that checks my inbox every 30 minutes"* → drops a task file in `cron-tasks/`; the
  scheduler picks it up.
- *"Connect my GitHub"* → it researches how the service authenticates, prepares everything, and
  tells you to run `yodacode addkey` on the server — where you just paste the key at a hidden
  prompt. Keys are added on the server, never pasted into chat.
- *"Connect my Gmail"* → it prepares a Google sign-in request; `yodacode connect` on the server
  walks you through a one-time browser consent (Calendar, Drive & co ride the same sign-in).

## Security: de-rooted by default

Your API keys never enter the agent. They live in a separate **broker** container that holds the
vault and makes the authenticated calls; the **agent** container — the bot itself — runs as an
unprivileged user with no service keys in its environment and reaches every API through the broker.
So a prompt injection or a confused agent has nothing to leak: the keys are on the other side of a
container boundary, enforced by the OS, not by a prompt rule. See [docs/BROKER.md](docs/BROKER.md).

## Day-to-day

The installer drops a `yodacode` command on your PATH. Run `yodacode help` for the full list:

```bash
yodacode doctor      # diagnose setup & health, with fixes
yodacode logs        # watch the bot work
yodacode restart     # apply .env changes
yodacode stop        # stop it
yodacode shell       # open a shell inside the agent
yodacode status      # what's configured + container state
```

Configuration without editing files:

```bash
yodacode slack       # (re)connect the Slack app + tokens
yodacode persona     # change bot name, your name, timezone
yodacode model       # show / set the Claude model
yodacode tools       # toggle reflectors & guardrails
yodacode addkey      # give the bot an API key (via the broker)
yodacode connect     # sign the bot into an OAuth service (Google, Microsoft 365)
yodacode install-browsers  # give the bot a headless browser (one-time ~300MB download)
```

(Everything still works as plain `docker compose …` from the install folder if you prefer — the
`yodacode` command is a thin wrapper. If it isn't found yet, run `source ~/.bashrc` once, or use
`./yodacode` from the repo.)

**Adding an API key** (GitHub, Stripe, Notion, …): the easy way is to ask the bot — *"set up
Notion"* — it researches the service's API and prepares the request; then `yodacode addkey` on the
server shows what it prepared, you paste the key at a hidden prompt, and — when the service has a
known test endpoint — it verifies the connection with a live call. Well-known services also work
directly (`yodacode addkey github`), and
`yodacode addkey --help` covers the manual options. Either way the key is stored in the broker
(the agent never sees it) and the new host shows up in the agent's `CAPABILITIES.md`.

**Connecting Google or Microsoft 365** (Gmail, Google Calendar/Drive/Docs…; Outlook Mail,
Calendar, OneDrive…): these use a browser sign-in instead of a pasteable key — run
`yodacode connect google` / `yodacode connect microsoft` (or just ask the bot: *"connect my
gmail"*, then run `yodacode connect`). The wizard walks you through creating your own OAuth
client (one-time — your data stays strictly between your server and the provider), then prints
a sign-in link to open on your laptop, and verifies each service with a live call before
storing anything. Tokens live in the broker vault; the agent never sees them. Renewals
(`--renew`) take ~2 minutes, and `yodacode doctor` diagnoses expired sign-ins. Details:
[docs/providers/](docs/providers/).

## Updating

```bash
yodacode update      # fetch the latest, show what changed, rebuild & restart
```

It pulls the newest version, rebuilds the image, and restarts the stack — pausing to show you the
incoming commits first. (By hand it's `git pull && docker compose up -d --build` from the install
folder.)

**You'll know when there's something to update:** the bot checks for new releases once a day and
DMs you (once per version) with the highlights, and every `yodacode` command shows a one-line
banner when a newer version exists. The DM goes to the first `YODA_DM_AUTHORIZED_USERS` entry —
put the operator first. Disable both with `YODA_UPDATE_CHECK=0` in `.env`.

Your workspace (memory, skills, cron definitions) is **bind-mounted**, so you can read and edit it
on the host. Set `PUID`/`PGID` in `.env` to your host user if you want those files owned by you.

## Architecture

```
                 ┌──────────────┐
                 │   Slack API  │  (Socket Mode — no inbound ports)
                 └──────┬───────┘
                        │ real-time events
   ╔════════════════════▼═══════════════════════╗
   ║  agent container  (unprivileged, no keys)  ║
   ║   yoda.js ─ surfaces                        ║
   ║     ├─ dispatcher (policy + context)        ║
   ║     ├─ claude-runner → Agent SDK query()    ║
   ║     │     ├─ live status streaming          ║
   ║     │     └─ model fallback (529 → Haiku)   ║
   ║     ├─ stop-handler (abort mid-tick)        ║
   ║     └─ scheduler (in-container crons)       ║
   ╚════════════════════╤═══════════════════════╝
                        │ broker call (unix socket)
   ╔════════════════════▼═══════════════════════╗
   ║  broker container  (holds the vault)       ║
   ║   injects credentials, makes the API calls ║
   ╚════════════════════════════════════════════╝
```

## Features

| Feature | Description |
|---|---|
| **De-rooted by default** | Keys live in a separate broker container; the agent never sees them. |
| **Google / Microsoft 365 sign-ins** | Guided `yodacode connect` wizard: bring-your-own OAuth client, browser consent from your laptop, tokens broker-held, one-command renewal. See [docs/providers/](docs/providers/). |
| **Live streaming** | Placeholder message updates in real time as Claude works. |
| **Threaded replies** | Every reply in a thread. Old threads work forever (no aging). |
| **Memory system** | Proactive memory with 4 typed categories, a daily consolidation cron, and FTS5 search. See [Memory search](#memory-search). |
| **Skill self-generation** | Opt-in reflector turns long conversations into reusable `SKILL.md` files. See [Self-improvement](#closed-loop-self-improvement-opt-in). |
| **Loop guardrails** | Repeat-failure, no-progress, and iteration-cap detection. See [Loop guardrails](#loop-guardrails). |
| **In-container crons** | Declarative YAML tasks run on their own timers — no host systemd. See [Cron tasks](#adding-a-cron-task). |
| **Model fallback** | Sonnet to Haiku (configurable chain). Fail-fast on 529. |
| **Slash commands** | `/opus`, `/sonnet`, `/haiku <question>` pick a model per thread; `/yodacode` shows help & setup. |
| **Effort levels** | Reasoning depth (`low` to `max`) set globally, per cron, or per thread. See [Effort levels](#effort-levels). |
| **Browser automation** | Playwright headless Chromium for JS-rendered pages and screenshots — enable once with `yodacode install-browsers` (~300MB download into a persistent volume; the image ships the system libraries, so the bot honestly reports ❌/✅ in its capabilities until/once enabled). |
| **Subagents** | `Task` tool for parallel work and context protection. |
| **Stop command** | Type "stop" to kill an in-flight reply cleanly. |
| **Web dashboard** | Status, crons, live logs, file editing. Basic auth. |
| **Auto-capabilities** | `CAPABILITIES.md` is auto-generated from the broker registry + `bin/` manifests so the agent never lies about what it can do. |

## Configuration

The installer writes `.env` for you. To change something later, edit `.env` and
`docker compose restart`. See `.env.example` for the full list with documentation.

```bash
CLAUDE_CODE_OAUTH_TOKEN=       # set by the installer (claude sign-in)
SLACK_BOT_TOKEN=               # set by the installer
SLACK_APP_TOKEN=               # set by the installer
YODA_DM_AUTHORIZED_USERS=      # comma-separated Slack user IDs allowed to DM the bot
YODA_CLAUDE_MODEL=             # primary model (empty = Claude Code default)
YODA_CLAUDE_FALLBACK_MODELS=claude-haiku-4-5
YODA_CLAUDE_EFFORT=            # low|medium|high|xhigh|max (empty = model default)
BOT_NAME=                      # your assistant's name
USER_NAME=                     # what it calls you
PUID=                          # host uid to own bind-mounted workspace files (optional)
PGID=
```

## Effort levels

Claude Code exposes a reasoning **effort** control (`low`, `medium`, `high`, `xhigh`, `max`), where
higher means deeper reasoning at the cost of more tokens per turn. YodaCode wires it in three ways:

- **Global default:** set `YODA_CLAUDE_EFFORT` in `.env`. Empty uses the model's own default.
- **Per cron:** add `effort: xhigh` to a task's YAML.
- **Per thread (sticky):** say `ultrathink` or `xhigh` in any message, and that reply plus every
  later reply in the same thread runs at `xhigh`. Say `xhigh off` to drop back. A new thread starts
  at the default.

Notes: `xhigh` is supported on Opus only; other models clamp it to `high`, and Haiku ignores effort.
Effort stickiness is re-derived from recent thread history each reply — in a very long thread,
just say the word again.

## Persistent thread sessions

Each conversation thread keeps its own Agent SDK session: every reply resumes the agent's prior
session, so its earlier turns, tool results, and working memory carry over, and each tick only
sends the messages that arrived since its last turn (cheaper, faster, and the agent doesn't
re-derive what it already worked out). Session pointers live in `state/sessions.json`; the
transcripts live in the agent's `~/.claude` (persisted across container recreation by the
`yc_agent_home` volume). If a session goes missing — pruned, or a fresh volume — the next reply
transparently starts a new session with the full thread history. A thread idle longer than
`YODA_SESSION_MAX_AGE_MS` (default 14 days) also starts fresh, and a very long-lived thread
rotates to a fresh session once a reply's total input reaches `YODA_SESSION_ROTATE_TOKENS`
(default 120k), so per-reply cost stays bounded. Edited messages are re-shown to the agent on
its next reply; deleted messages stay in its session memory until the session rotates. Set
`YODA_SESSION_RESUME=0` for the old fully-stateless behaviour.

## Adding a cron task

Scheduled tasks are YAML files run by the in-container scheduler — no host systemd, no shell
wrappers. Drop a file in `cron-tasks/` and `docker compose restart`:

```bash
cp cron-tasks/_template.yaml cron-tasks/my-task.yaml
# edit: name, prompt, on_calendar (systemd OnCalendar syntax), optional model/effort/deliver
docker compose restart
```

The scheduler reads `on_calendar`, runs the prompt on schedule via `cron-runner.js`, and handles
optional Slack delivery and skill/memory reflection. Delete or rename a file to disable it. See
[`cron-tasks/README.md`](cron-tasks/README.md) for the full schema. (You can also just ask the bot
to write one for you.)

## Adding a tool

Drop a script into `workspace/bin/` with a `@yoda-tool` manifest block at the top. On the next
restart, `refresh-capabilities.py` scans it and the agent sees it in `CAPABILITIES.md`. No code
edits.

```bash
#!/usr/bin/env bash
# @yoda-tool
# name: hello.sh
# summary: Say hello to a name.
# tags: example
# usage:
#   hello.sh <name>
# examples:
#   ./bin/hello.sh world
# @end

echo "hello $1"
```

## Adding a surface

Create `workspace/lib/surfaces/<name>.js` implementing the surface contract (see `lib/surface.js`
for the interface). Add `<name>` to `YODA_SURFACES` in `.env` and `docker compose restart`.

## Closed-loop self-improvement (opt-in)

Two background reflectors can run after any successful conversation that crosses a threshold
(default: ≥30 seconds OR ≥5 tool calls). Both fire a separate background agent run (Haiku by
default, so it's cheap), look at the just-completed transcript, and decide whether to persist
anything:

- **Skill reflector** asks *"Did we discover a reusable PROCEDURE here?"* If yes, it writes
  `workspace/skills/<slug>.md` with numbered steps + frontmatter and appends a pointer to
  `skills/INDEX.md` (which is `@-imported` into the agent's persona).
- **Memory reflector** asks *"Did we learn a durable FACT here?"* If yes, it appends a dated bullet
  to `MEMORY.md` under the right section, or writes a new `memory/<slug>.md` for larger topics.

Both fire-and-forget (never block the reply) and rebuild the FTS5 index after writing. A nightly
`skill-review` cron dedupes near-identical skills, promotes frequently-used ones into a "Core"
section of `INDEX.md`, and archives stale ones.

Both are off by default. Opt in with:

```bash
YODA_SKILL_REFLECTOR_ENABLED=1
YODA_MEMORY_REFLECTOR_ENABLED=1
```

## Loop guardrails

Every tick is wrapped by a tool tracker that watches the agent's live event stream and detects
three failure modes:

- **`repeat_failure`:** the same tool + same input errored ≥2× in a row → warning in the placeholder.
- **`no_progress`:** the same tool + same input + same output ≥3× in a row → "may be looping" warning.
- **`iteration_cap`:** total tool_use count exceeded the budget (`YODA_MAX_ITERATIONS_SLACK`,
  default 60) → SIGTERMs claude and replaces the placeholder with "🛑 Iteration cap hit".

Per-run summaries persist to `state/tool-runs.json` for post-mortem. Disable with
`YODA_GUARDRAIL_ENABLED=0`.

## Memory search

`./bin/memory-search.sh "<query>"` runs a SQLite FTS5 full-text search over `MEMORY.md`, every file
in `memory/`, and every file in `skills/`. The bot uses it to fetch just the relevant context for a
question instead of stuffing every memory file into every prompt.

Flags: `--limit N` (default 5), `--scope active|index|skill|all`, `--type <feedback|project|user|reference>`.
The index is rebuilt on startup and after the nightly `memory-consolidate` cron.

## Important notes

- **Quota usage.** Each reply is one turn against your Max limit. Higher effort levels
  (`xhigh`/`max`) and cron tasks use more. Monitor at `claude.ai/settings/usage`.
- **Personal use.** Designed for one person on one server. Not multi-tenant.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ProvanceMedia/yodacode&type=Date)](https://star-history.com/#ProvanceMedia/yodacode&Date)

## License

MIT
