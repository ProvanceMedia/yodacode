#!/usr/bin/env bash
# yodacode addkey — give the bot a service API key, without needing to know
# what an "API host" or "auth scheme" is.
#
# Three ways in, easiest first:
#   1. Ask the bot in Slack ("connect my Notion") — it researches the service and
#      writes a pending request under workspace/state/pending-keys/; then this
#      command is just: confirm what it prepared, paste the key, done.
#   2. `yodacode addkey github` — a built-in catalog covers well-known services.
#   3. Flags or the manual wizard for anything else.
#
# The secret is read here on the server (hidden prompt) and written only to .env,
# which is mounted into the BROKER container — the agent never sees it. Pending
# requests are agent-written and therefore untrusted: scripts/addkey-lib.py
# validates every field, the catalog overrides auth mechanics for known hosts,
# and re-pointing an EXISTING key at a new host demands typed confirmation
# (that shape is what credential exfiltration looks like).
set -uo pipefail
cd "$(dirname "$0")/.."
source scripts/common.sh

LIB="scripts/addkey-lib.py"
command -v python3 >/dev/null 2>&1 || { fail "python3 is required for addkey ($SUDO apt-get install -y python3)."; exit 1; }
BOT_NAME="$(env_get BOT_NAME)"; BOT_NAME="${BOT_NAME:-your bot}"

usage() {
  echo "Usage: yodacode addkey [service] [options]"
  echo ""
  echo "  yodacode addkey                    guided — uses what $BOT_NAME prepared, or asks"
  echo "  yodacode addkey github             a built-in service by name"
  echo "  yodacode addkey --list             show pending requests + configured services"
  echo ""
  echo "  Options (for services the catalog doesn't know):"
  echo "    --host <api.example.com>   --scheme <bearer|header|query|basic>"
  echo "    --name <EXAMPLE_API_KEY>   --header-name <X-API-Key>   --query-param <api_key>"
  echo "    --test-path <v1/me>        --docs-url <https://...>    --note <text>"
}

# ── args ──────────────────────────────────────────────────────────────────────
SERVICE_ARG=""; LIST=0
export AK_PENDING_FILE="" AK_SERVICE="" AK_HOST="" AK_SCHEME="" AK_NAME="" \
       AK_HEADER_NAME="" AK_QUERY_PARAM="" AK_BASIC_PASSWORD="" AK_NOTE="" \
       AK_TEST_PATH="" AK_DOCS_URL=""
# `shift 2` is a silent no-op when only one arg remains (bash won't shift past $#),
# so a trailing value-taking flag would spin this loop forever. need_val() proves a
# value is present before we consume it.
need_val() { [[ $# -ge 2 ]] || { fail "$1 needs a value."; exit 1; }; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)         need_val "$@"; AK_HOST="$2"; shift 2 ;;
    --scheme)       need_val "$@"; AK_SCHEME="$2"; shift 2 ;;
    --name|--key)   need_val "$@"; AK_NAME="$2"; shift 2 ;;
    --header-name)  need_val "$@"; AK_HEADER_NAME="$2"; shift 2 ;;
    --query-param)  need_val "$@"; AK_QUERY_PARAM="$2"; shift 2 ;;
    --note)         need_val "$@"; AK_NOTE="$2"; shift 2 ;;
    --test-path)    need_val "$@"; AK_TEST_PATH="$2"; shift 2 ;;
    --docs-url)     need_val "$@"; AK_DOCS_URL="$2"; shift 2 ;;
    --list)         LIST=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    --*)            fail "Unknown option: $1"; usage; exit 1 ;;
    *)              SERVICE_ARG="$1"; shift ;;
  esac
done

if [[ "$LIST" == 1 ]]; then
  title "Pending key requests (prepared by $BOT_NAME)"
  python3 "$LIB" pending-list | awk -F'\t' '{printf "  %s — %s (key %s)\n", $2, $3, $4}' \
    || true
  [[ -z "$(python3 "$LIB" pending-list 2>/dev/null)" ]] && note "none — ask $BOT_NAME in Slack to prepare one"
  title "Configured services"
  python3 "$LIB" hosts | awk -F'\t' '{printf "  %s (%s → %s)\n", $1, $2, $3}'
  [[ -z "$(python3 "$LIB" hosts)" ]] && note "none yet"
  exit 0
fi

# ── pick a source: pending request → catalog name → wizard ──────────────────
if [[ -n "$SERVICE_ARG" ]]; then
  if slug="$(python3 "$LIB" catalog-match "$SERVICE_ARG")"; then
    AK_SERVICE="$slug"
  else
    # not in the catalog — maybe the bot prepared it
    while IFS=$'\t' read -r pf ps ph pk; do
      pslug="$(echo "$ps" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
      aslug="$(echo "$SERVICE_ARG" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
      [[ -n "$aslug" && "$pslug" == *"$aslug"* ]] && { AK_PENDING_FILE="$pf"; break; }
    done < <(python3 "$LIB" pending-list 2>/dev/null)
    if [[ -z "$AK_PENDING_FILE" && -z "$AK_HOST" ]]; then
      fail "'$SERVICE_ARG' isn't in the built-in catalog and $BOT_NAME hasn't prepared it."
      note "Easiest: in Slack, tell $BOT_NAME \"set up $SERVICE_ARG\" — it researches the service"
      note "and prepares everything; then run 'yodacode addkey' again."
      note "(Or answer the questions yourself: run 'yodacode addkey' with no arguments.)"
      exit 1
    fi
  fi
elif [[ -z "$AK_HOST" ]]; then
  # no args at all — offer whatever the bot prepared
  PENDING_LINES=()
  while IFS= read -r l; do [[ -n "$l" ]] && PENDING_LINES+=("$l"); done < <(python3 "$LIB" pending-list 2>/dev/null)
  if (( ${#PENDING_LINES[@]} == 1 )); then
    IFS=$'\t' read -r pf ps ph pk <<< "${PENDING_LINES[0]}"
    title "Add an API key"
    echo -e "  $BOT_NAME has prepared a request: ${B}$ps${X} (${ph})"
    a="$(ask 'Use it? [Y/n]' 'Y')"
    [[ "${a,,}" =~ ^n ]] || AK_PENDING_FILE="$pf"
  elif (( ${#PENDING_LINES[@]} > 1 )); then
    title "Add an API key"
    echo "  $BOT_NAME has prepared ${#PENDING_LINES[@]} requests:"
    i=1
    for l in "${PENDING_LINES[@]}"; do
      IFS=$'\t' read -r pf ps ph pk <<< "$l"
      echo -e "    ${B}$i${X}) $ps (${ph})"
      i=$((i+1))
    done
    echo "    0) something else"
    pick="$(ask 'Which one?' '1')"
    if [[ "$pick" =~ ^[0-9]+$ ]] && (( pick >= 1 && pick <= ${#PENDING_LINES[@]} )); then
      IFS=$'\t' read -r pf _ _ _ <<< "${PENDING_LINES[pick-1]}"
      AK_PENDING_FILE="$pf"
    fi
  fi

  # nothing pending (or declined) — the wizard
  if [[ -z "$AK_PENDING_FILE" ]]; then
    title "Add an API key"
    echo -e "  ${D}Tip: the easy way is to ask $BOT_NAME in Slack — e.g. \"set up Notion\" — it researches"
    echo -e "  the service and prepares this step for you. But we can also do it right here.${X}"
    echo ""
    svc="$(ask 'Which service? (name, or Enter to list the built-in ones)' '')"
    if [[ -z "$svc" ]]; then
      python3 "$LIB" catalog-list | awk -F'\t' '{printf "    %-14s %s\n", $1, $3}'
      echo ""
      svc="$(ask 'Which service?' '')"
    fi
    [[ -z "$svc" ]] && { fail "Nothing chosen."; exit 1; }
    if slug="$(python3 "$LIB" catalog-match "$svc")"; then
      AK_SERVICE="$slug"
    else
      warn "'$svc' isn't in the built-in catalog — a few questions, then."
      note "(You can also abort and ask $BOT_NAME \"set up $svc\" in Slack instead.)"
      echo ""
      AK_NOTE="${AK_NOTE:-$svc}"
      AK_HOST="$(ask 'API host — where its API lives (e.g. api.example.com)' '')"
      echo "  How does it expect the key?  1) Bearer token (most common)   2) a custom header"
      echo "                               3) a ?query= parameter          4) HTTP basic auth"
      st="$(ask 'Auth style' '1')"
      case "$st" in
        2) AK_SCHEME=header; AK_HEADER_NAME="$(ask 'Header name (e.g. X-API-Key)' 'X-API-Key')" ;;
        3) AK_SCHEME=query;  AK_QUERY_PARAM="$(ask 'Query param name (e.g. api_key)' 'api_key')" ;;
        4) AK_SCHEME=basic ;;
        *) AK_SCHEME=bearer ;;
      esac
      AK_NAME="$(ask 'Name for this key (UPPER_SNAKE, e.g. EXAMPLE_API_KEY)' 'EXAMPLE_API_KEY')"
    fi
  fi
fi

# ── resolve + validate (pending/catalog/flags merged, agent input sanitised) ──
if ! VARS="$(python3 "$LIB" resolve)"; then
  exit 1
fi
eval "$VARS"
# `apply` below re-reads these from the environment; eval alone doesn't export
# the ones that weren't in the pre-declared export list (AK_KEYNAME etc.).
export AK_SERVICE_LABEL AK_HOST AK_SCHEME AK_SCHEME_DESC AK_KEYNAME \
       AK_HEADER_NAME AK_QUERY_PARAM AK_BASIC_PASSWORD AK_EXTRA_HEADERS \
       AK_DOCS_URL AK_KEY_HINT AK_TEST_PATH AK_NOTE

title "Add an API key — $AK_SERVICE_LABEL"
echo -e "  Sends to:  ${B}$AK_HOST${X}  ${D}← the only place this key will ever be sent${X}"
echo    "  Auth:      $AK_SCHEME_DESC"
echo    "  Stored as: $AK_KEYNAME  (in the broker vault — $BOT_NAME never sees the value)"
if [[ -n "$AK_DOCS_URL" ]]; then
  echo -e "  Create it: ${B}$AK_DOCS_URL${X}"
  [[ -n "$AK_KEY_HINT" ]] && echo -e "             ${D}$AK_KEY_HINT${X}"
fi
i=1
while true; do
  w="AK_WARN_$i"
  [[ -n "${!w:-}" ]] || break
  warn "${!w}"
  i=$((i+1))
done
echo ""

# ── the guard: re-pointing an existing key at a NEW host needs typed intent ──
# This exact shape — "send a key you already have to a host it doesn't serve" —
# is how a poisoned request (say, from a prompt-injected page the bot read)
# would try to exfiltrate a credential. A human who really means it can type
# the hostname; nothing else gets through.
if [[ ( -n "$AK_KEY_EXISTS" || -n "$AK_MAPPED_HOSTS" ) && -z "$AK_HOST_ALREADY_MAPPED" ]]; then
  echo -e "  ${R}${B}⚠ Security check${X}"
  echo -e "  ${R}$AK_KEYNAME already exists in your vault${X}${AK_MAPPED_HOSTS:+${R} and currently serves: $AK_MAPPED_HOSTS${X}}"
  echo -e "  ${R}Continuing ALSO sends it to $AK_HOST. If you didn't explicitly ask to reuse an${X}"
  echo -e "  ${R}existing key for a new host, stop — this is what a key-theft attempt looks like.${X}"
  typed="$(ask "Type the host name ($AK_HOST) to continue, or press Enter to abort" '')"
  [[ "$typed" == "$AK_HOST" ]] || { fail "Aborted — nothing was changed."; exit 1; }
else
  a="$(ask 'Continue? [Y/n]' 'Y')"
  [[ "${a,,}" =~ ^n ]] && { note "Aborted — nothing was changed."; exit 0; }
fi

# ── the secret — the only part that must happen on the server ────────────────
if [[ -n "$AK_KEY_EXISTS" ]]; then
  read -r -s -p "  Paste the value for $AK_KEYNAME (hidden; Enter keeps the current one): " SECRET; echo ""
else
  read -r -s -p "  Paste the value for $AK_KEYNAME (hidden): " SECRET; echo ""
fi
SECRET="$(printf '%s' "$SECRET" | tr -d '\r\n')"
SECRET="${SECRET#"${SECRET%%[![:space:]]*}"}"; SECRET="${SECRET%"${SECRET##*[![:space:]]}"}"
if [[ -z "$SECRET" && -z "$AK_KEY_EXISTS" ]]; then fail "No value entered."; exit 1; fi

[[ -n "$SECRET" ]] && set_env "$AK_KEYNAME" "$SECRET"
python3 "$LIB" apply || { fail "Could not update broker/auth-hosts.json"; exit 1; }
ok "Stored $AK_KEYNAME and mapped $AK_HOST."

# ── reload the broker + prove the key works ──────────────────────────────────
# TEST_FAILED tracks a smoke-test that ran and failed: we keep the bot-prepared
# pending request (so a re-run still finds it) and exit non-zero, rather than
# deleting it and reporting a false success.
TEST_FAILED=0
if command -v docker >/dev/null 2>&1 \
   && docker compose ps --services --status running 2>/dev/null | grep -qx broker; then
  rlog="$(mktemp)"
  spin "Reloading the broker" "$rlog" docker compose restart broker \
    || { warn "Broker restart reported an error:"; tail -6 "$rlog" 2>/dev/null | sed 's/^/    /'; }
  rm -f "$rlog"
  up=""
  for _ in $(seq 1 20); do
    docker compose exec -T agent broker ping >/dev/null 2>&1 && { up=1; break; }
    sleep 1
  done
  if [[ -z "$up" ]]; then
    warn "The broker isn't answering yet — give it a minute, then try 'yodacode doctor'."
  elif [[ -n "$AK_TEST_PATH" ]]; then
    tj="$(python3 -c 'import json,sys; print(json.dumps({"host": sys.argv[1], "path": sys.argv[2], "method": "GET"}))' "$AK_HOST" "$AK_TEST_PATH")"
    tout="$(mktemp)"
    if docker compose exec -T agent broker call http_call "$tj" >"$tout" 2>&1; then
      ok "Key verified — $AK_SERVICE_LABEL answered a test call. ✅"
    else
      TEST_FAILED=1
      warn "Stored, but a test call to $AK_HOST failed — usually a mispasted or under-scoped key."
      tail -c 300 "$tout" 2>/dev/null | tr -d '\0' | sed 's/^/    /'
      note "Create a fresh key and run 'yodacode addkey' again to replace it."
    fi
    rm -f "$tout"
  else
    if docker compose exec -T agent broker manifest 2>/dev/null | grep -q "$AK_HOST"; then
      ok "Broker reloaded — $AK_HOST is live (no test endpoint known, so not called)."
    else
      warn "Broker reloaded but $AK_HOST isn't in its manifest — run 'yodacode doctor'."
    fi
  fi
  # Refresh the agent's own capability doc so its very next reply knows the
  # service exists. Never as root: root-owned workspace files break later runs.
  PUID_V="$(env_get PUID)"; PGID_V="$(env_get PGID)"
  docker compose exec -T -u "${PUID_V:-1000}:${PGID_V:-1000}" agent \
    python3 /app/workspace/bin/refresh-capabilities.py >/dev/null 2>&1 || true
else
  note "The bot isn't running — the key is stored and goes live on 'yodacode start'."
fi

echo ""
if [[ "$TEST_FAILED" == 1 ]]; then
  # Keep the pending request so the operator can just re-run and re-paste.
  warn "Stored but unverified — repaste the key with 'yodacode addkey' once you have a working one."
  exit 2
fi
[[ -n "$AK_PENDING_FILE" ]] && rm -f "$AK_PENDING_FILE"
ok "Done. Back in Slack, just ask $BOT_NAME to use $AK_SERVICE_LABEL."
