#!/usr/bin/env bash
# Container entrypoint for both services. ROLE selects behaviour:
#   ROLE=broker → run the credential broker (holds the vault) as root in-container
#   ROLE=agent  → run the supervisor (yoda.js) + cron scheduler as the unprivileged
#                 `yoda` user, dropping privileges from root after fixing perms
#
# PUID/PGID remap the `yoda` user to the host owner of the bind-mounted repo, so
# files the agent writes (memory, state, logs) are owned correctly on the host.
set -euo pipefail

ROLE="${ROLE:-agent}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
SOCK_DIR="$(dirname "${YODA_BROKER_SOCK:-/run/yodacode-broker/broker.sock}")"

if [[ "$ROLE" == "broker" ]]; then
  # The broker holds the secrets; it runs as root inside its own container (isolated
  # from the host). It owns the socket dir so the agent (group yodacode) can connect.
  # Remap the yodacode group to PGID so the socket's group matches the agent's group
  # gid across containers (the agent may remap to the host's gid).
  if [[ "$PGID" != "$(getent group yodacode | cut -d: -f3)" ]]; then groupmod -o -g "$PGID" yodacode; fi
  mkdir -p "$SOCK_DIR"
  chgrp yodacode "$SOCK_DIR" 2>/dev/null || true
  chmod 0710 "$SOCK_DIR"
  echo "[entrypoint] starting broker (vault: ${YODA_ENV_FILE:-<none>})"
  exec node /app/workspace/broker/brokerd.js
fi

# ── agent role ───────────────────────────────────────────────────────────────
# Remap the yoda user to the host uid/gid so bind-mounted writes are owned right.
if [[ "$(id -u)" == "0" ]]; then
  CUR_UID="$(id -u yoda)"; CUR_GID="$(id -g yoda)"
  if [[ "$PGID" != "$CUR_GID" ]]; then groupmod -o -g "$PGID" yodacode; fi
  if [[ "$PUID" != "$CUR_UID" ]]; then usermod -o -u "$PUID" yoda; fi
  # Make the areas the agent writes owned by it. The workspace is bind-mounted from
  # the host (set PUID/PGID to your host user so these end up owned by you). Persona
  # files stay readable; only the writable areas are chowned. node_modules is a
  # separate volume — don't recurse into it.
  mkdir -p /app/logs /app/workspace/state /app/workspace/memory \
           /app/workspace/.memory-backups /app/workspace/skills /home/yoda 2>/dev/null || true
  # Skip the chown when the workspace is already group-shared with the agent's gid
  # (e.g. an existing host deployment mounted in) — flipping ownership there is wrong.
  if [[ "${YODA_NO_CHOWN:-0}" != "1" ]]; then
    chown yoda:yodacode /app/workspace 2>/dev/null || true
    chmod g+rwxs /app/workspace 2>/dev/null || true
    chown -R yoda:yodacode /app/logs /app/workspace/state /app/workspace/memory \
          /app/workspace/.memory-backups /app/workspace/skills 2>/dev/null || true
    [[ -f /app/workspace/MEMORY.md ]] && chown yoda:yodacode /app/workspace/MEMORY.md 2>/dev/null || true
  fi
  chown yoda:yodacode /home/yoda 2>/dev/null || true
  exec gosu yoda "$0" "$@"
fi

# Now running as the unprivileged yoda user, from the workspace dir (where the
# code expects ./state, ./memory, etc. to resolve).
cd /app/workspace
echo "[entrypoint] agent up as $(id -un) (uid $(id -u), gid $(id -g)) in $(pwd)"

# Wait for the broker socket so the first cron/message doesn't race startup.
for i in $(seq 1 30); do
  [[ -S "${YODA_BROKER_SOCK}" ]] && break
  [[ "$i" == "1" ]] && echo "[entrypoint] waiting for broker socket at ${YODA_BROKER_SOCK}…"
  sleep 1
done

# Start the in-container cron scheduler in the background, then the supervisor in
# the foreground. If the supervisor exits, take the container down with it.
node /app/workspace/bin/scheduler.js &
SCHED_PID=$!
trap 'kill "$SCHED_PID" 2>/dev/null || true' EXIT
exec node /app/workspace/yoda.js
