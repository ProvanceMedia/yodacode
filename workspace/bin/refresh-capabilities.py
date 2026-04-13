#!/usr/bin/env python3
"""
Yoda capability auto-generator.

Reads ../.env, classifies each key against a known map of services,
and writes ./CAPABILITIES.md as a structured reference of what
Yoda can actually do right now. Run on every loop.sh startup
so the file stays in sync with reality.
"""

import os
import sys
from datetime import datetime

# ROOT = workspace/ (one level up from bin/ where this script lives)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.path.join(ROOT, "..", ".env")
OUT = os.path.join(ROOT, "CAPABILITIES.md")

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

    # Group services by category for output
    groups: dict[str, list[tuple[str, str, str, str, str]]] = {}
    uncategorised: list[str] = []
    for k in sorted(present):
        if k in SERVICE_MAP:
            cat, name, base, auth, notes = SERVICE_MAP[k]
            groups.setdefault(cat, []).append((k, name, base, auth, notes))
        else:
            uncategorised.append(k)

    today = datetime.utcnow().strftime("%Y-%m-%d")

    out = []
    out.append("# CAPABILITIES.md — Yoda")
    out.append("")
    out.append(f"*Auto-generated from `../.env` on {today}. Re-runs on every loop start via `refresh-capabilities.py`. Do not hand-edit — change the script's SERVICE_MAP instead.*")
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
    out.append("**This is your real model fallback chain.** If a user asks what you'll fall back to, this is the answer — NOT Groq. Groq is only available as a direct curl target via `$GROQ_API_KEY` for completion calls when you explicitly want it; the `Role: Fallback model` line in the imported production-Codi `TOOLS.md` is OpenClaw-specific and does NOT describe Yoda. Yoda's automatic fallback is whatever is in `YODA_CLAUDE_FALLBACK_MODELS`.")
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
        out.append("These keys are present in `.env` but not in `refresh-capabilities.py`'s service map. They may still be usable — check `TOOLS.md` or ask Stu before claiming they don't work.")
        out.append("")
        for k in uncategorised:
            out.append(f"- `${k}`")
        out.append("")

    out.append("---")
    out.append("")
    out.append("## Honesty rules")
    out.append("")
    out.append("- **If a service is listed here, you have it.** Don't claim you can't do something that's in this file.")
    out.append("- **If a service is NOT listed here, you don't have it.** Don't pretend you do. Say so honestly and offer the closest alternative.")
    out.append('- **If you discover a new env var that should be here**, run `python3 refresh-capabilities.py` (the loop does this automatically on restart) and tell Stu so he can add it to the SERVICE_MAP if it is not there.')
    out.append("- **If a service IS listed here but actually fails**, the credentials may be stale or the upstream may be down. Report the actual error rather than claiming you don't have access.")

    open(OUT, "w").write("\n".join(out) + "\n")
    print(f"wrote {OUT} — {sum(len(g) for g in groups.values())} known services + {len(uncategorised)} uncategorised")
    return 0


if __name__ == "__main__":
    sys.exit(main())
