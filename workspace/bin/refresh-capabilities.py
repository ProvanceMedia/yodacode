#!/usr/bin/env python3
"""
Yoda capability auto-generator.

Two sources of truth → one CAPABILITIES.md:

1. `@yoda-tool` manifests scanned from `workspace/bin/*` — describes the
   CLI tools Yoda can invoke via Bash.
2. The broker registry (`broker/auth-hosts.json` + `broker/services.policy.json`)
   — describes which authenticated HTTP hosts/services are configured right now.

Run on every yoda startup so the file stays in sync with reality.
Adding a new tool: drop a manifest block at the top of the script (see
`browser-tools.sh` for the format). No code edit needed.
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

# ROOT = workspace/ (one level up from bin/ where this script lives)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "bin")
BROKER_DIR = os.path.join(ROOT, "broker")
OUT = os.path.join(ROOT, "CAPABILITIES.md")

# Files in workspace/bin/ that are NOT user-facing tools (helpers, generators).
SKIP_TOOLS = {
    "refresh-capabilities.py",
}


# ───────────────────────── manifest scanner ─────────────────────────

MANIFEST_KEYS = {"name", "summary", "tags", "requires", "usage", "examples", "probe", "install"}
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


_probe_cache: dict[str, bool] = {}


def run_probe(tool: dict) -> bool:
    """Run a manifest's optional `probe:` command (cwd = workspace root).

    Exit 0 → the tool is genuinely usable right now. No probe → assume usable
    (the requires: env-key check has already passed). Probes must be cheap and
    side-effect-free — they run on every agent startup. Results are memoized by
    probe string so the same check (e.g. the browser probe, used by both the
    Built-in section and the tools section) runs once per generation.
    """
    probe = tool.get("probe")
    if not probe:
        return True
    if isinstance(probe, list):
        probe = " ".join(probe)
    if probe in _probe_cache:
        return _probe_cache[probe]
    try:
        r = subprocess.run(probe, shell=True, cwd=ROOT, timeout=15,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        result = r.returncode == 0
    except Exception:
        result = False
    _probe_cache[probe] = result
    return result


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
            if missing:
                missing_str = ", ".join("`$" + k + "`" for k in missing)
                head = f"- ❌ **`{name}`** *(missing {missing_str})* — {summary}"
            elif not run_probe(t):
                # A tool with a failing probe is NOT available — advertising it
                # would make the agent claim capabilities it can't deliver.
                hint = t.get("install") or "see the tool's script header"
                if isinstance(hint, list):
                    hint = " ".join(hint)
                head = f"- ❌ **`{name}`** *(not installed — {hint})* — {summary}"
            else:
                head = f"- ✅ **`{name}`** — {summary}"
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


# ───────────────────────── broker registry ─────────────────────────


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


def load_oauth_grants() -> dict:
    """OAuth sign-in metadata written by `yodacode connect` (account, per-service
    access tier) — lets the agent know Drive is read-only BEFORE a call 403s."""
    try:
        gf = os.path.join(BROKER_DIR, "oauth-grants.json")
        if os.path.exists(gf):
            g = json.load(open(gf))
            if isinstance(g, dict):
                return g
    except Exception:
        pass
    return {}


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
    if run_probe({"probe": "node bin/browser-tool.cjs probe"}):
        out.append("- ✅ **Browser automation** — Playwright + headless Chromium via `./bin/browser-tools.sh` (`fetch`, `text`, `screenshot`, `script`). Screenshots save to `/tmp/`; `Read` them to view.")
    else:
        out.append("- ❌ **Browser automation** *(not installed — the operator can enable it with `yodacode install-browsers`, one-time ~300MB download)* — do NOT claim you can browse, screenshot, or render JS pages until this shows ✅.")
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
    grants = load_oauth_grants()
    if grants:
        out.append("**OAuth sign-ins** — the broker mints access tokens automatically. Check the granted "
                   "access level BEFORE you call; if you need a higher tier, ask the user to re-run "
                   "`yodacode connect <provider>` and pick it.")
        out.append("")
        for prov, g in sorted(grants.items()):
            if not isinstance(g, dict):
                continue
            acct = g.get("account") or "account unknown"
            svcs = g.get("services") if isinstance(g.get("services"), dict) else {}
            svc_str = ", ".join(f"{s}: {t}" for s, t in svcs.items()) or "—"
            out.append(f"- **{prov}** ({acct}) — {svc_str}")
        out.append("")
        out.append("If a call fails with *\"authorization has expired or been revoked\"*, relay that message "
                   "verbatim — the fix is `yodacode connect <provider> --renew` on the server (~2 minutes).")
        out.append("")
    if services:
        out.append("**Named services** — `broker call <name> '{...}'`")
        out.append("")
        for name, desc in services:
            out.append(f"- `{name}` — {desc}" if desc else f"- `{name}`")
        out.append("")
    if not hosts and not services:
        out.append("_No services configured yet._ Until then, use the built-in tools above. "
                   "If a user asks for a service that isn't listed, YOU prepare it: research the service's API auth, "
                   "write a pending request, and walk them through `yodacode addkey` (API keys) or "
                   "`yodacode connect` (OAuth sign-ins like Google) on the server "
                   "(see TOOLS.md → Adding a new service). Secrets are never typed into chat.")
        out.append("")

    out.append("---")
    out.append("")
    out.append("## Honesty rules")
    out.append("")
    out.append("- **If a tool or service is listed here, you have it.** Use it; don't claim you can't.")
    out.append("- **If a service is NOT listed, you don't have it yet.** Say so — then offer to set it up: research its API auth, write a pending request, and have the user run `yodacode addkey` (API keys) or `yodacode connect` (OAuth sign-ins like Google) on the server — see TOOLS.md. Do NOT tell them to edit `.env`, `auth-hosts.json`, or run `systemctl` — that is not how this works.")
    out.append("- **If a listed service fails**, the key may be stale or upstream down. Report the actual error rather than claiming no access.")

    open(OUT, "w").write("\n".join(out) + "\n")
    print(f"wrote {OUT} — {len(tools)} tools + {len(hosts)} broker hosts + {len(services)} broker services")
    return 0


if __name__ == "__main__":
    sys.exit(main())
