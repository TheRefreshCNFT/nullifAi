
# MEMORY.md - Long-Term Memory

_Curated knowledge. Only load in main sessions (direct chats with your human). Do NOT load in shared contexts._

## Environment

- **OS:** Windows 11 Home
- **Machine user:** thisc
- **Home:** C:\Users\thisc
- **nullclaw binary:** C:\Tools\nullclaw\2026.3.4\nullclaw.exe (custom patched build)
- **nullclaw source:** C:\Users\thisc\Documents\Projects\myAis\null\nullclaw\src
- **nullclaw workspace:** C:\Users\thisc\.nullclaw\workspace\ (this directory)
- **nullclaw config:** C:\Users\thisc\.nullclaw\config.json
- **Default model:** xai/grok-4-1-fast-non-reasoning (Grok 4.1 by xAI)
- **Reasoning model:** xai/grok-4-1-fast-reasoning (auto-used for complex tasks)
- **Local fallback:** ollama/qwen3:4b (2.5GB, runs on laptop)
- **Ollama:** http://127.0.0.1:11434
- **Available local models:** qwen3:4b (2.5GB), qwen3:8b (5.2GB), qwen3-coder:30b (18.6GB), moondream (1.7GB vision)

## Active Projects

### nullifAi
- **What:** Local AI agent platform — nullclaw + Grok + Node.js bridge + Svelte 5 chat UI + Discord bot
- **Repo:** C:\Users\thisc\Documents\Projects\myAis\null\agents\nullifAi\
- **GitHub:** https://github.com/TheRefreshCNFT/nullifAi
- **Current version:** v1.5.0
- **Bridge:** nullifai-bridge.js (~1830 lines) — web UI only
- **Gateway:** nullclaw gateway on port 32124 — Discord + all other channels
- **Architecture:** Web UI → bridge (32123) → nullclaw. Discord → gateway (32124) → nullclaw.

## File Access

- **`file_read` works EVERYWHERE now** — `allowed_paths: ["*"]` is configured
- You can read ANY file on the system (except C:\Windows, C:\Program Files, C:\ProgramData)
- Use absolute paths: `/file_read C:\Users\thisc\Documents\somefile.txt`
- Or relative workspace paths: `/file_read SOUL.md`
- `/shell type <path>` still works as alternative but `file_read` is preferred now

## Known Limitations

- nullclaw silently ignores unknown config keys — only use: `autonomy`, `security`, `models`, `agents`, `gateway`, `channels`
- `/think on` is invalid — use `/think high` or specific levels
- `/reasoning` is wrong — the command is `/reason`
- HEARTBEAT.md must stay comments-only — actual tasks cause HEARTBEAT_OK spam
- Discord replies work (custom binary patch), but only for replies to bot's own messages

## Configured Settings (Auto-Applied on Session Start)

The bridge auto-sends these on every web session:
- `/think high` — deep reasoning enabled
- `/reason on` — chain-of-thought enabled
- `/exec security=full` — unrestricted shell access

## Discord Bot

- **Bot name:** iykyAi
- **Guild:** 878250798528745542
- **Trigger:** @mention OR reply to bot's message
- **Keep it short:** 2-3 sentences max on Discord unless asked for detail

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
