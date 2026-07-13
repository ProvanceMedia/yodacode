#!/usr/bin/env python3
"""connect-lib — JSON, validation + OAuth helper behind `yodacode connect` (scripts/connect.sh).

OAuth services (Google et al) can't be set up by pasting one key: they need a
browser consent step and a code→refresh-token exchange. The wizard in
connect.sh drives the prompts; everything security-relevant happens here:

  - The catalog (scripts/service-catalog.json, outside the agent's mounts) is
    the ONLY source of auth mechanics — endpoints, vault key names, scopes.
    Agent-written pending requests may name a catalog provider + services and
    nothing else; a request can never inject a scope string or a token URL.
  - The authorization URL carries a state nonce + PKCE (S256), both held only
    in the wizard process's memory between steps.
  - The code→token exchange and the pre-store smoke tests run here, host-side,
    so a bad sign-in is caught BEFORE anything is written to the vault.

Subcommands (env-driven with CN_* vars, shlex-quoted eval-able output — same
contract as addkey-lib.py; run from anywhere, paths are repo-relative):
  pending-list       one line per valid OAuth pending request:
                     file<TAB>provider<TAB>label<TAB>services-csv
  provider-match <t> resolve user text ("gmail", "google") →
                     "provider[<TAB>service]" on stdout, exit 1 if no match
  resolve            merge pending request + catalog + flags → wizard vars
  auth-url           build the consent URL (state + PKCE) for chosen scopes
  exchange           pasted redirect URL/code → refresh + access token + account
  smoke              pre-store test calls with the fresh access token
  apply              upsert broker/auth-hosts.json + broker/oauth-grants.json
  grants             list recorded grants: provider<TAB>account<TAB>mintedAt<TAB>published<TAB>services
  doctor-plan        provider<TAB>label<TAB>host<TAB>testPath<TAB>account<TAB>mintedAt<TAB>published
                     (one line per connected provider that has a testable service)
"""
import base64
import hashlib
import json
import os
import re
import secrets as pysecrets
import shlex
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG_FILE = os.path.join(ROOT, "scripts", "service-catalog.json")
PENDING_DIR = os.path.join(ROOT, "workspace", "state", "pending-keys")
AUTH_HOSTS = os.path.join(ROOT, "workspace", "broker", "auth-hosts.json")
# Grant metadata (account, scopes, mint time) lives in broker/ — mounted
# read-only into the agent — because it drives what a renewal re-consents to
# and what doctor diagnoses. It must be agent-readable but never agent-writable.
GRANTS_FILE = os.path.join(ROOT, "workspace", "broker", "oauth-grants.json")
ENV_FILE = os.path.join(ROOT, ".env")

DEFAULT_REDIRECT = "http://127.0.0.1:8765"
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")
URL_RE = re.compile(r"^https://[A-Za-z0-9./_#?=&%~+:-]{1,300}$")
# A pasted bare authorization code (Google's look like "4/0Adeu5B…" and run
# 60+ chars). ≥16 chars so a stray word doesn't get sent to the token endpoint
# as a "code"; no scheme, no whitespace.
CODE_RE = re.compile(r"^[A-Za-z0-9._/-]{16,512}$")
# C0 + C1 control bytes and DEL — same rationale as addkey-lib: agent-sourced
# strings reach the operator's terminal via echo -e; strip anything that could
# redraw the consent screen. Backslashes dropped too (echo -e re-expands them).
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def die(msg):
    sys.stderr.write(f"connect: {msg}\n")
    sys.exit(1)


def clean_text(s, limit):
    return CONTROL_RE.sub(" ", str(s)).replace("\\", "").strip()[:limit]


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception as e:
        die(f"could not parse {os.path.relpath(path, ROOT)}: {e}")


def norm(s):
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def providers():
    """All oauth-provider catalog entries, {slug: entry}."""
    cat = load_json(CATALOG_FILE, {})
    if not isinstance(cat, dict):
        return {}
    return {s: e for s, e in cat.items() if isinstance(e, dict) and e.get("kind") == "oauth-provider"}


def provider_entry(slug):
    p = providers().get(slug)
    if not p:
        die(f"unknown OAuth provider {slug!r} (catalog providers: {', '.join(sorted(providers())) or 'none'})")
    # The catalog ships with the repo, but validate the load-bearing fields
    # anyway — a typo here would send credentials to the wrong place.
    for f in ("authUrl", "tokenUrl"):
        if not URL_RE.match(str(p.get(f, ""))):
            die(f"catalog entry {slug}: bad {f}")
    for f in ("clientIdKey", "clientSecretKey", "refreshTokenKey"):
        if not KEY_RE.match(str(p.get(f, ""))):
            die(f"catalog entry {slug}: bad {f}")
    if not isinstance(p.get("services"), dict) or not p["services"]:
        die(f"catalog entry {slug}: no services")
    # Every service must carry ≥1 hostname-shaped host: smoke/doctor/apply all
    # index hosts[0], and a bad catalog edit should die here, not mid-wizard.
    for ssl, svc in p["services"].items():
        hostlist = svc.get("hosts") if isinstance(svc, dict) else None
        if (not isinstance(hostlist, list) or not hostlist
                or not all(isinstance(h, str) and re.fullmatch(r"[a-z0-9.-]+", h) for h in hostlist)):
            die(f"catalog entry {slug}: service {ssl} has a missing or malformed hosts list")
    return p


def match_provider(text):
    """User text → (provider_slug, service_slug|None). Matches provider
    slug/label/aliases first, then any service slug/label/aliases."""
    key = norm(text)
    if not key:
        return None, None
    for slug, p in providers().items():
        names = [slug, p.get("label", "")] + list(p.get("aliases", []))
        if key in {norm(n) for n in names if n}:
            return slug, None
    for slug, p in providers().items():
        for ssl, svc in p.get("services", {}).items():
            names = [ssl, svc.get("label", "")] + list(svc.get("aliases", []))
            if key in {norm(n) for n in names if n}:
                return slug, ssl
    return None, None


def env_values():
    """Non-empty values from .env, parsed the way the broker's vault reads it."""
    out = {}
    try:
        with open(ENV_FILE, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                if line.startswith("export "):
                    line = line[len("export "):].lstrip()
                k, v = line.split("=", 1)
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                out[k.strip()] = v
    except FileNotFoundError:
        pass
    return {k: v for k, v in out.items() if v.strip()}


def read_pending(path):
    """Load one OAuth pending request. Returns dict or None. Agent-written,
    therefore untrusted: only {kind, provider, services, note} are read, and
    provider/services must resolve against the catalog."""
    if os.path.realpath(path).startswith(os.path.realpath(PENDING_DIR) + os.sep) is False:
        return None
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("kind") != "oauth":
        return None
    slug = str(data.get("provider", "")).strip().lower()
    p = providers().get(slug)
    if not p:
        return None
    raw_services = data.get("services")
    if not isinstance(raw_services, list):
        return None
    svcs = []
    for s in raw_services:
        s = str(s).strip().lower()
        if s in p.get("services", {}) and s not in svcs:
            svcs.append(s)
    if not svcs:
        return None
    return {"provider": slug, "services": svcs, "note": clean_text(data.get("note", ""), 160)}


def cmd_pending_list():
    if not os.path.isdir(PENDING_DIR):
        return
    files = [os.path.join(PENDING_DIR, f) for f in os.listdir(PENDING_DIR) if f.endswith(".json")]
    files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    for path in files:
        # Only surface files that declare kind:"oauth" — everything else is
        # addkey's territory (and addkey-lib skips oauth files in turn).
        try:
            with open(path) as f:
                raw = json.load(f)
        except Exception:
            continue
        if not isinstance(raw, dict) or raw.get("kind") != "oauth":
            continue
        data = read_pending(path)
        # The path is emitted raw as the first tab-separated field, so a
        # filename containing a tab/control byte could forge the later columns
        # the operator sees — reject those files outright.
        if data is None or CONTROL_RE.search(os.path.basename(path)) or "\t" in os.path.basename(path):
            sys.stderr.write(f"connect: skipping invalid OAuth request {clean_text(os.path.basename(path), 80)}\n")
            continue
        label = providers()[data["provider"]].get("label", data["provider"])
        print(f"{path}\t{data['provider']}\t{label}\t{','.join(data['services'])}")


def read_grants():
    g = load_json(GRANTS_FILE, {})
    return g if isinstance(g, dict) else {}


def parse_services_env(p, raw, *, required=True):
    """CSV of service slugs from the wizard → validated ordered list."""
    svcs = []
    for s in (raw or "").split(","):
        s = s.strip().lower()
        if not s:
            continue
        if s not in p.get("services", {}):
            die(f"unknown service {s!r} for this provider")
        if s not in svcs:
            svcs.append(s)
    if required and not svcs:
        die("no services selected")
    return svcs


def parse_tiers_env(p, svcs, raw):
    """CSV "gmail=modify,calendar=full" → {slug: tier_key}. Tier keys are
    validated against the catalog; scope strings never travel through env."""
    chosen = {}
    for part in (raw or "").split(","):
        part = part.strip()
        if not part or "=" not in part:
            continue
        s, t = part.split("=", 1)
        s, t = s.strip().lower(), t.strip().lower()
        if s in svcs:
            chosen[s] = t
    out = {}
    for s in svcs:
        tiers = provider_service_tiers(p, s)
        keys = [t["key"] for t in tiers]
        want = chosen.get(s, "")
        if want and want in keys:
            out[s] = want
        else:
            if want:
                die(f"unknown scope tier {want!r} for {s} (one of: {', '.join(keys)})")
            out[s] = default_tier(tiers)
    return out


def provider_service_tiers(p, slug):
    tiers = p["services"][slug].get("scopeTiers")
    if not isinstance(tiers, list) or not tiers:
        die(f"catalog service {slug}: no scopeTiers")
    return tiers


def default_tier(tiers):
    for t in tiers:
        if t.get("default"):
            return t["key"]
    return tiers[0]["key"]


def scopes_for(p, tier_map):
    """Union of catalog scopes for the chosen tiers + the provider's identity
    scopes (so the wizard can show which account signed in)."""
    scopes = []
    for s, tkey in tier_map.items():
        for t in provider_service_tiers(p, s):
            if t["key"] == tkey:
                for sc in t.get("scopes", []):
                    if sc not in scopes:
                        scopes.append(sc)
    for sc in p.get("identityScopes", []):
        if sc not in scopes:
            scopes.append(sc)
    return scopes


def tier_label(p, svc, tkey, *, bare=False):
    """Tier's human label; bare=True drops the '(recommended)' prompt marker
    for contexts like auth-hosts notes and CAPABILITIES."""
    for t in provider_service_tiers(p, svc):
        if t["key"] == tkey:
            label = t.get("label", tkey)
            return re.sub(r"\s*\(recommended\)", "", label) if bare else label
    return tkey


def emit(out):
    for k, v in out.items():
        print(f"{k}={shlex.quote(str(v))}")


# ───────────────────────── resolve ─────────────────────────

def cmd_resolve():
    env = os.environ
    warnings = []
    pending_file = env.get("CN_PENDING_FILE", "")
    slug = env.get("CN_PROVIDER", "").strip().lower()
    svc_hint = []

    if pending_file:
        data = read_pending(pending_file)
        if data is None:
            die(f"pending OAuth request {pending_file} is missing or invalid")
        slug = data["provider"]
        svc_hint = data["services"]

    if not slug:
        die("no provider named")
    if not SLUG_RE.match(slug):
        die(f"bad provider name {slug!r}")
    p = provider_entry(slug)

    # Explicit --services beats the pending request's list.
    if env.get("CN_SERVICES", "").strip():
        svc_hint = parse_services_env(p, env["CN_SERVICES"])

    vals = env_values()
    grants = read_grants().get(slug) or {}
    grant_services = grants.get("services") if isinstance(grants.get("services"), dict) else {}
    # Previously-connected services stay selected: installed-app OAuth has no
    # incremental consent, so every sign-in must re-request the full union or
    # the older services silently lose access.
    selected = [s for s in p["services"] if s in grant_services or s in svc_hint]

    out = {
        "CN_OK": "1",
        "CN_PROVIDER": slug,
        "CN_PROVIDER_LABEL": p.get("label", slug),
        "CN_CLIENT_ID_KEY": p["clientIdKey"],
        "CN_CLIENT_SECRET_KEY": p["clientSecretKey"],
        "CN_REFRESH_TOKEN_KEY": p["refreshTokenKey"],
        "CN_CLIENT_ID_PATTERN": p.get("clientIdPattern", ""),
        "CN_SETUP_GUIDE": p.get("setupGuide", ""),
        "CN_REDIRECT_URI": p.get("redirectUri", DEFAULT_REDIRECT),
        "CN_CLIENT_EXISTS": "1" if (vals.get(p["clientIdKey"]) and vals.get(p["clientSecretKey"])) else "",
        "CN_REFRESH_EXISTS": "1" if vals.get(p["refreshTokenKey"]) else "",
        "CN_GRANT_ACCOUNT": clean_text(grants.get("account", ""), 120),
        "CN_GRANT_PUBLISHED": "1" if grants.get("published") else "",
    }

    steps = p.get("setupSteps", [])
    out["CN_SETUP_STEP_COUNT"] = len(steps)
    for i, st in enumerate(steps, 1):
        out[f"CN_SETUP_STEP_{i}_TEXT"] = clean_text(st.get("text", ""), 220)
        u = str(st.get("url", ""))
        out[f"CN_SETUP_STEP_{i}_URL"] = u if URL_RE.match(u) else ""

    slugs = list(p["services"])
    out["CN_SVC_COUNT"] = len(slugs)
    for i, s in enumerate(slugs, 1):
        svc = p["services"][s]
        tiers = provider_service_tiers(p, s)
        out[f"CN_SVC_{i}_SLUG"] = s
        out[f"CN_SVC_{i}_LABEL"] = svc.get("label", s)
        out[f"CN_SVC_{i}_SELECTED"] = "1" if s in selected else ""
        out[f"CN_SVC_{i}_PRIOR_TIER"] = grant_services.get(s, "")
        u = str(svc.get("enableApiUrl", ""))
        out[f"CN_SVC_{i}_ENABLE_URL"] = u if URL_RE.match(u) else ""
        out[f"CN_SVC_{i}_HOST"] = str(svc.get("hosts", [""])[0]).lower()
        out[f"CN_SVC_{i}_TESTPATH"] = str(svc.get("testPath", "")).lstrip("/")
        out[f"CN_SVC_{i}_TIER_COUNT"] = len(tiers)
        # A recorded tier may no longer exist after a catalog update — fall
        # back to the default rather than dead-ending the renewal later.
        prior = grant_services.get(s, "")
        if prior and prior not in {t["key"] for t in tiers}:
            warnings.append(f"{s}: recorded access tier {clean_text(prior, 24)!r} no longer exists — using the default")
            prior = ""
        out[f"CN_SVC_{i}_TIER_DEFAULT"] = prior or default_tier(tiers)
        for j, t in enumerate(tiers, 1):
            out[f"CN_SVC_{i}_TIER_{j}_KEY"] = t["key"]
            out[f"CN_SVC_{i}_TIER_{j}_LABEL"] = t.get("label", t["key"])

    if env.get("CN_RENEW") == "1":
        if not grant_services:
            warnings.append("no previous sign-in recorded — running a full connect instead of a renewal")
        if not out["CN_CLIENT_EXISTS"]:
            warnings.append(f"{p['clientIdKey']}/{p['clientSecretKey']} missing from the vault — the client setup step will run")
    for i, w in enumerate(warnings, 1):
        out[f"CN_WARN_{i}"] = w
    emit(out)


# ───────────────────────── auth-url ─────────────────────────

def cmd_auth_url():
    env = os.environ
    p = provider_entry(env.get("CN_PROVIDER", "").strip().lower())
    svcs = parse_services_env(p, env.get("CN_SERVICES", ""))
    tier_map = parse_tiers_env(p, svcs, env.get("CN_TIERS", ""))
    client_id = env.get("CN_CLIENT_ID", "").strip()
    if not client_id:
        die("auth-url: no client id")
    pattern = str(p.get("clientIdPattern", ""))
    if pattern and not re.search(pattern, client_id):
        # Catches a malformed stored value (e.g. hand-edited .env with stray
        # quotes) before the user burns a browser round-trip on it.
        die(f"the stored {p['clientIdKey']} doesn't look like a {p.get('label', '')} client ID — "
            f"re-run 'yodacode connect {env.get('CN_PROVIDER', '').strip().lower()}' and answer 'n' to reusing the client")

    state = pysecrets.token_urlsafe(24)
    verifier = pysecrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()

    params = {
        "client_id": client_id,
        "redirect_uri": p.get("redirectUri", DEFAULT_REDIRECT),
        "response_type": "code",
        "scope": " ".join(scopes_for(p, tier_map)),
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    for k, v in (p.get("authParams") or {}).items():
        params[str(k)] = str(v)
    hint = env.get("CN_LOGIN_HINT", "").strip()
    if hint:
        params["login_hint"] = hint

    summary = "; ".join(f"{p['services'][s].get('label', s)}: {tier_label(p, s, tier_map[s])}" for s in svcs)
    emit({
        "CN_AUTH_URL": p["authUrl"] + "?" + urllib.parse.urlencode(params),
        "CN_STATE": state,
        "CN_PKCE_VERIFIER": verifier,
        "CN_SCOPE_SUMMARY": summary,
        "CN_TIERS_RESOLVED": ",".join(f"{s}={tier_map[s]}" for s in svcs),
    })


# ───────────────────────── exchange ─────────────────────────

def http_json(url, data=None, bearer=None, timeout=15):
    req = urllib.request.Request(url)
    if bearer:
        req.add_header("Authorization", f"Bearer {bearer}")
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data).encode()
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, body, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": "network", "error_description": str(e)}


def parse_paste(paste, expect_state):
    """The user pastes either the full dead-redirect URL from the address bar
    (preferred — carries the anti-CSRF state we minted) or, as a fallback for
    browsers that truncate it, the bare code. The code is single-use and bound
    to our PKCE verifier either way."""
    paste = paste.strip().strip("'\"")
    if "://" in paste or paste.startswith(("localhost", "127.0.0.1")):
        try:
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(paste).query)
        except Exception:
            return None, "that doesn't parse as a URL — paste the full address-bar URL"
        if q.get("error"):
            err = q["error"][0]
            if err == "access_denied":
                return None, "Google reports you clicked Cancel/Deny on the consent screen — re-open the link and approve"
            return None, f"the sign-in returned an error: {clean_text(err, 60)}"
        code = (q.get("code") or [""])[0]
        state = (q.get("state") or [""])[0]
        if not code:
            return None, "no ?code= in that URL — copy the FULL address-bar URL after the consent screen"
        if state != expect_state:
            return None, "the state token doesn't match this session — re-run and use the freshly printed link"
        return code, None
    # Browsers show the query percent-encoded (Google codes start "4%2F0A…"),
    # so decode before matching; decoded codes contain no '%', so this is safe.
    candidate = urllib.parse.unquote(paste)
    if CODE_RE.match(candidate):
        return candidate, None
    return None, "that doesn't look like a redirect URL or an authorization code"


def cmd_exchange():
    env = os.environ
    p = provider_entry(env.get("CN_PROVIDER", "").strip().lower())
    client_id = env.get("CN_CLIENT_ID", "").strip()
    client_secret = env.get("CN_CLIENT_SECRET", "").strip()
    verifier = env.get("CN_PKCE_VERIFIER", "").strip()
    if not (client_id and client_secret and verifier):
        die("exchange: missing client credentials or PKCE verifier")

    code, perr = parse_paste(env.get("CN_PASTE", ""), env.get("CN_STATE", ""))
    if perr:
        # Always emit BOTH retry flags: the wizard evals each result over the
        # previous one, and a flag left unset here would leave a stale '1'
        # from an earlier failure driving the wrong retry branch.
        emit({"CN_OK": "", "CN_ERROR": perr, "CN_RETRY_PASTE": "1", "CN_RETRY_URL": ""})
        sys.exit(2)

    status, j = http_json(p["tokenUrl"], data={
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code,
        "code_verifier": verifier,
        "redirect_uri": p.get("redirectUri", DEFAULT_REDIRECT),
        "grant_type": "authorization_code",
    })
    if status != 200 or not j.get("access_token"):
        err = str(j.get("error", f"HTTP {status}"))
        desc = clean_text(j.get("error_description", ""), 200)
        hints = {
            "invalid_grant": ("the code expired or was already used (they last ~10 minutes) — "
                              "a fresh sign-in link is needed", "1"),
            "redirect_uri_mismatch": ("your OAuth client is the wrong type — it must be application type "
                                      "'Desktop app'. Create a new Desktop-app client and re-run", ""),
            "invalid_client": ("the client ID or secret is wrong — re-copy both from the Google Cloud "
                               "console and re-run", ""),
            "network": ("couldn't reach the token endpoint — check the server's network and re-try", "1"),
        }
        hint, retry = hints.get(err, (f"token exchange failed: {clean_text(err, 60)}", ""))
        emit({"CN_OK": "", "CN_ERROR": f"{hint}{' — ' + desc if desc and err not in hints else ''}",
              "CN_RETRY_URL": retry, "CN_RETRY_PASTE": ""})
        sys.exit(2)

    refresh = j.get("refresh_token", "")
    if not refresh:
        emit({"CN_OK": "", "CN_ERROR": ("Google returned no refresh token. Revoke the app's access at "
                                        "https://myaccount.google.com/permissions and run the sign-in again"),
              "CN_RETRY_URL": "", "CN_RETRY_PASTE": ""})
        sys.exit(2)

    account = ""
    id_url = p.get("identityUrl", "")
    if URL_RE.match(str(id_url)):
        _, who = http_json(id_url, bearer=j["access_token"], timeout=10)
        account = clean_text(who.get(p.get("identityField", "email"), ""), 120)

    emit({
        "CN_OK": "1",
        "CN_REFRESH_TOKEN": refresh,
        "CN_ACCESS_TOKEN": j["access_token"],
        "CN_ACCOUNT": account,
        "CN_GRANTED_SCOPES": clean_text(j.get("scope", ""), 2000),
    })


# ───────────────────────── smoke ─────────────────────────

def cmd_smoke():
    """Pre-store verification: call each selected service's test endpoint with
    the just-minted ACCESS token, before anything touches the vault. Output:
    slug<TAB>ok|fail|skip<TAB>message. Exit 1 if every testable service failed."""
    env = os.environ
    p = provider_entry(env.get("CN_PROVIDER", "").strip().lower())
    svcs = parse_services_env(p, env.get("CN_SERVICES", ""))
    token = env.get("CN_ACCESS_TOKEN", "")
    if not token:
        die("smoke: no access token")
    tested = failed = 0
    for s in svcs:
        svc = p["services"][s]
        path = str(svc.get("testPath", "")).lstrip("/")
        if not path:
            print(f"{s}\tskip\tno test endpoint — verified by the sign-in itself")
            continue
        tested += 1
        host = svc["hosts"][0]
        status, j = http_json(f"https://{host}/{path}", bearer=token, timeout=12)
        if 200 <= status < 300:
            print(f"{s}\tok\t")
            continue
        failed += 1
        body = json.dumps(j)[:400]
        if "accessNotConfigured" in body or "has not been used in project" in body or "SERVICE_DISABLED" in body:
            print(f"{s}\tfail\tAPI not enabled in your Google Cloud project — open "
                  f"{svc.get('enableApiUrl', 'the API library')} , click Enable, wait ~1 min, re-run")
        elif status == 403:
            print(f"{s}\tfail\tHTTP 403 — {clean_text(j.get('error', {}).get('message', 'permission denied') if isinstance(j.get('error'), dict) else 'permission denied', 140)}")
        else:
            print(f"{s}\tfail\tHTTP {status}")
    sys.exit(1 if tested and failed == tested else 0)


# ───────────────────────── apply ─────────────────────────

def cmd_apply():
    """Write the auth-hosts entries + grant metadata. Called only after the
    exchange and smoke tests succeeded and the vault keys were stored. Hosts
    come from the CATALOG for the validated services — a pending request or
    env var can never point provider credentials at a foreign host."""
    env = os.environ
    slug = env.get("CN_PROVIDER", "").strip().lower()
    p = provider_entry(slug)
    svcs = parse_services_env(p, env.get("CN_SERVICES", ""))
    tier_map = parse_tiers_env(p, svcs, env.get("CN_TIERS", ""))

    hosts = load_json(AUTH_HOSTS, {})
    if not isinstance(hosts, dict):
        hosts = {}
    host_services = {}
    for s in svcs:
        for h in p["services"][s].get("hosts", []):
            host_services.setdefault(str(h).lower(), []).append(s)
    for h, ss in host_services.items():
        existing = hosts.get(h)
        if isinstance(existing, dict) and existing.get("scheme") not in (None, "oauth2"):
            sys.stderr.write(f"connect: replacing the existing {existing.get('scheme')} entry for {h}\n")
        labels = ", ".join(f"{p['services'][s].get('label', s)} ({tier_label(p, s, tier_map[s], bare=True)})" for s in ss)
        hosts[h] = {
            "scheme": "oauth2",
            "tokenUrl": p["tokenUrl"],
            "clientIdKey": p["clientIdKey"],
            "clientSecretKey": p["clientSecretKey"],
            "refreshTokenKey": p["refreshTokenKey"],
            "provider": slug,
            "note": f"{p.get('label', slug)}: {labels} — set up via 'yodacode connect {slug}'"[:200],
        }
    os.makedirs(os.path.dirname(AUTH_HOSTS), exist_ok=True)
    tmp = AUTH_HOSTS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(hosts, f, indent=2)
        f.write("\n")
    os.replace(tmp, AUTH_HOSTS)

    grants = read_grants()
    # If this run couldn't verify the signed-in identity (userinfo hiccup),
    # keep the previously recorded account rather than erasing it — it feeds
    # the account-switch guard and login_hint on every future run.
    prev = grants.get(slug) if isinstance(grants.get(slug), dict) else {}
    grants[slug] = {
        "account": clean_text(env.get("CN_ACCOUNT", ""), 120) or clean_text(prev.get("account", ""), 120),
        "services": tier_map,
        "scopes": [s for s in env.get("CN_GRANTED_SCOPES", "").split() if s][:40],
        "mintedAt": int(time.time()),
        "published": env.get("CN_PUBLISHED", "") == "1",
    }
    tmp = GRANTS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(grants, f, indent=2)
        f.write("\n")
    os.replace(tmp, GRANTS_FILE)


# ───────────────────────── grants / doctor ─────────────────────────

def cmd_grants():
    for slug, g in sorted(read_grants().items()):
        if not isinstance(g, dict):
            continue
        svcs = g.get("services") if isinstance(g.get("services"), dict) else {}
        print(f"{slug}\t{clean_text(g.get('account', ''), 120)}\t{int(g.get('mintedAt', 0) or 0)}"
              f"\t{'1' if g.get('published') else '0'}\t{','.join(f'{s}={t}' for s, t in svcs.items())}")


def cmd_doctor_plan():
    """One line per connected provider. host/testPath are empty when no granted
    service has a cheap test endpoint — doctor still reports the provider then,
    instead of silently skipping it."""
    provs = providers()
    for slug, g in sorted(read_grants().items()):
        p = provs.get(slug)
        if not p or not isinstance(g, dict):
            continue
        svcs = g.get("services") if isinstance(g.get("services"), dict) else {}
        host = path = ""
        for s in svcs:
            svc = p.get("services", {}).get(s)
            if svc and svc.get("testPath"):
                host, path = svc["hosts"][0], str(svc["testPath"]).lstrip("/")
                break
        print(f"{slug}\t{p.get('label', slug)}\t{host}\t{path}"
              f"\t{clean_text(g.get('account', ''), 120)}\t{int(g.get('mintedAt', 0) or 0)}"
              f"\t{'1' if g.get('published') else '0'}")


def cmd_providers_list():
    for slug, p in sorted(providers().items()):
        print(f"{slug}\t{p.get('label', slug)}\t{', '.join(p.get('services', {}))}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "pending-list":
        cmd_pending_list()
    elif cmd == "provider-match":
        slug, svc = match_provider(sys.argv[2] if len(sys.argv) > 2 else "")
        if not slug:
            sys.exit(1)
        print(f"{slug}\t{svc}" if svc else slug)
    elif cmd == "resolve":
        cmd_resolve()
    elif cmd == "auth-url":
        cmd_auth_url()
    elif cmd == "exchange":
        cmd_exchange()
    elif cmd == "smoke":
        cmd_smoke()
    elif cmd == "apply":
        cmd_apply()
    elif cmd == "grants":
        cmd_grants()
    elif cmd == "doctor-plan":
        cmd_doctor_plan()
    elif cmd == "providers-list":
        cmd_providers_list()
    else:
        die(f"unknown subcommand {cmd!r}")


if __name__ == "__main__":
    main()
