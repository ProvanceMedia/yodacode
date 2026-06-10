#!/usr/bin/env bash
# YodaCode quickstart — gets a fresh Linux server from zero to a running stack.
#
#   git clone https://github.com/ProvanceMedia/yodacode.git && cd yodacode
#   ./quickstart.sh
#
# Installs Docker (via get.docker.com) if it's missing, creates .env from the
# example on first run, then builds and starts the de-rooted broker + agent.
set -uo pipefail
cd "$(dirname "$0")"

YELLOW='\033[33m'; GREEN='\033[32m'; RED='\033[31m'; RESET='\033[0m'

# ── Docker ────────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo -e "${YELLOW}Docker not found — installing via get.docker.com (needs root)...${RESET}"
  if [[ $EUID -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
    echo -e "${RED}Need root (or sudo) to install Docker. Re-run as root.${RESET}"; exit 1
  fi
  SUDO=""; [[ $EUID -ne 0 ]] && SUDO="sudo"
  curl -fsSL https://get.docker.com | $SUDO sh || { echo -e "${RED}Docker install failed.${RESET}"; exit 1; }
  $SUDO systemctl enable --now docker 2>/dev/null || true
fi
if ! docker compose version >/dev/null 2>&1; then
  echo -e "${RED}Docker is installed but the compose plugin is missing.${RESET}"
  echo "On Debian/Ubuntu:  apt install docker-compose-plugin"
  exit 1
fi
echo -e "${GREEN}Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1) ready.${RESET}"

# ── .env ──────────────────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  echo ""
  echo -e "${YELLOW}Created .env from the example. Before the bot can connect you must add:${RESET}"
  echo "  - CLAUDE_CODE_OAUTH_TOKEN   (run \`claude setup-token\` on a machine with a browser)"
  echo "  - SLACK_BOT_TOKEN / SLACK_APP_TOKEN  (create the app from scripts/slack-app-manifest.yaml)"
  echo "  - any service API keys you want the broker to hold"
  echo ""
  echo -e "Edit .env now, then re-run ${GREEN}./quickstart.sh${RESET}"
  exit 0
fi

# Refuse to start with the placeholder tokens still in place.
if grep -qE '^(SLACK_BOT_TOKEN=xoxb-your-bot-token|CLAUDE_CODE_OAUTH_TOKEN=$)' .env; then
  echo -e "${YELLOW}.env still has placeholder values — fill in CLAUDE_CODE_OAUTH_TOKEN and the Slack tokens, then re-run.${RESET}"
  exit 1
fi

# ── up ────────────────────────────────────────────────────────────────────────
echo "Building and starting the stack (first build takes a few minutes)..."
docker compose up -d --build || exit 1
echo ""
echo -e "${GREEN}YodaCode is up.${RESET}  Useful commands:"
echo "  docker compose logs -f agent     # watch the bot"
echo "  docker compose restart           # after editing .env or broker config"
echo "  docker compose down              # stop"
echo ""
echo "DM your bot in Slack to say hello."
