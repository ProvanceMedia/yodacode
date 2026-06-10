#!/usr/bin/env bash
# YodaCode guided installer — fresh Linux server → running bot, no prior setup needed.
#
#   git clone https://github.com/ProvanceMedia/yodacode.git && cd yodacode
#   ./quickstart.sh
#
# Walks you through everything: installs Docker, builds the image, signs you in to
# Claude, helps you create the Slack app, writes the config for you, and launches.
set -uo pipefail
cd "$(dirname "$0")"

Y='\033[33m'; G='\033[32m'; R='\033[31m'; B='\033[1m'; D='\033[2m'; X='\033[0m'

step()  { echo ""; echo -e "${B}━━ Step $1 of 5 — $2 ━━${X}"; echo ""; }
ok()    { echo -e "  ${G}✓${X} $1"; }
warn()  { echo -e "  ${Y}!${X} $1"; }
fail()  { echo -e "  ${R}✗${X} $1"; }
note()  { echo -e "  ${D}$1${X}"; }

SUDO=""; [[ $EUID -ne 0 ]] && SUDO="sudo"

echo ""
echo -e "${B}YodaCode installer${X}"
echo "  Your own Claude-powered Slack assistant, running on your server."
echo "  This takes about 5 minutes. You'll need:"
echo "    • a Claude subscription (Max recommended) and a browser on your laptop/phone"
echo "    • permission to add an app to your Slack workspace"
echo ""
read -r -p "  Ready? Press Enter to begin (Ctrl-C to quit) " _

# ── Already configured? ───────────────────────────────────────────────────────
if [[ -f .env ]] && grep -q '^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-' .env 2>/dev/null \
   && grep -q '^SLACK_BOT_TOKEN=xoxb-' .env 2>/dev/null \
   && ! grep -q 'xoxb-your-bot-token' .env 2>/dev/null; then
  echo ""
  ok "Found an existing configuration (.env)."
  read -r -p "  (S)tart the bot with it, or (R)econfigure from scratch? [S/r] " ans
  if [[ ! "${ans,,}" =~ ^r ]]; then
    docker compose up -d --build && echo "" && ok "YodaCode is starting — watch it with: docker compose logs -f agent"
    exit $?
  fi
fi

# ── 1/5 Docker ────────────────────────────────────────────────────────────────
step 1 "Docker"
wait_for_apt() {
  command -v fuser >/dev/null 2>&1 || return 0
  local locks="/var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock"
  local waited=0
  while $SUDO fuser $locks >/dev/null 2>&1; do
    (( waited == 0 )) && warn "Your server is finishing its first-boot updates — waiting (this is normal on a new machine)…"
    sleep 5; waited=$((waited + 5))
    (( waited >= 600 )) && { fail "Still locked after 10 minutes — try again shortly."; return 1; }
  done
  (( waited > 0 )) && ok "Updates finished (waited ${waited}s)."
  return 0
}
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1) is already installed."
else
  note "Docker runs the bot in an isolated container. Installing it now (1–2 minutes)…"
  if [[ $EUID -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
    fail "This needs root. Re-run as: sudo ./quickstart.sh"; exit 1
  fi
  wait_for_apt || exit 1
  installed=0
  for attempt in 1 2; do
    if curl -fsSL https://get.docker.com | $SUDO sh >/dev/null 2>&1; then installed=1; break; fi
    warn "Install attempt ${attempt} hit a snag — retrying…"; sleep 10; wait_for_apt || break
  done
  [[ "$installed" == "1" ]] || { fail "Docker install failed. Try: curl -fsSL https://get.docker.com | sh"; exit 1; }
  $SUDO systemctl enable --now docker 2>/dev/null || true
  ok "Docker installed."
fi

# ── 2/5 Build ─────────────────────────────────────────────────────────────────
step 2 "Building YodaCode"
note "Building the container image (3–5 minutes on a small server — grab a coffee)…"
if docker compose build >/tmp/yodacode-build.log 2>&1; then
  ok "Image built."
else
  fail "Build failed — last lines:"; tail -8 /tmp/yodacode-build.log | sed 's/^/    /'
  note "Full log: /tmp/yodacode-build.log  (low memory? add swap: fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile)"
  exit 1
fi

# ── 3/5 Claude sign-in ────────────────────────────────────────────────────────
step 3 "Sign in to Claude"
echo "  YodaCode runs on your Claude subscription — no API key, no extra billing."
echo "  A sign-in helper will start now. It shows a URL:"
echo ""
echo -e "    1. Open the URL in the browser on your ${B}laptop or phone${X}"
echo "    2. Sign in to Claude and approve"
echo "    3. Copy the code it gives you, paste it back here, press Enter"
echo ""
read -r -p "  Press Enter to start the sign-in… " _
docker compose run --rm --no-deps --entrypoint claude agent setup-token || true
echo ""
echo -e "  The helper printed a long token starting with ${B}sk-ant-oat01-${X}."
CLAUDE_TOKEN=""
for try in 1 2 3; do
  read -r -p "  Paste that token here: " CLAUDE_TOKEN
  CLAUDE_TOKEN="$(echo "$CLAUDE_TOKEN" | tr -d '[:space:]')"
  [[ "$CLAUDE_TOKEN" == sk-ant-oat01-* ]] && break
  fail "That doesn't look right — it should start with sk-ant-oat01-. ($((3-try)) tries left)"
  CLAUDE_TOKEN=""
done
[[ -n "$CLAUDE_TOKEN" ]] || { fail "No valid token. Re-run ./quickstart.sh to try again."; exit 1; }
note "Checking the token works…"
verify=$(docker compose run --rm --no-deps -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOKEN" -e ANTHROPIC_API_KEY= \
  --entrypoint claude agent -p "say OK" --output-format json 2>/dev/null || true)
if grep -q '"result"[: ]*"OK"' <<<"$verify"; then
  ok "Signed in to Claude."
else
  warn "Couldn't verify the token right now — continuing anyway (it may still work)."
fi

# ── 4/5 Slack app ─────────────────────────────────────────────────────────────
step 4 "Create your Slack app"
echo "  Two minutes of clicking, fully guided:"
echo ""
echo -e "    1. Open  ${B}https://api.slack.com/apps?new_app=1${X}  in your browser"
echo -e "    2. Choose ${B}\"From a manifest\"${X} → pick your workspace"
echo -e "    3. Replace everything in the code box with this (works on the JSON or YAML tab),"
echo -e "       then click ${B}Next${X} → ${B}Create${X}:"
echo ""
echo -e "  ${D}──── copy from here ────${X}"
sed 's/^/  /' scripts/slack-app-manifest.json
echo -e "  ${D}──── to here ───────────${X}"
echo ""
echo -e "    4. On the app page: ${B}Install App${X} (left menu) → ${B}Install to Workspace${X} → Allow"
echo -e "       Copy the ${B}Bot User OAuth Token${X} (starts xoxb-)"
echo ""
SLACK_BOT=""
for try in 1 2 3; do
  read -r -p "  Paste the Bot token (xoxb-…): " SLACK_BOT
  SLACK_BOT="$(echo "$SLACK_BOT" | tr -d '[:space:]')"
  if [[ "$SLACK_BOT" == xoxb-* ]]; then
    auth=$(curl -s -H "Authorization: Bearer $SLACK_BOT" https://slack.com/api/auth.test || true)
    if grep -q '"ok":true' <<<"$auth"; then
      team=$(grep -o '"team":"[^"]*"' <<<"$auth" | head -1 | cut -d'"' -f4)
      botn=$(grep -o '"user":"[^"]*"' <<<"$auth" | head -1 | cut -d'"' -f4)
      ok "Connected to the ${team:-your} workspace as @${botn:-bot}."
      break
    fi
    fail "Slack rejected that token — re-copy it from OAuth & Permissions. ($((3-try)) tries left)"
  else
    fail "Bot tokens start with xoxb-. ($((3-try)) tries left)"
  fi
  SLACK_BOT=""
done
[[ -n "$SLACK_BOT" ]] || { fail "No valid bot token. Re-run ./quickstart.sh to try again."; exit 1; }
echo ""
echo -e "    5. Last one: ${B}Basic Information${X} (left menu) → scroll to ${B}App-Level Tokens${X}"
echo -e "       → ${B}Generate Token${X} → name it anything → add scope ${B}connections:write${X} → Generate"
echo -e "       Copy that token (starts xapp-)"
echo ""
SLACK_APP=""
for try in 1 2 3; do
  read -r -p "  Paste the App-Level token (xapp-…): " SLACK_APP
  SLACK_APP="$(echo "$SLACK_APP" | tr -d '[:space:]')"
  if [[ "$SLACK_APP" == xapp-* ]]; then
    conn=$(curl -s -X POST -H "Authorization: Bearer $SLACK_APP" https://slack.com/api/apps.connections.open || true)
    if grep -q '"ok":true' <<<"$conn"; then ok "App-level token works."; break; fi
    fail "Slack rejected that token — make sure it has the connections:write scope. ($((3-try)) tries left)"
  else
    fail "App-level tokens start with xapp-. ($((3-try)) tries left)"
  fi
  SLACK_APP=""
done
[[ -n "$SLACK_APP" ]] || { fail "No valid app token. Re-run ./quickstart.sh to try again."; exit 1; }

# ── Write config ──────────────────────────────────────────────────────────────
TZ_GUESS="$(cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || echo UTC)"
if [[ ! -f .env ]]; then cp .env.example .env; fi
chmod 600 .env
set_env() { # set_env KEY VALUE — replace or append
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
set_env CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_TOKEN"
set_env SLACK_BOT_TOKEN "$SLACK_BOT"
set_env SLACK_APP_TOKEN "$SLACK_APP"
set_env TZ "$TZ_GUESS"
ok "Configuration saved to .env (timezone: $TZ_GUESS)."

# ── 5/5 Launch ────────────────────────────────────────────────────────────────
step 5 "Launch"
docker compose up -d >/dev/null 2>&1 || { fail "Start failed — check: docker compose logs"; exit 1; }
note "Starting up…"
ready=0
for i in $(seq 1 30); do
  if docker compose logs agent 2>/dev/null | grep -q '"msg":"slack: ready"'; then ready=1; break; fi
  sleep 2
done
echo ""
if [[ "$ready" == "1" ]]; then
  echo -e "  ${G}${B}🎉 YodaCode is live.${X}"
  echo ""
  echo -e "  Open Slack and send your bot a DM — say hello."
  echo ""
  echo "  Day-to-day commands (run from this folder):"
  echo "    docker compose logs -f agent     # watch it think"
  echo "    docker compose restart           # after changing settings"
  echo "    docker compose down              # stop it"
  echo ""
  echo -e "  ${B}Optional, any time later:${X} give the bot API keys (GitHub, Stripe, …)."
  echo "  Keys live in a separate broker container — the bot itself never sees them."
  echo "    1. add the key to .env"
  echo "    2. add the host to workspace/broker/auth-hosts.json (copy the .example)"
  echo "    3. docker compose restart"
  echo "  Details: docs/BROKER.md"
else
  warn "Started, but no 'slack: ready' yet. Watch it with: docker compose logs -f agent"
  note "If you see invalid_auth, a Slack token is wrong — re-run ./quickstart.sh and choose Reconfigure."
fi
