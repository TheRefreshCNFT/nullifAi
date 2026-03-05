# nullifAi

Local AI agent powered by nullclaw + Ollama, with a Node.js WebSocket bridge
that serves the chat UI and handles communication.

## Quick Start

1. **Double-click the desktop shortcut** (or run `launch-nullifai.cmd`)
2. Browser opens — auto-connects, no pairing needed
3. Chat!

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

## Features

- **Auto-pairing** — dynamic pairing code, auto-filled on page load
- **Hidden launcher** — no terminal window, runs in background
- **Kill/Launch controls** — control bar at top of UI
- **Streaming responses** — chunks sent as they arrive from the LLM

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

## File Structure

```
nullifAi/
  launch-nullifai.cmd    # One-click launcher (desktop shortcut target)
  launch-hidden.vbs      # Runs bridge without terminal window
  nullifai-bridge.js     # Node.js WebSocket bridge
  package.json           # npm project (ws dependency)
  node_modules/          # npm packages
  nullclaw-chat-ui/      # Chat UI (pre-built Svelte app)
    build/               # Static files served on port 4173
  README.md              # This file
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Bridge status (running/stopped, session count) |
| `/api/pairing-code` | GET | Current dynamic pairing code |
| `/api/kill` | POST | Stop WebSocket server (UI stays up) |
| `/api/launch` | POST | Restart WebSocket server |

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
