# Claude Max API Proxy v2 — Architecture

## System Overview

A stateless bridge between OpenAI-compatible API clients and Claude Code CLI. Translates API requests into CLI subprocess calls and buffers multi-turn tool execution output.

```
┌─────────────────────────────────────────────────────┐
│                    Clients                           │
│         Telegram / Discord / Slack / Any             │
└────────────────────┬────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────┐
│              OpenClaw Gateway (:18789)               │
│                                                     │
│  Multi-Agent Routing │ Bindings │ Platform Tools    │
│  Session & Memory    │ channel→ │ (cron, browser)   │
│  Management          │  agent   │                   │
│                                                     │
│  Tools (model-agnostic, available to ALL agents):   │
│  Bash, Read, Write, Edit, Grep, Glob,              │
│  WebFetch, WebSearch, Browser, Cron                 │
└───────┬─────────────────────────────┬───────────────┘
        │                             │
        │ Claude agents               │ Gemini agents
        │ POST /v1/chat/completions   │ (native, direct)
        ▼                             ▼
┌───────────────────────┐   ┌─────────────────────────┐
│ Claude Max API Proxy  │   │    Google AI API         │
│      (:3456)          │   │                         │
│                       │   │  Gemini 2.5 Flash/Pro   │
│ ┌────────┐ ┌────────┐│   │  Full OpenClaw tool     │
│ │OAI→CLI │ │CLI→OAI ││   │  access (Bash, Web, etc)│
│ │Adapter │ │Adapter ││   └─────────────────────────┘
│ └───┬────┘ └───▲────┘│
│ ┌───▼──────────┴────┐ │
│ │ Subprocess Mgr    │ │
│ │ + Turn Buffering  │ │
│ │ + Telegram Prog.  │ │
│ └───┬───────────────┘ │
└─────┼─────────────────┘
      │ subprocess
      ▼
┌───────────────────────┐
│   Claude Code CLI     │
│   --print --stream    │
│   --skip-permissions  │
│   --system-prompt     │
└───────┬───────────────┘
        │ OAuth (Max)
        ▼
┌───────────────────────┐
│   Anthropic API       │
│   Opus/Sonnet/Haiku 4 │
│   $200/mo flat rate   │
└───────────────────────┘
```

## Component Details

### Request Handler (`src/server/routes.ts`)

Entry point for all API requests. Handles:

1. **Request validation** — Ensures messages array is present and non-empty
2. **CLI conversion** — Converts OpenAI format to CLI input via adapter
3. **Subprocess dispatch** — Starts Claude CLI subprocess
4. **Response formatting** — Streaming (SSE) or non-streaming (JSON)

### Smart Turn Buffering (`src/server/routes.ts`)

Claude CLI executes multiple "turns" when using tools. Each turn is marked by a `message_start` event. The proxy buffers all content deltas per turn and only flushes the **last turn's** content when the `result` event arrives.

```
Turn 1: [Read file] → content: "Let me check..."     ← discarded
Turn 2: [Bash cmd]  → content: "Running..."           ← discarded
Turn 3: [no tools]  → content: "Here's the answer..." ← sent to client
```

### Telegram Progress Reporter (`src/server/routes.ts`)

Sends tool execution progress updates via Telegram Bot API during long-running requests. Reads bot token from `~/.openclaw/openclaw.json` (cached). Throttled to 1 update per 3 seconds.

### OpenAI → CLI Adapter (`src/adapter/openai-to-cli.ts`)

Converts OpenAI chat completion requests to Claude CLI input:

- **System messages** → `--system-prompt` flag (passthrough, no injection)
- **User messages** → CLI prompt text
- **Assistant messages** → Wrapped in `<previous_response>` tags (with XML tool patterns cleaned)
- **Model mapping** → `claude-opus-4` → `opus`, `claude-sonnet-4` → `sonnet`, etc.

### CLI → OpenAI Adapter (`src/adapter/cli-to-openai.ts`)

Converts Claude CLI JSON stream output to OpenAI API format:

- **Result messages** → OpenAI `ChatCompletion` response
- **Stream events** → OpenAI SSE `ChatCompletionChunk` events
- **Done signal** → `data: [DONE]` SSE terminator

### Subprocess Manager (`src/subprocess/manager.ts`)

Manages Claude CLI subprocess lifecycle:

- **Spawn**: `claude --print --output-format stream-json --verbose --dangerously-skip-permissions`
- **Flags**: `--model`, `--system-prompt`
- **Activity timeout**: 10 minutes of no stdout output → SIGTERM
- **Event emission**: Parses JSON lines from stdout → typed events (message, content_delta, assistant, result)

### Monitoring Dashboard (`src/server/dashboard.ts`)

- **`GET /dashboard`** — Auto-refreshing HTML dashboard (5s interval)
- **`GET /api/status`** — JSON status API with component health and request counts
- **Components monitored**: Proxy, OpenClaw Gateway, Claude CLI

### Statistics (`src/server/stats.ts`)

In-memory request counter. Tracks total requests and uptime. Reset on process restart.

## Data Flow

### Streaming Request

```
1. Client → POST /v1/chat/completions (stream: true)
2. Proxy: Set SSE headers, flush, write ":ok\n\n"
3. Proxy: Convert OpenAI messages → CLI prompt + system prompt
4. Proxy: Spawn claude subprocess with flags
5. CLI → stdout JSON lines:
   a. system/init → ignored
   b. message_start (turn N) → reset buffer
   c. content_block_delta → buffer text
   d. message_start (turn N+1) → reset buffer (discard turn N)
   e. content_block_delta → buffer text
   f. result → flush buffer as SSE chunks, append 🟣 model tag, send [DONE]
6. Proxy → Client: SSE stream of chat.completion.chunk events
```

### Non-Streaming Request

```
1. Client → POST /v1/chat/completions (stream: false)
2. Proxy: Same steps 3-4 as above
3. CLI → stdout JSON lines → wait for result event
4. Proxy: Convert result → OpenAI ChatCompletion JSON, append 🟣 model tag
5. Proxy → Client: Single JSON response
```

## Session & Memory Management

**The proxy is completely stateless.** All session, memory, and agent identity management is handled by OpenClaw.

| Responsibility | Owner | How |
|---|---|---|
| Conversation history | OpenClaw | Sends full `messages` array each request |
| Agent persona | OpenClaw | Injects via system message / workspace CLAUDE.md |
| Persistent memory | OpenClaw | `memory/` files injected into system message |
| Model routing | OpenClaw | Per-channel agent bindings |
| Proxy state | None | Zero state between requests |

### Context Flow

```
OpenClaw constructs:
  messages: [
    { system: "<agent identity> + <memory context>" },
    { user: "message 1" },
    { assistant: "response 1" },
    { user: "current message" }
  ]
       ↓
Proxy splits:
  --system-prompt = system messages joined
  prompt = user/assistant messages concatenated
       ↓
Claude CLI: fresh process, no --session-id or --resume
       ↓
Response → OpenClaw stores in history → next request includes it
```

## v1 → v2 Changes

### Removed Components

| v1 Component | v2 Replacement |
|---|---|
| `src/router/index.ts` (Gemini Flash classifier) | OpenClaw agent bindings (per-channel routing) |
| `src/provider/gemini.ts` (LiteLLM proxy) | OpenClaw native Gemini provider (direct API) |
| `src/session/manager.ts` | Removed — OpenClaw sends full history |
| `bots.json` / `src/bot/config.ts` | OpenClaw agent workspaces + CLAUDE.md |
| `CLI_TOOL_INSTRUCTION` (~65 lines) | Agent CLAUDE.md (per-agent instructions) |
| LiteLLM sidecar process (:4000) | Not needed — Gemini runs natively in OpenClaw |
| `--session-id` / `--resume` CLI flags | Not needed — full context each request |
| `migrate-claude-md.sh` | Not needed — OpenClaw manages workspaces |

### Retained Components

| Component | Role |
|---|---|
| OpenAI → CLI Adapter | Core: format conversion |
| CLI → OpenAI Adapter | Core: format conversion |
| Smart Turn Buffering | Core: tool output filtering |
| Subprocess Manager | Core: CLI lifecycle + activity timeout |
| Telegram Progress Reporter | UX: tool execution updates |
| Model Tag (🟣) | UX: identify response source |

## v1 vs v2 Architecture Comparison

### v1: Proxy as Smart Hub

```
Clients → OpenClaw → Proxy (:3456) ─┬─ Router (Gemini Flash classifier)
                                     ├─ Claude Path: Session Mgr → CLI --resume
                                     ├─ Gemini Path: → LiteLLM (:4000) → Google API
                                     └─ Bot Config + CLI_TOOL_INSTRUCTION injection
```

### v2: Proxy as Stateless Translator

```
Clients → OpenClaw (:18789) ─┬─ Claude agents → Proxy (:3456) → CLI → Anthropic
          (routing/session/  └─ Gemini agents → Google AI API (direct)
           memory all here)
```

### Side-by-Side

| Dimension | v1 | v2 |
|---|---|---|
| **Proxy role** | Smart hub: routing + session + memory | Stateless translator: format conversion only |
| **Codebase** | ~2500 lines (16 source files) | ~950 lines (-60%) |
| **Processes** | 3 (Proxy + LiteLLM + OpenClaw) | 2 (Proxy + OpenClaw) |
| **Routing** | Per-message (Gemini Flash classifier, +1-2s) | Per-channel (OpenClaw agent binding) |
| **Session** | SessionManager + --resume (was dead code) | None (full history each request) |
| **Memory** | Proxy injects CLI_TOOL_INSTRUCTION + bootstraps memory/ | OpenClaw injects via system message |
| **Personas** | bots.json + proxy system prompt injection | OpenClaw agent workspace CLAUDE.md |
| **Gemini** | Proxy → LiteLLM → Google API (text-only) | OpenClaw → Google API (with full tools) |

### What v1 Had (Theoretically)

1. **CLI Session Resume** — `--resume` could save tokens by only sending new messages. But `body.user` was always undefined, so sessions never actually resumed.
2. **Per-message routing** — Auto-select best model per message. But added 1-2s latency and classification was unreliable.
3. **Centralized tool instructions** — One place to update voice/YouTube/media handling. But these belong in agent config, not proxy.

### What v2 Gained

1. **Maintainability** — 60% less code, single responsibility, zero state bugs
2. **Stability** — No LiteLLM process to crash/OOM
3. **Agent isolation** — Each agent has independent workspace, CLAUDE.md, memory
4. **No dead code** — Every code path actually executes
5. **Simpler debugging** — Problems only in message conversion or CLI subprocess
6. **Flexible ops** — Change agent config without restarting proxy

### Long-term Consideration

Full history injection causes linear context growth. Mitigation should happen at the OpenClaw layer (conversation windowing, history summarization), not by reintroducing session management in the proxy.
