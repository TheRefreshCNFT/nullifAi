
# MEMORY.md - Long-Term Memory

_Curated knowledge. Only load in main sessions (direct chats with your human). Do NOT load in shared contexts._

## Environment

- **OS:** Windows 11 Home
- **Machine user:** thisc
- **Home:** C:\Users\thisc
- **nullclaw binary:** C:\Tools\nullclaw\2026.3.4\nullclaw.exe
- **nullclaw workspace:** C:\Users\thisc\.nullclaw\workspace\ (this directory)
- **nullclaw config:** C:\Users\thisc\.nullclaw\config.json
- **Ollama:** http://127.0.0.1:11434
- **Default model:** ollama/qwen3-coder:480b-cloud
- **Available models:** qwen3:8b (5.2GB), qwen3-coder:30b (18.6GB), qwen3-coder:480b-cloud, moondream (1.7GB vision)

## Active Projects

### nullifAi
- **What:** Local AI agent platform — nullclaw + Ollama + Node.js bridge + Svelte 5 chat UI
- **Repo:** C:\Users\thisc\Documents\Projects\myAis\null\agents\nullifAi\
- **GitHub:** https://github.com/TheRefreshCNFT/nullifAi
- **Current version:** v1.4.0
- **Single file:** nullifai-bridge.js (~1830 lines) — all server logic and UI customizations
- **Architecture:** Browser → WebSocket → bridge → persistent stdin/stdout → nullclaw → Ollama

## Known Limitations

- `file_read` is workspace-only regardless of config. Use `/shell type <path>` for files outside workspace.
- nullclaw silently ignores unknown config keys — only use: `autonomy`, `security`, `models`, `agents`, `gateway`, `channels`
- `/think on` is invalid — use `/think high` or specific levels
- `/reasoning` is wrong — the command is `/reason`
- No skills ecosystem available yet
- LLM may return empty responses for some tool operations

## Configured Settings (Auto-Applied on Session Start)

The bridge auto-sends these on every session:
- `/think high` — deep reasoning enabled
- `/reason on` — chain-of-thought enabled
- `/exec security=full` — unrestricted shell access

## Reference Files

For detailed guidance, consult these workspace files:
- **SOUL.md** — identity, reasoning patterns, communication style
- **AGENTS.md** — operational rules, safety, heartbeats, group chats
- **TOOLS.md** — every tool with syntax, gotchas, and effective patterns
- **REASONING.md** — problem-solving playbook, debugging, decision making
- **WORKFLOWS.md** — step-by-step recipes for common tasks
- **USER.md** — about your human (build this over time from conversations)

---

_Review and update this file periodically. Remove outdated entries. Add significant learnings._
