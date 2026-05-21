#!/usr/bin/env bash
# Yoda skill review cron task.
# Nightly librarian pass over workspace/skills/: dedup near-identical skills,
# promote frequently-used ones to "Core" in INDEX.md, archive stale ones.
#
# Schedule: 03:30 daily (after memory-consolidate at 03:00 finishes).
# Timer: yoda-skill-review.timer (create if absent).

set -uo pipefail

# Model for this cron (haiku is fine — this is mechanical tidying).
CRON_MODEL="${CRON_MODEL:-claude-haiku-4-5}"

cd "$(dirname "$0")/../workspace"

set -a
. ../.env
set +a
unset ANTHROPIC_API_KEY

LOG=../logs/skill-review.log
mkdir -p ../logs

START=$(date -Iseconds)
TODAY=$(date -u +%Y-%m-%d)
echo "[$START] skill-review starting" >> "$LOG"

# Bail early if there are no active skills yet.
ACTIVE_COUNT=$(find ./skills -maxdepth 1 -name '*.md' ! -name 'INDEX.md' 2>/dev/null | wc -l | tr -d ' ')
if [[ "$ACTIVE_COUNT" -eq 0 ]]; then
  echo "[$START] no active skills — skipping" >> "$LOG"
  exit 0
fi

PROMPT='Skill review cron run.

You are the librarian for `workspace/skills/`. Today is '"$TODAY"'.

## Your job

1. **Read** `workspace/skills/INDEX.md` and every active `workspace/skills/*.md`. Use `Glob` + `Read`.

2. **Dedup.** If two skills cover the same procedure, keep the older one (or whichever has higher `use_count`), merge any unique steps from the loser into the keeper, and move the loser to `workspace/skills/archive/<slug>.md` (use `Bash mv`).

3. **Promote to Core.** Any skill with `use_count >= 3` AND `last_used` within the last 30 days should be listed under the `## Core` section of `INDEX.md`. Move its pointer line from `## Active` to `## Core`. Skills used less often stay under `## Active`.

4. **Archive stale.** Any skill with `last_used` older than 180 days (or no `last_used` and `created` older than 180 days) → move to `workspace/skills/archive/`. Remove its pointer from `INDEX.md`.

5. **Rewrite `INDEX.md`** with the updated Core / Active lists. Keep the header section verbatim.

6. **Be conservative.** When unsure whether two skills are duplicates, KEEP both. Better one extra skill than a wrong merge.

## Hard rules

- Only touch `workspace/skills/` and `workspace/skills/archive/`. Never touch MEMORY.md, memory/, or legacy-memory/.
- If `skills/` has fewer than 2 skills, there is nothing to dedup or promote — just refresh `INDEX.md` and exit.

## Output

Emit one final line on stdout:
- `SKILL_REVIEW_OK promoted=N archived=N deduped=N` if you made changes
- `SKILL_REVIEW_NOOP` if nothing needed changing

This is a CRON RUN. Run exactly one pass and stop.'

MODEL_FLAG=""
if [[ -n "$CRON_MODEL" ]]; then
  MODEL_FLAG="--model $CRON_MODEL"
fi

OUT=$(claude -p "$PROMPT" \
  --output-format text \
  --permission-mode acceptEdits \
  $MODEL_FLAG \
  --allowed-tools "Bash,Read,Write,Edit,Glob,Grep" \
  2>&1) || true

echo "[$START] $OUT" >> "$LOG"

# Rebuild FTS5 index so memory-search/skill-tools search pick up moved skills.
python3 ./bin/memory-reindex.py >> "$LOG" 2>&1 || echo "[$(date -Iseconds)] memory-reindex failed" >> "$LOG"

echo "[$(date -Iseconds)] skill-review finished" >> "$LOG"
