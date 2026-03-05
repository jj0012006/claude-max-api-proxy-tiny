# Changelog

All notable changes to this project will be documented in this file.

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
