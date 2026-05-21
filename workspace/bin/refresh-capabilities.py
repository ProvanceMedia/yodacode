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

import os
import re
import sys
from datetime import datetime, timezone

# ROOT = workspace/ (one level up from bin/ where this script lives)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "bin")
ENV = os.path.join(ROOT, "..", ".env")
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
    "DO_PROD_TOKEN":    ("Infra", "DigitalOcean (prod)", "https://api.digitalocean.com/v2", "Authorization: Bearer $DO_PROD_TOKEN", "⚠️ ALWAYS ask Stu before ANY write action. Read-only lookups fine."),
    "DO_TEST_TOKEN":    ("Infra", "DigitalOcean (test)", "https://api.digitalocean.com/v2", "Authorization: Bearer $DO_TEST_TOKEN", "Test account."),
    "DO_BILLING_TOKEN": ("Infra", "DigitalOcean (billing)", "https://api.digitalocean.com/v2", "Authorization: Bearer $DO_BILLING_TOKEN", ""),
    "TAILSCALE_API_KEY":("Infra", "Tailscale",   "https://api.tailscale.com/api/v2", "Basic auth: $TAILSCALE_API_KEY: (colon, no password)", "/tailnet/-/devices, /tailnet/-/status. Key expires every 90 days."),
    "GITHUB_PAT":       ("Infra", "GitHub",      "https://api.github.com",        "Authorization: Bearer $GITHUB_PAT",  "Your repos."),
    "BACKBLAZE_KEY_ID": ("Infra", "Backblaze B2 (key id)", "(see B2 docs)",       "$BACKBLAZE_KEY_ID + $BACKBLAZE_API_KEY", "Used with $BACKBLAZE_API_KEY."),
    "BACKBLAZE_API_KEY":("Infra", "Backblaze B2 (key)",    "(see B2 docs)",       "$BACKBLAZE_KEY_ID + $BACKBLAZE_API_KEY", ""),

    # ─── Content / Marketing ───────────────────────────────────────────
    "SANITY_TOKEN":            ("Content", "Sanity CMS",      "https://m158eta3.api.sanity.io/v2024-01-01/data", "Authorization: Bearer $SANITY_TOKEN", "Project m158eta3, dataset production. /query/production for reads, /mutate/production for writes."),
    "SE_RANKING_DATA_API_KEY": ("Content", "SE Ranking (data)","https://api.seranking.com/v1",   "$SE_RANKING_DATA_API_KEY", "Data API. Use web_fetch — curl hangs."),
    "SE_RANKING_PROJECT_TOKEN":("Content", "SE Ranking (project)","https://api4.seranking.com",  "$SE_RANKING_PROJECT_TOKEN", "Project API, free tier."),
    "MAKE_API_KEY":            ("Content", "Make.com",        "(per-scenario webhooks)",        "$MAKE_API_KEY",                  "Letter workflow webhook: hook.eu1.make.com/m3ftsa7cftrgfk1173s9wbg8b2ngsnfw"),
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
    "SLACK_BOT_TOKEN":  ("Slack",  "Slack bot token",  "(via bin/slack-tools.sh)", "internal", "Yoda's own Slack app — use ./bin/slack-tools.sh, not direct curl."),
    "SLACK_APP_TOKEN":  ("Slack",  "Slack app token",  "", "internal", "Socket mode connection. Not used directly."),
    "SLACK_SIGNING_SECRET": ("Slack", "Slack signing secret", "", "", "Webhook verification. Not used in socket mode."),
    "SLACK_TEST_CHANNEL_ID":("Slack","Test channel ID","", "", "#yoda-test channel id."),

    # ─── Yoda own ─────────────────────────────────────────────────
    "CLAUDE_CODE_OAUTH_TOKEN": ("Auth", "Claude Code OAuth", "(internal)", "internal", "Stu's Max sub OAuth token. NEVER expose. Routes Yoda's own claude -p calls to the sub instead of API billing."),
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


def main() -> int:
    present = parse_env(ENV)
    tools = scan_tools(BIN)

    # Group services by category for output
    groups: dict[str, list[tuple[str, str, str, str, str]]] = {}
    uncategorised: list[str] = []
    for k in sorted(present):
        if k in SERVICE_MAP:
            cat, name, base, auth, notes = SERVICE_MAP[k]
            groups.setdefault(cat, []).append((k, name, base, auth, notes))
        else:
            uncategorised.append(k)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    out = []
    out.append("# CAPABILITIES.md — Yoda")
    out.append("")
    out.append(f"*Auto-generated on {today}. Two sources: `@yoda-tool` manifests in `workspace/bin/*`, and `SERVICE_MAP` × `../.env`. Re-runs on every yoda startup via `refresh-capabilities.py`. Do not hand-edit.*")
    out.append("")
    out.append("This is the **source of truth** for what Yoda can do right now. If a service is listed here, you have the credentials and you should use them when relevant. If a service is NOT listed here, you do not have access — say so honestly.")
    out.append("")
    out.append("## Built-in (no env var needed)")
    out.append("")
    out.append("- ✅ **Bash, Read, Write, Edit, WebFetch, Glob, Grep** — full local FS and HTTP access via the standard tool list")
    out.append("- ✅ **Task subagents** (`general-purpose`, `Explore`, `Plan`) — for parallel work and context-protected research")
    out.append("- ✅ **File-based memory** — read both canonical Codi MEMORY.md and own MEMORY.md every tick; write only to own")
    out.append("- ✅ **Slack I/O** — via `./slack-tools.sh` (handled automatically by the loop wrapper for interactive replies)")
    out.append("- ✅ **Live status streaming** — `claude --output-format stream-json` piped through `lib/stream-translator.js` updates the placeholder in real time")
    out.append("- ✅ **SSH to your-server** — via `ssh -F .ssh/config your-server`")
    out.append("- ✅ **Browser automation** — Playwright + headless Chromium via `./bin/browser-tools.sh` (`fetch`, `text`, `screenshot`, `maps`, `street-view`, `script`). Use for JS-rendered pages, Google Maps address verification, and any flow needing real DOM rendering. Screenshots are saved to `/tmp/yoda-*.png` and you can `Read` them to visually analyse the image.")
    out.append("- ❌ **No native MCP servers** (browser, slack, hubspot plugins) — replicate via raw HTTP curls or `./bin/browser-tools.sh`")
    out.append("- ❌ **No `image_generate`, `image`, `pdf`, `web_search`, `tts` tools** — those were OpenClaw plugin tools. Use OpenAI APIs via curl instead.")
    out.append("")
    primary = os.environ.get("YODA_CLAUDE_MODEL") or "claude-sonnet-4-6 (Claude Code default)"
    fallbacks_csv = os.environ.get("YODA_CLAUDE_FALLBACK_MODELS") or "claude-haiku-4-5"
    fallbacks = [m.strip() for m in fallbacks_csv.split(",") if m.strip()]
    out.append("## Model fallback chain")
    out.append("")
    out.append(f"- **Primary:** `{primary}`")
    if fallbacks:
        out.append(f"- **Fallback:** `{' → '.join(fallbacks)}` (auto-tried by the dispatcher when the primary returns 529 / `overloaded_error`)")
    else:
        out.append("- **Fallback:** none configured")
    out.append("")
    out.append("**This is your real model fallback chain.** If a user asks what you'll fall back to, this is the answer — NOT Groq. Groq is only available as a direct curl target via `$GROQ_API_KEY` for completion calls when you explicitly want it. Yoda's automatic fallback is whatever is in `YODA_CLAUDE_FALLBACK_MODELS`.")
    out.append("")

    out.extend(render_tools_section(tools, present))

    out.append("## Services by env var")
    out.append("")
    out.append("Raw HTTP APIs available via curl. Auth headers and base URLs documented here so you don't have to grep TOOLS.md.")
    out.append("")
    for cat in ["AI", "Google", "Business", "CRM", "Money", "Infra", "Content", "Commerce", "Personal", "Slack", "Auth"]:
        if cat not in groups:
            continue
        out.append(f"## {cat}")
        out.append("")
        out.append("| Env var | Service | Base URL | Auth | Notes |")
        out.append("|---|---|---|---|---|")
        for k, name, base, auth, notes in sorted(groups[cat]):
            base_md = base.replace("|", "\\|") if base else ""
            auth_md = auth.replace("|", "\\|") if auth else ""
            notes_md = notes.replace("|", "\\|") if notes else ""
            out.append(f"| `${k}` | {name} | {base_md} | {auth_md} | {notes_md} |")
        out.append("")

    if uncategorised:
        out.append("## Uncategorised env vars")
        out.append("")
        out.append("These keys are present in `.env` but not in `refresh-capabilities.py`'s `SERVICE_MAP`. They may still be usable — check `TOOLS.md` before claiming they don't work.")
        out.append("")
        for k in uncategorised:
            out.append(f"- `${k}`")
        out.append("")

    out.append("---")
    out.append("")
    out.append("## Honesty rules")
    out.append("")
    out.append("- **If a tool or service is listed here, you have it.** Don't claim you can't do something that's in this file.")
    out.append("- **If a tool/service is NOT listed here, you don't have it.** Don't pretend you do. Say so honestly and offer the closest alternative.")
    out.append("- **If you discover a new env var or want to register a new tool**, add a `@yoda-tool` manifest block to the script in `workspace/bin/` (or add the env key to `SERVICE_MAP` in `refresh-capabilities.py`). The yoda startup will regenerate this file.")
    out.append("- **If a service IS listed but actually fails**, the credentials may be stale or the upstream may be down. Report the actual error rather than claiming you don't have access.")

    open(OUT, "w").write("\n".join(out) + "\n")
    print(f"wrote {OUT} — {len(tools)} tools + {sum(len(g) for g in groups.values())} known services + {len(uncategorised)} uncategorised")
    return 0


if __name__ == "__main__":
    sys.exit(main())
