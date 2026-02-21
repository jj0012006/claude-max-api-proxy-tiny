# Claude Max API Proxy v2

**Use your Claude Max subscription ($200/month) with any OpenAI-compatible client — no separate API costs!**

A focused Claude CLI bridge that converts OpenAI API requests into Claude Code CLI subprocess calls. Works with OpenClaw's multi-agent system for per-channel persona routing.

## v2 Changes (from v1)

- **Removed**: LiteLLM dependency, Gemini provider, intelligent routing from proxy
- **Added**: Multi-bot persona system with per-channel workspace isolation
- **Added**: Gemini as OpenClaw native provider — Gemini agents can use all OpenClaw tools (Bash, WebSearch, Read, Write, etc.)
- **Simplified**: Proxy now focuses solely on OpenAI API <-> Claude CLI conversion
- **Routing**: Moved from proxy-level (message classifier) to OpenClaw-level (agent bindings)

## Why This Exists

| Approach | Cost | Limitation |
|----------|------|------------|
| Claude API | ~$15/M input, ~$75/M output tokens | Pay per use |
| Claude Max | $200/month flat | OAuth blocked for third-party API use |
| **This Proxy** | $0 extra (uses Max subscription) | Routes through CLI |

Anthropic blocks OAuth tokens from being used directly with third-party API clients. However, the Claude Code CLI *can* use OAuth tokens. This proxy bridges that gap by wrapping the CLI and exposing a standard API.

## How It Works

```
Telegram / Slack / Discord / Any Client
         |
         v
  OpenClaw Gateway (:18789)
    - Multi-agent routing (bindings)
    - Each channel -> specific agent
    - Agent -> model + provider
         |
    +----+----+
    |         |
    v         v
  Claude    Gemini (native)
  agents    agents
    |         |
    v         v
  Proxy     Google AI API
  (:3456)   (direct, with OpenClaw tools)
    |
    v
  Claude Code CLI (subprocess)
    - --print --output-format stream-json
    - --dangerously-skip-permissions
    - --session-id / --resume
    |
    v
  Anthropic API (via Max subscription)
    - Opus 4 / Sonnet 4 / Haiku 4
```

## Features

- **OpenAI-compatible API** — Works with any client that supports OpenAI's API format
- **Streaming support** — Real-time SSE streaming with Smart Turn Buffering
- **Session persistence** — Multi-turn conversations via `--resume` / `--session-id`
- **Tool execution** — Full CLI tool access (Bash, Read, Write, WebFetch, WebSearch, etc.)
- **Voice support** — Audio transcription via Groq Whisper
- **YouTube analysis** — Video content analysis via yt-dlp
- **Telegram progress** — Live tool execution updates in Telegram chats
- **Activity timeout** — Auto-kill after 10 minutes of inactivity
- **Gemini native tools** — Gemini agents run natively in OpenClaw with full tool access (Bash, WebSearch, etc.)
- **Model tags** — Response suffix shows which model answered (🟣 Claude)
- **Monitoring dashboard** — `/dashboard` with auto-refreshing component status
- **Secure by design** — Uses spawn() to prevent shell injection

## Prerequisites

1. **Claude Max subscription** ($200/month) — [Subscribe here](https://claude.ai)
2. **Claude Code CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```
3. **Node.js** >= 20

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

### Test it

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4", "messages": [{"role": "user", "content": "Hello!"}]}'

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
| `/dashboard` | GET | Monitoring dashboard |
| `/api/status` | GET | JSON status of all components |

## Available Models

| Model ID | Description |
|----------|-------------|
| `claude-opus-4` | Claude Opus 4 (via CLI) |
| `claude-sonnet-4` | Claude Sonnet 4 (via CLI) |
| `claude-haiku-4` | Claude Haiku 4 (via CLI) |

Model aliases with provider prefixes are also supported: `claude-max/claude-sonnet-4`, `maxproxy/claude-opus-4`, etc.

## Workspace & Memory

The proxy itself **does not** manage workspaces, CLAUDE.md files, or memory directories. These are managed by OpenClaw at the agent level:

- Each OpenClaw agent has its own workspace directory (`~/.openclaw/workspaces/{agent-id}/`)
- Claude CLI automatically reads `CLAUDE.md` from its working directory
- Per-agent `CLAUDE.md` contains persona instructions and memory guidance
- `memory/` subdirectory holds persistent context files read/written by the agent

To customize an agent's behavior, edit its CLAUDE.md directly:
```bash
vim ~/.openclaw/workspaces/kol-scout/CLAUDE.md
```

A migration script (`migrate-claude-md.sh`) is provided to bootstrap CLAUDE.md files for each agent workspace.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Proxy server port |
| `PROXY_CWD` | Current directory | Default working directory for CLI subprocesses |

## Architecture

```
src/
├── config.ts                # Environment config (openclawBaseUrl)
├── index.ts                 # Package exports (OpenClaw plugin)
├── types/
│   ├── claude-cli.ts        # Claude CLI JSON stream types + helpers
│   └── openai.ts            # OpenAI API request/response types
├── adapter/
│   ├── openai-to-cli.ts     # OpenAI → CLI format (prompt, system prompt, model)
│   └── cli-to-openai.ts     # CLI → OpenAI format (result, streaming chunks)
├── subprocess/
│   └── manager.ts           # Claude CLI subprocess lifecycle
├── session/
│   └── manager.ts           # Session ID mapping, persistence, resume
└── server/
    ├── index.ts             # Express server setup
    ├── routes.ts            # Route handlers + Smart Turn Buffering + Telegram progress
    ├── stats.ts             # Request statistics collector
    ├── dashboard.ts         # Monitoring dashboard (HTML + API)
    └── standalone.ts        # Standalone entry point
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed component documentation.

## Deployment

### With pm2 (recommended)

```bash
npm run build
pm2 start dist/server/standalone.js --name claude-proxy
```

### Deploy updates

```bash
# On local: pack source
tar czf /tmp/proxy-v2.tar.gz --exclude=node_modules --exclude=dist --exclude=.git .

# Transfer to server
scp /tmp/proxy-v2.tar.gz user@server:/tmp/

# On server: extract, build, restart
cd ~/claude-max-api-proxy
tar xzf /tmp/proxy-v2.tar.gz
npm install && npm run build
pm2 restart claude-proxy
```

## Integration with OpenClaw

### Multi-Agent Setup

In `~/.openclaw/openclaw.json`, configure providers (Claude via Proxy + Gemini native) and set up agent bindings:

```json
{
  "models": {
    "providers": {
      "claude-max": {
        "baseUrl": "http://127.0.0.1:3456/v1/",
        "api": "openai-completions",
        "models": [
          { "id": "claude-opus-4", "name": "Claude Opus 4" },
          { "id": "claude-sonnet-4", "name": "Claude Sonnet 4" },
          { "id": "claude-haiku-4", "name": "Claude Haiku 4" }
        ]
      },
      "google": {
        "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "apiKey": "${GEMINI_API_KEY}",
        "api": "openai-completions",
        "models": [
          { "id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash" },
          { "id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro" }
        ]
      }
    }
  },
  "agents": {
    "list": [
      { "id": "kol-scout", "model": { "primary": "claude-max/claude-opus-4" } },
      { "id": "ai-news", "model": { "primary": "claude-max/claude-sonnet-4" } },
      { "id": "general", "model": { "primary": "claude-max/claude-sonnet-4" } },
      { "id": "gemini-qa", "model": { "primary": "google/gemini-2.5-flash" } }
    ]
  },
  "bindings": [
    { "agentId": "kol-scout", "match": { "channel": "discord", "peer": { "kind": "channel", "id": "CHANNEL_ID" } } },
    { "agentId": "gemini-qa", "match": { "channel": "discord", "peer": { "kind": "channel", "id": "QUICK_QA_CHANNEL_ID" } } },
    { "agentId": "general", "match": { "channel": "telegram" } }
  ]
}
```

Gemini agents configured as native OpenClaw providers automatically get access to all OpenClaw tools (Bash, Read, Write, WebSearch, WebFetch, etc.) — no proxy needed. Claude agents route through the proxy to use the Max subscription.

### Generic OpenAI Client (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="not-needed"
)

response = client.chat.completions.create(
    model="claude-sonnet-4",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## Security

- Uses Node.js `spawn()` instead of shell execution to prevent injection attacks
- No API keys stored or transmitted by this proxy
- All Claude authentication handled by CLI's secure keychain storage
- Prompts passed as CLI arguments, not through shell interpretation
- `--dangerously-skip-permissions` enables full tool access (required for CLI tools)

## Troubleshooting

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

The proxy must run as a non-root user. Use a dedicated user (e.g., `claude-proxy`):
```bash
useradd -m -s /bin/bash claude-proxy
su - claude-proxy
claude auth login
```

## License

MIT
