#!/usr/bin/env bash
# Generates a systemd .timer file for a cron-tasks/<task>.yaml and the
# concrete .service file from yoda-cron@.service.template (substituting
# {{INSTALL_DIR}}). Idempotent — re-runs are safe.
#
# Usage:
#   ./gen-units.sh <task-name>

set -uo pipefail

TASK="${1:-}"
if [[ -z "$TASK" ]]; then
  echo "usage: gen-units.sh <task-name>" >&2
  exit 2
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$(cd "$DIR/.." && pwd)"
YAML="$DIR/$TASK.yaml"
TIMER="$DIR/systemd/yoda-cron@$TASK.timer"
SERVICE_TEMPLATE="$DIR/systemd/yoda-cron@.service.template"
SERVICE="$DIR/systemd/yoda-cron@.service"

if [[ ! -f "$YAML" ]]; then
  echo "task definition not found: $YAML" >&2
  exit 2
fi

# Extract on_calendar — bare-bones YAML scan (works for our schema)
ON_CAL=$(grep -E '^on_calendar:' "$YAML" | head -1 | sed -E 's/^on_calendar:\s*//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')
if [[ -z "$ON_CAL" ]]; then
  echo "missing on_calendar: in $YAML" >&2
  exit 2
fi

DESC=$(grep -E '^description:' "$YAML" | head -1 | sed -E 's/^description:\s*//; s/^"(.*)"$/\1/' || echo "$TASK")
[[ -z "$DESC" ]] && DESC="$TASK"

mkdir -p "$DIR/systemd"

# Materialise the concrete .service from the template (substitute {{INSTALL_DIR}}).
if [[ -f "$SERVICE_TEMPLATE" ]]; then
  sed "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" "$SERVICE_TEMPLATE" > "$SERVICE"
  echo "wrote $SERVICE (substituted INSTALL_DIR=$INSTALL_DIR)"
fi

cat > "$TIMER" <<EOF
[Unit]
Description=Yoda cron timer: $TASK ($DESC)

[Timer]
OnCalendar=$ON_CAL
Persistent=true
Unit=yoda-cron@$TASK.service

[Install]
WantedBy=timers.target
EOF

echo "wrote $TIMER"
echo ""
echo "to install:"
echo "  sudo cp '$SERVICE' '$TIMER' /etc/systemd/system/"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable --now yoda-cron@$TASK.timer"
