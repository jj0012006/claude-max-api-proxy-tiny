# Changelog

All notable changes to this project will be documented in this file.

## [3.1.0] - 2026-03-06

### 🎉 Major Features

#### CLI `--resume` Session Continuity
- **Session Resume** - 首次请求用 `--session-id` 建立 CLI session，后续请求用 `--resume` 只发最新消息
- **Session ID 派生** - 从 system message hash 自动生成稳定的 session ID，无需客户端传递
- **SessionStore** - 内存级 CLI session 映射，24 小时 TTL 自动清理
- **Fallback 机制** - Resume 失败自动回退到完整 prompt 模式

#### 代码精简
- **移除 Context Manager** - 滑动窗口和摘要压缩已被 `--resume` 替代
- **移除 Telegram 进度推送** - 未使用（`telegram_chat_id` 始终 undefined）
- **移除模型名标签** - 不再在回复末尾拼接 `🟣 model`

### 🏗️ Architecture Changes

| Aspect | v3.0 | v3.1 |
|--------|------|------|
| **Session** | Stateless（每次全量 prompt） | `--resume`（后续只发新消息） |
| **参数长度** | 滑动窗口裁剪（~11k tokens） | Resume 模式（仅最新消息） |
| **Context 管理** | Proxy 层滑动窗口 + 摘要 | CLI 原生 session 持久化 |
| **依赖** | Gemini Flash（摘要生成） | 无外部依赖 |

### 📁 File Changes

**新增:**
- `src/session/store.ts` - CLI session 映射存储

**删除 (7 files):**
- `src/context/` 整个目录（manager, strategies, store, types, config）

**修改:**
- `src/server/routes.ts` - Resume 流程 + 清理 Telegram/Context 代码（净减 ~730 行）
- `src/subprocess/manager.ts` - 添加 `--resume` / `--session-id` 参数支持
- `src/adapter/openai-to-cli.ts` - 添加 `extractLatestUserMessage()`

### 📊 Impact

- 代码量：~950 行 → ~550 行（-42%）
- 后续请求参数：从 ~44K chars 降到 <1K chars
- 无外部 API 依赖（移除 Gemini Flash 摘要调用）

---

## [3.0.0] - 2026-03-05

### 🎉 Major Features

#### Context Manager (上下文管理)
**New module: `src/context/`**

- **Sliding Window Strategy** - Automatically retains only the most recent N turns of conversation (default: 30)
- **Summary Compression Strategy** - Generates conversation summaries every 50 turns using Gemini Flash
- **Session State Management** - In-memory storage with automatic cleanup of expired sessions
- **Token Optimization** - Real-time token estimation and savings reporting
- **Response Headers** - Added `x-session-id`, `x-context-tokens`, `x-context-saved`, `x-context-savings`

**Expected token savings:**
- 30 turns: ~15% reduction
- 50 turns: ~40% reduction  
- 100+ turns: 60-80% reduction

**Configuration (Environment Variables):**
- `CONTEXT_WINDOW_SIZE` - Sliding window size (default: 30)
- `CONTEXT_SUMMARY_THRESHOLD` - Summary trigger threshold (default: 50)
- `GEMINI_API_URL` - Gemini API endpoint
- `GEMINI_MODEL` - Gemini model for summary generation

### 🏗️ Architecture Changes

#### v2 → v3 Evolution

| Aspect | v2 | v3 |
|--------|----|----|
| **Context** | Full history injection | Windowed + summarized |
| **Token growth** | Linear | Bounded |
| **State** | Stateless | Session-aware (context only) |
| **Cost** | Increases with turns | Stabilizes after 50 turns |

### 📁 New Files

```
src/context/
├── types.ts              # Type definitions
├── config.ts             # Configuration management
├── manager.ts            # Core context manager
├── index.ts              # Module exports
├── strategies/
│   ├── window.ts         # Sliding window strategy
│   └── summary.ts        # Summary compression strategy
└── store/
    └── memory.ts         # In-memory store (Redis-ready)
```

### 🔧 Modified Files

- `src/server/routes.ts` - Integrated Context Manager before CLI conversion

### 📊 Performance Impact

**Before (v2):**
- 100 turns: ~10,000 tokens per request
- Cost: ~$0.15 per request

**After (v3):**
- 100 turns: ~4,000 tokens per request (60% reduction)
- Cost: ~$0.06 per request

### 🔄 Breaking Changes

**None** - Fully backward compatible. Context optimization is transparent to clients.

### 📝 Migration Notes

- No code changes required
- Existing clients work without modification
- Monitor `x-context-savings` header to track optimization effectiveness

---

## [2.0.0] - 2026-02-24

### Major Changes

- **Stateless Architecture** - Removed session management, full history injection
- **Simplified Codebase** - Reduced from ~2500 lines to ~950 lines (-60%)
- **Removed LiteLLM** - Gemini runs natively in OpenClaw
- **Multi-Agent Support** - Per-channel workspace isolation via OpenClaw
- **Smart Turn Buffering** - Filters intermediate tool execution output

### Removed Components

- Router (Gemini Flash classifier)
- SessionManager + `--resume` CLI flags
- `bots.json` + centralized bot config
- LiteLLM sidecar process

### Retained Components

- OpenAI ↔ CLI adapters
- Smart Turn Buffering
- Subprocess Manager with activity timeout
- Telegram Progress Reporter
- Monitoring Dashboard

---

## [1.0.0] - 2026-01-15

### Initial Release

- OpenAI-compatible API wrapper for Claude Code CLI
- OAuth token bypass via CLI authentication
- Streaming and non-streaming support
- Tool execution support
- Basic monitoring dashboard
