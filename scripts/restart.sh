#!/bin/bash
# ============================================
# Claude Max API Proxy — 一键重启脚本
# 用法: chmod +x restart.sh && ./restart.sh
# ============================================

set -e

# ---- 配置 ----
LITELLM_CONFIG="/root/.openclaw/litellm-config.yaml"
LITELLM_PORT=4000
PROXY_ENTRY="/home/claude-proxy/claude-max-api-proxy-main/dist/server/standalone.js"

# ---- 加载环境变量 ----
# GEMINI_API_KEY 必须设置，否则 LiteLLM 会 401
if [ -z "$GEMINI_API_KEY" ]; then
  # 尝试从 .bashrc 或 .env 文件读取
  [ -f /root/.bashrc ] && source /root/.bashrc
  [ -f /root/.openclaw/.env ] && source /root/.openclaw/.env
fi

if [ -z "$GEMINI_API_KEY" ]; then
  echo "❌ GEMINI_API_KEY 未设置！"
  echo "   请先执行: export GEMINI_API_KEY=\"你的key\""
  echo "   或将其写入 /root/.bashrc"
  exit 1
fi

echo "✅ GEMINI_API_KEY 已设置"

# ---- 停止现有服务 ----
echo ""
echo "=== 停止现有服务 ==="
pm2 stop litellm 2>/dev/null && pm2 delete litellm 2>/dev/null || true
pm2 stop claude-proxy 2>/dev/null && pm2 delete claude-proxy 2>/dev/null || true
echo "已清理旧进程"

# ---- 启动 LiteLLM ----
echo ""
echo "=== 启动 LiteLLM (端口 $LITELLM_PORT) ==="
pm2 start litellm --name litellm --interpreter none -- --config "$LITELLM_CONFIG" --port "$LITELLM_PORT"

# 等待 LiteLLM 就绪
echo -n "等待 LiteLLM 启动"
for i in $(seq 1 15); do
  sleep 1
  echo -n "."
  if curl -s "http://127.0.0.1:$LITELLM_PORT/health" > /dev/null 2>&1; then
    echo " ✅"
    break
  fi
  if [ "$i" -eq 15 ]; then
    echo " ⚠️  超时，继续启动 proxy（LiteLLM 可能还在初始化）"
  fi
done

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
LITELLM_HEALTH=$(curl -s "http://127.0.0.1:$LITELLM_PORT/health" 2>/dev/null || echo "unreachable")

echo "Proxy:   $PROXY_HEALTH"
echo "LiteLLM: $LITELLM_HEALTH"

echo ""
echo "=== 完成 ==="
echo "Dashboard: http://127.0.0.1:3456/dashboard"
echo "日志查看:  pm2 logs"
