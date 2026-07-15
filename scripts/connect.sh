#!/usr/bin/env bash
# yodacode connect — sign the bot into an OAuth service (Google/Gmail etc.)
# without needing to know what a "refresh token" or a "scope" is.
#
# Three ways in, easiest first:
#   1. Ask the bot in Slack ("connect my gmail") — it writes a pending OAuth
#      request under workspace/state/pending-keys/; then this command just
#      confirms what it prepared and walks you through the sign-in.
#   2. `yodacode connect google` (or `yodacode connect gmail`) — the built-in
#      catalog knows the provider's endpoints, scopes and vault keys.
#   3. `yodacode connect <provider> --renew` — redo an expired sign-in (~2 min).
#
# The consent step runs in the browser on your LAPTOP. Depending on the
# provider's catalog "flow" this is either auth-code (print a link, paste the
# dead redirect back) or device-code (type a short code at the provider's
# verification page; the wizard polls until you approve). The exchange happens
# on the server (scripts/connect-lib.py) and the resulting refresh token is
# written only to .env — the broker's vault. The agent never sees it.
# Everything an agent-written pending request proposes is validated against
# the catalog: it can name a provider + services, never a scope or an endpoint.
set -uo pipefail
cd "$(dirname "$0")/.."
source scripts/common.sh

LIB="scripts/connect-lib.py"
command -v python3 >/dev/null 2>&1 || { fail "python3 is required for connect ($SUDO apt-get install -y python3)."; exit 1; }
BOT_NAME="$(env_get BOT_NAME)"; BOT_NAME="${BOT_NAME:-your bot}"

usage() {
  echo "Usage: yodacode connect [provider|service] [options]"
  echo ""
  echo "  yodacode connect                   guided — uses what $BOT_NAME prepared, or asks"
  echo "  yodacode connect google            sign in to a provider by name"
  echo "  yodacode connect gmail             a service name works too"
  echo "  yodacode connect google --renew    redo an expired/revoked sign-in"
  echo "  yodacode connect --list            pending requests + connected providers"
  echo ""
  echo "  Options:  --services gmail,calendar    pre-select services"
}

# ── args ──────────────────────────────────────────────────────────────────────
PROVIDER_ARG=""; LIST=0
export CN_PENDING_FILE="" CN_PROVIDER="" CN_SERVICES="" CN_RENEW="" CN_TIERS="" \
       CN_CLIENT_ID="" CN_CLIENT_SECRET="" CN_STATE="" CN_PKCE_VERIFIER="" \
       CN_PASTE="" CN_ACCESS_TOKEN="" CN_ACCOUNT="" CN_GRANTED_SCOPES="" \
       CN_PUBLISHED="" CN_LOGIN_HINT=""
need_val() { [[ $# -ge 2 ]] || { fail "$1 needs a value."; exit 1; }; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --services)  need_val "$@"; CN_SERVICES="$2"; shift 2 ;;
    --renew)     CN_RENEW=1; shift ;;
    --list)      LIST=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    --*)         fail "Unknown option: $1"; usage; exit 1 ;;
    *)           PROVIDER_ARG="$1"; shift ;;
  esac
done

if [[ "$LIST" == 1 ]]; then
  title "Available providers"
  python3 "$LIB" providers-list | awk -F'\t' '{printf "  %-10s %s — %s\n", $1, $2, $3}'
  title "Pending sign-in requests (prepared by $BOT_NAME)"
  python3 "$LIB" pending-list | awk -F'\t' '{printf "  %s — %s\n", $3, $4}' || true
  [[ -z "$(python3 "$LIB" pending-list 2>/dev/null)" ]] && note "none — ask $BOT_NAME in Slack to prepare one"
  title "Connected providers"
  python3 "$LIB" grants | awk -F'\t' '{printf "  %s — %s (%s)\n", $1, ($2==""?"account unknown":$2), $5}'
  [[ -z "$(python3 "$LIB" grants)" ]] && note "none yet"
  exit 0
fi

# ── pick a source: named provider/service → pending request → ask ────────────
if [[ -n "$PROVIDER_ARG" ]]; then
  if m="$(python3 "$LIB" provider-match "$PROVIDER_ARG")"; then
    IFS=$'\t' read -r CN_PROVIDER msvc <<< "$m"
    [[ -n "${msvc:-}" && "$msvc" != "None" && -z "$CN_SERVICES" ]] && CN_SERVICES="$msvc"
  else
    fail "'$PROVIDER_ARG' isn't a known OAuth provider or service."
    note "Known: run 'yodacode connect --list'. Plain API-key services use 'yodacode addkey' instead."
    exit 1
  fi
else
  PENDING_LINES=()
  while IFS= read -r l; do [[ -n "$l" ]] && PENDING_LINES+=("$l"); done < <(python3 "$LIB" pending-list 2>/dev/null)
  if (( ${#PENDING_LINES[@]} == 1 )); then
    IFS=$'\t' read -r pf pp pl ps <<< "${PENDING_LINES[0]}"
    title "Connect a service"
    echo -e "  $BOT_NAME has prepared a sign-in request: ${B}$pl${X} (${ps})"
    a="$(ask 'Use it? [Y/n]' 'Y')"
    [[ "${a,,}" =~ ^n ]] || CN_PENDING_FILE="$pf"
  elif (( ${#PENDING_LINES[@]} > 1 )); then
    title "Connect a service"
    echo "  $BOT_NAME has prepared ${#PENDING_LINES[@]} sign-in requests:"
    i=1
    for l in "${PENDING_LINES[@]}"; do
      IFS=$'\t' read -r pf pp pl ps <<< "$l"
      echo -e "    ${B}$i${X}) $pl (${ps})"
      i=$((i+1))
    done
    echo "    0) something else"
    pick="$(ask 'Which one?' '1')"
    if [[ "$pick" =~ ^[0-9]+$ ]] && (( pick >= 1 && pick <= ${#PENDING_LINES[@]} )); then
      IFS=$'\t' read -r pf _ _ _ <<< "${PENDING_LINES[pick-1]}"
      CN_PENDING_FILE="$pf"
    fi
  fi
  if [[ -z "$CN_PENDING_FILE" ]]; then
    title "Connect a service"
    svc="$(ask 'Which provider or service? (e.g. google, gmail)' 'google')"
    if m="$(python3 "$LIB" provider-match "$svc")"; then
      IFS=$'\t' read -r CN_PROVIDER msvc <<< "$m"
      [[ -n "${msvc:-}" && "$msvc" != "None" && -z "$CN_SERVICES" ]] && CN_SERVICES="$msvc"
    else
      fail "'$svc' isn't a known OAuth provider or service. (API-key services: 'yodacode addkey'.)"
      exit 1
    fi
  fi
fi

# ── resolve: catalog is the trust anchor; agent input validated there ────────
if ! VARS="$(python3 "$LIB" resolve)"; then exit 1; fi
eval "$VARS"
i=1
while true; do w="CN_WARN_$i"; [[ -n "${!w:-}" ]] || break; warn "${!w}"; i=$((i+1)); done

title "Connect $CN_PROVIDER_LABEL"
echo -e "  A one-time browser sign-in on your ${B}laptop${X}; the resulting token is stored"
echo    "  in the broker vault. $BOT_NAME never sees it — it calls $CN_PROVIDER_LABEL through the broker."
[[ -z "$CN_CLIENT_EXISTS" ]] && echo -e "  ${D}First time: ~10 minutes (one-time $CN_PROVIDER_LABEL client setup). After that: seconds.${X}"

# ── service selection ─────────────────────────────────────────────────────────
# One provider sign-in covers N services with ONE refresh token. Installed-app
# OAuth has no incremental consent, so adding a service later means redoing the
# sign-in — hence the "pick everything you might use" nudge. Previously
# connected services stay locked in: dropping one from the union would silently
# cut off its access when the new token replaces the old.
pick_by_token() {  # number or name → index (echo), else fail
  local tok="$1" j lc
  # 10# base: '02' would otherwise be read as octal (and '08'/'09' would error
  # in the arithmetic guard), then leak into a CN_SVC_02_* name nothing emits.
  [[ "$tok" =~ ^[0-9]+$ ]] && tok=$((10#$tok))
  if [[ "$tok" =~ ^[0-9]+$ ]] && (( tok >= 1 && tok <= CN_SVC_COUNT )); then echo "$tok"; return 0; fi
  lc="$(echo "$tok" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
  for (( j=1; j<=CN_SVC_COUNT; j++ )); do
    local s="CN_SVC_${j}_SLUG" l="CN_SVC_${j}_LABEL"
    [[ "$(echo "${!l}" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')" == "$lc" || "${!s}" == "$lc" ]] && { echo "$j"; return 0; }
  done
  return 1
}
# A renewal with nothing recorded (or nothing pre-selected) has nothing to
# skip — fall back to the full guided flow instead of dead-ending.
if [[ "$CN_RENEW" == 1 ]]; then
  any_sel=""
  for (( j=1; j<=CN_SVC_COUNT; j++ )); do sv="CN_SVC_${j}_SELECTED"; [[ -n "${!sv}" ]] && { any_sel=1; break; }; done
  [[ -z "$any_sel" ]] && CN_RENEW=""
fi
if [[ "$CN_RENEW" != 1 ]]; then
  echo ""
  echo -e "  ${B}Which $CN_PROVIDER_LABEL services should this sign-in cover?${X}"
  echo -e "  ${D}One combined sign-in covers them all — adding one later means redoing it (~2 min),${X}"
  echo -e "  ${D}so tick everything you might want. Already-connected services stay included.${X}"
  for (( j=1; j<=CN_SVC_COUNT; j++ )); do
    sv="CN_SVC_${j}_SELECTED"; lb="CN_SVC_${j}_LABEL"; pt="CN_SVC_${j}_PRIOR_TIER"
    mark=" "; [[ -n "${!sv}" ]] && mark="✓"
    extra=""; [[ -n "${!pt}" ]] && extra=" ${D}(already connected)${X}"
    echo -e "    ${G}$mark${X} ${B}$j${X}) ${!lb}$extra"
  done
  add="$(ask 'Add services (numbers/names, comma-separated; Enter = keep ticked)' '')"
  IFS=', ' read -ra toks <<< "$add"
  for tok in "${toks[@]}"; do
    [[ -z "$tok" ]] && continue
    if j="$(pick_by_token "$tok")"; then declare "CN_SVC_${j}_SELECTED=1"
    else warn "Skipping '$tok' — not one of the listed services."; fi
  done
fi
SELECTED=()
for (( j=1; j<=CN_SVC_COUNT; j++ )); do
  sv="CN_SVC_${j}_SELECTED"; s="CN_SVC_${j}_SLUG"
  [[ -n "${!sv}" ]] && SELECTED+=("${!s}")
done
(( ${#SELECTED[@]} > 0 )) || { fail "No services selected — nothing to connect."; exit 1; }
CN_SERVICES="$(IFS=,; echo "${SELECTED[*]}")"

# ── scope tiers (plain-English labels; raw scopes never leave the catalog) ───
CN_TIERS=""
for (( j=1; j<=CN_SVC_COUNT; j++ )); do
  sv="CN_SVC_${j}_SELECTED"; [[ -n "${!sv}" ]] || continue
  s="CN_SVC_${j}_SLUG"; lb="CN_SVC_${j}_LABEL"; tc="CN_SVC_${j}_TIER_COUNT"; td="CN_SVC_${j}_TIER_DEFAULT"
  choice="${!td}"
  if [[ "$CN_RENEW" != 1 && "${!tc}" -gt 1 ]]; then
    echo ""
    echo -e "  ${B}${!lb}${X} — how much access?"
    defnum=1
    for (( k=1; k<=${!tc}; k++ )); do
      tk="CN_SVC_${j}_TIER_${k}_KEY"; tl="CN_SVC_${j}_TIER_${k}_LABEL"
      echo "    $k) ${!tl}"
      [[ "${!tk}" == "${!td}" ]] && defnum=$k
    done
    pick="$(ask 'Choice' "$defnum")"
    [[ "$pick" =~ ^[0-9]+$ ]] && pick=$((10#$pick))   # '02' → 2, and no octal error on 08/09
    if [[ "$pick" =~ ^[0-9]+$ ]] && (( pick >= 1 && pick <= ${!tc} )); then
      tk="CN_SVC_${j}_TIER_${pick}_KEY"; choice="${!tk}"
    fi
  fi
  CN_TIERS="${CN_TIERS:+$CN_TIERS,}${!s}=$choice"
done

# ── the OAuth client (bring-your-own; first time only) ────────────────────────
# env_get returns .env values raw; the broker's vault strips one pair of
# matching quotes — do the same so a hand-quoted value doesn't build a broken
# consent URL (the quotes would be urlencoded into the client_id).
unquote() { local v="$1"; [[ ${#v} -ge 2 && "${v:0:1}" == "${v: -1}" && ( "${v:0:1}" == '"' || "${v:0:1}" == "'" ) ]] && v="${v:1:${#v}-2}"; printf '%s' "$v"; }
CN_CLIENT_ID="$(unquote "$(env_get "$CN_CLIENT_ID_KEY")")"
CN_CLIENT_SECRET=""
[[ -n "$CN_CLIENT_SECRET_KEY" ]] && CN_CLIENT_SECRET="$(unquote "$(env_get "$CN_CLIENT_SECRET_KEY")")"
NEW_CLIENT=""
if [[ -n "$CN_CLIENT_EXISTS" ]]; then
  if [[ "$CN_RENEW" == 1 ]]; then
    note "Reusing your existing $CN_PROVIDER_LABEL OAuth client."
  else
    a="$(ask "Reuse your existing $CN_PROVIDER_LABEL OAuth client? [Y/n]" 'Y')"
    [[ "${a,,}" =~ ^n ]] && CN_CLIENT_ID="" && CN_CLIENT_SECRET=""
  fi
fi
# A public client (no clientSecretKey in the catalog) needs only the client ID.
if [[ -z "$CN_CLIENT_ID" || ( -n "$CN_CLIENT_SECRET_KEY" && -z "$CN_CLIENT_SECRET" ) ]]; then
  NEW_CLIENT=1
  echo ""
  echo -e "  ${B}One-time $CN_PROVIDER_LABEL client setup${X} — open these on your laptop (full guide: ${D}$CN_SETUP_GUIDE${X}):"
  echo ""
  for (( j=1; j<=CN_SETUP_STEP_COUNT; j++ )); do
    st="CN_SETUP_STEP_${j}_TEXT"; su="CN_SETUP_STEP_${j}_URL"
    echo -e "    $j. ${!st}"
    [[ -n "${!su}" ]] && echo -e "       ${B}${!su}${X}"
  done
  ANY_ENABLE=""
  for (( j=1; j<=CN_SVC_COUNT; j++ )); do
    sv="CN_SVC_${j}_SELECTED"; eu="CN_SVC_${j}_ENABLE_URL"
    [[ -n "${!sv}" && -n "${!eu}" ]] && { ANY_ENABLE=1; break; }
  done
  if [[ -n "$ANY_ENABLE" ]]; then
    echo ""
    echo -e "    Enable these APIs (one click each):"
    for (( j=1; j<=CN_SVC_COUNT; j++ )); do
      sv="CN_SVC_${j}_SELECTED"; [[ -n "${!sv}" ]] || continue
      lb="CN_SVC_${j}_LABEL"; eu="CN_SVC_${j}_ENABLE_URL"
      [[ -n "${!eu}" ]] && echo -e "      • ${!lb}: ${B}${!eu}${X}"
    done
  fi
  echo ""
  if [[ "$CN_PUBLISH_CHECK" == 1 ]]; then
    warn "Don't skip 'Publish app': in Testing status Google expires the sign-in every 7 days."
    echo ""
  fi
  CN_CLIENT_ID=""
  for t in 1 2 3; do
    read -r -p "  Paste the Client ID: " CN_CLIENT_ID; CN_CLIENT_ID="$(echo "$CN_CLIENT_ID" | tr -d '[:space:]')"
    if [[ -n "$CN_CLIENT_ID_PATTERN" ]] && ! [[ "$CN_CLIENT_ID" =~ $CN_CLIENT_ID_PATTERN ]]; then
      fail "That doesn't look like a $CN_PROVIDER_LABEL client ID. ($((3-t)) left)"; CN_CLIENT_ID=""
    elif [[ -z "$CN_CLIENT_ID" ]]; then fail "Nothing entered. ($((3-t)) left)"
    else break; fi
  done
  [[ -n "$CN_CLIENT_ID" ]] || { fail "No client ID — aborted, nothing was changed."; exit 1; }
  if [[ -n "$CN_CLIENT_SECRET_KEY" ]]; then
    read -r -s -p "  Paste the Client secret (hidden): " CN_CLIENT_SECRET; echo ""
    CN_CLIENT_SECRET="$(printf '%s' "$CN_CLIENT_SECRET" | tr -d '[:space:]')"
    [[ -n "$CN_CLIENT_SECRET" ]] || { fail "No client secret — aborted, nothing was changed."; exit 1; }
  fi
fi

# The 7-day footgun: an "External" app left in Testing status gets its refresh
# tokens killed weekly. We can't verify the console state programmatically —
# the honest best is to ask, warn hard, and record the answer for doctor.
# Once recorded as published (and the same client is being reused), don't
# re-interrogate on every renewal — publishing doesn't un-happen. Providers
# without a Testing-status concept skip this entirely (catalog publishCheck).
if [[ "$CN_PUBLISH_CHECK" == 1 ]]; then
  echo ""
  if [[ "$CN_GRANT_PUBLISHED" == 1 && -z "$NEW_CLIENT" ]]; then
    CN_PUBLISHED=1
    note "Consent screen recorded as published to 'In production' — skipping that check."
  elif a="$(ask "Is the app's consent screen published to 'In production' (not Testing)? [y/N]" 'n')" \
       && [[ "${a,,}" =~ ^y ]]; then CN_PUBLISHED=1
  else
    CN_PUBLISHED=0
    warn "In Testing status this sign-in will STOP WORKING after 7 days (Google policy)."
    note "Fix now (1 min): open the Audience page → 'Publish app'. Unverified + In production"
    note "is fine for personal use — you'll just click through a warning during sign-in."
    a="$(ask 'Continue anyway? [y/N]' 'n')"
    [[ "${a,,}" =~ ^y ]] || { note "Aborted — publish the app, then re-run 'yodacode connect'."; exit 0; }
  fi
fi

# ── consent: device-code (enter a short code) or auth-code (paste-back) ──────
[[ -n "$CN_GRANT_ACCOUNT" ]] && CN_LOGIN_HINT="$CN_GRANT_ACCOUNT"
export CN_PROVIDER CN_SERVICES CN_TIERS CN_CLIENT_ID CN_CLIENT_SECRET CN_LOGIN_HINT
ATTEMPTS=0
if [[ "$CN_FLOW" == "device-code" ]]; then
  # No redirect and nothing to paste: the provider hands out a short code the
  # user types at a fixed verification URL on any device; we poll until the
  # sign-in completes (or the code expires, ~15 min).
  while true; do
    CN_OK=""; CN_ERROR=""; CN_RETRY_URL=""; CN_RETRY_PASTE=""
    rc=0; DSVARS="$(python3 "$LIB" device-start)" || rc=$?
    eval "$DSVARS"
    [[ "$rc" == 0 && -n "${CN_OK:-}" ]] || { fail "${CN_ERROR:-could not start the sign-in}"; exit 1; }
    export CN_DEVICE_CODE CN_INTERVAL CN_EXPIRES_IN
    mins=$(( (CN_EXPIRES_IN + 59) / 60 ))
    echo ""
    echo -e "  ${B}On your laptop (or phone), open:${X}  $CN_VERIFICATION_URI"
    echo ""
    echo -e "  and enter this code:  ${B}$CN_USER_CODE${X}"
    echo ""
    echo -e "  Access requested: ${D}$CN_SCOPE_SUMMARY${X}"
    echo -e "  ${D}Sign in and approve. The code is valid for ~$mins minutes.${X}"
    echo ""
    note "Waiting for you to finish the sign-in in the browser… (Ctrl-C aborts; nothing is stored yet)"
    CN_OK=""; CN_ERROR=""; CN_RETRY_URL=""; CN_RETRY_PASTE=""
    rc=0; DPVARS="$(python3 "$LIB" device-poll)" || rc=$?
    eval "$DPVARS"
    [[ "$rc" == 0 && -n "${CN_OK:-}" ]] && break
    fail "${CN_ERROR:-sign-in failed}"
    ATTEMPTS=$((ATTEMPTS+1))
    (( ATTEMPTS >= 3 )) && { fail "Giving up after 3 attempts — nothing was changed. Re-run 'yodacode connect'."; exit 1; }
    [[ "${CN_RETRY_URL:-}" == 1 ]] || exit 1
    note "Requesting a fresh code…"
  done
else
while true; do
  if ! URLVARS="$(python3 "$LIB" auth-url)"; then exit 1; fi
  eval "$URLVARS"
  export CN_STATE CN_PKCE_VERIFIER
  echo ""
  echo -e "  ${B}Open this link in the browser ON YOUR LAPTOP${X} ${D}(not the server)${X}:"
  echo ""
  echo "  $CN_AUTH_URL"
  echo ""
  echo -e "  Access requested: ${D}$CN_SCOPE_SUMMARY${X}"
  echo ""
  step=1
  echo    "    $step. Sign in and pick the account to connect."
  # Provider-specific guidance (e.g. Google's unverified-app warning) comes
  # from the catalog's signInNotes — nothing Google-shaped lives here.
  for (( n=1; n<=CN_SIGNIN_NOTE_COUNT; n++ )); do
    sn="CN_SIGNIN_NOTE_$n"; step=$((step+1))
    echo -e "    $step. ${!sn}"
  done
  step=$((step+1))
  echo -e "    $step. The final page will FAIL to load (${B}\"This site can't be reached\"${X})."
  echo -e "       ${B}That is expected.${X} Copy the ENTIRE URL from the address bar and paste it here."
  echo ""
  # Visible prompt on purpose: users need to see a mangled paste to fix it, and
  # the code in the URL is single-use, PKCE-bound and consumed seconds later.
  read -r -p "  Paste the full address-bar URL (or just the code): " CN_PASTE
  export CN_PASTE
  # Clear the previous attempt's outcome before each eval — the lib emits both
  # retry flags on every failure, but a stale value here must never steer.
  CN_OK=""; CN_ERROR=""; CN_RETRY_URL=""; CN_RETRY_PASTE=""
  rc=0; EXVARS="$(python3 "$LIB" exchange)" || rc=$?
  eval "$EXVARS"
  if [[ "$rc" == 0 && -n "${CN_OK:-}" ]]; then break; fi
  fail "${CN_ERROR:-sign-in failed}"
  ATTEMPTS=$((ATTEMPTS+1))
  (( ATTEMPTS >= 3 )) && { fail "Giving up after 3 attempts — nothing was changed. Re-run 'yodacode connect'."; exit 1; }
  if [[ "${CN_RETRY_URL:-}" == 1 ]]; then note "Generating a fresh sign-in link…"
  elif [[ "${CN_RETRY_PASTE:-}" == 1 ]]; then
    read -r -p "  Try the paste again: " CN_PASTE
    export CN_PASTE
    CN_OK=""; CN_ERROR=""; CN_RETRY_URL=""; CN_RETRY_PASTE=""
    rc=0; EXVARS="$(python3 "$LIB" exchange)" || rc=$?
    eval "$EXVARS"
    [[ "$rc" == 0 && -n "${CN_OK:-}" ]] && break
    fail "${CN_ERROR:-sign-in failed}"; note "Generating a fresh sign-in link…"
  else
    exit 1
  fi
done
fi

# ── account guard: this token replaces the account for ALL provider hosts ────
# Fail CLOSED when the identity lookup came back empty: with a prior account
# on record, an unverifiable sign-in could silently switch every connected
# service to the wrong account.
if [[ -z "$CN_ACCOUNT" && -n "$CN_GRANT_ACCOUNT" ]]; then
  warn "Couldn't verify which account you just signed in with (currently connected: $CN_GRANT_ACCOUNT)."
  warn "If it was a different account, continuing switches EVERY connected $CN_PROVIDER_LABEL service to it."
  a="$(ask "Continue anyway? [y/N]" 'n')"
  [[ "${a,,}" =~ ^y ]] || { fail "Aborted — nothing was changed. Re-run 'yodacode connect'."; exit 1; }
fi
if [[ -n "$CN_ACCOUNT" ]]; then
  if [[ -n "$CN_GRANT_ACCOUNT" && "$CN_ACCOUNT" != "$CN_GRANT_ACCOUNT" ]]; then
    echo ""
    echo -e "  ${R}${B}⚠ Different account${X}"
    echo -e "  ${R}You signed in as $CN_ACCOUNT, but $CN_PROVIDER_LABEL is currently connected as${X}"
    echo -e "  ${R}$CN_GRANT_ACCOUNT. Continuing switches EVERY connected $CN_PROVIDER_LABEL service to $CN_ACCOUNT.${X}"
    a="$(ask 'Switch account? [y/N]' 'n')"
    [[ "${a,,}" =~ ^y ]] || { fail "Aborted — nothing was changed. Re-run and sign in as $CN_GRANT_ACCOUNT."; exit 1; }
  else
    a="$(ask "Signed in as $CN_ACCOUNT — connect this account? [Y/n]" 'Y')"
    [[ "${a,,}" =~ ^n ]] && { note "Aborted — nothing was changed."; exit 0; }
  fi
fi

# ── pre-store smoke test: prove the token works BEFORE touching the vault ────
export CN_ACCESS_TOKEN
echo ""
SMOKE_RC=0; SMOKE_OUT="$(python3 "$LIB" smoke)" || SMOKE_RC=$?
ANY_FAIL=0
while IFS=$'\t' read -r s st msg; do
  [[ -z "$s" ]] && continue
  lb="$s"
  for (( j=1; j<=CN_SVC_COUNT; j++ )); do
    sl="CN_SVC_${j}_SLUG"; [[ "${!sl}" == "$s" ]] && { l2="CN_SVC_${j}_LABEL"; lb="${!l2}"; break; }
  done
  case "$st" in
    ok)   ok "$lb works" ;;
    skip) note "$lb: $msg" ;;
    *)    ANY_FAIL=1; warn "$lb: $msg" ;;
  esac
done <<< "$SMOKE_OUT"
if [[ "$SMOKE_RC" != 0 ]]; then
  fail "Every testable service failed — nothing was stored."
  note "Usually the API isn't enabled yet (links above). Enable it, wait ~1 minute, re-run 'yodacode connect'."
  exit 2
elif [[ "$ANY_FAIL" == 1 ]]; then
  a="$(ask 'Some services failed (see above). Store the sign-in anyway? [y/N]' 'n')"
  [[ "${a,,}" =~ ^y ]] || { note "Aborted — nothing was changed. Fix the failures and re-run."; exit 2; }
fi

# ── store: vault keys + auth-hosts + grant metadata ───────────────────────────
if [[ -n "$NEW_CLIENT" ]]; then
  set_env "$CN_CLIENT_ID_KEY" "$CN_CLIENT_ID"
  [[ -n "$CN_CLIENT_SECRET_KEY" ]] && set_env "$CN_CLIENT_SECRET_KEY" "$CN_CLIENT_SECRET"
fi
set_env "$CN_REFRESH_TOKEN_KEY" "$CN_REFRESH_TOKEN"
export CN_ACCOUNT CN_GRANTED_SCOPES CN_PUBLISHED
python3 "$LIB" apply || { fail "Could not update broker/auth-hosts.json"; exit 1; }
ok "Stored the $CN_PROVIDER_LABEL sign-in${CN_ACCOUNT:+ for $CN_ACCOUNT} in the broker vault."

# ── restart the broker + prove the broker path works ─────────────────────────
# Always a full restart, never a SIGHUP reload: set_env overwrites replace the
# .env inode, and the broker's single-file :ro bind mount keeps serving the OLD
# file after a reload — a renewed token would silently not take effect.
TEST_FAILED=0
if command -v docker >/dev/null 2>&1 \
   && docker compose ps --services --status running 2>/dev/null | grep -qx broker; then
  rlog="$(mktemp)"
  spin "Restarting the broker" "$rlog" docker compose restart broker \
    || { warn "Broker restart reported an error:"; tail -6 "$rlog" 2>/dev/null | sed 's/^/    /'; }
  rm -f "$rlog"
  up=""
  for _ in $(seq 1 20); do
    docker compose exec -T agent broker ping >/dev/null 2>&1 && { up=1; break; }
    sleep 1
  done
  if [[ -z "$up" ]]; then
    warn "The broker isn't answering yet — give it a minute, then try 'yodacode doctor'."
  else
    FL_HOST=""; FL_PATH=""; FL_LABEL=""
    for (( j=1; j<=CN_SVC_COUNT; j++ )); do
      sv="CN_SVC_${j}_SELECTED"; tp="CN_SVC_${j}_TESTPATH"
      [[ -n "${!sv}" && -n "${!tp}" ]] || continue
      h="CN_SVC_${j}_HOST"; l2="CN_SVC_${j}_LABEL"
      FL_HOST="${!h}"; FL_PATH="${!tp}"; FL_LABEL="${!l2}"; break
    done
    if [[ -n "$FL_HOST" ]]; then
      tj="$(python3 -c 'import json,sys; print(json.dumps({"host": sys.argv[1], "path": sys.argv[2], "method": "GET"}))' "$FL_HOST" "$FL_PATH")"
      tout="$(mktemp)"
      if docker compose exec -T agent broker call http_call "$tj" >"$tout" 2>&1; then
        ok "$FL_LABEL connected${CN_ACCOUNT:+ as $CN_ACCOUNT} — verified through the broker. ✅"
      else
        TEST_FAILED=1
        warn "Stored, but the broker's test call failed:"
        tail -c 300 "$tout" 2>/dev/null | tr -d '\0' | sed 's/^/    /'
        note "Run 'yodacode doctor' for a diagnosis."
      fi
      rm -f "$tout"
    fi
  fi
  # Refresh the agent's capability doc so its next reply knows the service
  # exists. Never as root: root-owned workspace files break later runs.
  PUID_V="$(env_get PUID)"; PGID_V="$(env_get PGID)"
  docker compose exec -T -u "${PUID_V:-1000}:${PGID_V:-1000}" agent \
    python3 /app/workspace/bin/refresh-capabilities.py >/dev/null 2>&1 || true
else
  note "The bot isn't running — the sign-in is stored and goes live on 'yodacode start'."
fi

echo ""
if [[ "$TEST_FAILED" == 1 ]]; then
  warn "Stored but unverified — see above, then 'yodacode doctor'."
  exit 2
fi
[[ -n "$CN_PENDING_FILE" ]] && rm -f "$CN_PENDING_FILE"
[[ "$CN_PUBLISHED" == 0 ]] && warn "Reminder: publish the app to 'In production' or this sign-in dies in 7 days."
ok "Done. Back in Slack, just ask $BOT_NAME to use $CN_PROVIDER_LABEL."
