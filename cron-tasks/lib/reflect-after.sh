#!/usr/bin/env bash
# Source from a cron after its main `claude -p` invocation. Spawns the
# background skill + memory reflectors with the cron's prompt + output so
# scheduled tasks contribute to Yoda's closed-loop learning the same way
# Slack ticks do.
#
# Usage (at the end of a cron .sh):
#   . "$(dirname "$0")/lib/reflect-after.sh"
#   reflect_after_cron "<task-name>" "$PROMPT" "$OUT"
#
# Both reflectors are opt-in via the same env vars used for Slack ticks:
#   YODA_SKILL_REFLECTOR_ENABLED=1
#   YODA_MEMORY_REFLECTOR_ENABLED=1
#
# Fire-and-forget — never blocks the cron's exit. Reflector exit doesn't
# trigger a reindex; the nightly memory-consolidate cron and yoda startup
# both rebuild the FTS5 index, so new entries become searchable within
# the day. If you need faster freshness, run `./bin/memory-reindex.py`
# manually.

_reflect_model() {
  echo "${YODA_SKILL_REFLECTOR_MODEL:-claude-haiku-4-5}"
}

_reflect_spawn() {
  # $1 = prompt, $2 = kind label (skill|memory) for logging
  local prompt="$1"
  local kind="${2:-reflect}"
  local model
  model=$(_reflect_model)
  local log_dir="${YODA_LOG_DIR:-/opt/shared/projects/docker/yoda/logs}"
  local log_file="${log_dir}/reflectors.log"
  mkdir -p "$log_dir" 2>/dev/null
  # Log child output so silent NO_SKILL/NO_MEMORY is observable.
  # setsid + bg + disown → fully detached from the parent cron shell.
  (
    echo "[$(date -Iseconds)] ${kind} reflector starting (task=${REFLECT_TASK_NAME:-?}, model=${model})"
    setsid claude -p "$prompt" \
      --output-format text \
      --permission-mode acceptEdits \
      --model "$model" \
      --allowed-tools "Bash,Read,Write,Edit,Glob,Grep" \
      < /dev/null
    echo "[$(date -Iseconds)] ${kind} reflector finished"
  ) >> "$log_file" 2>&1 &
  disown 2>/dev/null || true
}

_reflect_skill_prompt() {
  # $1 task, $2 cron_prompt, $3 cron_output, $4 today
  local task="$1" cron_prompt="$2" cron_output="$3" today="$4"
  cat <<EOF
You are the skill librarian for Yoda, a personal AI agent.

A scheduled CRON task just finished.

TASK: $task
SOURCE: cron-$task
DATE: $today

THE CRON'S PROMPT TO CLAUDE:
$cron_prompt

CLAUDE'S OUTPUT:
$cron_output

## Your decision

Did this cron run reveal a *reusable procedure* worth recording as a SKILL.md?
Crons run the same workflow repeatedly, so any genuine insight here is
high-leverage. Be conservative — better one excellent skill per week than
five mediocre ones per day.

GOOD candidates (write a skill):
- A non-obvious tool combination that solved a recurring problem
- A diagnostic recipe Yoda will reach for again
- A workflow that varied from the cron prompt in a useful way

SKIP (output NO_SKILL):
- The cron just did what its prompt said — no novel insight
- Already covered in CLAUDE.md, MEMORY.md, or an existing skill
  (check via ./bin/skill-tools.sh search "<topic>")
- Failures or unresolved errors

If YES:
1. Pick a slug (lowercase, hyphens, ≤ 5 words). Confirm it's not in skills/INDEX.md.
2. Write workspace/skills/<slug>.md with frontmatter:
   name, description, tags, created: $today, last_used: $today, use_count: 1, source: cron-$task
3. Body: short procedure in numbered steps, ≤ 30 lines.
4. Append a one-line pointer to workspace/skills/INDEX.md under Active.
5. Emit \`SKILL_OK <slug>\` on stdout.

If NO: emit \`NO_SKILL\` and exit.

This is a CRON-style invocation. One pass, then stop.
EOF
}

_reflect_memory_prompt() {
  # $1 task, $2 cron_prompt, $3 cron_output, $4 today
  local task="$1" cron_prompt="$2" cron_output="$3" today="$4"
  cat <<EOF
You are the memory librarian for Yoda, a personal AI agent.

A scheduled CRON task just finished.

TASK: $task
SOURCE: cron-$task
DATE: $today

THE CRON'S PROMPT TO CLAUDE:
$cron_prompt

CLAUDE'S OUTPUT:
$cron_output

## Your decision

Did this cron reveal a *durable fact* worth saving to MEMORY.md or memory/?

Categories:
- user-fact: a new fact about the user or their team
- feedback: a corrected approach or validated pattern (include WHY)
- project-state: a decision, deadline, or milestone (convert dates to absolute, today = $today)
- reference: a new external resource (channel, dashboard, URL) and its purpose

Skip (output NO_MEMORY):
- Routine cron digest output
- Already-known facts
- Transient task state
- Unresolved failures

Be conservative. First dedupe:
  ./bin/memory-search.sh "<keywords>" --scope all
Prefer UPDATING an existing entry over appending a duplicate.

If YES:
- Append a dated bullet under the right section of MEMORY.md
  (format: \`- **$today** <fact>\`, include WHY for feedback entries)
- If > 30 lines of new context, write memory/<slug>.md instead and leave
  a one-line pointer in MEMORY.md.
- Emit \`MEMORY_OK <category>\` on stdout.

If NO: emit \`NO_MEMORY\` and exit.

This is a CRON-style invocation. One pass, then stop.
EOF
}

reflect_after_cron() {
  local task_name="$1"
  local cron_prompt="$2"
  local cron_output="$3"

  if [[ -z "$task_name" ]]; then
    echo "reflect_after_cron: missing task name" >&2
    return 1
  fi
  # Don't recurse — the librarian crons shouldn't reflect on themselves.
  case "$task_name" in
    memory-consolidate|skill-review)
      return 0
      ;;
  esac

  local today
  today=$(date -u +%Y-%m-%d)

  # OAuth/sub auth — never let an API key sneak in (mirror the runner).
  unset ANTHROPIC_API_KEY

  REFLECT_TASK_NAME="$task_name"
  if [[ "${YODA_SKILL_REFLECTOR_ENABLED:-0}" == "1" ]]; then
    local skill_prompt
    skill_prompt=$(_reflect_skill_prompt "$task_name" "$cron_prompt" "$cron_output" "$today")
    _reflect_spawn "$skill_prompt" "skill"
  fi
  if [[ "${YODA_MEMORY_REFLECTOR_ENABLED:-0}" == "1" ]]; then
    local memory_prompt
    memory_prompt=$(_reflect_memory_prompt "$task_name" "$cron_prompt" "$cron_output" "$today")
    _reflect_spawn "$memory_prompt" "memory"
  fi
}
