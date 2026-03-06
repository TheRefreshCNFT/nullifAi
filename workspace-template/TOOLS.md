
# TOOLS.md - Tool Mastery Guide

Your available tools and how to use them effectively. Reference this when you need to do something — don't guess at syntax.

## File System Tools

### `/file_read <path>`
Reads file contents. **Works with absolute paths AND workspace-relative paths.**
```
/file_read SOUL.md                                    # relative to workspace
/file_read memory/2026-03-05.md                       # subdirectories work
/file_read C:\Users\thisc\Documents\somefile.txt      # absolute path — works!
/file_read C:\Users\thisc\.nullclaw\config.json       # config files — works!
```
**What's blocked:** System directories only (C:\Windows, C:\Program Files, C:\ProgramData, C:\System32, C:\Recovery).
**Everything else is fair game.** You have `allowed_paths: ["*"]` configured.

### `/file_write <path> <content>`
Creates or overwrites a file. Works in workspace and allowed paths.
```
/file_write notes.md # My Notes\n\nSome content here.
```

### `/file_edit <path>`
Edit an existing file. Opens in-place editing mode.

### Shell Alternative (when file tools fail)
If a file tool gives you trouble, `/shell` always works:
```
/shell type "C:\Users\thisc\Documents\somefile.txt"      # Windows read
/shell cat /home/user/somefile.txt                        # Linux read
```

## System Tools

### `/shell <command>`
Run any shell command. This is your most powerful tool.
```
/shell dir C:\Users\thisc\Downloads          # list directory
/shell type "C:\path\to\file.txt"            # read any file
/shell echo Hello > output.txt               # write files
/shell git status                            # git operations
/shell node -e "console.log(2+2)"           # run code
/shell curl http://localhost:11434/api/tags  # API calls
```
**Tips:**
- Quote paths with spaces: `type "C:\My Files\doc.txt"`
- Chain commands: `cd /d C:\project && dir`
- Redirect output: `command > file.txt 2>&1`

### `/git <operation>`
Git operations. Shorthand for common git commands.
```
/git status
/git log --oneline -5
/git diff
```
Note: Internal tool name is `git_operations` but slash command is `/git`.

### `/image_info <path>`
Analyze an image file. Returns metadata, dimensions, and visual description if vision model is available.

## Memory Tools

Your durable brain. These survive across sessions.

### `/memory store <content>`
Save something to long-term memory.
```
/memory store User prefers dark mode. Name is Ian, goes by Crazy.
/memory store Project nullifAi is at C:\Users\thisc\Documents\Projects\myAis\null\agents\nullifAi
```
**When to store:** Preferences, facts, decisions, lessons learned, anything you'd need later.

### `/memory recall <query>`
Search memory by keyword or topic.
```
/memory recall user preferences
/memory recall nullifAi project path
```

### `/memory list`
Show all stored memories. Good for periodic review.

### `/memory search <query>`
More targeted search than recall.

### `/memory forget <id>`
Remove a specific memory entry. Use when information is outdated.

### `/memory stats`
Show memory usage statistics.

**Memory strategy:**
- Store immediately when you learn something important — don't wait
- Be specific: "User's name is Ian" not "learned about user"
- Update rather than duplicate — recall first, then store refined version
- Periodically review with `/memory list` and clean up stale entries

## Agent Tools

### `/delegate <task>`
Spawn a sub-agent for a specific task. Useful for parallel work or isolated operations.

### `/schedule <task>`
Schedule a task for later execution.

### `/spawn`
Create a new agent instance.

## Session Commands (Not Tools — Slash Commands)

These configure your current session:

### Thinking & Reasoning
```
/think high              # deep reasoning (recommended)
/think xhigh             # maximum reasoning
/think minimal           # light reasoning
/think off               # no extra reasoning
/reason on               # enable chain-of-thought
/reason off              # disable
/verbose on              # detailed output
/verbose off             # concise output
```
**Note:** `/think on` is INVALID. Use specific levels. `/reasoning` is INVALID — it's `/reason`.

### Execution Security
```
/exec security=full      # allow all commands (auto-set on start)
/exec security=allowlist # only pre-approved commands
/exec security=deny      # block all execution
/allowlist               # manage allowed commands
/elevated                # show elevation status
```

### Session Management
```
/new                     # new conversation
/reset                   # reset session state
/restart                 # restart agent process
/compact                 # compress context
/export                  # export session
/status                  # show current settings
```

### Models
```
/models                  # list available models
/model <name>            # switch model
```

### Utility
```
/help                    # all commands
/capabilities            # all tools and their status
/doctor                  # diagnostics
/usage                   # token usage stats
/debug                   # debug info
```

## Disabled Tools (Not Currently Available)

These exist in the system but are disabled: `http_request`, `browser`, `screenshot`, `composio`, `browser_open`, `hardware_board_info`, `hardware_memory`, `i2c`.

To enable: would need config changes and possibly binary support.

## Tool Combinations (Patterns That Work)

**Read any file, store key info:**
```
/file_read C:\path\to\config.json
/memory store Config at C:\path has setting X=Y
```

**Check project status:**
```
/shell cd /d C:\project && git status && git log --oneline -3
```

**Write and verify:**
```
/file_write test.md # Content here
/file_read test.md
```

**Debug a problem:**
```
/file_read C:\path\to\logfile.log              # read the logs
/memory recall similar issue                    # check if seen before
# fix the issue
/memory store Fixed X by doing Y               # remember for next time
```

---

_Update this file as you discover new patterns and gotchas._
