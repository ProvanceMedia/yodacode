```
██╗   ██╗ ██████╗ ██████╗  █████╗  ██████╗ ██████╗ ██████╗ ███████╗
╚██╗ ██╔╝██╔═══██╗██╔══██╗██╔══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝
 ╚████╔╝ ██║   ██║██║  ██║███████║██║     ██║   ██║██║  ██║█████╗
  ╚██╔╝  ██║   ██║██║  ██║██╔══██║██║     ██║   ██║██║  ██║██╔══╝
   ██║   ╚██████╔╝██████╔╝██║  ██║╚██████╗╚██████╔╝██████╔╝███████╗
   ╚═╝    ╚═════╝ ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
```

Personal Claude-Code-powered chat agent for Slack, WhatsApp, and beyond.

Runs entirely on your **Claude Max subscription**, so there's no API key and no per-request billing. One command to install. DM your bot 3 minutes later.

## What is this?

YodaCode is a self-hosted personal AI agent that lives on your own server and replies to you in Slack (and optionally WhatsApp). Every reply runs through Claude Code (`claude -p`), so the agent has real tools: Read, Write, Edit, web search, browser automation, subagents, and sandboxable Bash.

It also remembers. A structured file-based memory system with daily consolidation and full-text search means the agent builds up context over time instead of starting cold every conversation. The full feature list is in the [table below](#features).

## Server requirements

YodaCode runs as a persistent background service, so it needs an always-on Linux host: a cheap VPS, a cloud droplet, or a home server. A laptop that sleeps won't do.

- **OS:** Linux with `systemd`. Ubuntu/Debian-family is smoothest (the sandbox step uses `apt`). macOS works if you run it manually (`node workspace/yoda.js`, with the sandbox using Seatbelt); the one-command installer is Linux-only, and Windows isn't supported.
- **Node.js 20+:** if it's missing, `install.sh` drops Node 22 LTS into `~/.yodacode/node/` for you, no sudo required.
- **Claude subscription:** Max recommended, Pro works with tighter limits. The installer signs you in with `claude setup-token`, and the Claude Code CLI is installed for you if it's not already on PATH.
- **A Slack workspace** where you can add an app: the wizard creates it from a manifest in one click. WhatsApp is optional.
- **Hardware:** modest. 1 vCPU and 1 GB RAM is enough for the agent itself (the Node process idles around 40 MB). Bump to ~2 GB RAM and ~2 GB free disk if you want the browser tools, which pull in headless Chromium (~400 MB).
- **Network:** outbound HTTPS only. Slack runs over Socket Mode, so you don't open any inbound ports or expose the box to the internet.

The wizard installs the heavier optional bits on demand: `bubblewrap` + `socat` for the Bash sandbox, and Playwright + Chromium for the browser tools. Skip them and the footprint stays tiny.

## You don't need to be technical

You *can* manually edit files, write cron scripts, and configure integrations, but you usually don't need to. YodaCode has access to its own workspace and knows its own directory structure. Just ask it:

- *"Remember that I prefer bullet points over paragraphs"* appends to its own MEMORY.md under the right section.
- *"Change your name to Jarvis"* edits IDENTITY.md and CLAUDE.md.
- *"Write a cron that checks my inbox every 30 minutes"* writes the YAML in `cron-tasks/`, and the in-container scheduler picks it up automatically — no command to run.
- *"Add HubSpot integration"* tells you what to add to `.env`, updates `refresh-capabilities.py` with the new service, and starts using it once you restart.

With the default config the agent has full host access, so it can carry these out end to end. With the sandbox on it writes what it can and tells you the one protected step (see [Sandbox](#sandbox)). Either way: the agent builds everything, you flip the switch.

## Security model: de-rooted by default

YodaCode runs **de-rooted out of the box**. Your API keys never enter the agent. They live
in a separate **broker** container that holds the vault and makes the authenticated calls; the
**agent** container — the bot itself — runs as an unprivileged user with no service keys in its
environment and reaches every API through the broker. So a prompt injection or a confused agent
has nothing to leak: the keys are on the other side of a container boundary, enforced by the OS,
not by a prompt rule. See [docs/BROKER.md](docs/BROKER.md).

## Quickstart (Docker)

```bash
git clone https://github.com/ProvanceMedia/yodacode.git
cd yodacode
./quickstart.sh             # installs Docker if missing, creates .env, starts the stack
```

`quickstart.sh` installs Docker (via get.docker.com) when it's not already present, creates
`.env` from the example on first run and tells you which tokens to fill in, then builds and
starts the de-rooted broker + agent. Re-run it after editing `.env`. (Already have Docker and
a filled `.env`? `docker compose up -d` does the same thing.)

Docker bakes node + Claude Code into the image, so there's nothing else to provision on the
host and it behaves identically on any machine. Give the build ~1 GB of RAM — on a 512 MB VPS
add swap first or the image build can stall. Edit `.env`, add hosts to
`workspace/broker/auth-hosts.json`, and `docker compose restart`. Your workspace (memory, skills,
cron definitions) is bind-mounted, so you can read and edit it on the host; set `PUID`/`PGID` in
`.env` to your host user so those files stay owned by you.

```bash
docker compose logs -f agent      # watch the bot
docker compose exec agent bash    # poke around inside
docker compose restart            # after editing .env or configs
```

Crons run **inside the agent container** on their own timers (no host systemd) — drop a YAML in
`cron-tasks/` and it's picked up automatically. 3 minutes after `up`, DM your bot in Slack.

### Bare-metal alternative (no Docker)

If you can't run Docker, `./install.sh` still does a host install (Node into `~/.yodacode/node/`,
a setup wizard, a systemd service). For de-rooting on bare metal, run `sudo scripts/setup-broker.sh`
after install. The `yodacode` CLI (`yodacode update|status|help`) manages a host install. The
container path above is the recommended one.

## Architecture

```
                    ┌──────────────┐
                    │   Slack API  │
                    │ (Socket Mode)│
                    └──────┬───────┘
                           │ real-time events
                    ┌──────▼───────┐
                    │   yoda.js    │ ← Node.js coordinator
                    │  (surfaces)  │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
     ┌────────▼──┐  ┌──────▼─────┐  ┌──-▼─────────┐
     │ dispatcher│  │stop-handler│  │queue (serial│
     │ (policy + │  │ (kill mid- │  │ per-convo   │
     │  context) │  │  tick)     │  │ + coalesce) │
     └────────┬──┘  └────────────┘  └─────────────┘
              │
     ┌────────▼───────────────────────────┐
     │          claude-runner             │
     │  spawn claude -p --stream-json     │
     │  ├─ stream-translator (live status)│
     │  ├─ model fallback (529 → Haiku)   │
     │  ├─ bubblewrap sandbox             │
     │  └─ tick state (for stop/timeout)  │
     └────────────────────────────────────┘
```

## Features

| Feature | Description |
|---|---|
| **Multi-surface** | Slack + WhatsApp. Add more via `lib/surfaces/<name>.js`. |
| **Live streaming** | Placeholder message updates in real time as Claude works. |
| **Threaded replies** | Every reply in a thread. Old threads work forever (no aging). |
| **Memory system** | Proactive memory with 4 typed categories, a daily consolidation cron, and FTS5 search. See [Memory search](#memory-search). |
| **Skill self-generation** | Opt-in reflector turns long conversations into reusable `SKILL.md` files. See [Closed-loop self-improvement](#closed-loop-self-improvement-opt-in). |
| **Loop guardrails** | Repeat-failure, no-progress, and iteration-cap detection. See [Loop guardrails](#loop-guardrails). |
| **Tool auto-discovery** | Drop a `@yoda-tool` manifest on a script in `bin/` and it appears in `CAPABILITIES.md` on restart. See [Adding a tool](#adding-a-tool). |
| **Cron tasks** | Declarative YAML task definitions run by a shared runner. Per-task model, optional Slack delivery. See [Adding a cron task](#adding-a-cron-task). |
| **Model fallback** | Sonnet to Haiku (configurable chain). Fail-fast on 529. |
| **Slash commands** | `/opus`, `/sonnet`, `/haiku <question>` pick a model per thread, and it sticks for follow-up replies. |
| **Effort levels** | Reasoning depth (`low` to `max`) set globally, per cron, or per thread. See [Effort levels](#effort-levels). |
| **Browser automation** | Playwright for JS-rendered pages and Google Maps verification. |
| **Subagents** | `Task` tool for parallel work and context protection. |
| **Stop command** | Type "stop" to kill an in-flight reply cleanly. |
| **Web dashboard** | Status, crons, live logs, file editing. Basic auth. |
| **Auto-capabilities** | `CAPABILITIES.md` auto-generated from `.env` + `bin/` manifests so the agent never lies about what it can do. |
| **Sandbox** | Opt-in OS-level bubblewrap isolation, off by default. See [Sandbox](#sandbox). |

## Sandbox

Default is `YODA_SANDBOX=off`, which gives the agent full host access (install systemd units end to end, sudo, talk to D-Bus, and so on). This is the practical default because the bubblewrap sandbox blocks systemctl, sudo, and most multi-step ops.

If you want the sandbox, set `YODA_SANDBOX=auto` in `.env`. When enabled:

- Bash commands can **only write** to: workspace, `/tmp`, `logs/`, `cron-tasks/`, `pollers/`
- `.env` and `.claude/settings.json` are protected from the agent
- Network is domain-filtered via a proxy
- Cron self-install, sudo, and most system-level work will not function

```bash
# .env options:
YODA_SANDBOX=off      # default, full host access
YODA_SANDBOX=auto     # bubblewrap sandbox + auto-allow (restricts writes + network)
```

## Configuration

All configuration is via `.env`. See `.env.example` for the full list with documentation.

Key variables:

```bash
CLAUDE_CODE_OAUTH_TOKEN=       # from `claude setup-token`
SLACK_BOT_TOKEN=               # from your Slack app
SLACK_APP_TOKEN=               # from your Slack app
YODA_DM_AUTHORIZED_USERS=     # comma-separated Slack user IDs
YODA_CLAUDE_FALLBACK_MODELS=claude-haiku-4-5
YODA_CLAUDE_EFFORT=            # low|medium|high|xhigh|max (empty = model default)
YODA_SANDBOX=off               # off (default) or auto
```

## Effort levels

Claude Code exposes a reasoning **effort** control (`low`, `medium`, `high`, `xhigh`, `max`), where higher means deeper reasoning at the cost of more tokens per turn. YodaCode wires it in three ways:

- **Global default:** set `YODA_CLAUDE_EFFORT` in `.env`. Empty uses the model's own default (`high` on Opus 4.7/4.8 and Sonnet 4.6).
- **Per cron:** add `effort: xhigh` to a task's YAML.
- **Per thread (sticky):** say `ultrathink` or `xhigh` in any message, and that reply plus every later reply in the same thread runs at `xhigh`. Say `xhigh off` (or `normal effort`) to drop back. A new thread starts at the default.

Notes:

- `xhigh` is supported on Opus 4.7/4.8 only; other models clamp it to `high`. Haiku has no effort levels, so the setting is ignored there.
- There's no persistent session (each reply is a fresh `claude -p`), so thread stickiness is re-derived from the recent thread history each turn. It lasts while the triggering message stays in the fetched window, so in a very long thread, just say the word again.
- `ultrathink` additionally triggers Claude Code's built-in per-turn deep-reasoning nudge, independent of the effort level.

## Adding a cron task

**Declarative YAML (recommended).** One file per task, no boilerplate:

```bash
cp cron-tasks/_template.yaml cron-tasks/my-task.yaml
# edit my-task.yaml: name, prompt, on_calendar, optional deliver block
./cron-tasks/gen-units.sh my-task
# follow the printed sudo commands to install + enable
```

The shared runner (`workspace/bin/cron-runner.js`) handles env loading, claude invocation, optional Slack delivery, and skill/memory reflection. See [`cron-tasks/README.md`](cron-tasks/README.md) for the full schema.

## Adding a tool

Drop a script into `workspace/bin/` with a `@yoda-tool` manifest block at the top. On next restart, `refresh-capabilities.py` scans it and the agent sees it in `CAPABILITIES.md`. No code edits.

```bash
#!/usr/bin/env bash
# @yoda-tool
# name: hello.sh
# summary: Say hello to a name.
# tags: example
# requires:                        # CSV of env keys the tool needs (or empty)
# usage:
#   hello.sh <name>
# examples:
#   ./bin/hello.sh world
# @end

echo "hello $1"
```

The `requires:` field cross-references against `.env`; if a required key is missing, the tool is marked `❌ missing $X` in the agent's capability listing so it knows not to try.

## Adding a surface

Create `workspace/lib/surfaces/<name>.js` implementing the surface contract (see `lib/surface.js` for the interface). Then add `<name>` to `YODA_SURFACES` in `.env` and restart the service.

## Closed-loop self-improvement (opt-in)

Two background reflectors can run after any successful conversation that crosses a threshold (default: ≥30 seconds OR ≥5 tool calls). Both spawn a separate detached `claude -p` (Haiku by default, so it's cheap), look at the just-completed transcript, and decide whether to persist anything:

- **Skill reflector** asks *"Did we discover a reusable PROCEDURE here?"* If yes, it writes `workspace/skills/<slug>.md` with numbered steps + frontmatter and appends a pointer to `skills/INDEX.md` (which is `@-imported` into the agent's persona, so future conversations see it).
- **Memory reflector** asks *"Did we learn a durable FACT here?"* If yes, it appends a dated bullet to `MEMORY.md` under the right section, or writes a new `memory/<slug>.md` for larger topics.

Both fire-and-forget (never block the user-facing reply). After writing, each rebuilds the FTS5 index so the new entry is searchable on the very next conversation.

A nightly `skill-review.sh` cron then dedupes near-identical skills, promotes ones with `use_count ≥ 3` in the last 30 days into a "Core" section of `INDEX.md`, and archives stale ones (>180 days unused) into `skills/archive/`.

Both are off by default. Opt in with:

```bash
YODA_SKILL_REFLECTOR_ENABLED=1
YODA_MEMORY_REFLECTOR_ENABLED=1
```

Cost: one extra Haiku invocation per reflector per notable conversation. Cheap, but not free, so start with the skill reflector and see how it goes before enabling memory too.

## Loop guardrails

Every Slack/WhatsApp tick is wrapped by a tool tracker that watches the `stream-json` event stream and detects three failure modes:

- **`repeat_failure`:** the same tool called with the same input errored ≥2× in a row, which puts a warning in the Slack placeholder ("⚠️ Bash failed 2× - may be stuck").
- **`no_progress`:** the same tool + same input + same output ≥3× in a row, which warns ("⚠️ may be looping").
- **`iteration_cap`:** total tool_use count exceeded the budget (`YODA_MAX_ITERATIONS_SLACK`, default 60), which SIGTERMs claude and replaces the placeholder with "🛑 Iteration cap hit".

Per-run summary persisted to `state/tool-runs.json` (LRU-capped to 100) for post-mortem. Disable entirely with `YODA_GUARDRAIL_ENABLED=0` if you'd rather just rely on the 10-minute claude timeout.

## Memory search

`./bin/memory-search.sh "<query>"` runs a SQLite FTS5 full-text search over `MEMORY.md`, every file in `memory/`, every file in `skills/`, and (if present) `legacy-memory/`. The bot uses it to fetch just the relevant context for a given question instead of stuffing every memory file into every prompt.

Flags:

- `--limit N` (default 5)
- `--scope active|legacy|index|skill|all` (default = active + index + skill; legacy excluded)
- `--type <feedback|project|user|reference>` (filter by frontmatter)

The index is rebuilt on every yoda startup and after the nightly `memory-consolidate` cron. Each search returns the matching file paths so the agent can `Read` them for full context.

## Important notes

- **Quota usage.** Each reply is one turn against your Max 5-hour limit. Higher effort levels (`xhigh`/`max`) use more quota per turn, and cron tasks add up. Monitor at `claude.ai/settings/usage`.
- **Personal use.** Designed for one person on one server. Not multi-tenant.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ProvanceMedia/yodacode&type=Date)](https://star-history.com/#ProvanceMedia/yodacode&Date)

## License

MIT
