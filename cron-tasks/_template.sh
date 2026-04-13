#!/usr/bin/env bash
# YodaCode cron task template.
#
# Copy this file to create a new cron task:
#   cp _template.sh my-task.sh && chmod +x my-task.sh
#
# Then create a systemd service + timer:
#   cp ../systemd/yodacode-cron.service.template /etc/systemd/system/yodacode-my-task.service
#   cp ../systemd/yodacode-cron.timer.template /etc/systemd/system/yodacode-my-task.timer
#   # Edit the timer's OnCalendar= to set your schedule
#   systemctl daemon-reload && systemctl enable --now yodacode-my-task.timer

set -uo pipefail

# Model for this cron (leave empty to use default, e.g. claude-haiku-4-5, claude-opus-4-6)
CRON_MODEL="${CRON_MODEL:-}"

cd "$(dirname "$0")/../workspace"

# Load env
set -a
. ../.env
set +a
unset ANTHROPIC_API_KEY  # force OAuth/sub auth

LOG=../logs/my-task.log
mkdir -p ../logs

START=$(date -Iseconds)
echo "[$START] my-task starting" >> "$LOG"

PROMPT='Your prompt here.

Describe the task clearly. Include:
- What to do
- What tools to use (curl, gog-wrap, etc.)
- Where to post results (Slack channel ID, file path, etc.)
- How to format the output

This is a CRON RUN, not an interactive reply. Run exactly one pass and stop.
Output a one-line summary: `TASK_OK` or `TASK_ERR <reason>`.'

# Build model flag
MODEL_FLAG=""
if [[ -n "$CRON_MODEL" ]]; then
  MODEL_FLAG="--model $CRON_MODEL"
fi

OUT=$(claude -p "$PROMPT" \
  --output-format text \
  --permission-mode acceptEdits \
  $MODEL_FLAG \
  --allowed-tools "Bash,Read,Write,Edit,WebFetch,Glob,Grep" \
  --thinking enabled \
  2>&1) || true

echo "[$START] $OUT" >> "$LOG"
echo "[$(date -Iseconds)] my-task finished" >> "$LOG"
