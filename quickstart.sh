#!/usr/bin/env bash
# YodaCode guided installer — fresh Linux server → running, personalised bot.
#
#   git clone https://github.com/ProvanceMedia/yodacode.git && cd yodacode
#   ./quickstart.sh
set -uo pipefail
cd "$(dirname "$0")"

# ── palette ───────────────────────────────────────────────────────────────────
C='\033[38;5;43m'   # teal accent
G='\033[32m'; Y='\033[33m'; R='\033[31m'
B='\033[1m'; D='\033[2m'; X='\033[0m'

banner() {
  echo ""
  echo -e "${C}${B}  ╦ ╦╔═╗╔╦╗╔═╗╔═╗╔═╗╔╦╗╔═╗${X}"
  echo -e "${C}${B}  ╚╦╝║ ║ ║║╠═╣║  ║ ║ ║║║╣ ${X}"
  echo -e "${C}${B}   ╩ ╚═╝═╩╝╩ ╩╚═╝╚═╝═╩╝╚═╝${X}"
  echo -e "  ${D}your own Claude, running on your server${X}"
  echo ""
}

step()  { echo ""; echo -e "${C}${B}━━━ Step $1/6 · $2 ━━━${X}"; echo ""; }
ok()    { echo -e "  ${G}✓${X} $1"; }
warn()  { echo -e "  ${Y}!${X} $1"; }
fail()  { echo -e "  ${R}✗${X} $1"; }
note()  { echo -e "  ${D}$1${X}"; }
ask()   { local p="$1" d="${2:-}" v; if [[ -n "$d" ]]; then read -r -p "  $(echo -e "${B}$p${X}") [${d}] " v; echo "${v:-$d}"; else read -r -p "  $(echo -e "${B}$p${X}") " v; echo "$v"; fi; }

SUDO=""; [[ $EUID -ne 0 ]] && SUDO="sudo"
ENVF=".env"
set_env() {
  if [[ -f "$ENVF" ]] && grep -q "^$1=" "$ENVF" 2>/dev/null; then
    grep -v "^$1=" "$ENVF" > "$ENVF.tmp" || true   # grep -v exits 1 on empty output
    mv "$ENVF.tmp" "$ENVF"
  fi
  printf '%s=%s\n' "$1" "$2" >> "$ENVF"
}

# ── subcommand: addkey ────────────────────────────────────────────────────────
# Securely register a service API key with the broker. The secret value is read
# here on the server and written only to .env (mounted into the broker container);
# the agent never sees it. The host→key mapping goes into broker/auth-hosts.json.
if [[ "${1:-}" == "addkey" ]]; then
  echo ""
  echo -e "${C}${B}Add an API key${X}"
  echo "  Pick a service (the key stays on this server — the bot never sees it):"
  echo "    1) GitHub      2) Stripe      3) OpenAI"
  echo "    4) Anything else (you provide the host + scheme)"
  echo ""
  pick="$(ask 'Choice' '1')"
  case "$pick" in
    1) HOST=api.github.com;  SCHEME=bearer; KEYNAME=GITHUB_PAT;     EXTRA='"extraHeaders":{"Accept":"application/vnd.github+json","User-Agent":"yodacode"}' ;;
    2) HOST=api.stripe.com;  SCHEME=basic;  KEYNAME=STRIPE_API_KEY; EXTRA='"basicPassword":""' ;;
    3) HOST=api.openai.com;  SCHEME=bearer; KEYNAME=OPENAI_API_KEY; EXTRA='' ;;
    *) HOST="$(ask 'API host (e.g. api.example.com)' '')"
       echo "  Auth style:  1) Bearer token   2) custom header   3) ?query= param   4) HTTP basic"
       st="$(ask 'Style' '1')"
       case "$st" in
         2) HN="$(ask 'Header name (e.g. X-API-Key)' 'X-API-Key')"; SCHEME=header; EXTRA="\"headerName\":\"$HN\"" ;;
         3) QP="$(ask 'Query param name (e.g. api_key)' 'api_key')"; SCHEME=query; EXTRA="\"queryParam\":\"$QP\"" ;;
         4) SCHEME=basic; EXTRA='"basicPassword":""' ;;
         *) SCHEME=bearer; EXTRA='' ;;
       esac
       KEYNAME="$(ask 'Name this key (UPPER_SNAKE, e.g. EXAMPLE_API_KEY)' 'EXAMPLE_API_KEY')"
       KEYNAME="$(echo "$KEYNAME" | tr '[:lower:] -' '[:upper:]__' | tr -cd 'A-Z0-9_')" ;;
  esac
  [[ -z "${HOST:-}" || -z "${KEYNAME:-}" ]] && { fail "Need a host and a key name."; exit 1; }
  echo ""
  read -r -s -p "  Paste the secret value for $KEYNAME (hidden): " SECRET; echo ""
  [[ -z "$SECRET" ]] && { fail "No value entered."; exit 1; }

  [[ -f "$ENVF" ]] || cp .env.example "$ENVF"; chmod 600 "$ENVF"
  set_env "$KEYNAME" "$SECRET"
  AH="workspace/broker/auth-hosts.json"
  [[ -f "$AH" ]] || echo '{}' > "$AH"
  HOST="$HOST" SCHEME="$SCHEME" KEYNAME="$KEYNAME" EXTRA="$EXTRA" node -e '
    const fs=require("fs"); const f="workspace/broker/auth-hosts.json";
    const o=JSON.parse(fs.readFileSync(f,"utf8"));
    const e=JSON.parse("{\"scheme\":\""+process.env.SCHEME+"\",\"vaultKey\":\""+process.env.KEYNAME+"\""+(process.env.EXTRA?","+process.env.EXTRA:"")+"}");
    o[process.env.HOST]=e; fs.writeFileSync(f,JSON.stringify(o,null,2)+"\n");
  ' || { fail "Failed to update auth-hosts.json"; exit 1; }
  ok "Stored $KEYNAME and mapped $HOST (scheme: $SCHEME)."
  note "Reloading the broker…"
  docker compose restart broker >/dev/null 2>&1 || docker compose up -d >/dev/null 2>&1 || true
  ok "Done. Ask the bot to use $HOST — e.g. \"fetch my latest from $HOST\"."
  exit 0
fi

banner
echo "  This sets up your assistant from scratch — about 5 minutes. You'll need:"
echo "    • a Claude subscription (Max recommended) + a browser on your laptop/phone"
echo "    • the ability to add an app to your Slack workspace"
echo ""
read -r -p "  Press Enter to begin (Ctrl-C to quit) " _

# ── already configured? ───────────────────────────────────────────────────────
if [[ -f "$ENVF" ]] && grep -q '^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-' "$ENVF" 2>/dev/null \
   && grep -q '^SLACK_BOT_TOKEN=xoxb-' "$ENVF" 2>/dev/null && ! grep -q 'xoxb-your-bot-token' "$ENVF" 2>/dev/null; then
  ok "Found an existing setup ($(grep -m1 '^BOT_NAME=' "$ENVF" | cut -d= -f2-) for $(grep -m1 '^USER_NAME=' "$ENVF" | cut -d= -f2-))."
  a=$(ask "(S)tart it, or (R)econfigure from scratch?" "S")
  if [[ ! "${a,,}" =~ ^r ]]; then docker compose up -d --build && ok "Starting — watch with: docker compose logs -f agent"; exit $?; fi
fi

# ── 1 · Docker ────────────────────────────────────────────────────────────────
step 1 "Docker"
wait_for_apt() {
  command -v fuser >/dev/null 2>&1 || return 0
  local locks="/var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock" waited=0
  while $SUDO fuser $locks >/dev/null 2>&1; do
    (( waited == 0 )) && warn "Server is finishing first-boot updates — waiting (normal on a new machine)…"
    sleep 5; waited=$((waited+5)); (( waited >= 600 )) && { fail "Still locked after 10 min — try again shortly."; return 1; }
  done; (( waited > 0 )) && ok "Updates finished."; return 0
}
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1) already installed."
else
  note "Installing Docker (runs the bot in an isolated container)…"
  [[ $EUID -ne 0 ]] && ! command -v sudo >/dev/null 2>&1 && { fail "Needs root: sudo ./quickstart.sh"; exit 1; }
  wait_for_apt || exit 1; installed=0
  for a in 1 2; do curl -fsSL https://get.docker.com | $SUDO sh >/dev/null 2>&1 && { installed=1; break; }; warn "Retry…"; sleep 10; wait_for_apt || break; done
  [[ "$installed" == 1 ]] || { fail "Docker install failed. Try: curl -fsSL https://get.docker.com | sh"; exit 1; }
  $SUDO systemctl enable --now docker 2>/dev/null || true; ok "Docker installed."
fi

# ── 2 · Build ─────────────────────────────────────────────────────────────────
step 2 "Building"
note "Building the image (3–5 min on a small server — grab a coffee)…"
if docker compose build >/tmp/yc-build.log 2>&1; then ok "Image built."; else
  fail "Build failed — last lines:"; tail -8 /tmp/yc-build.log | sed 's/^/    /'
  note "Low memory? add swap: fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"; exit 1
fi

# ── 3 · Claude sign-in ────────────────────────────────────────────────────────
step 3 "Sign in to Claude"
echo "  Runs on your Claude subscription — no API key, no extra billing."
echo -e "  A helper starts now and prints a ${B}URL${X}:"
echo -e "    1. open it in the browser on your ${B}laptop or phone${X}"
echo "    2. sign in to Claude and approve"
echo "    3. copy the code it gives you, paste it back here"
echo ""
read -r -p "  Press Enter to start sign-in… " _
docker compose run --rm --no-deps --entrypoint claude agent setup-token || true
echo ""
echo -e "  It printed a token starting ${B}sk-ant-oat01-${X}."
CLAUDE_TOKEN=""
for t in 1 2 3; do
  read -r -p "  Paste it here: " CLAUDE_TOKEN; CLAUDE_TOKEN="$(echo "$CLAUDE_TOKEN" | tr -d '[:space:]')"
  [[ "$CLAUDE_TOKEN" == sk-ant-oat01-* ]] && break
  fail "Should start with sk-ant-oat01- ($((3-t)) left)"; CLAUDE_TOKEN=""
done
[[ -n "$CLAUDE_TOKEN" ]] || { fail "No valid token. Re-run ./quickstart.sh."; exit 1; }
note "Checking it works…"
if docker compose run --rm --no-deps -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOKEN" -e ANTHROPIC_API_KEY= \
     --entrypoint claude agent -p "say OK" --output-format json 2>/dev/null | grep -q '"result"[: ]*"OK"'; then
  ok "Signed in to Claude."; else warn "Couldn't verify just now — continuing (may still work)."; fi

# ── 4 · Personalise ───────────────────────────────────────────────────────────
step 4 "Personalise your assistant"
echo "  Let's give it a name and tell it who you are."
echo ""
BOT_NAME="$(ask 'What should your assistant be called?' 'Yoda')"
BOT_NAME="$(echo "$BOT_NAME" | tr -cd '[:alnum:] ' | sed 's/^ *//;s/ *$//')"; [[ -z "$BOT_NAME" ]] && BOT_NAME="Yoda"
USER_NAME="$(ask "What should ${BOT_NAME} call you?" 'friend')"
USER_NAME="$(echo "$USER_NAME" | tr -cd '[:alnum:] ' | sed 's/^ *//;s/ *$//')"; [[ -z "$USER_NAME" ]] && USER_NAME="friend"
echo ""
echo -e "  ${B}Your Slack member ID${X} — so ${BOT_NAME} knows it's you and replies to your DMs."
echo -e "  ${D}Find it: in Slack click your profile photo → Profile → the ⋮ (More) → Copy member ID.${X}"
echo -e "  ${D}It starts with a U, e.g. U01ABC2DEF3.${X}"
echo ""
SLACK_UID=""
for t in 1 2 3; do
  read -r -p "  Paste your Slack member ID: " SLACK_UID; SLACK_UID="$(echo "$SLACK_UID" | tr -d '[:space:]')"
  [[ "$SLACK_UID" =~ ^[UW][A-Z0-9]{6,}$ ]] && break
  fail "That doesn't look like a member ID (starts with U). ($((3-t)) left)"; SLACK_UID=""
done
[[ -n "$SLACK_UID" ]] || { fail "Need your member ID so the bot will reply to you. Re-run ./quickstart.sh."; exit 1; }
echo ""
USER_CTX="$(ask "Anything ${BOT_NAME} should know about you? (one line, or Enter to skip)" '')"
TZ_GUESS="$(cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || echo UTC)"

# render persona files from templates into the workspace
render() { sed -e "s/{{BOT_NAME}}/$BOT_NAME/g" -e "s/{{USER_NAME}}/$USER_NAME/g" -e "s|{{TIMEZONE}}|$TZ_GUESS|g" "templates/$1.template" > "workspace/$1"; }
for f in CLAUDE.md IDENTITY.md USER.md MEMORY.md; do [[ -f "templates/$f.template" ]] && render "$f"; done
if [[ -n "$USER_CTX" ]] && [[ -f workspace/USER.md ]]; then
  # drop the context under the Context heading
  awk -v c="$USER_CTX" '/^\*\(Fill this in/{print "- " c; next} {print}' workspace/USER.md > workspace/USER.md.tmp && mv workspace/USER.md.tmp workspace/USER.md
fi
ok "Persona written — ${BOT_NAME}, assisting ${USER_NAME} (${TZ_GUESS})."

# ── 5 · Slack app ─────────────────────────────────────────────────────────────
step 5 "Create the Slack app"
echo "  Two minutes of clicking — fully guided."
echo ""
echo -e "    1. open  ${B}https://api.slack.com/apps?new_app=1${X}"
echo -e "    2. choose ${B}\"From a manifest\"${X} → pick your workspace"
echo -e "    3. clear the box, paste this (works on the JSON or YAML tab), ${B}Next${X} → ${B}Create${X}:"
echo ""
echo -e "  ${C}┄┄┄ copy from here ┄┄┄${X}"
sed "s/\"YodaCode\"/\"$BOT_NAME\"/g" scripts/slack-app-manifest.json | sed 's/^/  /'
echo -e "  ${C}┄┄┄ to here ┄┄┄┄┄┄┄┄┄${X}"
echo ""
echo -e "    4. left menu ${B}Install App${X} → ${B}Install to Workspace${X} → Allow"
echo -e "       copy the ${B}Bot User OAuth Token${X} (xoxb-…)"
echo ""
SLACK_BOT=""
for t in 1 2 3; do
  read -r -p "  Paste the Bot token (xoxb-…): " SLACK_BOT; SLACK_BOT="$(echo "$SLACK_BOT" | tr -d '[:space:]')"
  if [[ "$SLACK_BOT" == xoxb-* ]]; then
    au=$(curl -s -H "Authorization: Bearer $SLACK_BOT" https://slack.com/api/auth.test || true)
    grep -q '"ok":true' <<<"$au" && { ok "Connected to $(grep -o '"team":"[^"]*"' <<<"$au" | cut -d'"' -f4) ✓"; break; }
    fail "Slack rejected it — re-copy from OAuth & Permissions. ($((3-t)) left)"
  else fail "Bot tokens start with xoxb-. ($((3-t)) left)"; fi
  SLACK_BOT=""
done
[[ -n "$SLACK_BOT" ]] || { fail "No valid bot token. Re-run ./quickstart.sh."; exit 1; }
echo ""
echo -e "    5. ${B}Basic Information${X} → ${B}App-Level Tokens${X} → ${B}Generate Token${X}"
echo -e "       add scope ${B}connections:write${X} → Generate → copy it (xapp-…)"
echo ""
SLACK_APP=""
for t in 1 2 3; do
  read -r -p "  Paste the App-Level token (xapp-…): " SLACK_APP; SLACK_APP="$(echo "$SLACK_APP" | tr -d '[:space:]')"
  if [[ "$SLACK_APP" == xapp-* ]]; then
    cn=$(curl -s -X POST -H "Authorization: Bearer $SLACK_APP" https://slack.com/api/apps.connections.open || true)
    grep -q '"ok":true' <<<"$cn" && { ok "App-level token works ✓"; break; }
    fail "Rejected — needs the connections:write scope. ($((3-t)) left)"
  else fail "App-level tokens start with xapp-. ($((3-t)) left)"; fi
  SLACK_APP=""
done
[[ -n "$SLACK_APP" ]] || { fail "No valid app token. Re-run ./quickstart.sh."; exit 1; }

# ── write config ──────────────────────────────────────────────────────────────
[[ -f "$ENVF" ]] || cp .env.example "$ENVF"; chmod 600 "$ENVF"
set_env CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_TOKEN"
set_env SLACK_BOT_TOKEN "$SLACK_BOT"
set_env SLACK_APP_TOKEN "$SLACK_APP"
set_env YODA_DM_AUTHORIZED_USERS "$SLACK_UID"
set_env BOT_NAME "$BOT_NAME"
set_env USER_NAME "$USER_NAME"
set_env TZ "$TZ_GUESS"
ok "Configuration saved."

# ── 6 · Launch + smoke test ───────────────────────────────────────────────────
step 6 "Launch"
docker compose up -d >/dev/null 2>&1 || { fail "Start failed — check: docker compose logs"; exit 1; }
note "Starting…"
ready=0; for i in $(seq 1 30); do docker compose logs agent 2>/dev/null | grep -q '"msg":"slack: ready"' && { ready=1; break; }; sleep 2; done
[[ "$ready" == 1 ]] && ok "Connected to Slack." || warn "No 'slack: ready' yet — check: docker compose logs -f agent"

echo ""
note "Quick test — asking ${BOT_NAME} to say hello (proves Claude + the agent work):"
echo ""
reply=$(docker compose exec -T agent claude -p "You are ${BOT_NAME}. In one short, friendly sentence, introduce yourself to ${USER_NAME} and say you're ready." 2>/dev/null | head -c 400)
if [[ -n "$reply" ]]; then echo -e "  ${C}${B}${BOT_NAME}:${X} ${reply}"; ok "${BOT_NAME} is responding."; else warn "No reply from the test — check: docker compose logs agent"; fi

echo ""
echo -e "  ${G}${B}🎉 ${BOT_NAME} is live.${X}  Open Slack and DM ${BOT_NAME} — say hello."
echo ""
echo "  Manage it from this folder:"
echo "    docker compose logs -f agent     # watch it think"
echo "    docker compose restart           # after changing settings"
echo "    docker compose down              # stop"
echo ""
echo -e "  ${B}Add API keys any time:${X} in Slack, DM ${BOT_NAME} \`/help\` — it'll walk you through it."
echo "  Keys live in a separate broker container; ${BOT_NAME} itself never sees them."
