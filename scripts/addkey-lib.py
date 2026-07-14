#!/usr/bin/env python3
"""addkey-lib — JSON + validation helper behind `yodacode addkey` (scripts/addkey.sh).

Bash is the wrong tool for JSON, and pending key requests are written by the
AGENT — helpful, but not a trusted config author. Everything it proposes passes
through here: strict regex validation on every security-relevant field, the
built-in catalog (scripts/service-catalog.json, outside the agent's mounts)
overriding auth mechanics for known hosts, and shlex-quoted output so the shell
can safely `eval` what we print.

Subcommands (all read/write repo-relative paths; run from anywhere):
  pending-list                 one line per valid pending request: file<TAB>service<TAB>host<TAB>keyName
  catalog-match <text>         print the catalog slug matching a user-typed name, if any
  catalog-list                 human list of built-in services (for the wizard)
  resolve                      env-driven (AK_*): merge pending + catalog + flags -> eval-able vars
  apply                        env-driven (AK_*): upsert the host entry in broker/auth-hosts.json
  hosts                        list configured hosts (host<TAB>scheme<TAB>vaultKey)
"""
import json
import os
import re
import shlex
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG_FILE = os.path.join(ROOT, "scripts", "service-catalog.json")
PENDING_DIR = os.path.join(ROOT, "workspace", "state", "pending-keys")
AUTH_HOSTS = os.path.join(ROOT, "workspace", "broker", "auth-hosts.json")
ENV_FILE = os.path.join(ROOT, ".env")

SCHEMES = ("bearer", "header", "query", "basic")
# Hostname with an optional :port — some APIs live on non-standard ports
# (e.g. api29.unipile.com:15907). The broker keys auth-hosts.json by the exact
# host[:port] string the agent names in http_call, so both must round-trip.
HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+(:[0-9]{1,5})?$")


def valid_host(host: str) -> bool:
    """HOST_RE plus a real port check when a :port is present. The port must be
    canonical (1-65535, no leading zeros): the exact string becomes the
    auth-hosts.json key, so every accepted spelling must round-trip to the port
    the broker actually connects to."""
    if not HOST_RE.match(host):
        return False
    if ":" in host:
        port_str = host.rsplit(":", 1)[1]
        port = int(port_str)
        return 1 <= port <= 65535 and str(port) == port_str
    return True
KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")
HEADER_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
QPARAM_RE = re.compile(r"^[A-Za-z0-9_.\[\]-]{1,64}$")
# testPath may embed a querystring; no spaces, no backslashes, no scheme.
PATH_RE = re.compile(r"^[A-Za-z0-9/_.\-?=&%+,:@~]{1,512}$")
# No '@': a userinfo segment (https://trusted.com@evil.example) would render a
# phishing link with a trusted-looking prefix on the consent screen.
URL_RE = re.compile(r"^https://[A-Za-z0-9./_#?=&%~+:-]{1,300}$")
HEADER_VALUE_RE = re.compile(r"^[\x20-\x7e]{1,256}$")
# C0 + C1 control bytes (incl. ESC 0x1b) and DEL. Pending requests are written by
# the agent (untrusted); these bytes in a display field would let a poisoned
# request inject ANSI cursor/erase sequences and rewrite the operator's consent
# screen (e.g. forge the "Sends to: <host>" line). Strip them from EVERY
# agent-sourced string that can reach the terminal.
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def die(msg):
    sys.stderr.write(f"addkey: {msg}\n")
    sys.exit(1)


def clean_text(s, limit):
    """Render-safe form of an agent-sourced string. Strips control bytes AND
    backslashes: the shell prints these fields via `echo -e`, which re-expands
    backslash escapes (\\033, \\e, \\x1b, \\n, \\c …) back into real control/ANSI
    sequences — so a literal "\\033[2K" in the JSON would forge the consent screen
    even though it contains no raw control byte. Dropping backslashes neutralises
    every echo -e sink at the source; no legitimate label/hint/note needs one."""
    return CONTROL_RE.sub(" ", str(s)).replace("\\", "").strip()[:limit]


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception as e:
        die(f"could not parse {os.path.relpath(path, ROOT)}: {e}")


def load_catalog():
    cat = load_json(CATALOG_FILE, {})
    return cat if isinstance(cat, dict) else {}


def catalog_match(text):
    """User-typed name -> catalog slug (exact slug/label/alias, case-insensitive)."""
    key = re.sub(r"[^a-z0-9]+", "", (text or "").lower())
    if not key:
        return None
    for slug, entry in load_catalog().items():
        names = [slug, entry.get("label", "")] + list(entry.get("aliases", []))
        if key in {re.sub(r"[^a-z0-9]+", "", n.lower()) for n in names if n}:
            return slug
    return None


def catalog_by_host(host):
    for slug, entry in load_catalog().items():
        if entry.get("host", "").lower() == host:
            return slug, entry
    return None, None


def env_keys():
    """Names in .env that have a non-empty value. Parsed the way the broker's vault
    reads it (strip a leading `export `, unquote the value) so this existence check
    agrees with what the vault actually holds — otherwise `export FOO=…` would be
    recorded as key `export FOO` and the existing-key guard would miss it."""
    out = {}
    try:
        # utf-8-sig so a leading BOM doesn't get folded into the first key name
        # (the broker's dotenv parser strips it; match that).
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
    return {k for k, v in out.items() if v.strip()}


def validate_extra_headers(raw, warnings, auth_header):
    """Agent-proposed static headers: printable string->string only, and never
    the header the auth scheme itself writes (the broker would let the literal
    shadow nothing — scheme wins — but a colliding entry is always a mistake)."""
    if not isinstance(raw, dict):
        if raw not in (None, ""):
            warnings.append("ignored extraHeaders (not an object)")
        return {}
    out = {}
    for k, v in raw.items():
        # Warnings are printed via `warn`→`echo -e`; scrub the agent-supplied key
        # (clean_text drops control bytes + backslashes) so a hostile header name
        # can't smuggle an escape sequence into the message. Never use repr() here
        # — it would re-introduce backslash escapes (e.g. '\x1b').
        kd = clean_text(k if isinstance(k, str) else str(k), 40)
        if not (isinstance(k, str) and isinstance(v, str) and HEADER_RE.match(k) and HEADER_VALUE_RE.match(v)):
            warnings.append(f"dropped extra header '{kd}' (invalid name or value)")
            continue
        if k.lower() in {"authorization", (auth_header or "").lower()}:
            warnings.append(f"dropped extra header '{kd}' (collides with the auth header)")
            continue
        out[k] = v
    return out


def read_pending(path):
    """Load + minimally shape one pending request file. Full validation happens
    in resolve(); here we only need it parseable and host/keyName plausible."""
    if os.path.realpath(path).startswith(os.path.realpath(PENDING_DIR) + os.sep) is False:
        return None
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    if data.get("kind") == "oauth":
        # OAuth sign-in requests are connect's territory (scripts/connect-lib.py);
        # addkey neither validates nor lists them.
        return None
    host = str(data.get("host", "")).strip().lower()
    key = str(data.get("keyName", "")).strip().upper()
    if not valid_host(host) or not KEY_RE.match(key):
        return None
    return data


def cmd_pending_list():
    if not os.path.isdir(PENDING_DIR):
        return
    files = [os.path.join(PENDING_DIR, f) for f in os.listdir(PENDING_DIR) if f.endswith(".json")]
    files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    for p in files:
        try:
            with open(p) as f:
                if json.load(f).get("kind") == "oauth":
                    continue  # connect's territory — listed by connect-lib, not here
        except Exception:
            pass
        data = read_pending(p)
        if data is None:
            # Scrub the filename: it is agent-controlled and this diagnostic reaches
            # the terminal (the --list path doesn't 2>/dev/null it) via echo -e/awk.
            sys.stderr.write(f"addkey: skipping invalid pending request {clean_text(os.path.basename(p), 80)}\n")
            continue
        # Never emit an empty service column: it is a TAB-separated field and an
        # empty middle field would collapse under the reader's `IFS=$'\t' read`,
        # shifting host/key into the wrong variables. Fall back to the filename —
        # itself scrubbed, since a filename is agent-controlled and also reaches
        # the terminal via `echo -e`.
        fallback = clean_text(os.path.basename(p)[:-5], 60) or "pending"
        service = clean_text(data.get("service") or "", 60) or fallback
        print(f"{p}\t{service}\t{data['host'].strip().lower()}\t{str(data['keyName']).strip().upper()}")


def cmd_catalog_list():
    cat = load_catalog()
    for slug in sorted(cat):
        e = cat[slug]
        print(f"{slug}\t{e.get('label', slug)}\t{e.get('host', '')}")


SCHEME_DESC = {
    "bearer": "Bearer token (standard Authorization header)",
    "basic": "HTTP Basic (the key is the username)",
}


def scheme_desc(scheme, header_name, query_param):
    if scheme == "header":
        return f"sent in the {header_name} header"
    if scheme == "query":
        return f"sent as a URL parameter (?{query_param}=...)"
    return SCHEME_DESC.get(scheme, scheme)


def cmd_resolve():
    env = os.environ
    warnings = []
    desc = {}
    src = "manual"

    pending_file = env.get("AK_PENDING_FILE", "")
    if pending_file:
        data = read_pending(pending_file)
        if data is None:
            raw = load_json(pending_file, {})
            if isinstance(raw, dict) and raw.get("kind") == "oauth":
                die("that is an OAuth sign-in request — run: yodacode connect")
            die(f"pending request {pending_file} is missing or invalid")
        for k in ("service", "host", "scheme", "headerName", "queryParam", "basicPassword",
                  "extraHeaders", "keyName", "docsUrl", "keyHint", "testPath", "note"):
            if k in data:
                desc[k] = data[k]
        src = "pending"

    slug = None
    if env.get("AK_SERVICE"):
        slug = catalog_match(env["AK_SERVICE"])
        if slug is None and src == "manual":
            die(f"'{env['AK_SERVICE']}' is not in the built-in catalog")

    # Explicit flags override whatever a pending file proposed.
    for var, field in (("AK_HOST", "host"), ("AK_SCHEME", "scheme"), ("AK_NAME", "keyName"),
                       ("AK_HEADER_NAME", "headerName"), ("AK_QUERY_PARAM", "queryParam"),
                       ("AK_BASIC_PASSWORD", "basicPassword"), ("AK_NOTE", "note"),
                       ("AK_TEST_PATH", "testPath"), ("AK_DOCS_URL", "docsUrl")):
        if env.get(var, "") != "":
            desc[field] = env[var]
            src = src if src == "pending" else "flags"

    host = str(desc.get("host", "")).strip().lower()

    # The catalog is the trusted source for auth mechanics. If the target host
    # (or the named service) is a known one, its entry overrides whatever the
    # request proposed — an agent-written request cannot re-shape auth for a
    # host we already understand.
    cat_entry = None
    if slug:
        cat_entry = load_catalog().get(slug)
    if cat_entry is None and host:
        slug2, entry2 = catalog_by_host(host)
        if entry2:
            slug, cat_entry = slug2, entry2
    if isinstance(cat_entry, dict) and cat_entry.get("kind") == "oauth-provider":
        die(f"{cat_entry.get('label', slug)} services use OAuth, not a pasted key — run: yodacode connect {slug}")
    if cat_entry:
        if not host:
            desc["host"] = cat_entry.get("host", "")
            host = desc["host"]
        for field in ("scheme", "headerName", "queryParam", "basicPassword", "extraHeaders"):
            cat_v = cat_entry.get(field)
            if (cat_v or field == "scheme") and desc.get(field) not in (None, "", {}) and desc[field] != cat_v:
                warnings.append(f"{field} overridden by the built-in catalog entry for {cat_entry.get('label', slug)}")
            if cat_v is not None:
                desc[field] = cat_v
            else:
                desc.pop(field, None)
        for field in ("docsUrl", "keyHint", "testPath"):
            if cat_entry.get(field):
                desc[field] = cat_entry[field]
        desc.setdefault("keyName", cat_entry.get("keyName", ""))
        desc["service"] = cat_entry.get("label", slug)

    # service / keyHint / note are free-text and may be agent-authored — scrub all
    # control bytes (see CONTROL_RE) so they cannot inject terminal escapes when the
    # shell echoes them onto the consent screen.
    service = clean_text(desc.get("service", "") or host or "", 80)
    scheme = str(desc.get("scheme", "") or "bearer").strip().lower()
    key_name = re.sub(r"[^A-Z0-9_]", "", str(desc.get("keyName", "")).strip().upper().replace("-", "_").replace(" ", "_"))
    header_name = str(desc.get("headerName", "")).strip()
    query_param = str(desc.get("queryParam", "")).strip()
    basic_password = str(desc.get("basicPassword", "") or "")
    docs_url = str(desc.get("docsUrl", "")).strip()
    key_hint = clean_text(desc.get("keyHint", ""), 160)
    test_path = str(desc.get("testPath", "")).strip().lstrip("/")
    note = clean_text(desc.get("note", ""), 160)

    if not valid_host(host):
        die(f"invalid or missing API host: {host!r} (expect something like api.example.com, optionally with :port)")
    if scheme == "oauth2":
        die("OAuth services are set up with a guided sign-in, not a pasted key — run: yodacode connect")
    if scheme not in SCHEMES:
        die(f"invalid auth scheme {scheme!r} (one of: {', '.join(SCHEMES)})")
    if not KEY_RE.match(key_name):
        die(f"invalid or missing key name: {key_name!r} (UPPER_SNAKE, e.g. EXAMPLE_API_KEY)")
    if scheme == "header" and not HEADER_RE.match(header_name):
        die(f"scheme 'header' needs a valid header name (got {header_name!r})")
    if scheme == "query" and not QPARAM_RE.match(query_param):
        die(f"scheme 'query' needs a valid query parameter name (got {query_param!r})")
    if scheme == "basic" and not HEADER_VALUE_RE.match(basic_password or " "):
        die("invalid basic-auth password literal")
    if docs_url and not URL_RE.match(docs_url):
        warnings.append("ignored docsUrl (not a plain https:// URL)")
        docs_url = ""
    if test_path and not PATH_RE.match(test_path):
        warnings.append("ignored testPath (unexpected characters)")
        test_path = ""
    extra_headers = validate_extra_headers(desc.get("extraHeaders"), warnings, header_name if scheme == "header" else None)

    auth_hosts = load_json(AUTH_HOSTS, {})
    if not isinstance(auth_hosts, dict):
        auth_hosts = {}
    # Scrubbed for display: in the container deploy auth-hosts.json is a trust anchor
    # (agent can't write it), but on a bare-metal install it may not be, and these
    # host strings reach the terminal via `echo -e`.
    mapped_hosts = sorted(clean_text(h, 64) for h, d in auth_hosts.items() if isinstance(d, dict) and d.get("vaultKey") == key_name)
    existing = auth_hosts.get(host)
    host_already_mapped = isinstance(existing, dict) and existing.get("vaultKey") == key_name
    if isinstance(existing, dict) and existing.get("vaultKey") not in (None, key_name):
        warnings.append(f"{host} is currently mapped to {clean_text(existing.get('vaultKey'), 64)} — this will replace that mapping")
    # oauth2 entries carry no vaultKey, so the mapping warning above misses them.
    if isinstance(existing, dict) and existing.get("scheme") == "oauth2":
        warnings.append(f"{host} is currently an OAuth sign-in (set up via 'yodacode connect') — this replaces it with a pasted key")
    # Re-adding an already-mapped host (same key) skips the typed-hostname challenge,
    # so call out a change to its auth MECHANICS explicitly — e.g. a poisoned request
    # downgrading a header credential to a logged ?query= param on an existing host.
    if host_already_mapped and existing.get("scheme") != scheme:
        warnings.append(f"changes how {host} sends its key: {clean_text(existing.get('scheme', '?'), 16)} → {scheme}")

    out = {
        "AK_OK": "1",
        "AK_SRC": src,
        "AK_SERVICE_LABEL": service or host,
        "AK_HOST": host,
        "AK_SCHEME": scheme,
        "AK_SCHEME_DESC": scheme_desc(scheme, header_name, query_param),
        "AK_KEYNAME": key_name,
        "AK_HEADER_NAME": header_name if scheme == "header" else "",
        "AK_QUERY_PARAM": query_param if scheme == "query" else "",
        "AK_BASIC_PASSWORD": basic_password if scheme == "basic" else "",
        "AK_EXTRA_HEADERS": json.dumps(extra_headers) if extra_headers else "",
        "AK_DOCS_URL": docs_url,
        "AK_KEY_HINT": key_hint,
        "AK_TEST_PATH": test_path,
        "AK_NOTE": note or service,
        "AK_FROM_CATALOG": "1" if cat_entry else "",
        "AK_KEY_EXISTS": "1" if key_name in env_keys() else "",
        "AK_MAPPED_HOSTS": ", ".join(mapped_hosts),
        "AK_HOST_ALREADY_MAPPED": "1" if host_already_mapped else "",
    }
    for i, w in enumerate(warnings, 1):
        out[f"AK_WARN_{i}"] = w
    for k, v in out.items():
        print(f"{k}={shlex.quote(v)}")


def cmd_apply():
    """Upsert auth-hosts.json from AK_* vars (already validated by resolve; we
    re-check the load-bearing ones anyway — this function writes live config)."""
    env = os.environ
    host = env.get("AK_HOST", "")
    scheme = env.get("AK_SCHEME", "")
    key_name = env.get("AK_KEYNAME", "")
    if not valid_host(host) or scheme not in SCHEMES or not KEY_RE.match(key_name):
        die("apply: refusing invalid host/scheme/key")
    entry = {"scheme": scheme, "vaultKey": key_name}
    if scheme == "header":
        if not HEADER_RE.match(env.get("AK_HEADER_NAME", "")):
            die("apply: bad header name")
        entry["headerName"] = env["AK_HEADER_NAME"]
    if scheme == "query":
        if not QPARAM_RE.match(env.get("AK_QUERY_PARAM", "")):
            die("apply: bad query param")
        entry["queryParam"] = env["AK_QUERY_PARAM"]
    if scheme == "basic":
        entry["basicPassword"] = env.get("AK_BASIC_PASSWORD", "")
    if env.get("AK_EXTRA_HEADERS"):
        try:
            eh = json.loads(env["AK_EXTRA_HEADERS"])
        except Exception:
            die("apply: bad extraHeaders JSON")
        checked = validate_extra_headers(eh, [], entry.get("headerName"))
        if checked:
            entry["extraHeaders"] = checked
    if env.get("AK_NOTE"):
        entry["note"] = env["AK_NOTE"][:160]

    hosts = load_json(AUTH_HOSTS, {})
    if not isinstance(hosts, dict):
        hosts = {}
    hosts[host] = entry
    os.makedirs(os.path.dirname(AUTH_HOSTS), exist_ok=True)
    tmp = AUTH_HOSTS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(hosts, f, indent=2)
        f.write("\n")
    os.replace(tmp, AUTH_HOSTS)


def cmd_hosts():
    hosts = load_json(AUTH_HOSTS, {})
    if not isinstance(hosts, dict):
        return
    for h in sorted(hosts):
        d = hosts[h] if isinstance(hosts[h], dict) else {}
        print(f"{h}\t{d.get('scheme', '?')}\t{d.get('vaultKey', '?')}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "pending-list":
        cmd_pending_list()
    elif cmd == "catalog-match":
        slug = catalog_match(sys.argv[2] if len(sys.argv) > 2 else "")
        if slug:
            print(slug)
        else:
            sys.exit(1)
    elif cmd == "catalog-list":
        cmd_catalog_list()
    elif cmd == "resolve":
        cmd_resolve()
    elif cmd == "apply":
        cmd_apply()
    elif cmd == "hosts":
        cmd_hosts()
    else:
        die(f"unknown subcommand {cmd!r}")


if __name__ == "__main__":
    main()
