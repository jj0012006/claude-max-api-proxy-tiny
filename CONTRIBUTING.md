# Contributing to Claude Max API Proxy

## Development Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. Build: `npm run build`
4. Run: `node dist/server/standalone.js`

## Project Structure

```
src/
├── config.ts          # Environment config
├── index.ts           # OpenClaw plugin exports
├── types/             # TypeScript type definitions
├── adapter/           # OpenAI <-> CLI format conversion
├── subprocess/        # Claude CLI subprocess lifecycle
├── session/           # Session ID mapping and persistence
└── server/            # Express server, routes, dashboard
```

## Making Changes

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make your changes
3. Build and test: `npm run build`
4. Commit with a descriptive message
5. Push and create a PR

## Code Style

- TypeScript with strict mode
- Use `spawn()` instead of shell execution for security
- Add JSDoc comments to public functions
- Keep functions focused and small

## Testing

Test your changes with:

```bash
# Start the server
node dist/server/standalone.js

# Test non-streaming
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-haiku-4", "messages": [{"role": "user", "content": "Hi"}]}'

# Test streaming
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-haiku-4", "messages": [{"role": "user", "content": "Hi"}], "stream": true}'

# Check dashboard
open http://localhost:3456/dashboard
```

## Reporting Issues

Please include:
- Node.js version (`node --version`)
- Claude CLI version (`claude --version`)
- Operating system
- Steps to reproduce
- Error messages/logs

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
