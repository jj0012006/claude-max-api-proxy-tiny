#!/bin/bash
# ============================================
# Claude Max API Proxy — API 测试用例
# 用法: chmod +x test-cases.sh && ./test-cases.sh
# ============================================

PROXY="http://127.0.0.1:3456"

echo "========== 0. 健康检查 =========="

echo "--- Proxy health ---"
curl -s "$PROXY/health"
echo ""

echo "--- Proxy status ---"
curl -s "$PROXY/api/status" | python3 -m json.tool 2>/dev/null || curl -s "$PROXY/api/status"
echo ""

echo "--- Models ---"
curl -s "$PROXY/v1/models" | python3 -m json.tool 2>/dev/null || curl -s "$PROXY/v1/models"
echo ""

echo "========== 1. Claude Non-Streaming (haiku) =========="

curl -s -X POST "$PROXY/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4","messages":[{"role":"user","content":"2+2=? 只回答数字"}]}'
echo ""
echo ""

echo "========== 2. Claude Non-Streaming (sonnet) =========="

curl -s -X POST "$PROXY/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4","messages":[{"role":"user","content":"1+1=? 只回答数字"}]}'
echo ""
echo ""

echo "========== 3. Claude Streaming =========="

curl -N -X POST "$PROXY/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4","messages":[{"role":"user","content":"Say hi"}],"stream":true}'
echo ""
echo ""

echo "========== 4. System Prompt 透传 =========="

curl -s -X POST "$PROXY/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4","messages":[{"role":"system","content":"你是一只猫，只能说喵"},{"role":"user","content":"你好"}]}'
echo ""
echo ""

echo "========== 5. 多轮对话历史 =========="

curl -s -X POST "$PROXY/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4","messages":[{"role":"user","content":"我叫小明"},{"role":"assistant","content":"你好小明！"},{"role":"user","content":"我叫什么？只回答名字"}]}'
echo ""
echo ""

echo "========== 6. 错误处理：空消息 =========="

curl -s -X POST "$PROXY/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4","messages":[]}'
echo ""
echo ""

echo "========== 完成 =========="
