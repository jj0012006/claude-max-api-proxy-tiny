#!/bin/bash
# Migrate kol-scout memory to 3-layer architecture
# Run on server as claude-proxy user
#
# Before running: review the generated MEMORY.md and adjust as needed

set -euo pipefail

WORKSPACE="$HOME/.openclaw/workspaces/kol-scout"
MEMORY_DIR="$WORKSPACE/memory"
ARCHIVE_DIR="$MEMORY_DIR/archive"

echo "=== kol-scout memory migration ==="
echo "Workspace: $WORKSPACE"
echo ""

# ── 1. Create archive directory ──
mkdir -p "$ARCHIVE_DIR"
echo "[1/5] Created archive directory"

# ── 2. Move knowledge-log.md to archive ──
if [ -f "$MEMORY_DIR/knowledge-log.md" ]; then
    mv "$MEMORY_DIR/knowledge-log.md" "$ARCHIVE_DIR/knowledge-log-full.md"
    echo "[2/5] Archived knowledge-log.md → archive/knowledge-log-full.md"
else
    echo "[2/5] knowledge-log.md not found (skip)"
fi

# ── 3. Move old daily logs to archive ──
TODAY=$(date +%Y-%m-%d)
YESTERDAY=$(date -d "yesterday" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d)

moved=0
for f in "$MEMORY_DIR"/????-??-??.md; do
    [ -f "$f" ] || continue
    basename=$(basename "$f")
    datepart="${basename%.md}"
    if [ "$datepart" != "$TODAY" ] && [ "$datepart" != "$YESTERDAY" ]; then
        mv "$f" "$ARCHIVE_DIR/"
        echo "  Archived: $basename"
        moved=$((moved + 1))
    fi
done
echo "[3/5] Archived $moved old daily logs"

# ── 4. Create MEMORY.md with P0/P1/P2 format ──
# Extract summary from tracked-kols.md if it exists
if [ ! -f "$MEMORY_DIR/MEMORY.md" ]; then
    cat > "$MEMORY_DIR/MEMORY.md" << 'MEMEOF'
# Hot Memory

## P0 — Core (never expires)

- [P0][2026-02-20] Evaluation criteria: see collaboration-criteria.md
- [P0][2026-02-20] Output format: detailed report → archive/{name}.md, summary → here

## P1 — Active KOL Tracking

- [P1][2026-02-20] Jacob Crypto Bury: 55K subs, daily uploads, Bybit/Bitunix affiliate, NO Pionex. Full: archive/knowledge-log-full.md

## P2 — Temporary Notes

MEMEOF
    echo "[4/5] Created MEMORY.md template (REVIEW AND EDIT based on tracked-kols.md)"
else
    echo "[4/5] MEMORY.md already exists (skip)"
fi

# ── 5. Backup and update CLAUDE.md ──
if [ -f "$WORKSPACE/CLAUDE.md" ]; then
    cp "$WORKSPACE/CLAUDE.md" "$WORKSPACE/CLAUDE.md.bak"
    echo "[5/5] Backed up CLAUDE.md → CLAUDE.md.bak"
else
    echo "[5/5] No CLAUDE.md to backup"
fi

echo ""
echo "=== Migration complete ==="
echo ""
echo "Next steps:"
echo "  1. Review and edit $MEMORY_DIR/MEMORY.md"
echo "     - Convert tracked-kols.md entries to P1 summary lines"
echo "     - Convert search-history.md entries to P2 lines"
echo "  2. Deploy new CLAUDE.md:"
echo "     cp /path/to/kol-scout-CLAUDE.md $WORKSPACE/CLAUDE.md"
echo "  3. After MEMORY.md is ready, you can remove:"
echo "     rm $MEMORY_DIR/tracked-kols.md  (data migrated to MEMORY.md P1)"
echo "     rm $MEMORY_DIR/search-history.md  (data migrated to MEMORY.md P2)"
echo "  4. Set up daily janitor cron:"
echo "     crontab -e"
echo "     0 4 * * * /usr/bin/python3 ~/scripts/memory-janitor.py --all ~/.openclaw/workspaces/*/"
echo ""
echo "Current memory sizes:"
du -sh "$MEMORY_DIR"/*.md 2>/dev/null || true
echo ""
echo "Archive contents:"
ls -lh "$ARCHIVE_DIR"/ 2>/dev/null || true
