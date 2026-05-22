#!/usr/bin/env bash
# YodaCode bootstrap.
#
# Local mode:   ./install.sh
# Piped mode:   curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash
#
# Installs Node 22 LTS into ~/.yodacode/node/ (no sudo needed) if a suitable
# Node isn't already on PATH, then hands off to the setup wizard.

set -uo pipefail

cd "$(dirname "$0")"

YELLOW='\033[33m'
GREEN='\033[32m'
RED='\033[31m'
RESET='\033[0m'

NODE_VERSION="${YODACODE_NODE_VERSION:-v22.11.0}"
YODACODE_HOME="${YODACODE_HOME:-$HOME/.yodacode}"
NODE_DIR="$YODACODE_HOME/node"
LOCAL_BIN="$HOME/.local/bin"

need_node() {
  if ! command -v node >/dev/null 2>&1; then return 1; fi
  local major
  major=$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')
  [[ -n "$major" && "$major" -ge 20 ]]
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    armv7l) echo "armv7l" ;;
    *) echo "" ;;
  esac
}

detect_os() {
  case "$(uname -s)" in
    Linux) echo "linux" ;;
    Darwin) echo "darwin" ;;
    *) echo "" ;;
  esac
}

install_node_local() {
  local arch os
  arch=$(detect_arch)
  os=$(detect_os)
  if [[ -z "$arch" || -z "$os" ]]; then
    echo -e "${RED}Unsupported platform: $(uname -sm). Install Node 20+ manually.${RESET}" >&2
    return 1
  fi

  local fname="node-${NODE_VERSION}-${os}-${arch}"
  local url="https://nodejs.org/dist/${NODE_VERSION}/${fname}.tar.xz"

  echo -e "${YELLOW}Installing Node ${NODE_VERSION} to ${NODE_DIR} (no sudo needed)...${RESET}"
  mkdir -p "$YODACODE_HOME"
  local tmp
  tmp=$(mktemp -d)
  trap "rm -rf '$tmp'" RETURN

  echo "  ↓ ${url}"
  if ! curl -fsSL "$url" -o "$tmp/node.tar.xz"; then
    echo -e "${RED}Download failed.${RESET}" >&2
    return 1
  fi
  if ! tar -xJf "$tmp/node.tar.xz" -C "$tmp"; then
    echo -e "${RED}Extract failed.${RESET}" >&2
    return 1
  fi

  rm -rf "$NODE_DIR"
  mv "$tmp/$fname" "$NODE_DIR"

  mkdir -p "$LOCAL_BIN"
  ln -sf "$NODE_DIR/bin/node" "$LOCAL_BIN/node"
  ln -sf "$NODE_DIR/bin/npm" "$LOCAL_BIN/npm"
  ln -sf "$NODE_DIR/bin/npx" "$LOCAL_BIN/npx"

  export PATH="$LOCAL_BIN:$PATH"

  # Persist PATH for future shells
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [[ -f "$rc" ]] && ! grep -q 'YODACODE_PATH_ADDED' "$rc"; then
      printf '\n# YODACODE_PATH_ADDED\nexport PATH="%s:$PATH"\n' "$LOCAL_BIN" >> "$rc"
    fi
  done

  if ! need_node; then
    echo -e "${RED}Install completed but node still not detected.${RESET}" >&2
    return 1
  fi
  echo -e "${GREEN}Node $(node -v) installed.${RESET}"
}

install_yodacode_wrapper() {
  # A tiny CLI shim so users can run `yodacode setup` from anywhere.
  mkdir -p "$LOCAL_BIN"
  local install_dir
  install_dir=$(cd "$(dirname "$0")" && pwd)
  cat > "$LOCAL_BIN/yodacode" <<EOF
#!/usr/bin/env bash
exec node "$install_dir/scripts/install.js" "\$@"
EOF
  chmod +x "$LOCAL_BIN/yodacode"
}

if ! need_node; then
  current=$(command -v node >/dev/null && node -v || echo "not installed")
  echo -e "${YELLOW}Node 20+ required. Current: ${current}.${RESET}"
  install_node_local || exit 1
fi

install_yodacode_wrapper

echo -e "${GREEN}Node $(node -v) — good.${RESET}"
exec node scripts/install.js "$@"
