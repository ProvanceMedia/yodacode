#!/usr/bin/env python3
"""
Yoda memory search — FTS5 query against workspace/state/memory.db.

Invoked via ./bin/memory-search.sh (which carries the @yoda-tool manifest).
Auto-rebuilds the index if missing.
"""

import argparse
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[1]
DB_PATH = WORKSPACE / "state" / "memory.db"
REINDEX = Path(__file__).parent / "memory-reindex.py"


def ensure_index() -> None:
    if DB_PATH.exists():
        return
    subprocess.run([sys.executable, str(REINDEX)], check=True)


def build_scope_clause(scope: str) -> str:
    return {
        "default": "scope IN ('index','active','skill')",
        "active": "scope = 'active'",
        "legacy": "scope = 'legacy'",
        "index": "scope = 'index'",
        "skill": "scope = 'skill'",
        "all": "1=1",
    }[scope]


def main() -> int:
    parser = argparse.ArgumentParser(description="Search Yoda memory (FTS5).")
    parser.add_argument("query", nargs="+", help="FTS5 query (multi-word OK).")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument(
        "--scope",
        choices=["default", "active", "legacy", "index", "skill", "all"],
        default="default",
        help="Default = index + active + skill (excludes legacy). Use --scope legacy or --scope all to include historical context.",
    )
    parser.add_argument("--type", dest="mtype", default="", help="Filter by frontmatter metadata.type")
    args = parser.parse_args()

    query = " ".join(args.query)
    ensure_index()

    where = [f"memory_fts MATCH ?", build_scope_clause(args.scope)]
    params: list = [query]
    if args.mtype:
        where.append("mtype = ?")
        params.append(args.mtype)
    params.append(args.limit)

    sql = f"""
        SELECT scope, mtype, name, title, path,
               snippet(memory_fts, 5, '[', ']', '…', 12) AS snip
        FROM memory_fts
        WHERE {' AND '.join(where)}
        ORDER BY bm25(memory_fts)
        LIMIT ?
    """

    con = sqlite3.connect(str(DB_PATH))
    try:
        rows = con.execute(sql, params).fetchall()
    except sqlite3.OperationalError as e:
        print(f"memory-search: sqlite error — {e}", file=sys.stderr)
        return 1
    finally:
        con.close()

    if not rows:
        print(f"no matches for: {query}")
        return 0

    for i, (scope, mtype, name, title, path, snip) in enumerate(rows, 1):
        rel = os.path.relpath(path, WORKSPACE)
        type_tag = f" {mtype}" if mtype else ""
        print(f"[{i}] {scope}{type_tag} — {name}")
        if title:
            print(f"    {title}")
        print(f"    file: {rel}")
        print(f"    snippet: {snip}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
