# Copilot Pool Relay

WebSocket relay server with session pooling for Copilot CLI.

## Architecture

```
iOS App → WebSocket → relay-server.js → single CLI (--headless --stdio)
                                         └─ N pooled sessions
```

- **Raw proxy**: Forwards Content-Length framed JSON-RPC between clients and CLI
- **Session pool**: Pre-warms N sessions, lazily creates more on demand
- **RPC ID remapping**: Prevents collisions when multiple clients use same IDs
- **Zero persistence**: No database, no state files. Sessions are ephemeral.

## Quick Start

```bash
npm install
node relay-server.js
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8765` | WebSocket listen port |
| `CLI_PATH` | auto-detect | Path to `copilot` binary |
| `POOL_SIZE` | `3` | Sessions to pre-warm on startup |
| `LOG_LEVEL` | `info` | Set to `debug` for verbose output |

## Files

- `relay-server.js` — Pool relay (production)
- `relay-server-simple.js` — Simple 1:1 relay (reference/fallback)
- `DESIGN.md` — Full design document

## How It Works

1. On startup, spawns one CLI process and pre-creates N sessions
2. When a client sends `session.create`, it gets an available pool session
3. All other messages forwarded to CLI with remapped RPC IDs
4. When client disconnects, session is released back to pool
5. If pool is exhausted, new sessions are created on-the-fly
