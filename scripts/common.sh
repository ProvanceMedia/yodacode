#!/usr/bin/env bash
# Shared helpers for the YodaCode installer (quickstart.sh) and the day-to-day
# CLI (./yodacode). Source this AFTER `set -uo pipefail` and after cd'ing to the
# repo root — the functions use repo-relative paths (.env, templates/, workspace/).

# ── palette ─────────────────────────────────────────────────────────────────
# ANSI-C quoting ($'…') stores real escape BYTES, so the colours render with
# plain echo/printf too — a literal '\033[1m' string only renders under
# `echo -e` and prints as garbage everywhere else.
C=$'\033[38;5;43m'   # teal accent
G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'
B=$'\033[1m'; D=$'\033[2m'; X=$'\033[0m'

banner() {
  echo ""
  echo -e "${C}${B}  ╦ ╦╔═╗╔╦╗╔═╗╔═╗╔═╗╔╦╗╔═╗${X}"
  echo -e "${C}${B}  ╚╦╝║ ║ ║║╠═╣║  ║ ║ ║║║╣ ${X}"
  echo -e "${C}${B}   ╩ ╚═╝═╩╝╩ ╩╚═╝╚═╝═╩╝╚═╝${X}"
  echo -e "  ${D}your own Claude, running on your server${X}"
  echo ""
}

ok()    { echo -e "  ${G}✓${X} $1"; }
warn()  { echo -e "  ${Y}!${X} $1"; }
fail()  { echo -e "  ${R}✗${X} $1"; }
note()  { echo -e "  ${D}$1${X}"; }
title() { echo ""; echo -e "${C}${B}$1${X}"; echo ""; }
ask()   { local p="$1" d="${2:-}" v; if [[ -n "$d" ]]; then read -r -p "  $(echo -e "${B}$p${X}") [${d}] " v; echo "${v:-$d}"; else read -r -p "  $(echo -e "${B}$p${X}") " v; echo "$v"; fi; }

# ── spinner ─────────────────────────────────────────────────────────────────
SPIN_FRAMES=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
SPIN_PID=""
kill_tree() { local p; for p in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$p"; done; kill -TERM "$1" 2>/dev/null; }
spin() {
  # spin "message" logfile cmd [args…] — run cmd (output → logfile) behind an
  # animated spinner + elapsed clock, so long steps visibly make progress.
  local msg="$1" log="$2"; shift 2
  if [[ ! -t 1 ]]; then note "$msg"; "$@" >"$log" 2>&1; return $?; fi
  "$@" >"$log" 2>&1 &
  SPIN_PID=$!
  local start=$SECONDS i=0 rc el t
  printf '\033[?25l\033[?7l'   # hide cursor, no line-wrap (narrow terminals)
  while kill -0 "$SPIN_PID" 2>/dev/null; do
    el=$((SECONDS - start))
    if (( el >= 60 )); then t="$((el/60))m$((el%60))s"; else t="${el}s"; fi
    printf '\r  %b%s%b %s %b%s%b ' "$C" "${SPIN_FRAMES[i % ${#SPIN_FRAMES[@]}]}" "$X" "$msg" "$D" "$t" "$X"
    i=$((i+1)); sleep 0.15
  done
  wait "$SPIN_PID"; rc=$?; SPIN_PID=""
  printf '\r\033[K\033[?25h\033[?7h'
  # drain lines typed during the spin so they can't auto-answer the next prompt
  if [[ -t 0 ]]; then while read -r -t 0; do IFS= read -r -s -t 0.01 _ || break; done; fi
  return $rc
}
spin_abort() {
  # Ctrl-C/TERM mid-spin: the bg job ignores SIGINT (async children get
  # SIG_IGN), so TERM its whole tree before exiting — else an orphaned
  # apt-get keeps the dpkg locks and stalls the next run.
  [[ -n "${SPIN_PID:-}" ]] && kill_tree "$SPIN_PID"
  exit 130
}
trap spin_abort INT TERM
[[ -t 1 ]] && trap 'printf "\033[?25h\033[?7h"' EXIT   # never leave the cursor hidden

# ── timezone helpers ─────────────────────────────────────────────────────────
tz_all() {
  # Every IANA zone name this host knows about, one per line.
  if command -v timedatectl >/dev/null 2>&1; then
    timedatectl list-timezones 2>/dev/null && return 0
  fi
  [[ -d /usr/share/zoneinfo ]] && find /usr/share/zoneinfo \( -type f -o -type l \) 2>/dev/null \
    | sed 's|^/usr/share/zoneinfo/||' \
    | grep -E '^(Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific|UTC)' | sort -u
  return 0
}
resolve_tz() {
  # Natural language → IANA zone: "London"/"UK" → Europe/London,
  # "New York" → America/New_York. Exact zone names pass straight through.
  local raw key cand city
  raw="$(echo "$1" | sed 's/^ *//;s/ *$//')"
  [[ -z "$raw" ]] && return 1
  key="$(echo "$raw" | tr '[:upper:]' '[:lower:]')"
  cand=""
  case "$key" in
    uk|gb|england|britain|"great britain"|"united kingdom"|scotland|wales|"northern ireland") cand="Europe/London" ;;
    ireland) cand="Europe/Dublin" ;;
    us|usa|"united states"|america|eastern|est|edt|"east coast") cand="America/New_York" ;;
    central|cst|cdt|texas) cand="America/Chicago" ;;
    mountain|mst|mdt) cand="America/Denver" ;;
    pacific|pst|pdt|"west coast"|california) cand="America/Los_Angeles" ;;
    arizona) cand="America/Phoenix" ;;
    alaska) cand="America/Anchorage" ;;
    hawaii) cand="Pacific/Honolulu" ;;
    canada) cand="America/Toronto" ;;
    mexico) cand="America/Mexico_City" ;;
    brazil) cand="America/Sao_Paulo" ;;
    germany) cand="Europe/Berlin" ;;
    france) cand="Europe/Paris" ;;
    spain) cand="Europe/Madrid" ;;
    italy) cand="Europe/Rome" ;;
    netherlands|holland) cand="Europe/Amsterdam" ;;
    portugal) cand="Europe/Lisbon" ;;
    poland) cand="Europe/Warsaw" ;;
    sweden) cand="Europe/Stockholm" ;;
    norway) cand="Europe/Oslo" ;;
    denmark) cand="Europe/Copenhagen" ;;
    switzerland) cand="Europe/Zurich" ;;
    austria) cand="Europe/Vienna" ;;
    belgium) cand="Europe/Brussels" ;;
    greece) cand="Europe/Athens" ;;
    turkey) cand="Europe/Istanbul" ;;
    russia) cand="Europe/Moscow" ;;
    ukraine) cand="Europe/Kyiv" ;;
    india|mumbai|delhi|"new delhi"|bangalore|bengaluru) cand="Asia/Kolkata" ;;
    china|beijing) cand="Asia/Shanghai" ;;
    japan) cand="Asia/Tokyo" ;;
    korea|"south korea") cand="Asia/Seoul" ;;
    uae|"united arab emirates") cand="Asia/Dubai" ;;
    israel) cand="Asia/Jerusalem" ;;
    "south africa") cand="Africa/Johannesburg" ;;
    australia) cand="Australia/Sydney" ;;
    nz|"new zealand") cand="Pacific/Auckland" ;;
    utc|gmt) echo "UTC"; return 0 ;;   # always valid, even without tzdata
  esac
  if [[ -n "$cand" ]] && tz_all | grep -qx "$cand"; then echo "$cand"; return 0; fi
  city="$(echo "$key" | sed 's/ /_/g')"
  cand="$(tz_all | grep -ixm1 -- "$city")";        [[ -n "$cand" ]] && { echo "$cand"; return 0; }  # exact id, any case
  cand="$(tz_all | grep -im1 -- "/${city}\$")";    [[ -n "$cand" ]] && { echo "$cand"; return 0; }  # city: new_york → America/New_York
  if [[ ${#city} -ge 4 ]]; then  # loose match anchored at a path segment: kolk → Asia/Kolkata.
    # ≥4 chars so 3-letter fragments don't silently resolve (e.g. "man" → America/Managua).
    cand="$(tz_all | grep -im1 -- "/${city}")";    [[ -n "$cand" ]] && { echo "$cand"; return 0; }
  fi
  return 1
}

# Ask for a timezone in plain language; sets the global TZ_FINAL. Falls back to
# UTC after 3 misses. Pass a default (e.g. the current TZ) as $1.
ask_timezone() {
  local def="${1:-UTC}" tz_in pick lc t
  [[ -z "$def" || "$def" == Etc/* ]] && def="UTC"
  TZ_FINAL=""
  for t in 1 2 3; do
    tz_in="$(ask 'Your timezone? (city or country — e.g. London, New York, UK)' "$def")"
    lc="$(echo "$tz_in" | tr '[:upper:]' '[:lower:]' | sed 's/^ *//;s/ *$//')"
    case "$lc" in
      us|usa|"united states"|"united states of america"|america)
        echo "    The US has a few — which is closest?"
        echo "    1) New York (Eastern)  2) Chicago (Central)  3) Denver (Mountain)  4) Los Angeles (Pacific)"
        pick="$(ask 'Choice (1-4, or type your nearest big city)' '1')"
        case "$pick" in [1-4]\)|[1-4].) pick="${pick:0:1}" ;; esac   # tolerate "2)" / "3."
        case "$pick" in
          2) tz_in="Chicago" ;; 3) tz_in="Denver" ;; 4) tz_in="Los Angeles" ;; 1|"") tz_in="New York" ;;
          *) tz_in="$pick" ;;   # typed a city (Phoenix, Honolulu, Anchorage…) — resolve it below
        esac ;;
    esac
    TZ_FINAL="$(resolve_tz "$tz_in")" && break
    fail "Couldn't match \"$tz_in\" to a timezone — try a nearby big city. ($((3-t)) tries left)"
    TZ_FINAL=""
  done
  [[ -n "$TZ_FINAL" ]] || { TZ_FINAL="UTC"; warn "Sticking with UTC — change TZ= in .env any time."; }
  ok "Timezone: ${TZ_FINAL} — local time there is $(TZ="$TZ_FINAL" date +'%H:%M')."
}

# ── .env helpers ─────────────────────────────────────────────────────────────
SUDO=""; [[ ${EUID:-$(id -u)} -ne 0 ]] && SUDO="sudo"
ENVF=".env"
ensure_env() { [[ -f "$ENVF" ]] || cp .env.example "$ENVF"; chmod 600 "$ENVF" 2>/dev/null || true; }
set_env() {
  ensure_env
  if grep -q "^$1=" "$ENVF" 2>/dev/null; then
    grep -v "^$1=" "$ENVF" > "$ENVF.tmp" || true   # grep -v exits 1 on empty output
    mv "$ENVF.tmp" "$ENVF"
  fi
  printf '%s=%s\n' "$1" "$2" >> "$ENVF"
  chmod 600 "$ENVF" 2>/dev/null || true   # the tmp+mv replace path drops to 644 otherwise — .env holds tokens
}
# Strip a trailing CR so values survive a .env edited on Windows (CRLF), which
# would otherwise break exact comparisons like `[[ "$(env_get X)" == 1 ]]`.
env_get() { [[ -f "$ENVF" ]] && grep -m1 "^$1=" "$ENVF" 2>/dev/null | cut -d= -f2- | tr -d '\r' || true; }

# ── persona ──────────────────────────────────────────────────────────────────
# Render one template into the workspace, substituting persona vars. Relies on
# the globals BOT_NAME / USER_NAME / TZ_FINAL.
render_persona() {
  sed -e "s/{{BOT_NAME}}/$BOT_NAME/g" -e "s/{{USER_NAME}}/$USER_NAME/g" -e "s|{{TIMEZONE}}|$TZ_FINAL|g" \
      -e "s|{{INSTALL_DIR}}|$PWD|g" -e "s|{{DATE}}|$(date +%F)|g" \
    "templates/$1.template" > "workspace/$1"
}

# TOOLS.local.md — the agent's per-install service notes, split out of the
# tracked TOOLS.md so framework updates never collide with local notes.
#   • migrate: older installs (or an agent that ignored the redirect) keep notes
#     in the tracked TOOLS.md. If it diverges from HEAD, rescue those additions
#     into TOOLS.local.md and restore TOOLS.md so a pull fast-forwards cleanly.
#   • ensure: render the starter from the template when the file is absent.
# Idempotent, zero-loss, and safe outside a git checkout. Needs no persona vars,
# so it is callable from the update path where those globals aren't set.
ensure_tools_local() {
  local dest="workspace/TOOLS.local.md"
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
     && ! git diff --quiet HEAD -- workspace/TOOLS.md 2>/dev/null; then
    # Rescue the operator's ADDED lines before restoring TOOLS.md, so nothing is
    # lost. awk keys off the first @@ hunk header, so every diff header (which
    # precedes it) is skipped, and substr($0,2) strips exactly the one '+' marker
    # git adds — preserving note lines whose own content starts with '+' (markdown
    # bullets, phone numbers, pasted diffs) and blank added lines.
    local rescued
    rescued="$(git diff HEAD -- workspace/TOOLS.md | awk '/^@@/{h=1;next} h && /^\+/{print substr($0,2)}')"
    if printf '%s' "$rescued" | grep -q '[^[:space:]]'; then   # only real content
      [[ -f "$dest" ]] || printf '# TOOLS.local.md — your service notes\n' > "$dest"
      { printf '\n<!-- recovered from your edited TOOLS.md on %s -->\n' "$(date +%F)"
        printf '%s\n' "$rescued"; } >> "$dest"
      note "Rescued your TOOLS.md notes into TOOLS.local.md (framework updates won't touch it)."
    fi
    git checkout HEAD -- workspace/TOOLS.md 2>/dev/null || true
  fi
  # Guarantee the file exists so CLAUDE.md's @-import is never left dangling —
  # from the template when present, else a minimal stub.
  if [[ ! -f "$dest" ]]; then
    if [[ -f templates/TOOLS.local.md.template ]]; then
      cp templates/TOOLS.local.md.template "$dest"
    else
      printf '# TOOLS.local.md — your service notes\n\nAdd notes on connected services here.\n' > "$dest"
    fi
  fi
}

# Collect name / user name / context / timezone, render persona docs, persist to
# .env. Pre-fills from existing .env so it doubles as a reconfigure step. Sets
# globals BOT_NAME, USER_NAME, TZ_FINAL.
configure_persona() {
  ensure_env
  local cur_bot cur_user cur_tz
  cur_bot="$(env_get BOT_NAME)"; cur_user="$(env_get USER_NAME)"; cur_tz="$(env_get TZ)"
  BOT_NAME="$(ask 'What should your assistant be called?' "${cur_bot:-Yoda}")"
  BOT_NAME="$(echo "$BOT_NAME" | tr -cd '[:alnum:] ' | sed 's/^ *//;s/ *$//')"; [[ -z "$BOT_NAME" ]] && BOT_NAME="Yoda"
  USER_NAME="$(ask "What should ${BOT_NAME} call you?" "${cur_user:-friend}")"
  USER_NAME="$(echo "$USER_NAME" | tr -cd '[:alnum:] ' | sed 's/^ *//;s/ *$//')"; [[ -z "$USER_NAME" ]] && USER_NAME="friend"
  echo ""
  local USER_CTX
  USER_CTX="$(ask "Anything ${BOT_NAME} should know about you? (one line, or Enter to skip)" '')"
  echo ""
  # Timezone — plain language, resolved to an IANA zone so reminders and crons
  # fire at *your* local time, not the server's.
  ask_timezone "$cur_tz"

  local f
  for f in CLAUDE.md IDENTITY.md USER.md MEMORY.md; do [[ -f "templates/$f.template" ]] && render_persona "$f"; done
  ensure_tools_local   # seed the agent's per-install service-notes file
  if [[ -n "$USER_CTX" ]] && [[ -f workspace/USER.md ]]; then
    awk -v c="$USER_CTX" '/^\*\(Fill this in/{print "- " c; next} {print}' workspace/USER.md > workspace/USER.md.tmp && mv workspace/USER.md.tmp workspace/USER.md
  fi
  set_env BOT_NAME "$BOT_NAME"
  set_env USER_NAME "$USER_NAME"
  set_env TZ "$TZ_FINAL"
  ok "Persona written — ${BOT_NAME}, assisting ${USER_NAME}."
}

# Guide the user through creating/installing the Slack app and collect the two
# tokens + their member ID. Pre-fills the member ID from .env. Sets globals
# SLACK_BOT, SLACK_APP, SLACK_UID and persists them.
configure_slack() {
  ensure_env
  : "${BOT_NAME:=$(env_get BOT_NAME)}"; : "${BOT_NAME:=Yoda}"
  local cur_uid t au cn
  cur_uid="$(env_get YODA_DM_AUTHORIZED_USERS)"

  echo -e "  ${B}Your Slack member ID${X} — so ${BOT_NAME} knows it's you and replies to your DMs."
  echo -e "  ${D}Find it: in Slack click your profile photo → Profile → the ⋮ (More) → Copy member ID.${X}"
  echo -e "  ${D}It starts with a U, e.g. U01ABC2DEF3.${X}"
  echo ""
  SLACK_UID=""
  for t in 1 2 3; do
    if [[ -n "$cur_uid" ]]; then
      read -r -p "  Paste your Slack member ID (Enter to keep ${cur_uid}): " SLACK_UID
      SLACK_UID="$(echo "${SLACK_UID:-$cur_uid}" | tr -d '[:space:]')"
    else
      read -r -p "  Paste your Slack member ID: " SLACK_UID; SLACK_UID="$(echo "$SLACK_UID" | tr -d '[:space:]')"
    fi
    [[ "$SLACK_UID" =~ ^[UW][A-Z0-9]{6,}$ ]] && break
    fail "That doesn't look like a member ID (starts with U). ($((3-t)) left)"; SLACK_UID=""
  done
  [[ -n "$SLACK_UID" ]] || { fail "Need your member ID so the bot will reply to you."; return 1; }
  echo ""
  echo "  Create the Slack app — two minutes of clicking:"
  echo ""
  echo -e "    1. open  ${B}https://api.slack.com/apps?new_app=1${X}"
  echo -e "    2. choose ${B}\"From a manifest\"${X} → pick your workspace"
  echo -e "    3. clear the box, paste this (works on the JSON or YAML tab), ${B}Next${X} → ${B}Create${X}:"
  echo ""
  echo -e "  ${C}┄┄┄ copy from here ┄┄┄${X}"
  # Personalise every "YodaCode" (app name, bot display name, and the slash
  # command descriptions — "Ask YodaCode using…"). Case-sensitive, so the
  # /yodacode command names themselves are untouched (the bot matches them
  # literally). Escape sed specials in case the name contains & or /.
  local bn_esc="${BOT_NAME//&/\\&}"; bn_esc="${bn_esc//\//\\/}"
  sed "s/YodaCode/$bn_esc/g" scripts/slack-app-manifest.json | sed 's/^/  /'
  echo -e "  ${C}┄┄┄ to here ┄┄┄┄┄┄┄┄┄${X}"
  echo ""
  echo -e "    4. left menu ${B}Install App${X} → ${B}Install to Workspace${X} → Allow"
  echo -e "       copy the ${B}Bot User OAuth Token${X} (xoxb-…)"
  echo ""
  SLACK_BOT=""
  for t in 1 2 3; do
    read -r -p "  Paste the Bot token (xoxb-…): " SLACK_BOT; SLACK_BOT="$(echo "$SLACK_BOT" | tr -d '[:space:]')"
    if [[ "$SLACK_BOT" == xoxb-* ]]; then
      local rc=0; au="$(curl -sS --max-time 10 -H "Authorization: Bearer $SLACK_BOT" https://slack.com/api/auth.test 2>/dev/null)" || rc=$?
      if [[ $rc -ne 0 || -z "$au" ]]; then
        warn "Couldn't reach Slack to verify (offline?) — accepting; it'll be checked when the bot connects."; break
      elif grep -q '"ok":true' <<<"$au"; then
        ok "Connected to $(grep -o '"team":"[^"]*"' <<<"$au" | cut -d'"' -f4) ✓"; break
      else fail "Slack rejected it — re-copy from OAuth & Permissions. ($((3-t)) left)"; fi
    else fail "Bot tokens start with xoxb-. ($((3-t)) left)"; fi
    SLACK_BOT=""
  done
  [[ -n "$SLACK_BOT" ]] || { fail "No valid bot token."; return 1; }
  echo ""
  echo -e "    5. ${B}Basic Information${X} → ${B}App-Level Tokens${X} → ${B}Generate Token${X}"
  echo -e "       add scope ${B}connections:write${X} → Generate → copy it (xapp-…)"
  echo ""
  SLACK_APP=""
  for t in 1 2 3; do
    read -r -p "  Paste the App-Level token (xapp-…): " SLACK_APP; SLACK_APP="$(echo "$SLACK_APP" | tr -d '[:space:]')"
    if [[ "$SLACK_APP" == xapp-* ]]; then
      local rc=0; cn="$(curl -sS --max-time 10 -X POST -H "Authorization: Bearer $SLACK_APP" https://slack.com/api/apps.connections.open 2>/dev/null)" || rc=$?
      if [[ $rc -ne 0 || -z "$cn" ]]; then
        warn "Couldn't reach Slack to verify (offline?) — accepting; it'll be checked when the bot connects."; break
      elif grep -q '"ok":true' <<<"$cn"; then ok "App-level token works ✓"; break
      else fail "Rejected — needs the connections:write scope. ($((3-t)) left)"; fi
    else fail "App-level tokens start with xapp-. ($((3-t)) left)"; fi
    SLACK_APP=""
  done
  [[ -n "$SLACK_APP" ]] || { fail "No valid app token."; return 1; }

  set_env SLACK_BOT_TOKEN "$SLACK_BOT"
  set_env SLACK_APP_TOKEN "$SLACK_APP"
  set_env YODA_DM_AUTHORIZED_USERS "$SLACK_UID"
  ok "Slack configured."
}

require_docker() {
  command -v docker >/dev/null 2>&1 && return 0
  fail "Docker isn't installed or not on PATH."
  note "Run ./quickstart.sh to install it, or check: yodacode doctor"
  exit 1
}

# ── CLI wrapper install ──────────────────────────────────────────────────────
# Drop a `yodacode` shim pointing at this repo's ./yodacode. Prefers
# /usr/local/bin when writable (root installs — already on every shell's
# PATH, so the command works IMMEDIATELY, no `source ~/.bashrc` dance);
# falls back to ~/.local/bin + shell-rc PATH persistence otherwise.
# Idempotent. Sets YC_WRAPPER_PATH_ADDED=1 when it had to add a dir to PATH
# (so the caller can tell the user to open a new shell).
YC_WRAPPER_PATH_ADDED=0
install_cli_wrapper() {
  local bindir="$HOME/.local/bin" target rcf persisted=0
  target="$(readlink -f ./yodacode 2>/dev/null || echo "$PWD/yodacode")"
  [[ -f "$target" ]] || return 0
  if [[ -d /usr/local/bin && -w /usr/local/bin ]]; then
    printf '#!/usr/bin/env bash\n# yodacode-shim: docker\nexec "%s" "$@"\n' "$target" > /usr/local/bin/yodacode
    chmod +x /usr/local/bin/yodacode
    # Remove a stale ~/.local/bin shim so there's exactly one launcher.
    rm -f "$HOME/.local/bin/yodacode" 2>/dev/null || true
    return 0
  fi
  mkdir -p "$bindir"
  # If an existing shim belongs to the legacy bundled-node installer, say so
  # rather than silently flipping the user between install modes.
  if [[ -f "$bindir/yodacode" ]] && grep -q 'install\.js' "$bindir/yodacode" 2>/dev/null; then
    warn "Replacing a previous (bundled-node) yodacode command with the Docker one."
  fi
  printf '#!/usr/bin/env bash\n# yodacode-shim: docker\nexec "%s" "$@"\n' "$target" > "$bindir/yodacode"
  chmod +x "$bindir/yodacode"
  case ":$PATH:" in
    *":$bindir:"*) ;;   # already on PATH — nothing to persist
    *) export PATH="$bindir:$PATH"; YC_WRAPPER_PATH_ADDED=1
       # Append to every shell rc that lacks the marker; if none exist at all,
       # guarantee one persistence file so a fresh shell still resolves it.
       for rcf in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
         [[ -f "$rcf" ]] || continue
         if grep -q 'YODACODE_PATH_ADDED' "$rcf" 2>/dev/null; then persisted=1; continue; fi
         printf '\n# YODACODE_PATH_ADDED\nexport PATH="%s:$PATH"\n' "$bindir" >> "$rcf"; persisted=1
       done
       [[ "$persisted" == 1 ]] || printf '\n# YODACODE_PATH_ADDED\nexport PATH="%s:$PATH"\n' "$bindir" >> "$HOME/.profile"
       ;;
  esac
}
