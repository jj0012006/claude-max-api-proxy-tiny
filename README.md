# Claude Max API Proxy

**Use your Claude Max subscription ($200/month) with any OpenAI-compatible client — no separate API costs!**

Multi-model AI proxy that routes requests between Claude (via Claude Code CLI) and Gemini (via LiteLLM), with intelligent routing, persistent memory, and session management.

## Why This Exists

| Approach | Cost | Limitation |
|----------|------|------------|
| Claude API | ~$15/M input, ~$75/M output tokens | Pay per use |
| Claude Max | $200/month flat | OAuth blocked for third-party API use |
| **This Proxy** | $0 extra (uses Max subscription) | Routes through CLI |

Anthropic blocks OAuth tokens from being used directly with third-party API clients. However, the Claude Code CLI *can* use OAuth tokens. This proxy bridges that gap by wrapping the CLI and exposing a standard API.

## How It Works

```
Telegram / Slack / Any Client
         |
         v
  OpenClaw Gateway (:18789)
         |  OpenAI /v1/chat/completions
         v
  Claude Max API Proxy (:3456)
         |
    +----+----+
    |         |
    v         v
  Claude    Gemini
  (CLI)     (LiteLLM :4000)
    |         |
    v         v
 Anthropic  Google AI
   API       API
```

### Request Routing

```
Request → model field check
  |- model contains "gemini"  → Gemini (via LiteLLM)
  |- model contains "claude"  → Claude (via CLI subprocess)
  |- model = "auto"           → Gemini Flash classifier → Claude or Gemini
  '- other                    → Claude (default)
```

## Features

- **OpenAI-compatible API** — Works with any client that supports OpenAI's API format
- **Multi-model routing** — Claude + Gemini with intelligent automatic routing
- **Streaming support** — Real-time SSE streaming with Smart Turn Buffering
- **Session persistence** — Multi-turn conversations via `--resume` / `--session-id`
- **Persistent memory** — CLAUDE.md + memory/ files for personalized responses
- **Tool execution** — Full CLI tool access (Bash, Read, Write, WebFetch, etc.)
- **Voice support** — Audio transcription via Groq Whisper
- **YouTube analysis** — Video content analysis via yt-dlp
- **Telegram progress** — Live tool execution updates in Telegram chats
- **Activity timeout** — Auto-kill after 10 minutes of inactivity
- **Model tags** — Response suffix shows which model answered (Claude / Gemini)
- **Secure by design** — Uses spawn() to prevent shell injection

## Prerequisites

1. **Claude Max subscription** ($200/month) — [Subscribe here](https://claude.ai)
2. **Claude Code CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```
3. **(Optional) LiteLLM** for Gemini support:
   ```bash
   pip install 'litellm[proxy]'
   ```

## Installation

```bash
git clone <repo-url>
cd claude-max-api-proxy

npm install
npm run build
```

## Usage

### Start the proxy server

```bash
node dist/server/standalone.js
```

The server runs at `http://localhost:3456` by default.

### (Optional) Start LiteLLM for Gemini

```bash
litellm --config litellm-config.yaml --port 4000
```

### Test it

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion — Claude (explicit)
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4", "messages": [{"role": "user", "content": "Hello!"}]}'

# Chat completion — Gemini (explicit)
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gemini-pro", "messages": [{"role": "user", "content": "Translate hello to French"}]}'

# Chat completion — Auto routing
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Write a Python function"}]}'

# Streaming
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4", "messages": [{"role": "user", "content": "Hello!"}], "stream": true}'
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (streaming & non-streaming) |

## Available Models

| Model ID | Provider | Description |
|----------|----------|-------------|
| `claude-opus-4` | Claude | Claude Opus 4 (via CLI) |
| `claude-sonnet-4` | Claude | Claude Sonnet 4 (via CLI) |
| `claude-haiku-4` | Claude | Claude Haiku 4 (via CLI) |
| `gemini-pro` | Gemini | Gemini Pro (via LiteLLM) |
| `gemini-flash` | Gemini | Gemini Flash (via LiteLLM) |
| `auto` | Router | Intelligent routing — Gemini Flash classifies the task |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Proxy server port |
| `LITELLM_BASE_URL` | `http://127.0.0.1:4000` | LiteLLM base URL for Gemini access |
| `ROUTER_MODEL` | `gemini-flash` | Model used for routing decisions |
| `ROUTER_ENABLED` | `true` | Enable intelligent routing (`false` = all to Claude) |
| `GEMINI_DEFAULT_MODEL` | `gemini-pro` | Default Gemini model when router picks Gemini |
| `PROXY_CWD` | `~/.openclaw/workspace` | Working directory for CLI subprocesses |

## Architecture

```
src/
├── config.ts                # Centralized environment config
├── index.ts                 # Package exports (Clawdbot plugin)
├── types/
│   ├── claude-cli.ts        # Claude CLI JSON stream types + helpers
│   └── openai.ts            # OpenAI API request/response types
├── adapter/
│   ├── openai-to-cli.ts     # OpenAI → CLI format (prompt, system prompt, model)
│   └── cli-to-openai.ts     # CLI → OpenAI format (result, streaming chunks)
├── router/
│   └── index.ts             # Intelligent router (Gemini Flash classifier)
├── provider/
│   └── gemini.ts            # Gemini provider (streaming + non-streaming via LiteLLM)
├── subprocess/
│   └── manager.ts           # Claude CLI subprocess lifecycle + memory bootstrap
├── session/
│   └── manager.ts           # Session ID mapping, persistence, resume
└── server/
    ├── index.ts             # Express server setup
    ├── routes.ts            # Route handlers + Smart Turn Buffering + Telegram progress
    └── standalone.ts        # Standalone entry point
```

### Component Overview

#### Intelligent Router (`src/router/index.ts`)

Uses Gemini Flash (via LiteLLM) to classify incoming requests when `model=auto`. Routes coding/tool tasks to Claude, and math/translation/Q&A to Gemini. Falls back to Claude on any error or timeout (15s).

#### Gemini Provider (`src/provider/gemini.ts`)

Forwards requests to Gemini models through LiteLLM's OpenAI-compatible API. Supports both SSE streaming and non-streaming responses.

#### Adapters (`src/adapter/`)

Bidirectional format conversion:
- **openai-to-cli**: Extracts system prompt, converts messages to CLI prompt, cleans XML tool patterns from assistant messages, injects CLI tool instructions + memory system prompt
- **cli-to-openai**: Converts CLI result/stream events to OpenAI response format

#### Subprocess Manager (`src/subprocess/manager.ts`)

Manages Claude CLI lifecycle:
- Spawns `claude --print --output-format stream-json` subprocesses
- Activity-based timeout (10 min no output → kill)
- Resume failure detection (stderr keyword scanning)
- Bootstraps CLAUDE.md + memory/ directory on first run

#### Session Manager (`src/session/manager.ts`)

Maps conversation IDs to Claude CLI session UUIDs:
- `--session-id` for new conversations
- `--resume` for continuing existing sessions
- Auto-invalidation on resume failure
- 24-hour TTL with periodic cleanup

#### Smart Turn Buffering (`src/server/routes.ts`)

Claude CLI executes multiple "turns" when using tools. Each turn produces streaming content. The proxy buffers all content and only forwards the **last turn** to the client, preventing intermediate tool output from leaking.

#### Persistent Memory (`CLAUDE.md` + `memory/`)

Each subprocess runs in a stable working directory (`~/.openclaw/workspace`) with:
- `CLAUDE.md` — Instructions for the CLI to read memory files on startup
- `memory/user-profile.md` — Facts about the user
- `memory/preferences.md` — Communication style, tools
- `memory/knowledge-log.md` — Insights, decisions, patterns
- `memory/projects.md` — Active work context

The CLI reads CLAUDE.md automatically and updates memory files over time.

## Deployment

### With pm2 (recommended)

```bash
# Build
npm run build

# Start proxy
pm2 start dist/server/standalone.js --name claude-proxy

# (Optional) Start LiteLLM for Gemini
pm2 start $(which litellm) --name litellm --interpreter none -- --config /path/to/litellm-config.yaml --port 4000
```

### Deploy updates

```bash
# On local machine: sync dist/ to server
rsync -avz dist/ user@server:/path/to/claude-max-api-proxy/dist/

# On server: restart
pm2 restart claude-proxy
```

## Security

- Uses Node.js `spawn()` instead of shell execution to prevent injection attacks
- No API keys stored or transmitted by this proxy
- All Claude authentication handled by CLI's secure keychain storage
- Prompts passed as CLI arguments, not through shell interpretation
- `--dangerously-skip-permissions` enables full tool access (required for CLI tools)

## Configuration with Popular Tools

### OpenClaw Gateway

Set model in `~/.openclaw/openclaw.json`:
```json
{
  "model": "claude-max/auto"
}
```

Use `claude-max/auto` for intelligent routing, or `claude-max/claude-sonnet-4` for a specific model.

### Continue.dev

```json
{
  "models": [{
    "title": "Claude (Max)",
    "provider": "openai",
    "model": "claude-opus-4",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

### Generic OpenAI Client (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="not-needed"
)

response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## Troubleshooting

### All requests route to Claude (router not working)

Check that LiteLLM is running:
```bash
curl http://127.0.0.1:4000/health
```

If not running, start it:
```bash
litellm --config litellm-config.yaml --port 4000
```

### "Claude CLI not found"

Install and authenticate the CLI:
```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

### Streaming returns immediately with no content

Use `-N` flag with curl (disables buffering):
```bash
curl -N -X POST http://localhost:3456/v1/chat/completions ...
```

### "--dangerously-skip-permissions cannot be used with root"

The proxy must run as a non-root user. Use a dedicated user (e.g., `claude-proxy`) and grant file access via ACL:
```bash
setfacl -m u:claude-proxy:rx /path/to/needed/dirs
```

## License

MIT
