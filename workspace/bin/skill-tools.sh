#!/usr/bin/env bash
# @yoda-tool
# name: skill-tools.sh
# summary: List, search, and mark-used reusable procedures stored in workspace/skills/.
# tags: skills, memory
# requires:
# usage:
#   skill-tools.sh list                       — list all active skills with last_used / use_count
#   skill-tools.sh search "<query>" [--limit N] — FTS5 search across skill bodies
#   skill-tools.sh mark-used <slug>           — bump use_count + last_used (call after invoking a skill)
# examples:
#   ./bin/skill-tools.sh list
#   ./bin/skill-tools.sh search "hubspot enrich"
#   ./bin/skill-tools.sh mark-used enrich-hubspot-from-domain
# @end
#
# Skills are auto-written by the skill-reflector (background agent run
# after notable ticks) and tidied by cron-tasks/skill-review.sh.

set -uo pipefail
exec python3 "$(dirname "$0")/skill-tools.py" "$@"
