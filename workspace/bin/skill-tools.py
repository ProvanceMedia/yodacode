#!/usr/bin/env python3
"""
Yoda skill tools — list, search, mark-used.

Invoked via ./bin/skill-tools.sh (which carries the @yoda-tool manifest).
"""

import argparse
import os
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[1]
SKILLS_DIR = WORKSPACE / "skills"
ARCHIVE_DIR = SKILLS_DIR / "archive"
MEMORY_SEARCH = WORKSPACE / "bin" / "memory-search.sh"


_FM_TOP = re.compile(r"^(\w+):\s*(.*)$")


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
    for line in lines[1:end]:
        if not line.strip() or line.startswith((" ", "\t")):
            continue
        m = _FM_TOP.match(line)
        if m:
            fm[m.group(1)] = m.group(2).strip()
    body = "\n".join(lines[end + 1:])
    return fm, body


def iter_skills() -> list[tuple[Path, dict]]:
    out: list[tuple[Path, dict]] = []
    if not SKILLS_DIR.is_dir():
        return out
    for f in sorted(SKILLS_DIR.glob("*.md")):
        if f.name == "INDEX.md":
            continue
        fm, _ = parse_frontmatter(f.read_text(encoding="utf-8", errors="replace"))
        out.append((f, fm))
    return out


def cmd_list(_args) -> int:
    skills = iter_skills()
    if not skills:
        print("no skills yet")
        return 0
    for path, fm in skills:
        rel = path.relative_to(WORKSPACE)
        name = fm.get("name", path.stem)
        desc = fm.get("description", "")
        last = fm.get("last_used", "?")
        count = fm.get("use_count", "?")
        print(f"- {name}  (used {count}× · last {last})")
        if desc:
            print(f"    {desc}")
        print(f"    file: {rel}")
    print(f"\n{len(skills)} skill(s)")
    return 0


def cmd_search(args) -> int:
    if not MEMORY_SEARCH.exists():
        print("memory-search.sh not found", file=sys.stderr)
        return 1
    # Delegate to memory-search with scope=all and filter for skills/ paths.
    proc = subprocess.run(
        [str(MEMORY_SEARCH), args.query, "--limit", str(args.limit), "--scope", "all"],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        print(proc.stderr or proc.stdout, file=sys.stderr)
        return proc.returncode
    # Filter the output to skill paths only (post-filter is simpler than
    # threading a 'skill' scope through the FTS5 index — skills are
    # currently sparse, so this is fine).
    in_block = []
    blocks = []
    for line in proc.stdout.splitlines():
        if line.startswith("[") and in_block:
            blocks.append("\n".join(in_block))
            in_block = []
        in_block.append(line)
    if in_block:
        blocks.append("\n".join(in_block))
    skill_blocks = [b for b in blocks if "skills/" in b]
    if not skill_blocks:
        print(f"no skills match: {args.query}")
        return 0
    for b in skill_blocks:
        print(b)
        print()
    return 0


def cmd_mark_used(args) -> int:
    slug = args.slug
    path = SKILLS_DIR / f"{slug}.md"
    if not path.exists():
        print(f"skill not found: {slug}", file=sys.stderr)
        return 2
    text = path.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(text)
    if not fm:
        print(f"no frontmatter in {path}", file=sys.stderr)
        return 1
    today = date.today().isoformat()
    fm["last_used"] = today
    try:
        fm["use_count"] = str(int(fm.get("use_count", "0")) + 1)
    except ValueError:
        fm["use_count"] = "1"
    # Re-render — preserve top-level ordering by reading original keys
    lines = text.splitlines()
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        print(f"bad frontmatter in {path}", file=sys.stderr)
        return 1
    original_keys = []
    for line in lines[1:end]:
        m = _FM_TOP.match(line)
        if m:
            original_keys.append(m.group(1))
    new_fm_lines = ["---"]
    seen = set()
    for k in original_keys:
        new_fm_lines.append(f"{k}: {fm.get(k, '')}")
        seen.add(k)
    for k, v in fm.items():
        if k not in seen:
            new_fm_lines.append(f"{k}: {v}")
    new_fm_lines.append("---")
    new_body = "\n".join(lines[end + 1:])
    path.write_text("\n".join(new_fm_lines) + "\n" + new_body, encoding="utf-8")
    print(f"bumped {slug}: use_count={fm['use_count']}, last_used={today}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Yoda skill tools.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="List all active skills.")
    s_search = sub.add_parser("search", help="Search skill bodies via FTS5.")
    s_search.add_argument("query")
    s_search.add_argument("--limit", type=int, default=5)
    s_mark = sub.add_parser("mark-used", help="Bump use_count and last_used on a skill.")
    s_mark.add_argument("slug")
    args = parser.parse_args()

    return {
        "list": cmd_list,
        "search": cmd_search,
        "mark-used": cmd_mark_used,
    }[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
