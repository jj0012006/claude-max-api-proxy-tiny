# 部署与运维手册

## 服务架构

```
LiteLLM (:4000)  ←→  Claude Proxy (:3456)  ←→  OpenClaw (:18789)
```

| 服务 | 端口 | 用途 |
|---|---|---|
| LiteLLM | 4000 | Gemini API 代理 |
| Claude Proxy | 3456 | OpenAI 兼容 API，路由 Claude/Gemini |
| OpenClaw | 18789 | Telegram/Slack 网关 |

## 环境变量

**必须设置**（写入 `/root/.bashrc`）：

```bash
export GEMINI_API_KEY="AIzaSy..."
```

**可选**：

```bash
export ROUTER_ENABLED=true              # 是否启用智能路由（默认 true）
export ROUTER_MODEL=gemini-router       # 路由分类用的模型（默认 gemini-flash）
export GEMINI_DEFAULT_MODEL=gemini-flash # 默认 Gemini 模型（默认 gemini-flash）
export OPENCLAW_BASE_URL=http://127.0.0.1:18789
export LITELLM_BASE_URL=http://127.0.0.1:4000
```

## 一键重启

```bash
chmod +x /root/claude-max-api-proxy-main/scripts/restart.sh
/root/claude-max-api-proxy-main/scripts/restart.sh
```

## 手动操作

### 启动 LiteLLM

```bash
export GEMINI_API_KEY="你的key"
pm2 start litellm --name litellm --interpreter none -- --config /root/.openclaw/litellm-config.yaml --port 4000
```

### 启动 Claude Proxy

```bash
pm2 start /home/claude-proxy/claude-max-api-proxy-main/dist/server/standalone.js --name claude-proxy
```

### 保存 PM2 配置（重启后自动恢复）

```bash
pm2 save
pm2 startup  # 首次执行，设置开机自启
```

### 停止服务

```bash
pm2 stop all        # 停止所有
pm2 stop litellm    # 单独停止 LiteLLM
pm2 stop claude-proxy  # 单独停止 Proxy
```

### 重启单个服务

```bash
pm2 restart litellm
pm2 restart claude-proxy
```

## 日志查看

```bash
pm2 logs                  # 实时查看所有日志
pm2 logs claude-proxy     # 只看 Proxy 日志
pm2 logs litellm          # 只看 LiteLLM 日志
pm2 logs --lines 100      # 最近 100 行
```

## 健康检查

```bash
curl -s http://127.0.0.1:3456/health           # Proxy
curl -s http://127.0.0.1:4000/health           # LiteLLM
curl -s http://127.0.0.1:3456/api/status       # 完整状态
```

## 代码更新部署

```bash
# 1. 本地 build
npm run build

# 2. 同步到服务器（从本地执行）
rsync -avz --exclude node_modules --exclude .git dist/ package.json 服务器:/home/claude-proxy/claude-max-api-proxy-main/

# 3. 服务器上重启
pm2 restart claude-proxy
```

## 常见问题

### LiteLLM 返回 401
GEMINI_API_KEY 环境变量未设置。确认 `echo $GEMINI_API_KEY` 有值后重启。

### Gemini 返回 429
模型限额已满。检查 LiteLLM config 是否用了 preview 模型（限额低），改用稳定版。

### 路由全走 Claude
1. 检查 LiteLLM 是否在线：`curl http://127.0.0.1:4000/health`
2. 检查 `ROUTER_ENABLED` 不是 `false`
3. 查看日志中 `[Router]` 开头的行

### 服务器重启后服务没恢复
执行 `pm2 startup` 设置开机自启，然后 `pm2 save` 保存当前进程列表。
