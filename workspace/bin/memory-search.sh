#!/usr/bin/env bash
# @yoda-tool
# name: memory-search.sh
# summary: Full-text search across MEMORY.md, memory/*.md, and legacy-memory/*.md (SQLite FTS5).
# tags: memory, search
# requires:
# usage:
#   memory-search.sh "<query>" [--limit N] [--scope active|legacy|index|all] [--type <type>]
# examples:
#   ./bin/memory-search.sh "linkedin outreach"
#   ./bin/memory-search.sh "stripe alerts" --limit 3
#   ./bin/memory-search.sh "enrichment" --scope legacy
#   ./bin/memory-search.sh "copywriting" --type feedback
# @end
#
# Output: one block per hit, with relative path, name/title, type/scope, snippet.
# After finding a relevant file, `Read` it for full context.
# Defaults: limit=5, scope=active+index (legacy excluded — pass --scope legacy
# or --scope all to include historical context).

set -uo pipefail
exec python3 "$(dirname "$0")/memory-search.py" "$@"
