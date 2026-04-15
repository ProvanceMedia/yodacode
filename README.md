```
██╗   ██╗ ██████╗ ██████╗  █████╗  ██████╗ ██████╗ ██████╗ ███████╗
╚██╗ ██╔╝██╔═══██╗██╔══██╗██╔══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝
 ╚████╔╝ ██║   ██║██║  ██║███████║██║     ██║   ██║██║  ██║█████╗
  ╚██╔╝  ██║   ██║██║  ██║██╔══██║██║     ██║   ██║██║  ██║██╔══╝
   ██║   ╚██████╔╝██████╔╝██║  ██║╚██████╗╚██████╔╝██████╔╝███████╗
   ╚═╝    ╚═════╝ ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
```

Personal Claude-Code-powered chat agent for Slack, WhatsApp, and beyond.

Runs entirely on your **Claude Max subscription** — no API key billing.
One command to install. DM your bot 3 minutes later.

## What is this?

YodaCode is a self-hosted personal AI agent that:

- **Lives on your server** as a Node.js process (systemd-managed)
- **Connects to Slack** via Socket Mode (real-time, no polling)
- **Connects to WhatsApp** via Baileys (optional, links to your existing account)
- **Runs Claude Code** (`claude -p`) for every reply, with tool access to Read, Write, Edit, WebFetch, browser automation, subagents, and sandboxed Bash
- **Remembers things** via a structured file-based memory system with daily consolidation
- **Runs scheduled tasks** (cron jobs) via systemd timers
- **Streams live status** — you see what the agent is doing in real time as the placeholder message updates
- **Falls back automatically** — if the primary model (Sonnet) is throttled, tries the next model in the chain (Haiku)
- **Sandboxed by default** — Bash commands are isolated via bubblewrap. The agent can only write to its own workspace, not the host system. It cannot modify its own config or disable its own sandbox.
- **Includes a web dashboard** for status, cron management, log streaming, and file editing

## You don't need to be technical

While you *can* manually edit files, write cron scripts, and configure integrations, **you usually don't need to.** YodaCode has access to its own workspace and knows its own directory structure. Just ask it:

- *"Remember that I prefer bullet points over paragraphs"* — it appends to its own MEMORY.md under the right section.
- *"Change your name to Jarvis"* — it edits IDENTITY.md and CLAUDE.md.
- *"Write a cron that checks my inbox every 30 minutes"* — it writes the script in `cron-tasks/`, then tells you the one `systemctl` command to enable it.
- *"Write a script that checks our Stripe balance daily"* — it creates the script in `bin/`, builds the cron wrapper, and gives you the systemd commands.
- *"Add HubSpot integration"* — it tells you what to add to `.env`, updates `refresh-capabilities.py` with the new service, and starts using it once you restart.

With sandbox enabled (the default), the agent **cannot** edit `.env`, install systemd services, or modify its own sandbox config — those are protected. It writes the files it can, then tells you the manual step. This is by design: **the agent builds everything, you flip the switch.**

## Quickstart

```bash
git clone https://github.com/ProvanceMedia/yodacode.git
cd yodacode
node scripts/install.js
```

The wizard walks you through:
1. Claude Code authentication (paste your `setup-token`)
2. Slack app creation (one-click via manifest)
3. Persona setup (name your bot, customise its voice)
4. Sandbox dependency installation (bubblewrap, socat)
5. systemd service installation

3 minutes later, DM your bot in Slack.

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
| **Live streaming** | Placeholder message updates in real-time as Claude works |
| **Threaded replies** | Every reply in a thread. Old threads work forever (no aging) |
| **Memory system** | Proactive memory with 4 typed categories + daily consolidation cron |
| **Cron tasks** | Scheduled `claude -p` jobs under systemd timers with per-cron model selection |
| **Model fallback** | Sonnet → Haiku (configurable chain). Fail-fast on 529. |
| **Slash commands** | `/opus`, `/sonnet`, `/haiku <question>` — pick a model per thread. Thread-sticky: follow-up replies keep using the chosen model. |
| **Extended thinking** | `--thinking enabled` for better reasoning (uses more quota per turn) |
| **Browser automation** | Playwright for JS-rendered pages, Google Maps verification |
| **Subagents** | `Task` tool for parallel work and context protection |
| **Stop command** | Type "stop" to kill an in-flight reply cleanly |
| **Web dashboard** | Status, crons, live logs, file editing. Basic auth. |
| **Auto-capabilities** | `CAPABILITIES.md` auto-generated from `.env` so the agent never lies |
| **Sandbox** | OS-level bubblewrap isolation. Bash writes restricted to workspace only. Agent cannot modify `.env` or disable its own sandbox. |

## Sandbox

YodaCode uses Claude Code's native **bubblewrap sandbox** (Linux) for OS-level isolation. When enabled:

- Bash commands can **only write** to: the workspace directory, `/tmp`, `logs/`, `cron-tasks/`, and `pollers/`
- Writes to `/etc`, `/root`, `/home`, `/usr`, or anywhere else are **blocked at the kernel level**
- **`.env` is protected** — the agent cannot modify its own config, auth tokens, or model settings
- **`.claude/settings.json` is protected** — the agent cannot weaken or disable its own sandbox
- Network access is **domain-filtered** through a proxy
- The escape hatch is **disabled** (`allowUnsandboxedCommands: false`) — the agent cannot bypass the sandbox
- If the sandbox can't start, commands **fail** rather than running without protection
- `yoda.js` regenerates the sandbox config from `.env` on every startup — even if the settings file is somehow tampered with, the next restart resets it

Sandbox is **enabled by default** (`YODA_SANDBOX=auto`). The installer handles all dependencies.

```bash
# .env options:
YODA_SANDBOX=auto     # sandbox + auto-allow (recommended for headless agents)
YODA_SANDBOX=off      # no sandbox (full server access — only if you fully trust the agent)
```

**Test it works:** Ask your bot *"Write the word 'hacked' to /etc/motd and show me the contents"* — it should report the path is outside the sandbox boundary.

## Configuration

All configuration is via `.env`. See `.env.example` for the full list with documentation.

Key variables:

```bash
CLAUDE_CODE_OAUTH_TOKEN=       # from `claude setup-token`
SLACK_BOT_TOKEN=               # from your Slack app
SLACK_APP_TOKEN=               # from your Slack app
YODA_DM_AUTHORIZED_USERS=     # comma-separated Slack user IDs
YODA_CLAUDE_FALLBACK_MODELS=claude-haiku-4-5
YODA_SANDBOX=auto              # auto (recommended) or off
```

## Adding a cron task

```bash
cp cron-tasks/_template.sh cron-tasks/my-task.sh
chmod +x cron-tasks/my-task.sh
# Edit the PROMPT and CRON_MODEL in the script
# Then create systemd units from the templates in systemd/
```

Or just ask your bot: *"Write a cron that does X every morning at 7am"* — it'll create the script and tell you the systemd commands to run.

See `cron-tasks/_template.sh` for the full pattern including per-cron model selection.

## Adding a surface

Create `workspace/lib/surfaces/<name>.js` implementing the surface contract (see `lib/surface.js` for the interface). Then add `<name>` to `YODA_SURFACES` in `.env` and restart the service.

## Important notes

- **Claude Max subscription required.** YodaCode uses `claude -p` (headless Claude Code) which authenticates via your subscription OAuth token. No API key needed.
- **Quota usage.** Each reply = 1 turn against your Max 5-hour limit. Extended thinking uses more quota per turn. Cron tasks add up. Monitor at `claude.ai/settings/usage`.
- **Linux only.** The installer assumes systemd and bubblewrap. macOS users can run `node workspace/yoda.js` manually (sandbox uses Seatbelt on macOS).
- **Personal use.** Designed for one person on one server. Not multi-tenant.

## License

MIT
