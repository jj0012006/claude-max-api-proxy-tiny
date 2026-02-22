#!/usr/bin/env python3
"""
Memory Janitor for OpenClaw agents.

Three-layer memory architecture:
  Hot   — MEMORY.md (P0/P1/P2, auto-loaded every request, max 200 lines)
  Cold  — memory/archive/ (expired entries, searchable via Read tool)
  Logs  — memory/YYYY-MM-DD.md (raw daily logs, only keep recent 2 days in memory/)

Runs daily via cron. Archives expired P1 (>90d) and P2 (>30d) entries,
moves old daily logs to archive, warns if MEMORY.md exceeds line limit.

Usage:
    python3 memory-janitor.py /path/to/workspace [--dry-run]
    python3 memory-janitor.py --all ~/.openclaw/workspaces/*/  [--dry-run]

Cron example (daily at 4:00 AM):
    0 4 * * * /usr/bin/python3 /home/claude-proxy/scripts/memory-janitor.py --all /home/claude-proxy/.openclaw/workspaces/*/
"""

import os
import re
import sys
import shutil
from datetime import datetime, timedelta
from pathlib import Path

# ── Config ──────────────────────────────────────────────
MAX_LINES = 200
P1_TTL_DAYS = 90
P2_TTL_DAYS = 30
DAILY_LOG_KEEP_DAYS = 2  # keep today + yesterday in memory/

# ── Patterns ────────────────────────────────────────────
# Matches: - [P0][2026-02-20] some content
# Matches: - [P1][2026-02-20] some content
ENTRY_RE = re.compile(
    r"^\s*-\s*\[P([012])\]\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.*)",
)
DAILY_LOG_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.md$")


def parse_memory(filepath: Path) -> tuple[list[str], list[dict]]:
    """Parse MEMORY.md into header lines and structured entries."""
    if not filepath.exists():
        return [], []

    lines = filepath.read_text(encoding="utf-8").splitlines()
    header = []
    entries = []
    current_entry = None

    for line in lines:
        m = ENTRY_RE.match(line)
        if m:
            if current_entry:
                entries.append(current_entry)
            current_entry = {
                "priority": int(m.group(1)),
                "date": m.group(2),
                "text": m.group(3),
                "raw_lines": [line],
            }
        elif current_entry and line.startswith("  "):
            # Continuation line (indented under an entry)
            current_entry["raw_lines"].append(line)
            current_entry["text"] += " " + line.strip()
        elif current_entry is None:
            header.append(line)
        else:
            # Non-entry, non-continuation line after entries started
            if current_entry:
                entries.append(current_entry)
                current_entry = None
            header.append(line)

    if current_entry:
        entries.append(current_entry)

    return header, entries


def is_expired(entry: dict, today: datetime) -> bool:
    """Check if an entry has expired based on its priority and date."""
    if entry["priority"] == 0:
        return False  # P0 never expires

    try:
        entry_date = datetime.strptime(entry["date"], "%Y-%m-%d")
    except ValueError:
        return False  # Can't parse date, keep it

    ttl = P1_TTL_DAYS if entry["priority"] == 1 else P2_TTL_DAYS
    return (today - entry_date).days > ttl


def archive_entries(entries: list[dict], archive_dir: Path, today_str: str) -> None:
    """Append expired entries to archive file with dedup."""
    if not entries:
        return

    archive_dir.mkdir(parents=True, exist_ok=True)
    archive_file = archive_dir / f"memory-archived-{today_str}.md"

    # Read existing archived content for dedup
    existing = set()
    if archive_file.exists():
        for line in archive_file.read_text(encoding="utf-8").splitlines():
            existing.add(line.strip())

    new_lines = []
    for entry in entries:
        for raw_line in entry["raw_lines"]:
            if raw_line.strip() not in existing:
                new_lines.append(raw_line)

    if new_lines:
        with open(archive_file, "a", encoding="utf-8") as f:
            if not existing:
                f.write(f"# Archived memories — {today_str}\n\n")
            for line in new_lines:
                f.write(line + "\n")


def write_memory_atomic(filepath: Path, header: list[str], entries: list[dict]) -> None:
    """Write MEMORY.md atomically (tmp file + rename)."""
    lines = header[:]

    for entry in entries:
        for raw_line in entry["raw_lines"]:
            lines.append(raw_line)

    content = "\n".join(lines) + "\n"

    tmp_path = filepath.with_suffix(".md.tmp")
    tmp_path.write_text(content, encoding="utf-8")
    os.replace(tmp_path, filepath)


def archive_old_daily_logs(memory_dir: Path, archive_dir: Path, today: datetime) -> list[str]:
    """Move old daily logs (>DAILY_LOG_KEEP_DAYS) from memory/ to memory/archive/."""
    cutoff = today - timedelta(days=DAILY_LOG_KEEP_DAYS)
    moved = []

    for f in memory_dir.iterdir():
        m = DAILY_LOG_RE.match(f.name)
        if m:
            try:
                log_date = datetime.strptime(m.group(1), "%Y-%m-%d")
            except ValueError:
                continue
            if log_date < cutoff:
                archive_dir.mkdir(parents=True, exist_ok=True)
                dest = archive_dir / f.name
                shutil.move(str(f), str(dest))
                moved.append(f.name)

    return moved


def process_workspace(workspace: Path, dry_run: bool = False) -> None:
    """Process a single agent workspace."""
    memory_dir = workspace / "memory"
    memory_file = memory_dir / "MEMORY.md"
    archive_dir = memory_dir / "archive"
    today = datetime.now()
    today_str = today.strftime("%Y-%m-%d")

    agent_name = workspace.name
    print(f"\n{'='*50}")
    print(f"Agent: {agent_name}")
    print(f"Workspace: {workspace}")

    # ── 1. Process MEMORY.md ──
    if memory_file.exists():
        header, entries = parse_memory(memory_file)
        total_before = len(entries)

        keep = []
        expired = []
        for entry in entries:
            if is_expired(entry, today):
                expired.append(entry)
            else:
                keep.append(entry)

        print(f"  MEMORY.md: {total_before} entries → {len(keep)} kept, {len(expired)} expired")

        if expired:
            for e in expired:
                print(f"    archived: [P{e['priority']}][{e['date']}] {e['text'][:60]}...")

        if not dry_run and expired:
            archive_entries(expired, archive_dir, today_str)
            write_memory_atomic(memory_file, header, keep)

        # Line count check
        total_lines = len(header) + sum(len(e["raw_lines"]) for e in keep)
        if total_lines > MAX_LINES:
            print(f"  WARNING: MEMORY.md has {total_lines} lines (limit: {MAX_LINES})")
        else:
            print(f"  MEMORY.md: {total_lines} lines (limit: {MAX_LINES})")
    else:
        print(f"  MEMORY.md: not found (skipping)")

    # ── 2. Archive old daily logs ──
    if memory_dir.exists():
        if dry_run:
            cutoff = today - timedelta(days=DAILY_LOG_KEEP_DAYS)
            old_logs = [
                f.name for f in memory_dir.iterdir()
                if DAILY_LOG_RE.match(f.name) and
                datetime.strptime(DAILY_LOG_RE.match(f.name).group(1), "%Y-%m-%d") < cutoff
            ]
            if old_logs:
                print(f"  Daily logs to archive: {old_logs}")
        else:
            moved = archive_old_daily_logs(memory_dir, archive_dir, today)
            if moved:
                print(f"  Daily logs archived: {moved}")

    # ── 3. Size report ──
    if memory_dir.exists():
        total_chars = 0
        file_sizes = []
        for f in sorted(memory_dir.iterdir()):
            if f.is_file() and f.suffix == ".md":
                size = f.stat().st_size
                total_chars += size
                file_sizes.append((f.name, size))

        print(f"  Memory total: {total_chars:,} chars ({total_chars // 4:,} est. tokens)")
        for name, size in file_sizes:
            print(f"    {name}: {size:,} chars")


def main():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    all_mode = "--all" in args
    args = [a for a in args if not a.startswith("--")]

    if not args:
        print("Usage: memory-janitor.py [--dry-run] [--all] <workspace_path> [...]")
        print("       memory-janitor.py --all ~/.openclaw/workspaces/*/")
        sys.exit(1)

    if dry_run:
        print("DRY RUN — no files will be modified\n")

    for path_str in args:
        workspace = Path(path_str).resolve()
        if workspace.is_dir():
            process_workspace(workspace, dry_run)
        else:
            print(f"Skipping (not a directory): {path_str}")

    print(f"\n{'='*50}")
    print("Done." + (" (dry run)" if dry_run else ""))


if __name__ == "__main__":
    main()
