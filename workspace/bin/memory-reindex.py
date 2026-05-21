#!/usr/bin/env python3
"""
Yoda memory FTS5 indexer.

Walks workspace/MEMORY.md + workspace/memory/*.md + workspace/legacy-memory/*.md
and builds an FTS5 index at workspace/state/memory.db. Idempotent: skips rebuild
if no source file is newer than the DB.

Queried by ./bin/memory-search.sh. Runs on yoda startup and from the
memory-consolidate cron.
"""

import re
import sqlite3
import sys
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[1]
STATE_DIR = WORKSPACE / "state"
DB_PATH = STATE_DIR / "memory.db"


def collect_sources() -> list[tuple[Path, str]]:
    sources: list[tuple[Path, str]] = []
    memory_index = WORKSPACE / "MEMORY.md"
    if memory_index.exists():
        sources.append((memory_index, "index"))
    active = WORKSPACE / "memory"
    if active.is_dir():
        for f in sorted(active.glob("*.md")):
            sources.append((f, "active"))
    legacy = WORKSPACE / "legacy-memory"
    if legacy.is_dir():
        for f in sorted(legacy.glob("*.md")):
            sources.append((f, "legacy"))
    skills = WORKSPACE / "skills"
    if skills.is_dir():
        for f in sorted(skills.glob("*.md")):
            if f.name == "INDEX.md":
                continue
            sources.append((f, "skill"))
    return sources


_FM_TOP = re.compile(r"^(\w+):\s*(.*)$")
_FM_NESTED = re.compile(r"^\s+(\w+):\s*(.*)$")


def parse_frontmatter(text: str) -> tuple[dict, str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return {}, text
    fm: dict = {}
    current = None
    for line in lines[1:end]:
        if not line.strip():
            continue
        if not (line.startswith(" ") or line.startswith("\t")):
            m = _FM_TOP.match(line)
            if m:
                fm[m.group(1)] = m.group(2).strip()
                current = m.group(1)
        else:
            m = _FM_NESTED.match(line)
            if m and current:
                fm[f"{current}.{m.group(1)}"] = m.group(2).strip()
    body = "\n".join(lines[end + 1:])
    return fm, body


def derive_meta(path: Path, scope: str) -> tuple[str, str, str, str, str, str]:
    """Returns (name, title, mtype, scope, path, body)."""
    text = path.read_text(encoding="utf-8", errors="replace")
    fm, body = parse_frontmatter(text)
    name = fm.get("name") or path.stem
    title = fm.get("description") or ""
    if not title:
        for line in body.splitlines():
            line = line.strip()
            if line.startswith("# "):
                title = line.lstrip("# ").strip()
                break
            if line and not line.startswith("---"):
                title = line[:120]
                break
    mtype = fm.get("metadata.type") or fm.get("type") or ""
    return name, title, mtype, scope, str(path), body or text


def db_is_fresh(db_path: Path, sources: list[tuple[Path, str]]) -> bool:
    if not db_path.exists():
        return False
    db_mtime = db_path.stat().st_mtime
    for src, _ in sources:
        if src.exists() and src.stat().st_mtime > db_mtime:
            return False
    return True


def main() -> int:
    sources = collect_sources()
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if db_is_fresh(DB_PATH, sources):
        print(f"memory.db up to date ({len(sources)} sources)")
        return 0
    if DB_PATH.exists():
        DB_PATH.unlink()
    con = sqlite3.connect(str(DB_PATH))
    cur = con.cursor()
    cur.execute(
        """
        CREATE VIRTUAL TABLE memory_fts USING fts5(
            name, title, mtype, scope, path, body,
            tokenize='porter unicode61'
        )
        """
    )
    inserted = 0
    for src, scope in sources:
        if not src.exists():
            continue
        meta = derive_meta(src, scope)
        cur.execute(
            "INSERT INTO memory_fts (name, title, mtype, scope, path, body) VALUES (?, ?, ?, ?, ?, ?)",
            meta,
        )
        inserted += 1
    con.commit()
    con.close()
    print(f"memory.db rebuilt — {inserted} rows ({len(sources)} sources scanned)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
