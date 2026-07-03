#!/usr/bin/env python3
"""
Yoda capability auto-generator.

Two sources of truth → one CAPABILITIES.md:

1. `@yoda-tool` manifests scanned from `workspace/bin/*` — describes the
   CLI tools Yoda can invoke via Bash.
2. SERVICE_MAP × `.env` — describes which raw HTTP APIs are usable
   right now based on which env vars are present.

Run on every yoda startup so the file stays in sync with reality.
Adding a new tool: drop a manifest block at the top of the script (see
`browser-tools.sh` for the format). No code edit needed.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone

# ROOT = workspace/ (one level up from bin/ where this script lives)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "bin")
ENV = os.path.join(ROOT, "..", ".env")
BROKER_DIR = os.path.join(ROOT, "broker")
OUT = os.path.join(ROOT, "CAPABILITIES.md")

# Files in workspace/bin/ that are NOT user-facing tools (helpers, generators).
SKIP_TOOLS = {
    "refresh-capabilities.py",
}

# (env key → service group, friendly name, base URL, auth header pattern, notes)
SERVICE_MAP: dict[str, tuple[str, str, str, str, str]] = {
    # ─── Anthropic / OpenAI ─────────────────────────────────────────────
    "OPENAI_API_KEY":        ("AI",     "OpenAI",          "https://api.openai.com/v1",                  "Authorization: Bearer $OPENAI_API_KEY",       "STT (gpt-4o-mini-transcribe), TTS (tts-1-hd, voice 'echo'). Use curl, NOT the built-in `tts` tool."),
    "OPENAI_EMBEDDING_KEY":  ("AI",     "OpenAI Embeddings","https://api.openai.com/v1",                 "Authorization: Bearer $OPENAI_EMBEDDING_KEY", "Memory search embeddings (text-embedding-3-small)."),
    "GROQ_API_KEY":          ("AI",     "Groq",            "https://api.groq.com/openai/v1",            "Authorization: Bearer $GROQ_API_KEY",         "Fallback model (openai/gpt-oss-120b, 131K context). OpenAI-compatible."),

    # ─── Google ─────────────────────────────────────────────────────────
    "GOOGLE_OAUTH_CLIENT_ID":      ("Google", "Google OAuth client", "", "", "Used with refresh tokens for Meet/YouTube/AppsScript/Ads."),
    "GOOGLE_OAUTH_CLIENT_SECRET":  ("Google", "Google OAuth secret", "", "", ""),
    "GOOGLE_API_KEY":              ("Google", "Google API key (legacy)", "", "", "Generic key in project 663913023036. ❌ Maps/Places/Geocoding all denied — restricted key, do not use for Maps work. Use $GOOGLE_PLACES_API_KEY instead."),
    "GOOGLE_PLACES_API_KEY":       ("Google", "Google Places API",   "https://maps.googleapis.com/maps/api/place", "?key=$GOOGLE_PLACES_API_KEY",
                                     "Project 663913023036. ✅ WORKS: textsearch (`/textsearch/json?query=...`), findplacefromtext (`/findplacefromtext/json?input=...&inputtype=textquery&fields=name,formatted_address,place_id,rating`). ❌ DENIED: nearbysearch, place details, geocoding (key restriction). Use for: verifying a business exists at an address, resolving a name → place_id + formatted_address + rating. For phone/website/hours fall back to WebFetch on the business website."),
    "GOOGLE_MEET_REFRESH_TOKEN":   ("Google", "Google Meet API",     "https://meet.googleapis.com/v2", "OAuth refresh → access token", "conferenceRecords, participants, transcripts. Read-only. Records expire after 30 days."),
    "GOOGLE_YOUTUBE_REFRESH_TOKEN":("Google", "YouTube Data API",    "https://www.googleapis.com/youtube/v3", "OAuth refresh → access token", "subscriptions, channels, search, videos. Read-only."),
    "GOOGLE_APPS_SCRIPT_REFRESH_TOKEN":("Google","Apps Script API",  "https://script.googleapis.com/v1", "OAuth refresh → access token", "Get/update project content, create project, run function."),
    "GOOGLE_ADS_REFRESH_TOKEN":    ("Google", "Google Ads API",      "https://googleads.googleapis.com", "OAuth refresh → access token", "Needs developer token header too."),
    "GOOGLE_ADS_DEVELOPER_TOKEN":  ("Google", "Google Ads dev token","",                                 "developer-token: $GOOGLE_ADS_DEVELOPER_TOKEN", "Required header for any Ads API call."),

    # ─── Business ──────────────────────────────────────────────────────

    # ─── CRM / Sales ────────────────────────────────────────────────────
    "HUBSPOT_PAT":      ("CRM",   "HubSpot",     "https://api.hubapi.com",        "Authorization: Bearer $HUBSPOT_PAT", "Direct API only — NEVER use Maton/api-gateway. /crm/v3/objects/{contacts,companies,deals}"),
    "OCEAN_IO_API_KEY": ("CRM",   "Ocean.io",    "(see Ocean.io docs)",           "$OCEAN_IO_API_KEY",                  "Company/contact prospecting."),
    "HUNTER_API_KEY":   ("CRM",   "Hunter.io",   "https://api.hunter.io/v2",      "?api_key=$HUNTER_API_KEY",           "Email finder/verifier."),
    "UNIPILE_API_KEY":  ("CRM",   "Unipile (LinkedIn)", "https://api29.unipile.com:15907", "$UNIPILE_API_KEY",          "Profile lookups 100/day, search 1000/day, invites 30/day."),

    # ─── Payments / Banking ─────────────────────────────────────────────
    "STRIPE_API_KEY":   ("Money", "Stripe",      "https://api.stripe.com/v1",     "Authorization: Bearer $STRIPE_API_KEY", "Events, charges, payment intents (read). Powers #payments alerts."),
    "STARLING_TOKEN":   ("Money", "Starling Bank","https://api.starlingbank.com/api/v2", "Authorization: Bearer $STARLING_TOKEN", "Endpoints: /accounts, /feed/account/{uid}/category/{uid}?changesSince={ISO}, /accounts/{uid}/balance"),

    # ─── Infrastructure ────────────────────────────────────────────────
    "DO_PROD_TOKEN":    ("Infra", "DigitalOcean (prod)", "https://api.digitalocean.com/v2", "Authorization: Bearer $DO_PROD_TOKEN", "⚠️ ALWAYS ask before ANY write action. Read-only lookups fine."),
    "DO_TEST_TOKEN":    ("Infra", "DigitalOcean (test)", "https://api.digitalocean.com/v2", "Authorization: Bearer $DO_TEST_TOKEN", "Test account."),
    "DO_BILLING_TOKEN": ("Infra", "DigitalOcean (billing)", "https://api.digitalocean.com/v2", "Authorization: Bearer $DO_BILLING_TOKEN", ""),
    "TAILSCALE_API_KEY":("Infra", "Tailscale",   "https://api.tailscale.com/api/v2", "Basic auth: $TAILSCALE_API_KEY: (colon, no password)", "/tailnet/-/devices, /tailnet/-/status. Key expires every 90 days."),
    "GITHUB_PAT":       ("Infra", "GitHub",      "https://api.github.com",        "Authorization: Bearer $GITHUB_PAT",  "Your repos."),
    "BACKBLAZE_KEY_ID": ("Infra", "Backblaze B2 (key id)", "(see B2 docs)",       "$BACKBLAZE_KEY_ID + $BACKBLAZE_API_KEY", "Used with $BACKBLAZE_API_KEY."),
    "BACKBLAZE_API_KEY":("Infra", "Backblaze B2 (key)",    "(see B2 docs)",       "$BACKBLAZE_KEY_ID + $BACKBLAZE_API_KEY", ""),

    # ─── Content / Marketing ───────────────────────────────────────────
    "SANITY_TOKEN":            ("Content", "Sanity CMS",      "https://<project>.api.sanity.io/v2024-01-01/data", "Authorization: Bearer $SANITY_TOKEN", "Replace <project> with your Sanity project id. /query/production for reads, /mutate/production for writes."),
    "SE_RANKING_DATA_API_KEY": ("Content", "SE Ranking (data)","https://api.seranking.com/v1",   "$SE_RANKING_DATA_API_KEY", "Data API. Use web_fetch — curl hangs."),
    "SE_RANKING_PROJECT_TOKEN":("Content", "SE Ranking (project)","https://api4.seranking.com",  "$SE_RANKING_PROJECT_TOKEN", "Project API, free tier."),
    "MAKE_API_KEY":            ("Content", "Make.com",        "(per-scenario webhooks)",        "$MAKE_API_KEY",                  "Automation platform. Webhook URLs are per-scenario."),
    "BRAVE_API_KEY":           ("Content", "Brave Search",    "https://api.search.brave.com/res/v1", "X-Subscription-Token: $BRAVE_API_KEY", "Web search alternative."),
    "BRAVE_SEARCH_API_KEY":    ("Content", "Brave Search (alt key)","",                          "X-Subscription-Token: $BRAVE_SEARCH_API_KEY", ""),
    "COMPANIES_HOUSE_API_KEY": ("Content", "Companies House", "https://api.company-information.service.gov.uk", "Basic auth: $COMPANIES_HOUSE_API_KEY:", "UK company filings/officers/registered addresses."),

    # ─── Commerce ──────────────────────────────────────────────────────
    "SHOPIFY_ACCESS_TOKEN": ("Commerce", "Shopify Admin API", "https://$SHOPIFY_SHOP_NAME.myshopify.com/admin/api/$SHOPIFY_API_VERSION", "X-Shopify-Access-Token: $SHOPIFY_ACCESS_TOKEN", ""),
    "SHOPIFY_API_VERSION":  ("Commerce", "Shopify version pin", "", "", ""),
    "SHOPIFY_SHOP_NAME":    ("Commerce", "Shopify shop name", "", "", ""),

    # ─── Personal / Smart Home ─────────────────────────────────────────
    "RING_REFRESH_TOKEN":   ("Personal", "Ring (doorbell/cameras)", "(via ring-client-api)", "OAuth refresh", "Personal smart home."),

    # ─── Slack (own app) ───────────────────────────────────────────────
    "SLACK_BOT_TOKEN":  ("Slack",  "Slack bot token",  "(via bin/slack-tools.sh)", "internal", "Use ./bin/slack-tools.sh, not direct curl."),
    "SLACK_APP_TOKEN":  ("Slack",  "Slack app token",  "", "internal", "Socket mode connection. Not used directly."),
    "SLACK_SIGNING_SECRET": ("Slack", "Slack signing secret", "", "", "Webhook verification. Not used in socket mode."),
    "SLACK_TEST_CHANNEL_ID":("Slack","Test channel ID","", "", "Test channel id (optional)."),

    # ─── Auth ──────────────────────────────────────────────────────
    "CLAUDE_CODE_OAUTH_TOKEN": ("Auth", "Claude Code OAuth", "(internal)", "internal", "Claude Code Max-sub OAuth token. NEVER expose. Routes agent runs to the subscription instead of API billing."),
}


# ───────────────────────── manifest scanner ─────────────────────────

MANIFEST_KEYS = {"name", "summary", "tags", "requires", "usage", "examples"}
COMMENT_PREFIX = re.compile(r"^\s*(#|//|--)\s?")
KEY_LINE = re.compile(r"^(\w+):\s*(.*)$")


def strip_comment(line: str) -> str:
    return COMMENT_PREFIX.sub("", line.rstrip("\n"))


def parse_manifest(filepath: str) -> dict | None:
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            lines = [f.readline() for _ in range(120)]
    except OSError:
        return None
    in_block = False
    body: list[str] = []
    for raw in lines:
        stripped = strip_comment(raw)
        if "@yoda-tool" in stripped:
            in_block = True
            continue
        if "@end" in stripped and in_block:
            in_block = False
            break
        if in_block:
            body.append(stripped)
    if not body:
        return None
    manifest: dict = {}
    current: str | None = None
    for line in body:
        m = KEY_LINE.match(line) if not line.startswith((" ", "\t")) else None
        if m and m.group(1) in MANIFEST_KEYS:
            key, value = m.group(1), m.group(2).strip()
            manifest[key] = value if value else []
            current = key
        elif current is not None and line.strip():
            existing = manifest.get(current)
            if isinstance(existing, list):
                existing.append(line.lstrip())
            elif existing:
                manifest[current] = [existing, line.lstrip()]
            else:
                manifest[current] = [line.lstrip()]
    for k in ("tags", "requires"):
        v = manifest.get(k)
        if isinstance(v, str):
            manifest[k] = [t.strip() for t in v.split(",") if t.strip()]
        elif v is None:
            manifest[k] = []
    if "name" not in manifest or "summary" not in manifest:
        return None
    return manifest


def scan_tools(bin_dir: str) -> list[dict]:
    tools: list[dict] = []
    if not os.path.isdir(bin_dir):
        return tools
    for entry in sorted(os.listdir(bin_dir)):
        if entry in SKIP_TOOLS:
            continue
        path = os.path.join(bin_dir, entry)
        if not os.path.isfile(path):
            continue
        manifest = parse_manifest(path)
        if manifest:
            manifest["_filename"] = entry
            tools.append(manifest)
    return tools


def render_tools_section(tools: list[dict], present_keys: set[str]) -> list[str]:
    if not tools:
        return []
    out = ["## Yoda CLI tools (`workspace/bin/`)", ""]
    out.append("Auto-discovered from `@yoda-tool` manifest blocks in each script. To add a new tool: drop one in `workspace/bin/` with a manifest block at the top — it shows up here on the next yoda restart.")
    out.append("")
    groups: dict[str, list[dict]] = {}
    for t in tools:
        tag = (t.get("tags") or ["misc"])[0]
        groups.setdefault(tag, []).append(t)
    for tag in sorted(groups):
        out.append(f"### {tag}")
        out.append("")
        for t in groups[tag]:
            name = t["name"]
            summary = t["summary"]
            requires = t.get("requires", [])
            missing = [k for k in requires if k not in present_keys]
            if not requires or not missing:
                head = f"- ✅ **`{name}`** — {summary}"
            else:
                missing_str = ", ".join("`$" + k + "`" for k in missing)
                head = f"- ❌ **`{name}`** *(missing {missing_str})* — {summary}"
            out.append(head)
            usage = t.get("usage")
            if isinstance(usage, list) and usage:
                out.append("  ```")
                for line in usage:
                    out.append(f"  {line.rstrip()}")
                out.append("  ```")
            elif isinstance(usage, str) and usage:
                out.append(f"  `{usage}`")
            examples = t.get("examples")
            if isinstance(examples, list) and examples:
                out.append("  *Examples:*")
                for ex in examples:
                    out.append(f"  - `{ex.rstrip()}`")
            elif isinstance(examples, str) and examples:
                out.append(f"  *Example:* `{examples}`")
        out.append("")
    return out


# ───────────────────────── env scanner ─────────────────────────


def parse_env(path: str) -> set[str]:
    keys = set()
    if not os.path.exists(path):
        return keys
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k = line.split("=", 1)[0].strip()
        if k:
            keys.add(k)
    return keys


def load_broker_services() -> tuple[list[tuple[str, str, str]], list[tuple[str, str]]]:
    """Read the broker registry (the real source of truth for what services this
    agent can reach). Returns (hosts, services) where hosts = (host, scheme, vaultKey)
    and services = (name, description). Empty if the broker isn't configured here."""
    hosts: list[tuple[str, str, str]] = []
    services: list[tuple[str, str]] = []
    try:
        ah = os.path.join(BROKER_DIR, "auth-hosts.json")
        if os.path.exists(ah):
            for host, cfg in sorted(json.load(open(ah)).items()):
                if isinstance(cfg, dict):
                    hosts.append((host, cfg.get("scheme", "?"), cfg.get("vaultKey", "?")))
    except Exception:
        pass
    try:
        sp = os.path.join(BROKER_DIR, "services.policy.json")
        if os.path.exists(sp):
            for name, cfg in sorted(json.load(open(sp)).items()):
                services.append((name, cfg.get("description", "") if isinstance(cfg, dict) else ""))
    except Exception:
        pass
    return hosts, services


def main() -> int:
    tools = scan_tools(BIN)
    hosts, services = load_broker_services()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    out = []
    out.append("# CAPABILITIES.md")
    out.append("")
    out.append(f"*Auto-generated on {today} from `@yoda-tool` manifests in `bin/*` and the broker registry "
               "(`broker/auth-hosts.json`, `broker/services.policy.json`). Re-runs on every startup. Do not hand-edit.*")
    out.append("")
    out.append("This lists what you can do right now. Service API keys are held by the **broker**, not by you — "
               "you reach every external API through `broker call` (see the Services section). For the live, "
               "authoritative list at any moment, run `broker manifest`.")
    out.append("")
    out.append("## Built-in (always available)")
    out.append("")
    out.append("- ✅ **Bash, Read, Write, Edit, WebFetch, WebSearch, Glob, Grep** — full local FS, HTTP, native web search")
    out.append("- ✅ **Task subagents** (`general-purpose`, `Explore`, `Plan`) — parallel work, context-protected research")
    out.append("- ✅ **File-based memory** — `MEMORY.md` auto-loaded each tick; `memory/` searched on demand via `memory-search.sh`")
    out.append("- ✅ **Slack** — the wrapper handles your interactive replies; for cron/other contexts use `./bin/slack-tools.sh` (routes through the broker)")
    out.append("- ✅ **Browser automation** — Playwright + headless Chromium via `./bin/browser-tools.sh` (`fetch`, `text`, `screenshot`, `script`). Screenshots save to `/tmp/`; `Read` them to view.")
    out.append("- ❌ **No native MCP servers** — use `broker call http_call` for APIs, or `./bin/browser-tools.sh`")
    out.append("- ❌ **No native `image_generate`, `pdf`, or `tts` tools** — call the relevant API through the broker when needed")
    out.append("")
    primary = os.environ.get("YODA_CLAUDE_MODEL") or "claude-sonnet-4-6 (Claude Code default)"
    fallbacks_csv = os.environ.get("YODA_CLAUDE_FALLBACK_MODELS") or "claude-haiku-4-5"
    fallbacks = [m.strip() for m in fallbacks_csv.split(",") if m.strip()]
    out.append("## Model fallback chain")
    out.append("")
    out.append(f"- **Primary:** `{primary}`")
    out.append(f"- **Fallback:** `{' → '.join(fallbacks)}` (auto-tried on 529 / `overloaded_error`)" if fallbacks
               else "- **Fallback:** none configured")
    out.append("")

    out.extend(render_tools_section(tools, set()))

    out.append("## Services (via the broker)")
    out.append("")
    out.append("Reach these through the broker — it injects the credential host-side; you never see the key. "
               "You have NO API keys in your environment, so a raw `curl -H \"Authorization: Bearer $KEY\"` will not work.")
    out.append("")
    if hosts:
        out.append("**Hosts** — `broker call http_call '{\"host\":\"<host>\",\"path\":\"<path>\",\"method\":\"GET\",\"query\":\"k=v\"}'`")
        out.append("")
        out.append("| Host | Auth (handled for you) |")
        out.append("|---|---|")
        for host, scheme, _vk in hosts:
            out.append(f"| `{host}` | {scheme} |")
        out.append("")
    if services:
        out.append("**Named services** — `broker call <name> '{...}'`")
        out.append("")
        for name, desc in services:
            out.append(f"- `{name}` — {desc}" if desc else f"- `{name}`")
        out.append("")
    if not hosts and not services:
        out.append("_No services configured yet._ The operator adds them on the server with `./quickstart.sh addkey` "
                   "(or by editing `broker/auth-hosts.json` + `.env`). Until then, use the built-in tools above. "
                   "If a user asks for a service that isn't listed, tell them to run `/yodacode` in Slack — it explains how to add one.")
        out.append("")

    out.append("---")
    out.append("")
    out.append("## Honesty rules")
    out.append("")
    out.append("- **If a tool or service is listed here, you have it.** Use it; don't claim you can't.")
    out.append("- **If a service is NOT listed, you don't have it yet.** Say so, and tell the user they can add it by running `/yodacode` in Slack (which points to `./quickstart.sh addkey` on the server). Do NOT tell them to edit `.env`, `SERVICE_MAP`, or run `systemctl` — that is not how this works.")
    out.append("- **If a listed service fails**, the key may be stale or upstream down. Report the actual error rather than claiming no access.")

    open(OUT, "w").write("\n".join(out) + "\n")
    print(f"wrote {OUT} — {len(tools)} tools + {len(hosts)} broker hosts + {len(services)} broker services")
    return 0


if __name__ == "__main__":
    sys.exit(main())
