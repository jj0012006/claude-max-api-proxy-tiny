# Claude Max API Proxy v2 — Architecture

## System Overview

The proxy is a focused bridge between OpenAI-compatible API clients and Claude Code CLI. It translates API requests into CLI subprocess calls, buffers multi-turn tool execution output, and manages session persistence.

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
│  ┌─────────────┐  ┌───────────┐  ┌──────────────┐  │
│  │ Multi-Agent  │  │ Bindings  │  │  Platform    │  │
│  │   Routing    │  │ channel→  │  │  Tools       │  │
│  │             │  │  agent    │  │  (cron,etc)  │  │
│  └─────────────┘  └───────────┘  └──────────────┘  │
│                                                     │
│  Tools (model-agnostic, available to ALL agents):   │
│  Bash, Read, Write, Edit, Grep, Glob,              │
│  WebFetch, WebSearch, Browser, Cron                 │
└───────┬─────────────────────────────┬───────────────┘
        │                             │
        │ Claude agents               │ Gemini agents
        │ POST /v1/chat/completions   │ (native, direct API)
        ▼                             ▼
┌───────────────────────┐   ┌─────────────────────────┐
│ Claude Max API Proxy  │   │    Google AI API         │
│      (:3456)          │   │                         │
│                       │   │  Gemini 2.5 Flash/Pro   │
│ ┌────────┐ ┌────────┐│   │  Full OpenClaw tool     │
│ │OAI→CLI │ │CLI→OAI ││   │  access (Bash, Web, etc)│
│ │Adapter │ │Adapter ││   └─────────────────────────┘
│ └───┬────┘ └───▲────┘│
│     │          │      │
│ ┌───▼──────────┴────┐ │
│ │ Claude CLI        │ │
│ │ + Turn Buffering  │ │
│ └───┬───────────────┘ │
│ ┌───▼────┐ ┌────────┐ │
│ │Session │ │Persona │ │
│ │Manager │ │Config  │ │
│ └────────┘ └────────┘ │
└───────┬───────────────┘
        │ subprocess
        ▼
┌───────────────────────┐
│   Claude Code CLI     │
│   --print --stream    │
│   --skip-permissions  │
│   CWD: workspaces/    │
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
2. **Session lookup** — Checks for existing conversation session to resume
3. **CLI conversion** — Converts OpenAI format to CLI input via adapter
4. **Subprocess dispatch** — Starts Claude CLI subprocess with appropriate flags
5. **Response formatting** — Streaming (SSE) or non-streaming (JSON)

### Smart Turn Buffering (`src/server/routes.ts`)

Claude CLI executes multiple "turns" when using tools. Each turn is marked by a `message_start` event and produces content deltas. Without buffering, intermediate tool output would leak to the client.

The proxy buffers all content deltas per turn and only flushes the **last turn's** content when the `result` event arrives. This ensures the client only sees the final answer.

```
Turn 1: [Read file] → content: "Let me check..."     ← discarded
Turn 2: [Bash cmd]  → content: "Running..."           ← discarded
Turn 3: [no tools]  → content: "Here's the answer..." ← sent to client
```

### OpenAI → CLI Adapter (`src/adapter/openai-to-cli.ts`)

Converts OpenAI chat completion requests to Claude CLI input:

- **System messages** → `--system-prompt` flag
- **User messages** → CLI prompt text
- **Assistant messages** → Wrapped in `<previous_response>` tags (with XML tool patterns cleaned)
- **Model mapping** → `claude-opus-4` → `opus`, `claude-sonnet-4` → `sonnet`, etc.
- **Session handling** → Existing session: only send latest user message; new session: send full context
- **CLI tool instructions** → Injected into system prompt (Bash, file ops, voice transcription, YouTube analysis)

### CLI → OpenAI Adapter (`src/adapter/cli-to-openai.ts`)

Converts Claude CLI JSON stream output to OpenAI API format:

- **Result messages** → OpenAI `ChatCompletion` response
- **Stream events** → OpenAI SSE `ChatCompletionChunk` events
- **Done signal** → `data: [DONE]` SSE terminator

### Subprocess Manager (`src/subprocess/manager.ts`)

Manages Claude CLI subprocess lifecycle:

- **Spawn**: `claude --print --output-format stream-json --verbose --dangerously-skip-permissions`
- **Flags**: `--model`, `--session-id`, `--resume`, `--system-prompt`
- **Activity timeout**: 10 minutes of no stdout output → SIGTERM
- **Resume failure detection**: Scans stderr for "Could not find session" → emits `resume_failed` event
- **Event emission**: Parses JSON lines from stdout → typed events (message, content_delta, assistant, result)

### Session Manager (`src/session/manager.ts`)

Maps conversation IDs to Claude CLI session UUIDs:

- **`get(conversationId)`** — Look up existing session
- **`getOrCreate(conversationId, model)`** — Get or create session UUID
- **`invalidate(conversationId)`** — Remove session on resume failure
- **TTL**: 24 hours with periodic cleanup

### Monitoring Dashboard (`src/server/dashboard.ts`)

- **`GET /dashboard`** — Auto-refreshing HTML dashboard (5s interval)
- **`GET /api/status`** — JSON status API with component health, request counts, session details
- **Components monitored**: Proxy, OpenClaw Gateway, Claude CLI

### Statistics (`src/server/stats.ts`)

In-memory request counter. Tracks total requests and uptime. Reset on process restart.

## v1 → v2 Migration

### Removed Components

| v1 Component | v2 Replacement |
|---|---|
| `src/router/index.ts` (Gemini Flash classifier) | OpenClaw agent bindings (per-channel routing) |
| `src/provider/gemini.ts` (LiteLLM proxy) | OpenClaw native Gemini provider (with full tool access) |
| LiteLLM sidecar process | Not needed — Gemini runs natively in OpenClaw |
| Message-level intelligent routing | Agent-level channel routing |
| Gemini without tools (v1: text-only via LiteLLM) | Gemini with all OpenClaw tools (v2: Bash, WebSearch, Read, etc.) |
| `LITELLM_BASE_URL` env var | Removed |
| `ROUTER_MODEL` / `ROUTER_ENABLED` env vars | Removed |
| `GEMINI_DEFAULT_MODEL` env var | Removed |

### Retained Components

| Component | Role |
|---|---|
| OpenAI → CLI Adapter | Core: format conversion |
| CLI → OpenAI Adapter | Core: format conversion |
| Smart Turn Buffering | Core: tool output filtering |
| Session Manager | Persistence: `--resume` support |
| Subprocess Manager | Core: CLI lifecycle |
| Telegram Progress | UX: tool execution updates |

### Routing Architecture Change

**v1**: Proxy decides per-message which provider to use (Claude vs Gemini)
```
Request → model check → explicit provider?
  yes → route directly
  no  → Gemini Flash classifier → Claude or Gemini
```

**v2**: OpenClaw decides per-channel which agent (and model) to use
```
Discord channel → OpenClaw binding → agent → model → provider
  ├── #kol-scout    → kol-scout agent → claude-opus-4    → Proxy → CLI → Anthropic
  ├── #ai-news      → ai-news agent   → claude-sonnet-4  → Proxy → CLI → Anthropic
  ├── #general      → general agent   → claude-sonnet-4  → Proxy → CLI → Anthropic
  ├── #quick-qa     → gemini-qa agent → gemini-2.5-flash → Google AI API (native)
  └── Telegram      → general agent   → claude-sonnet-4  → Proxy → CLI → Anthropic
```

Gemini agents bypass the proxy entirely — OpenClaw calls the Google AI API directly and provides its full tool suite (Bash, WebSearch, Read, Write, etc.) to Gemini via its model-agnostic tool system.

## Data Flow

### Streaming Request

```
1. Client → POST /v1/chat/completions (stream: true)
2. Proxy: Set SSE headers, flush, write ":ok\n\n"
3. Proxy: Look up / create session
4. Proxy: Convert OpenAI messages → CLI prompt + system prompt
5. Proxy: Spawn claude subprocess with flags
7. CLI → stdout JSON lines:
   a. system/init → ignored
   b. message_start (turn N) → reset buffer
   c. content_block_delta → buffer text
   d. message_start (turn N+1) → reset buffer (discard turn N)
   e. content_block_delta → buffer text
   f. result → flush buffer as SSE chunks, append model tag, send [DONE]
8. Proxy → Client: SSE stream of chat.completion.chunk events
```

### Non-Streaming Request

```
1. Client → POST /v1/chat/completions (stream: false)
2. Proxy: Same steps 3-6 as above
3. CLI → stdout JSON lines → wait for result event
4. Proxy: Convert result → OpenAI ChatCompletion JSON
5. Proxy → Client: Single JSON response
```
