#!/bin/bash
# ============================================
# API 测试用例
# 用法: 把这个文件传到服务器执行
#   chmod +x test-cases.sh && ./test-cases.sh
# ============================================

PROXY="http://127.0.0.1:3456"
LITELLM="http://127.0.0.1:4000"

echo "========== 0. 健康检查 =========="

echo "--- Proxy health ---"
curl -s "$PROXY/health"
echo ""

echo "--- LiteLLM health ---"
curl -s "$LITELLM/health"
echo ""

echo "--- Proxy status ---"
curl -s "$PROXY/api/status" | python3 -m json.tool 2>/dev/null || curl -s "$PROXY/api/status"
echo ""

echo "========== 1. LiteLLM 直连 Gemini =========="

cat > /tmp/test-litellm.json << 'ENDJSON'
{
  "model": "gemini-flash",
  "messages": [{"role": "user", "content": "Say hello in one word"}],
  "max_tokens": 10,
  "stream": false
}
ENDJSON

curl -s -X POST "$LITELLM/v1/chat/completions" -H "Content-Type: application/json" -d @/tmp/test-litellm.json
echo ""
echo ""

echo "========== 2. Proxy → Gemini (显式 model=gemini-pro) =========="

cat > /tmp/test-gemini.json << 'ENDJSON'
{
  "model": "gemini-pro",
  "messages": [{"role": "user", "content": "1+1等于几？只回答数字"}],
  "stream": false
}
ENDJSON

curl -s -X POST "$PROXY/v1/chat/completions" -H "Content-Type: application/json" -d @/tmp/test-gemini.json
echo ""
echo ""

echo "========== 3. Proxy → Claude (显式 model=claude-sonnet-4) =========="

cat > /tmp/test-claude.json << 'ENDJSON'
{
  "model": "claude-sonnet-4",
  "messages": [{"role": "user", "content": "1+1等于几？只回答数字"}],
  "stream": false
}
ENDJSON

curl -s -X POST "$PROXY/v1/chat/completions" -H "Content-Type: application/json" -d @/tmp/test-claude.json
echo ""
echo ""

echo "========== 4. Proxy → Auto (翻译任务,应路由到 Gemini) =========="

cat > /tmp/test-auto-gemini.json << 'ENDJSON'
{
  "model": "auto",
  "messages": [{"role": "user", "content": "请把这句话翻译成英文：今天天气不错"}],
  "stream": false
}
ENDJSON

curl -s -X POST "$PROXY/v1/chat/completions" -H "Content-Type: application/json" -d @/tmp/test-auto-gemini.json
echo ""
echo ""

echo "========== 5. Proxy → Auto (编程任务,应路由到 Claude) =========="

cat > /tmp/test-auto-claude.json << 'ENDJSON'
{
  "model": "auto",
  "messages": [{"role": "user", "content": "写一个Python函数判断素数"}],
  "stream": false
}
ENDJSON

curl -s -X POST "$PROXY/v1/chat/completions" -H "Content-Type: application/json" -d @/tmp/test-auto-claude.json
echo ""
echo ""

echo "========== 6. Proxy → Gemini Streaming =========="

cat > /tmp/test-gemini-stream.json << 'ENDJSON'
{
  "model": "gemini-flash",
  "messages": [{"role": "user", "content": "Say hi"}],
  "stream": true
}
ENDJSON

curl -s -X POST "$PROXY/v1/chat/completions" -H "Content-Type: application/json" -d @/tmp/test-gemini-stream.json
echo ""
echo ""

echo "========== 7. Proxy → Claude Streaming =========="

cat > /tmp/test-claude-stream.json << 'ENDJSON'
{
  "model": "claude-sonnet-4",
  "messages": [{"role": "user", "content": "Say hi"}],
  "stream": true
}
ENDJSON

curl -s -X POST "$PROXY/v1/chat/completions" -H "Content-Type: application/json" -d @/tmp/test-claude-stream.json
echo ""
echo ""

echo "========== 完成 =========="
