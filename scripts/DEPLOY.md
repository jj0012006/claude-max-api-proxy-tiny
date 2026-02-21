# 部署与运维手册

## 服务架构

```
OpenClaw (:18789)  →  Claude Proxy (:3456)  →  Claude CLI  →  Anthropic API
                   →  Google AI API (直连，无需 proxy)
```

| 服务 | 端口 | 用途 |
|---|---|---|
| Claude Proxy | 3456 | OpenAI 兼容 API → Claude CLI 翻译层 |
| OpenClaw | 18789 | Telegram/Slack/Discord 网关，管理 agents、session、memory |

## 环境变量

**可选**：

```bash
export OPENCLAW_BASE_URL=http://127.0.0.1:18789  # OpenClaw 地址（默认值）
export PROXY_CWD=~/.openclaw/workspaces/default/    # Claude CLI 工作目录（agent workspace）
```

## 一键重启

```bash
chmod +x scripts/restart.sh
./scripts/restart.sh
```

## 手动操作

### 启动 Claude Proxy

```bash
pm2 start /home/claude-proxy/claude-max-api-proxy-main/dist/server/standalone.js --name claude-proxy
```

### 保存 PM2 配置（重启后自动恢复）

```bash
pm2 save
pm2 startup  # 首次执行，设置开机自启
```

### 停止/重启

```bash
pm2 stop claude-proxy
pm2 restart claude-proxy
```

## 日志查看

```bash
pm2 logs claude-proxy         # 实时日志
pm2 logs claude-proxy --lines 100  # 最近 100 行
```

## 健康检查

```bash
curl -s http://127.0.0.1:3456/health       # Proxy 存活
curl -s http://127.0.0.1:3456/api/status   # 完整状态（含 CLI 版本、OpenClaw 连通性）
```

## 代码更新部署

```bash
# 1. 本地 build
npm run build

# 2. 同步到服务器
rsync -avz --exclude node_modules --exclude .git dist/ package.json 服务器:/home/claude-proxy/claude-max-api-proxy-main/

# 3. 服务器上重启
pm2 restart claude-proxy
```

## 常见问题

### Claude CLI 未找到
确认已安装: `npm install -g @anthropic-ai/claude-code`，并确认 `claude --version` 可用。

### 权限问题
- `claude-proxy` 用户需要读取 `~root/.openclaw/openclaw.json`（获取 Telegram bot token）
- 授权: `setfacl -m u:claude-proxy:rx /root/.openclaw/`

### 服务器重启后服务没恢复
执行 `pm2 startup` 设置开机自启，然后 `pm2 save` 保存当前进程列表。
