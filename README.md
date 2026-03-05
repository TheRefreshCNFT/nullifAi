# nullifAi

Local AI agent powered by nullclaw + Ollama, with a Node.js WebSocket bridge
that serves the chat UI and handles communication.

## Quick Start

1. **Double-click the desktop shortcut** (or run `launch-nullifai.cmd`)
2. Browser opens to `http://127.0.0.1:4173`
3. Enter pairing code: `123456`
4. Chat!

## Architecture

```
Browser (Chat UI)
    |
    | WebSocket (ws://127.0.0.1:32123/ws)
    v
nullifai-bridge.js  (Node.js)
    |
    | child_process.spawn
    v
nullclaw agent      (Zig binary, CLI mode)
    |
    | HTTP API
    v
Ollama              (local LLM server)
    |
    v
qwen3-coder:480b-cloud  (default model)
```

### Why a Node.js bridge?

nullclaw's built-in WebSocket server (`karlseguin/websocket.zig`) has a bug on
Windows: it uses `posix.read()` which maps to `NtReadFile` instead of
`ws2_32.recv()` for socket reads, causing `error.Unexpected` on every connection.
The bridge bypasses this by running nullclaw in CLI agent mode and serving
WebSocket via the battle-tested Node.js `ws` package.

## Components

| Component | Location | Port |
|-----------|----------|------|
| Bridge (WebSocket + orchestrator) | `nullifai-bridge.js` | 32123 |
| Chat UI (static Svelte app) | `nullclaw-chat-ui/build/` | 4173 |
| nullclaw binary | `C:\Tools\nullclaw\2026.3.4\nullclaw.exe` | - |
| Ollama | system install | 11434 |

## Prerequisites

- **Node.js** (v18+) with `ws` package (`npm install` in this directory)
- **nullclaw** v2026.3.4 at `C:\Tools\nullclaw\2026.3.4\nullclaw.exe`
- **Ollama** running locally with `qwen3-coder:480b-cloud` model

## Configuration

- nullclaw config: `~/.nullclaw/config.json`
- Default model: `ollama/qwen3-coder:480b-cloud`
- Available models: `qwen3:8b`, `qwen3-coder:30b`, `qwen3-coder:480b-cloud`
- Pairing code: `123456` (hardcoded for local use)

## File Structure

```
nullifAi/
  launch-nullifai.cmd    # One-click launcher (desktop shortcut target)
  nullifai-bridge.js     # Node.js WebSocket bridge
  package.json           # npm project (ws dependency)
  node_modules/          # npm packages
  nullclaw-chat-ui/      # Chat UI (pre-built Svelte app)
    build/               # Static files served on port 4173
  README.md              # This file
```

## WebChannel v1 Protocol

The bridge implements the WebChannel v1 protocol:

1. **Pairing**: Client sends `pairing_request` with code, gets back JWT token
2. **Messaging**: Client sends `user_message` with token, gets `assistant_chunk` stream + `assistant_final`
3. **Errors**: Bridge sends `error` events with codes

## Development

```bash
# Install dependencies
npm install

# Start bridge manually
node nullifai-bridge.js

# Environment overrides
NULLCLAW_EXE=path/to/nullclaw  node nullifai-bridge.js
WS_PORT=32123                   node nullifai-bridge.js
UI_PORT=4173                    node nullifai-bridge.js
```
