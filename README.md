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
    | persistent interactive process (stdin/stdout)
    v
nullclaw agent      (Zig binary, interactive mode)
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
The bridge bypasses this by running nullclaw in interactive agent mode and serving
WebSocket via the battle-tested Node.js `ws` package.

## Features

- **Customization Center** — sidebar tab with interactive pills for commands, tools, connectors, skills, and models
- **Persistent agent sessions** — settings persist within a session (thinking, reasoning, exec security)
- **Auto-setup** — sessions start with `/think high` and `/reason on` automatically
- **Collapsible sidebar** — session management, customization, and settings
- **File uploads & vision** — drag-and-drop or click to upload images for vision models
- **Auto-pairing** — dynamic pairing code, auto-filled on page load
- **Hidden launcher** — no terminal window, runs in background
- **Kill/Launch controls** — control bar at top of UI
- **Streaming responses** — chunks sent as they arrive from the LLM

## Customization Center

The sidebar Customize tab provides clickable pills organized into 5 categories:

| Category | What's in it |
|----------|-------------|
| **Commands** | All slash commands grouped by function (Info, Session, Models, Thinking, etc.) |
| **Skills** | Installed skills + install commands |
| **Tools** | Built-in tools grouped by type (File System, System, Memory, Agent, Disabled) |
| **Connectors** | Configured channels, dockable channels, and available integrations |
| **Models** | Dynamic list from Ollama with sizes, active model highlighted |

Pills auto-send complete commands on click. Template pills (dashed border) inject text for you to fill in parameters.

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
- Available models: `qwen3:8b`, `qwen3-coder:30b`, `qwen3-coder:480b-cloud`, `moondream` (vision)

### nullclaw config keys

```json
{
  "autonomy": {
    "level": "full",
    "workspace_only": false,
    "max_actions_per_hour": 100
  },
  "security": {
    "sandbox": { "backend": "auto" },
    "audit": { "enabled": true }
  }
}
```

**Note:** `file_read` has a hardcoded workspace restriction in the nullclaw binary regardless of `workspace_only` setting. Use `/shell type <path>` to read files outside the workspace.

## File Structure

```
nullifAi/
  launch-nullifai.cmd    # One-click launcher (desktop shortcut target)
  launch-hidden.vbs      # Runs bridge without terminal window
  nullifai-bridge.js     # Node.js WebSocket bridge + injected UI customizations
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
| `/api/models` | GET | Proxy to Ollama `/api/tags` — returns available models |

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

## Version History

| Version | Changes |
|---------|---------|
| **v1.4.0** | Customization Center, persistent agent sessions, auto-setup, config overhaul |
| **v1.3.0** | Collapsible sidebar with session management and local persistence |
| **v1.2.0** | File uploads, image vision support, rebrand to nullifAi |
| **v1.1.0** | Layout fix — control bar no longer pushes input below viewport |
| **v1.0.0** | Initial release — bridge, auto-pairing, streaming responses |
