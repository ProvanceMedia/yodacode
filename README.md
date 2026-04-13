# YodaCode

Personal Claude-Code-powered chat agent for Slack, WhatsApp, and beyond.

Runs entirely on your **Claude Max subscription** - no API key billing.
One command to install. DM your bot 3 minutes later.

## What is this?

YodaCode is a self-hosted personal AI agent that:

- **Lives on your server** as a Node.js process (systemd-managed)
- **Connects to Slack** via Socket Mode (real-time, no polling)
- **Connects to WhatsApp** via Baileys (optional, links to your existing account)
- **Runs Claude Code** (`claude -p`) for every reply, with full tool access (Bash, Read, Write, Edit, WebFetch, browser automation, subagents)
- **Remembers things** via a structured file-based memory system with daily consolidation
- **Runs scheduled tasks** (cron jobs) via systemd timers
- **Streams live status** - you see what the agent is doing in real time as the placeholder message updates
- **Falls back automatically** - if the primary model (Sonnet) is throttled, tries the next model in the chain (Haiku)
- **Includes a web dashboard** for status, cron management, log streaming, and file editing

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
4. systemd service installation

3 minutes later, DM your bot in Slack.

## Architecture

```
                    ┌──────────────┐
                    │   Slack API   │
                    │ (Socket Mode) │
                    └──────┬───────┘
                           │ real-time events
                    ┌──────▼───────┐
                    │   yoda.js    │ ← Node.js coordinator
                    │  (surfaces)  │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
     ┌────────▼──┐  ┌──────▼─────┐  ┌──▼──────────┐
     │ dispatcher │  │ stop-handler│  │ queue (serial│
     │ (policy +  │  │ (kill mid- │  │  per-convo   │
     │  context)  │  │  tick)     │  │  + coalesce) │
     └────────┬───┘  └────────────┘  └──────────────┘
              │
     ┌────────▼───────────────────────────┐
     │          claude-runner              │
     │  spawn claude -p --stream-json     │
     │  ├─ stream-translator (live status)│
     │  ├─ model fallback (529 → Haiku)   │
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
| **Extended thinking** | `--thinking enabled` for better reasoning |
| **Browser automation** | Playwright for JS-rendered pages, Google Maps verification |
| **Subagents** | `Task` tool for parallel work and context protection |
| **Stop command** | Type "stop" to kill an in-flight reply cleanly |
| **Web dashboard** | Status, crons, live logs, file editing. Basic auth. |
| **Auto-capabilities** | `CAPABILITIES.md` auto-generated from `.env` so the agent never lies |

## Configuration

All configuration is via `.env`. See `.env.example` for the full list with documentation.

Key variables:

```bash
CLAUDE_CODE_OAUTH_TOKEN=       # from `claude setup-token`
SLACK_BOT_TOKEN=               # from your Slack app
SLACK_APP_TOKEN=               # from your Slack app
YODA_DM_AUTHORIZED_USERS=     # comma-separated Slack user IDs
YODA_CLAUDE_FALLBACK_MODELS=claude-haiku-4-5
```

## Adding a cron task

```bash
cp cron-tasks/_template.sh cron-tasks/my-task.sh
chmod +x cron-tasks/my-task.sh
# Edit the PROMPT and CRON_MODEL in the script
# Then create systemd units from the templates in systemd/
```

See `cron-tasks/_template.sh` for the full pattern including per-cron model selection.

## Adding a surface

Create `workspace/lib/surfaces/<name>.js` implementing the surface contract (see `lib/surface.js` for the interface). Then add `<name>` to `YODA_SURFACES` in `.env`.

## Important notes

- **Claude Max subscription required.** YodaCode uses `claude -p` (headless Claude Code) which authenticates via your subscription OAuth token. No API key needed.
- **Quota usage.** Each reply = 1 turn against your Max 5-hour limit. Cron tasks add up. Monitor at `claude.ai/settings/usage`.
- **Linux only.** The installer assumes systemd. macOS users can run `node workspace/yoda.js` manually.
- **Personal use.** Designed for one person on one server. Not multi-tenant.

## License

MIT
