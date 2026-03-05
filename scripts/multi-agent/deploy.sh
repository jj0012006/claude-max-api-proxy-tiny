#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Multi-Agent 协作系统 — 一键部署
#
# 部署 Commander + 3 Specialists 到 OpenClaw
#
# 用法:
#   ./deploy.sh [discord-channel-id]
#
# 如果不提供 channel ID，只创建 workspace 不修改 bindings
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PARENT_DIR="$(dirname "$SCRIPT_DIR")"
WORKSPACES="$HOME/.openclaw/workspaces"
CHANNEL_ID="${1:-}"

AGENTS=("commander" "deep-analyst" "quick-executor" "research-scout")

echo "═══════════════════════════════════════════════════"
echo "Multi-Agent 协作系统部署"
echo "═══════════════════════════════════════════════════"
echo ""

# ── 1. 为每个 agent 创建 workspace + memory 架构 ──
echo "▸ Step 1: 创建 Workspace + Memory 三层架构"
echo ""

for agent in "${AGENTS[@]}"; do
    ws="$WORKSPACES/$agent"
    if [ -d "$ws" ]; then
        echo "  [$agent] workspace 已存在，跳过目录创建"
    else
        mkdir -p "$ws/memory/archive"
        echo "  [$agent] workspace 创建 ✓"
    fi

    # 确保 memory 目录存在
    mkdir -p "$ws/memory/archive"

    # 部署 CLAUDE.md
    TEMPLATE="$SCRIPT_DIR/${agent}-CLAUDE.md"
    if [ -f "$TEMPLATE" ]; then
        if [ -f "$ws/CLAUDE.md" ]; then
            cp "$ws/CLAUDE.md" "$ws/CLAUDE.md.bak.$(date +%Y%m%d%H%M%S)"
        fi
        cp "$TEMPLATE" "$ws/CLAUDE.md"
        echo "  [$agent] CLAUDE.md 部署 ✓"
    else
        echo "  [$agent] ⚠ 模板 $TEMPLATE 不存在"
    fi

    # 创建 MEMORY.md（如果不存在）
    if [ ! -f "$ws/memory/MEMORY.md" ]; then
        cat > "$ws/memory/MEMORY.md" << EOF
# Hot Memory

## P0 — Core (never expires)

- [P0][$(date +%Y-%m-%d)] Agent initialized as part of multi-agent collaboration system

## P1 — Active (90-day TTL)

## P2 — Temporary (30-day TTL)
EOF
        echo "  [$agent] MEMORY.md 创建 ✓"
    fi
done

# ── 2. 部署 memory-janitor ──
echo ""
echo "▸ Step 2: Memory Janitor"
JANITOR_SRC="$PARENT_DIR/memory-janitor.py"
JANITOR_DEST="$HOME/scripts/memory-janitor.py"

mkdir -p "$HOME/scripts"
if [ -f "$JANITOR_SRC" ]; then
    cp "$JANITOR_SRC" "$JANITOR_DEST"
    chmod +x "$JANITOR_DEST"
    echo "  memory-janitor.py 部署 ✓"
elif [ -f "$JANITOR_DEST" ]; then
    echo "  memory-janitor.py 已存在 ✓"
else
    echo "  ⚠ memory-janitor.py 未找到"
fi

# ── 3. 设置 cron ──
echo ""
echo "▸ Step 3: Cron 定时任务"
CRON_CMD="0 4 * * * /usr/bin/python3 $HOME/scripts/memory-janitor.py --all $WORKSPACES/*/"
if crontab -l 2>/dev/null | grep -qF "memory-janitor.py"; then
    echo "  cron 已配置 ✓"
else
    (crontab -l 2>/dev/null; echo "$CRON_CMD") | crontab -
    echo "  cron 添加 ✓ (每天 4:00 AM)"
fi

# ── 4. 输出 openclaw.json 配置片段 ──
echo ""
echo "═══════════════════════════════════════════════════"
echo "▸ Step 4: 将以下配置添加到 ~/.openclaw/openclaw.json"
echo "═══════════════════════════════════════════════════"
echo ""
cat << 'CONFIGEOF'
// ── agents.defaults 中添加 subagents 和 agentToAgent ──

"subagents": {
  "maxConcurrent": 8,
  "maxChildrenPerAgent": 5,
  "maxSpawnDepth": 2,
  "allowAgents": ["deep-analyst", "quick-executor", "research-scout"]
},

// ── agents.list 中添加四个 agent ──

{ "id": "commander",       "workspace": "~/.openclaw/workspaces/commander",       "model": { "primary": "claude-max/claude-sonnet-4" } },
{ "id": "deep-analyst",    "workspace": "~/.openclaw/workspaces/deep-analyst",    "model": { "primary": "claude-max/claude-opus-4" } },
{ "id": "quick-executor",  "workspace": "~/.openclaw/workspaces/quick-executor",  "model": { "primary": "claude-max/claude-haiku-4" } },
{ "id": "research-scout",  "workspace": "~/.openclaw/workspaces/research-scout",  "model": { "primary": "google/gemini-2.5-flash" } },

// ── bindings 中添加 commander 绑定 ──

CONFIGEOF

if [ -n "$CHANNEL_ID" ]; then
    echo "{ \"agentId\": \"commander\", \"match\": { \"channel\": \"discord\", \"peer\": { \"kind\": \"channel\", \"id\": \"$CHANNEL_ID\" } } }"
else
    echo '{ "agentId": "commander", "match": { "channel": "discord", "peer": { "kind": "channel", "id": "YOUR_CHANNEL_ID" } } }'
fi

cat << 'CONFIGEOF'

// ── 顶层添加 tools 配置（如果不存在）──

"tools": {
  "agentToAgent": {
    "enabled": true
  }
}
CONFIGEOF

echo ""
echo "═══════════════════════════════════════════════════"
echo "部署完成！"
echo ""
echo "Workspace 清单:"
for agent in "${AGENTS[@]}"; do
    ws="$WORKSPACES/$agent"
    echo "  $ws/"
    echo "    CLAUDE.md  $(wc -c < "$ws/CLAUDE.md" 2>/dev/null || echo '?') bytes"
    echo "    memory/    $(ls "$ws/memory/"*.md 2>/dev/null | wc -l) files"
done
echo ""
echo "下一步:"
echo "  1. 编辑 ~/.openclaw/openclaw.json 添加上面的配置"
echo "  2. 在 Discord 创建一个新频道给 Commander"
echo "  3. 把频道 ID 填入 bindings"
echo "  4. pm2 restart openclaw"
echo "  5. 在频道中测试: 发消息让 Commander 调度任务"
echo "═══════════════════════════════════════════════════"
