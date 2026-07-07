#!/usr/bin/env bash
# setup-broker.sh — enable YodaCode's optional credential-isolation (broker) mode.
#
# What this does (idempotent, run as root):
#   1. creates an unprivileged `yodacode-agent` user + `yodacode` group
#   2. locks the secret files (.env, workspace/.ssh) to root-only 0600
#   3. group-shares the workspace so the agent can read/write everything EXCEPT secrets
#   4. installs + starts the broker systemd service (yodacode-brokerd)
#   5. symlinks the `broker` CLI onto PATH
#   6. sets YODA_DEROOT=1 in .env so the agent + crons spawn de-rooted
#
# After this, restart the main service:  systemctl restart yodacode
# Roll back any time:  set YODA_DEROOT=0 in .env and restart (the agent runs as before).
#
# See docs/BROKER.md for the full picture.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run as root: sudo $0" >&2; exit 1; fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$ROOT/workspace"
AGENT_USER="${YODA_AGENT_USER:-yodacode-agent}"
AGENT_GROUP="${YODA_AGENT_GROUP:-yodacode}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
LOCAL_BIN="${LOCAL_BIN:-$HOME/.local/bin}"

echo "==> group + user"
getent group "$AGENT_GROUP" >/dev/null || groupadd --system "$AGENT_GROUP"
if ! id "$AGENT_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$AGENT_USER" \
          --shell /usr/sbin/nologin --gid "$AGENT_GROUP" "$AGENT_USER"
fi
# The supervisor's owner joins the group too, so it can read agent-written workspace files.
usermod -aG "$AGENT_GROUP" "$(stat -c %U "$ROOT")" 2>/dev/null || true

echo "==> lock secrets root-only"
chown root:root "$ROOT/.env" 2>/dev/null || true
chmod 600 "$ROOT/.env" 2>/dev/null || true
if [[ -d "$WORKSPACE/.ssh" ]]; then chown -R root:root "$WORKSPACE/.ssh"; chmod -R go-rwx "$WORKSPACE/.ssh"; fi
# Optional explicit vault file (if you keep one outside .env)
[[ -f "$WORKSPACE/broker/secrets.json" ]] && { chown root:root "$WORKSPACE/broker/secrets.json"; chmod 600 "$WORKSPACE/broker/secrets.json"; }

echo "==> group-share the workspace (secrets above stay root-only)"
chgrp -R "$AGENT_GROUP" "$WORKSPACE" 2>/dev/null || true
# setgid dirs so new files inherit the group; agent can read/write non-secret paths.
find "$WORKSPACE" -type d -not -path "*/.ssh*" -exec chmod g+rwxs {} + 2>/dev/null || true
find "$WORKSPACE" -type f -not -path "*/.ssh*" -not -name 'secrets.json' -exec chmod g+rw {} + 2>/dev/null || true
mkdir -p "$ROOT/logs"; chgrp "$AGENT_GROUP" "$ROOT/logs"; chmod g+rwxs "$ROOT/logs"

# The broker's code + credential map are a TRUST ANCHOR. The agent may READ them
# (refresh-capabilities.py lists configured hosts) but must NEVER write them: a
# prompt-injected agent that could edit auth-hosts.json would add a host→key mapping
# and exfiltrate a secret (the broker reloads the file live over its socket, no
# restart needed), bypassing `yodacode addkey` and its typed-hostname challenge.
# This is the bare-metal equivalent of the container's read-only broker mount.
echo "==> lock the broker registry + code (agent group: read-only)"
if [[ -d "$WORKSPACE/broker" ]]; then
  chown -R "root:$AGENT_GROUP" "$WORKSPACE/broker" 2>/dev/null || true
  find "$WORKSPACE/broker" -type d -exec chmod 2750 {} + 2>/dev/null || true   # rwxr-s--- : root writes, group reads
  find "$WORKSPACE/broker" -type f -exec chmod 640 {} + 2>/dev/null || true    # rw-r----- : group read-only
  [[ -f "$WORKSPACE/broker/secrets.json" ]] && chmod 600 "$WORKSPACE/broker/secrets.json"
fi

echo "==> broker service"
SVC=/etc/systemd/system/yodacode-brokerd.service
sed -e "s#{{INSTALL_DIR}}#$ROOT#g" -e "s#{{NODE_BIN}}#$NODE_BIN#g" -e "s#{{LOCAL_BIN}}#$LOCAL_BIN#g" \
    "$ROOT/systemd/yodacode-brokerd.service.template" > "$SVC"
systemctl daemon-reload
systemctl enable --now yodacode-brokerd.service

echo "==> broker CLI on PATH"
ln -sf "$WORKSPACE/bin/broker" /usr/local/bin/broker

echo "==> enable de-root mode in .env"
if grep -q '^YODA_DEROOT=' "$ROOT/.env" 2>/dev/null; then
  sed -i 's/^YODA_DEROOT=.*/YODA_DEROOT=1/' "$ROOT/.env"
else
  printf '\n# Credential-isolation mode: agent + crons spawn as %s with no keys in env\nYODA_DEROOT=1\n' "$AGENT_USER" >> "$ROOT/.env"
fi

echo ""
echo "Done. Verify, then restart the agent:"
echo "  sudo -u $AGENT_USER cat $ROOT/.env   # should be DENIED"
echo "  broker status                        # vault/host counts"
echo "  systemctl restart yodacode"
