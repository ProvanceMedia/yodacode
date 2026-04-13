#!/usr/bin/env bash
# Yoda daily memory consolidation cron task.
# Runs a `claude -p` librarian pass over Yoda's MEMORY.md to tidy
# new entries, merge duplicates, promote large topics into sub-files,
# and prune stale info. Posts a brief summary to the user via DM.
#
# Schedule: 03:00 daily (timer: yoda-memory-consolidate.timer)

set -uo pipefail

# Model for this cron (leave empty to use default, e.g. claude-haiku-4-5, claude-opus-4-6)
CRON_MODEL="${CRON_MODEL:-}"

cd "$(dirname "$0")/../workspace"

set -a
. ../.env
set +a
unset ANTHROPIC_API_KEY

LOG=../logs/memory-consolidate.log
mkdir -p ../logs

START=$(date -Iseconds)
TODAY=$(date -u +%Y-%m-%d)
echo "[$START] memory-consolidate starting" >> "$LOG"

# Backup before touching anything. Keep last 14 days, prune older.
BACKUP_DIR=./.memory-backups
mkdir -p "$BACKUP_DIR"
cp MEMORY.md "$BACKUP_DIR/MEMORY-$TODAY.md"
find "$BACKUP_DIR" -name "MEMORY-*.md" -type f -mtime +14 -delete

# the user's DM channel id (already in state) — fall back to opening fresh if needed.
STU_DM="YOUR_DM_CHANNEL_ID"

PROMPT='Memory consolidation cron run.

You are operating as a careful librarian on Yoda'"'"'s own memory file at `./MEMORY.md` (which is `/opt/shared/projects/docker/yoda/workspace/MEMORY.md`). The file has already been backed up.

## Your job

1. **Read `./MEMORY.md`** (the Yoda memory file, NOT the canonical production one).

2. **Tidy new entries.** Anything appended over the last day is likely informal ("the user said remember..."). Rewrite them into the file'"'"'s tight bullet style. Date-stamp with today (`'"$TODAY"'`). Place in the right section.

3. **Merge duplicates and supersede stale facts.** If two entries say overlapping things, merge into one richer entry. If a newer entry contradicts an older one, strike the older. Be **conservative** — when in doubt, KEEP information rather than delete it. Favour merging over deletion.

4. **Promote large topics to sub-files.** If any section has grown past ~30 lines and is a coherent standalone topic, extract it into `./memory/<slug>.md` (create the `memory/` directory if needed) and replace the original section in MEMORY.md with a one-line pointer like `- [<topic>](memory/<slug>.md) — <brief description>`.

5. **Verify load-bearing references (light touch).** For entries that name a file path, channel ID, or env var:
   - File paths: only flag with `**Stale?**` if you can quickly check it does not exist via `ls`.
   - Channel IDs and people: do NOT verify (too noisy). Trust them.
   Do not auto-delete stale references — only flag them for the user to review.

6. **Output the new MEMORY.md** by writing it back via the `Write` tool. Preserve the file'"'"'s frontmatter / header section verbatim.

## Hard rules (read carefully)

- **NEVER** edit `/opt/shared/projects/docker/agents_mds/codi/workspace/MEMORY.md` or anything under `agents_mds/codi/workspace/memory/`. That is the production Codi memory and is read-only from Yoda. You only touch `./MEMORY.md` and `./memory/*.md` (Yoda-local).
- **NEVER** delete an entry just because it looks redundant. Only delete if it is unambiguously superseded by a newer entry, OR a verbatim duplicate, OR contains a `**Stale?**` flag from a previous run that has now been confirmed gone.
- **Be conservative.** A small, careful tidy beats a sweeping rewrite. If you'"'"'re unsure whether a change is right, leave it.
- **Track your changes.** Keep a count of: entries merged, entries promoted to sub-files, entries flagged stale, lines before/after.

## Step 7 — Post summary to the user

After writing the file, post a brief summary to the user'"'"'s DM via:
```
./bin/slack-tools.sh post '"$STU_DM"' "<text>"
```

Format the summary as a short Codi-flavoured digest, e.g.:
```
📚 Memory tidy '"$TODAY"'
- Lines: <before> → <after>
- Merged: N duplicates
- Promoted: <topic> → memory/<slug>.md (if any)
- Flagged stale: N entries (if any)
- Backup: .memory-backups/MEMORY-'"$TODAY"'.md
```

If absolutely nothing changed, post nothing (no spam) and just emit `CONSOLIDATE_NOOP`.

Otherwise emit one final line on stdout: `CONSOLIDATE_OK <merged> <promoted> <flagged>` or `CONSOLIDATE_ERR <reason>`.

This is a CRON RUN. Run exactly one pass and stop.'

# Build model flag
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
echo "[$(date -Iseconds)] memory-consolidate finished" >> "$LOG"
