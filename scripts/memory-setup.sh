#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Memory 三层架构 — 一键部署
#
# 用法:
#   ./memory-setup.sh <agent-id> [workspace-path]
#
# 示例:
#   ./memory-setup.sh kol-scout
#   ./memory-setup.sh ai-news ~/.openclaw/workspaces/ai-news
#   ./memory-setup.sh general /custom/path/general
#
# 部署内容:
#   1. 目录结构: memory/, memory/archive/
#   2. MEMORY.md 模板 (P0/P1/P2 热记忆)
#   3. CLAUDE.md 模板 (含记忆管理规则)
#   4. memory-janitor.py (自动归档脚本)
#   5. cron 定时任务 (每天 4:00 AM 自动归档)
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# ── 参数 ──
AGENT_ID="${1:-}"
WORKSPACE="${2:-$HOME/.openclaw/workspaces/$AGENT_ID}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JANITOR_DEST="$HOME/scripts/memory-janitor.py"

if [ -z "$AGENT_ID" ]; then
    echo "用法: $0 <agent-id> [workspace-path]"
    echo ""
    echo "示例:"
    echo "  $0 kol-scout"
    echo "  $0 ai-news ~/.openclaw/workspaces/ai-news"
    echo ""
    echo "三层架构:"
    echo "  热记忆  memory/MEMORY.md       — P0/P1/P2, 每次请求自动加载, max 200行"
    echo "  冷记忆  memory/archive/        — 过期条目, 用 Read 工具按需召回"
    echo "  日志    memory/YYYY-MM-DD.md   — 每日原始记录, 只保留最近2天"
    exit 1
fi

echo "═══════════════════════════════════════════════════"
echo "Memory 三层架构部署"
echo "Agent:     $AGENT_ID"
echo "Workspace: $WORKSPACE"
echo "═══════════════════════════════════════════════════"
echo ""

# ── 1. 创建目录结构 ──
mkdir -p "$WORKSPACE/memory/archive"
echo "[1/5] 目录结构 ✓"
echo "  $WORKSPACE/memory/"
echo "  $WORKSPACE/memory/archive/"

# ── 2. 部署 MEMORY.md 模板 ──
MEMORY_FILE="$WORKSPACE/memory/MEMORY.md"
if [ -f "$MEMORY_FILE" ]; then
    echo "[2/5] MEMORY.md 已存在，跳过 ($(wc -c < "$MEMORY_FILE") bytes)"
else
    cat > "$MEMORY_FILE" << 'EOF'
# Hot Memory

## P0 — Core (never expires)

- [P0][YYYY-MM-DD] TODO: Add core identity, rules, criteria here

## P1 — Active Projects (90-day TTL)

- [P1][YYYY-MM-DD] TODO: Add active tracking items here

## P2 — Temporary Notes (30-day TTL)

- [P2][YYYY-MM-DD] TODO: Add temporary search notes, findings here
EOF
    echo "[2/5] MEMORY.md 模板 ✓"
fi

# ── 3. 部署 CLAUDE.md ──
CLAUDE_FILE="$WORKSPACE/CLAUDE.md"
if [ -f "$CLAUDE_FILE" ]; then
    BACKUP="$CLAUDE_FILE.bak.$(date +%Y%m%d%H%M%S)"
    cp "$CLAUDE_FILE" "$BACKUP"
    echo "[3/5] 已备份原 CLAUDE.md → $(basename "$BACKUP")"
fi

cat > "$CLAUDE_FILE" << CLAUDEEOF
# ${AGENT_ID}

TODO: Describe this agent's role in one line.

## Memory (auto-loaded — DO NOT Read again)

Files in \`memory/\` are auto-injected into your context every request. Never use the Read tool to re-read them.

### File Roles
- **MEMORY.md** — hot memory with P0/P1/P2 priority entries (max 200 lines)
- **YYYY-MM-DD.md** — today's working notes (only recent 2 days kept here)
- Other .md files in memory/ are also auto-loaded — keep them small

### Priority System
- \`[P0]\` — core rules, identity, criteria. Never expires.
- \`[P1]\` — active projects, tracking items. 90-day TTL.
- \`[P2]\` — search notes, temporary findings. 30-day TTL.

Every MEMORY.md entry MUST use format: \`- [Px][YYYY-MM-DD] content\`

### Size Rules
- MEMORY.md: max 200 lines. Keep entries concise (1-2 lines each).
- Detailed reports → \`memory/archive/{name}.md\` (not auto-loaded, read on demand)
- Old daily logs auto-archived by janitor script.
- To recall archived details: use Read tool on \`memory/archive/{filename}\`

### Writing Output
1. Detailed content → \`memory/archive/{descriptive-name}.md\`
2. Summary entry → append to MEMORY.md as \`- [P1][YYYY-MM-DD] summary\`
3. Today's activity → \`memory/YYYY-MM-DD.md\`
CLAUDEEOF
echo "[3/5] CLAUDE.md 模板 ✓ (请编辑第一行描述)"

# ── 4. 部署 memory-janitor.py ──
mkdir -p "$(dirname "$JANITOR_DEST")"
if [ -f "$SCRIPT_DIR/memory-janitor.py" ]; then
    cp "$SCRIPT_DIR/memory-janitor.py" "$JANITOR_DEST"
    chmod +x "$JANITOR_DEST"
    echo "[4/5] memory-janitor.py → $JANITOR_DEST ✓"
elif [ -f "$JANITOR_DEST" ]; then
    echo "[4/5] memory-janitor.py 已存在 ✓"
else
    echo "[4/5] ⚠ memory-janitor.py 未找到，请手动部署到 $JANITOR_DEST"
fi

# ── 5. 设置 cron ──
CRON_CMD="0 4 * * * /usr/bin/python3 $HOME/scripts/memory-janitor.py --all $HOME/.openclaw/workspaces/*/"
if crontab -l 2>/dev/null | grep -qF "memory-janitor.py"; then
    echo "[5/5] cron 已配置 ✓"
else
    (crontab -l 2>/dev/null; echo "$CRON_CMD") | crontab -
    echo "[5/5] cron 已添加 ✓ (每天 4:00 AM)"
fi

# ── 结果 ──
echo ""
echo "═══════════════════════════════════════════════════"
echo "部署完成！"
echo ""
echo "文件清单:"
echo "  $WORKSPACE/CLAUDE.md              ← 编辑: 填写 agent 描述"
echo "  $WORKSPACE/memory/MEMORY.md       ← 编辑: 填写 P0/P1/P2 初始条目"
echo "  $WORKSPACE/memory/archive/        ← 自动: 过期条目归档到这里"
echo "  $JANITOR_DEST   ← 自动: cron 每天 4AM 运行"
echo ""
echo "下一步:"
echo "  1. 编辑 CLAUDE.md — 填写 agent 角色描述"
echo "  2. 编辑 MEMORY.md — 填写初始 P0 核心条目"
echo "  3. 如有已有 memory 文件要迁移，运行:"
echo "     python3 $JANITOR_DEST --dry-run $WORKSPACE"
echo ""
echo "验证:"
echo "  python3 $JANITOR_DEST --dry-run $WORKSPACE"
echo "═══════════════════════════════════════════════════"
