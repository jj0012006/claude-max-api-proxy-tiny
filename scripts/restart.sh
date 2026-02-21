#!/bin/bash
# ============================================
# Claude Max API Proxy — 一键重启脚本
# 用法: chmod +x restart.sh && ./restart.sh
# ============================================

set -e

# ---- 配置 ----
PROXY_ENTRY="/home/claude-proxy/claude-max-api-proxy-main/dist/server/standalone.js"

# ---- 停止现有服务 ----
echo "=== 停止现有服务 ==="
pm2 stop claude-proxy 2>/dev/null && pm2 delete claude-proxy 2>/dev/null || true
echo "已清理旧进程"

# ---- 启动 Claude Proxy ----
echo ""
echo "=== 启动 Claude Proxy ==="
pm2 start "$PROXY_ENTRY" --name claude-proxy

# ---- 保存 PM2 配置 ----
pm2 save

# ---- 验证 ----
echo ""
echo "=== 服务状态 ==="
pm2 list

echo ""
echo "=== 健康检查 ==="
sleep 2

PROXY_HEALTH=$(curl -s http://127.0.0.1:3456/health 2>/dev/null || echo '{"status":"unreachable"}')
echo "Proxy: $PROXY_HEALTH"

echo ""
echo "=== 完成 ==="
echo "Dashboard: http://127.0.0.1:3456/dashboard"
echo "日志查看:  pm2 logs claude-proxy"
