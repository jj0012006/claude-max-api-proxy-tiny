# Claude Max API Proxy - Technical Design

## Overview

A multi-model AI proxy that exposes an OpenAI-compatible API. Routes requests between Claude (via Claude Code CLI subprocess) and Gemini (via LiteLLM), with intelligent automatic routing, session persistence, persistent memory, and streaming support.

## System Architecture

```
┌─────────────┐
│   Clients    │
│  Telegram    │
│  Slack       │
│  Any OpenAI  │
│  client      │
└──────┬───────┘
       │
       ▼
┌──────────────────────┐
│  OpenClaw Gateway    │
│  :18789              │
│  Message Routing     │
│  Platform Tools      │
│  (cron, browser)     │
└──────┬───────────────┘
       │ POST /v1/chat/completions
       ▼
┌──────────────────────────────────────────────────────┐
│              Claude Max API Proxy  :3456              │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │              Request Routing                   │  │
│  │  model = "gemini-*" → Gemini path             │  │
│  │  model = "claude-*" → Claude path             │  │
│  │  model = "auto"     → Router → classify       │  │
│  └───────┬────────────────────────┬───────────────┘  │
│          │                        │                  │
│          ▼                        ▼                  │
│  ┌───────────────┐     ┌──────────────────────┐     │
│  │ Claude Path   │     │ Gemini Path          │     │
│  │               │     │                      │     │
│  │ OpenAI→CLI    │     │ Forward to LiteLLM   │     │
│  │  Adapter      │     │ (streaming or JSON)  │     │
│  │               │     │                      │     │
│  │ Session Mgr   │     │ Append 🟢 tag        │     │
│  │  --resume     │     └──────────┬───────────┘     │
│  │  --session-id │                │                  │
│  │               │                ▼                  │
│  │ Subprocess    │     ┌──────────────────────┐     │
│  │  Manager      │     │  LiteLLM  :4000      │     │
│  │  spawn+stream │     │  OpenAI-compat proxy  │     │
│  │               │     └──────────┬───────────┘     │
│  │ Smart Turn    │                │                  │
│  │  Buffering    │                ▼                  │
│  │               │     ┌──────────────────────┐     │
│  │ CLI→OpenAI    │     │  Google AI API       │     │
│  │  Adapter      │     │  Gemini Pro/Flash    │     │
│  │               │     └──────────────────────┘     │
│  │ Append 🟣 tag │                                   │
│  └───────┬───────┘                                   │
│          │                                           │
│  ┌───────────────────────────────────────────────┐  │
│  │ Features: Simulated Tool Calling │ Session     │  │
│  │ Persistence │ Voice/Groq │ YouTube/yt-dlp │   │  │
│  │ SSE Heartbeat │ Activity Timeout (10min) │    │  │
│  │ Telegram Progress │ Persistent Memory │       │  │
│  └───────────────────────────────────────────────┘  │
└──────────┬───────────────────────────────────────────┘
           │ subprocess spawn
           ▼
┌──────────────────────────────────────────┐
│  Claude Code CLI                         │
│  --print                                 │
│  --output-format stream-json             │
│  --dangerously-skip-permissions          │
│  --system-prompt <injected>              │
│  --session-id / --resume                 │
│                                          │
│  Native Tools:                           │
│  Bash  Read  Write  Edit                 │
│  Grep  Glob  WebFetch  WebSearch         │
│                                          │
│  CWD: ~/.openclaw/workspace              │
│  Reads: CLAUDE.md + memory/              │
└──────────────────┬───────────────────────┘
                   │ Max subscription
                   ▼
┌──────────────────────────────────────────┐
│  Anthropic API                           │
│  Claude Max  $200/mo                     │
│  Opus 4 │ Sonnet 4 │ Haiku 4            │
└──────────────────────────────────────────┘
```

## Component Design

### 1. Configuration (`src/config.ts`)

Centralized environment variable configuration:

```typescript
interface ProxyConfig {
  litellmBaseUrl: string;       // LITELLM_BASE_URL (default: http://127.0.0.1:4000)
  routerModel: string;          // ROUTER_MODEL (default: gemini-flash)
  routerEnabled: boolean;       // ROUTER_ENABLED (default: true)
  geminiDefaultModel: string;   // GEMINI_DEFAULT_MODEL (default: gemini-pro)
}
```

### 2. Intelligent Router (`src/router/index.ts`)

Routes requests to the optimal provider using Gemini Flash as a classifier.

**Flow:**
1. `getExplicitProvider(model)` — Check if model name targets a specific provider
2. If model is `"auto"` → call `routeRequest(userMessage)` via LiteLLM
3. Gemini Flash classifies the task with a system prompt
4. Returns `"claude"` or `"gemini"`

**Routing rules:**
- **Gemini**: Math, science, translation, large doc summarization, general Q&A
- **Claude**: Coding, tool use, multi-step analysis, technical writing, DevOps, ambiguous

**Fallbacks:**
- 15-second timeout → Claude
- LiteLLM error → Claude
- `ROUTER_ENABLED=false` → all requests go to Claude

### 3. Gemini Provider (`src/provider/gemini.ts`)

Transparent proxy to Google's Gemini models via LiteLLM:

- `handleGeminiStreaming()` — Proxies SSE events from LiteLLM to client
- `handleGeminiNonStreaming()` — Waits for full response, returns JSON
- `resolveGeminiModel()` — Maps model names to LiteLLM identifiers
- Appends `🟢 Gemini` tag to all responses

### 4. Request Adapter (`src/adapter/openai-to-cli.ts`)

Converts OpenAI chat requests to Claude CLI input format:

**Key functions:**
- `openaiToCli(request, hasExistingSession)` — Main conversion entry point
  - New session: full message history → prompt + system prompt
  - Existing session: only latest user message (CLI has context)
- `messagesToPrompt(messages)` — Extracts system parts and prompt parts
- `extractModel(model)` — Maps model strings to CLI aliases (opus/sonnet/haiku)
- `cleanAssistantContent(text)` — Strips XML tool patterns from assistant messages
- `extractLatestUserMessage(messages)` — Gets most recent user message for routing

**System prompt injection:**
- CLI tool instructions (Bash, Read, Write, etc.)
- Voice/audio handling (Groq Whisper)
- YouTube analysis (yt-dlp)
- Media delivery protocol
- Persistent memory system instructions

### 5. Response Adapter (`src/adapter/cli-to-openai.ts`)

Converts Claude CLI output to OpenAI response format:

- `cliResultToOpenai(result, requestId)` — Non-streaming: result → OpenAI completion
- `createDoneChunk(requestId, model)` — Final SSE chunk with `finish_reason: "stop"`

### 6. Subprocess Manager (`src/subprocess/manager.ts`)

Manages Claude CLI subprocess lifecycle:

**Process spawning:**
```
claude --print --output-format stream-json --verbose
       --include-partial-messages --model <opus|sonnet|haiku>
       --dangerously-skip-permissions
       [--session-id <uuid> | --resume <uuid>]
       [--system-prompt <text>]
       -- <prompt>
```

**Features:**
- Activity-based timeout (10 min no output → SIGTERM)
- Resume failure detection via stderr keyword scanning
- Stable working directory (`PROXY_CWD` or `~/.openclaw/workspace`)
- Auto-bootstraps CLAUDE.md + memory/ directory on first run
- JSON stream parsing with buffer management

**Memory bootstrap (`ensureCwd`):**
- Creates `~/.openclaw/workspace/` directory
- Creates `CLAUDE.md` with memory instructions
- Creates `memory/` with seed files:
  - `user-profile.md`
  - `preferences.md`
  - `knowledge-log.md`
  - `projects.md`

### 7. Session Manager (`src/session/manager.ts`)

Maps external conversation IDs to Claude CLI session UUIDs:

```typescript
interface SessionMapping {
  clawdbotId: string;        // External conversation ID
  claudeSessionId: string;   // Claude CLI session UUID
  createdAt: number;
  lastUsedAt: number;
  model: string;
  messageCount: number;
}
```

**Session lifecycle:**
1. First message → `getOrCreate()` → new UUID → `--session-id`
2. Subsequent messages → existing mapping → `--resume`
3. Resume failure → `invalidate()` → next message creates new session
4. 24-hour TTL → `cleanup()` (runs hourly)

### 8. Route Handlers (`src/server/routes.ts`)

**`handleChatCompletions`** — Main entry point:
1. Validate request
2. Route to provider (explicit or intelligent)
3. Dispatch to Claude or Gemini handler

**Claude streaming — Smart Turn Buffering:**

Claude CLI executes multiple "turns" when using tools. Each turn starts with a `message_start` event and produces content deltas. Without buffering, intermediate tool output would leak to the client.

```
Turn 1: "Let me check..." [Bash tool] [Read tool] → buffered, discarded
Turn 2: "Let me analyze..." [WebFetch] → buffered, discarded
Turn 3: "Here are the results..." → buffered, flushed to client
```

Implementation:
- Track `message_start` events → new turn → clear buffer
- Buffer all `content_delta` text
- On `result` event → flush last turn's buffer as SSE chunks
- Append `🟣 Claude` tag chunk
- Send `[DONE]`

**Telegram Progress Reporter:**
- Reads bot token from `~/.openclaw/openclaw.json`
- Sends "Working... [tool1 → tool2 → ...]" message during tool execution
- Throttled to 1 update per 3 seconds
- Auto-cleanup on completion

## Data Flow

### Claude Path (streaming)

```
Client POST → handleChatCompletions
  → getExplicitProvider("claude-sonnet-4") → "claude"
  → openaiToCli(body, hasExistingSession)
    → { prompt, systemPrompt, model: "sonnet" }
  → sessionManager.getOrCreate(conversationId)
  → subprocess.start(prompt, { model, sessionId, systemPrompt })
    → spawn("claude", [...args, "--", prompt])
  → [SSE headers flushed]
  → subprocess events:
    → message_start → new turn, clear buffer
    → content_delta → push to buffer
    → content_block_start (tool_use) → report to Telegram
    → result → flush buffer as SSE chunks → 🟣 tag → [DONE]
```

### Gemini Path (streaming)

```
Client POST → handleChatCompletions
  → getExplicitProvider("gemini-pro") → "gemini"
  → handleGeminiStreaming(res, messages, model, requestId)
    → resolveGeminiModel("gemini-pro") → "gemini-pro"
    → fetch(LiteLLM /v1/chat/completions, { stream: true })
    → pipe SSE events to client
    → append 🟢 tag chunk
    → res.end()
```

### Auto-routing Path

```
Client POST (model="auto") → handleChatCompletions
  → getExplicitProvider("auto") → null
  → extractLatestUserMessage(messages) → "Write a Python function"
  → routeRequest("Write a Python function")
    → fetch(LiteLLM, { model: "gemini-flash", messages: [system + user] })
    → response: "claude"
  → [continue to Claude path]
```

## Type System

### Claude CLI Types (`src/types/claude-cli.ts`)

Key message types in the stream-json output:

| Type | Description |
|------|-------------|
| `system` (init) | Session initialization with tools list |
| `assistant` | Full assistant message with content blocks |
| `result` | Final result with usage stats |
| Stream events | `message_start`, `content_block_start`, `content_block_delta` |

Helper functions: `isAssistantMessage()`, `isResultMessage()`, `isContentDelta()`, `isMessageStart()`, `isContentBlockStart()`

### OpenAI Types (`src/types/openai.ts`)

Standard OpenAI chat completion types:
- `OpenAIChatRequest` — Request with messages, model, stream flag
- `OpenAIChatResponse` — Non-streaming response
- `OpenAIChatChunk` — SSE streaming chunk
- `OpenAIChatMessage` / `OpenAIContentPart` — Message formats

## Security

1. **spawn() over exec()** — Prevents shell injection
2. **No credential storage** — CLI handles OAuth via OS keychain
3. **Local binding** — Server binds to localhost only
4. **Non-root execution** — CLI rejects `--dangerously-skip-permissions` under root
5. **ACL for file access** — Cross-user permissions via `setfacl`

## Deployment Architecture

```
Server (Linux)
├── claude-proxy user
│   └── pm2: claude-proxy (node dist/server/standalone.js)
│       → Express :3456
│       → spawns claude CLI subprocesses
│       → CWD: ~/.openclaw/workspace
│
├── root user
│   └── pm2: litellm (litellm --config ... --port 4000)
│       → LiteLLM :4000
│       → proxies to Google AI API
│
└── root user
    └── pm2: openclaw (openclaw start)
        → OpenClaw Gateway :18789
        → Telegram/Slack ↔ Proxy
```

File permissions:
- `claude-proxy` needs read access to `~root/.openclaw/openclaw.json` (for Telegram bot token)
- Granted via ACL: `setfacl -m u:claude-proxy:rx /root/.openclaw/`
