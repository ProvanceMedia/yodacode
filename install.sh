#!/usr/bin/env bash
# YodaCode bootstrap. Run from the repo root: `./install.sh`
#
# Handles the Node 20 prerequisite (fresh Ubuntu droplets ship with Node 18 or
# nothing), then delegates to scripts/install.js for the actual wizard.

set -uo pipefail

cd "$(dirname "$0")"

YELLOW='\033[33m'
GREEN='\033[32m'
RED='\033[31m'
RESET='\033[0m'

need_node() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  local major
  major=$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')
  if [[ -z "$major" || "$major" -lt 20 ]]; then
    return 1
  fi
  return 0
}

install_node_apt() {
  echo -e "${YELLOW}Installing Node 20 via NodeSource...${RESET}"
  if [[ $EUID -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
    echo -e "${RED}Need root or sudo to install Node via apt. Re-run as root, or install Node 20 manually.${RESET}" >&2
    return 1
  fi
  local SUDO=""
  [[ $EUID -ne 0 ]] && SUDO="sudo -E"
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash - >/dev/null
  $SUDO apt-get install -y nodejs >/dev/null
}

if ! need_node; then
  current=$(command -v node >/dev/null && node -v || echo "not installed")
  echo -e "${YELLOW}Node 20+ required. Current: ${current}.${RESET}"
  if command -v apt-get >/dev/null 2>&1; then
    read -r -p "Install Node 20 now via NodeSource (apt)? [y/N] " ans
    if [[ "$ans" =~ ^[Yy]$ ]]; then
      if install_node_apt && need_node; then
        echo -e "${GREEN}Node $(node -v) installed.${RESET}"
      else
        echo -e "${RED}Auto-install failed. Install Node 20 manually and re-run ./install.sh${RESET}" >&2
        exit 1
      fi
    else
      echo "Skipped. Manual install:"
      echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
      echo "  sudo apt-get install -y nodejs"
      echo "Then re-run ./install.sh"
      exit 1
    fi
  else
    echo "No apt detected. Install Node 20 manually (nvm recommended):"
    echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
    echo "  source ~/.bashrc && nvm install 20"
    echo "Then re-run ./install.sh"
    exit 1
  fi
fi

echo -e "${GREEN}Node $(node -v) — good.${RESET}"
exec node scripts/install.js "$@"
