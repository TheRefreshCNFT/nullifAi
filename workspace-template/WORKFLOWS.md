
# WORKFLOWS.md - Common Task Recipes

Step-by-step workflows for recurring tasks. Don't reinvent these — follow the recipe, adapt as needed.

## File Operations

### Read a file outside workspace
```
/shell type "C:\full\path\to\file.txt"
```
file_read only works inside workspace. Shell has no such restriction.

### Find files matching a pattern
```
/shell dir /s /b C:\Users\thisc\*.json        # Windows recursive
/shell find /path -name "*.json"               # Linux/Mac
```

### Search file contents
```
/shell findstr /s /i "search_term" C:\path\*.txt     # Windows
/shell grep -r "search_term" /path/                   # Linux/Mac
```

### Compare two files
```
/shell fc "file1.txt" "file2.txt"              # Windows
/shell diff file1.txt file2.txt                # Linux/Mac
```

## Memory Management

### Start of session
1. `/memory list` — see what you know
2. Read workspace files — SOUL.md, AGENTS.md, TOOLS.md
3. Check `MEMORY.md` if in main session

### After learning something important
1. `/memory recall <topic>` — check if you already know this
2. If new: `/memory store <clear, specific fact>`
3. If update: `/memory forget <old_id>` then `/memory store <updated fact>`

### Periodic cleanup (during heartbeats)
1. `/memory list` — review everything
2. Remove outdated entries with `/memory forget`
3. Consolidate related memories into clearer single entries
4. Update MEMORY.md with significant long-term takeaways

## Project Investigation

### Understanding a new codebase
1. List the top-level structure: `/shell dir /b <project_root>` or `ls`
2. Read the README: `/shell type <project_root>\README.md`
3. Read the config: `/shell type <project_root>\package.json` (or equivalent)
4. Look at the entry point (main file, index, app)
5. Trace from entry point to understand flow
6. Store key findings: `/memory store Project X: entry=index.js, framework=Y, key_files=...`

### Debugging a reported issue
1. **Reproduce:** Understand what was expected vs what happened
2. **Locate:** Find the relevant file/function
3. **Read:** `/file_read` or `/shell type` the file
4. **Trace:** Follow the logic path that leads to the bug
5. **Fix:** Make the minimal change
6. **Verify:** Check the fix works
7. **Document:** `/memory store` the fix if it's a pattern

## Git Workflows

### Check project status
```
/shell cd /d C:\project && git status
/shell cd /d C:\project && git log --oneline -10
/shell cd /d C:\project && git diff --stat
```

### Stage and commit
```
/shell cd /d C:\project && git add <specific_files>
/shell cd /d C:\project && git commit -m "description of change"
```

### View changes before committing
```
/shell cd /d C:\project && git diff                  # unstaged changes
/shell cd /d C:\project && git diff --cached         # staged changes
```

## Responding to Requests

### "What is X?" (explanation request)
1. Check if you know from memory: `/memory recall X`
2. If not, investigate: read files, search, use shell
3. Give a concise answer. Expand if asked.

### "Do X" (action request)
1. Understand the goal (not just the literal words)
2. Plan the steps
3. Execute. Verify each step.
4. Report the result concisely.

### "Fix X" (debugging request)
1. Follow the debugging workflow above
2. If user pasted output — that IS the bug report, parse it carefully
3. Focus on root cause, not symptoms
4. Show what you found and what you did

### "Remember X" (memory request)
1. `/memory store` immediately with clear, specific phrasing
2. Confirm briefly: "Stored."
3. If it updates something existing: recall first, forget old, store new

## Working with the User

### When they paste raw output
That's their bug report. Don't ask for more info — analyze what they gave you:
- Error messages → read from bottom to top
- Status output → compare against expected values
- Test results → identify which ones failed and why

### When they give a preference
Store it. Don't ask again. Apply it going forward.
```
/memory store User prefers <specific preference>
```

### When you're unsure
Try the most reasonable interpretation first. If wrong, they'll correct you — and you'll learn. That's faster than a back-and-forth clarification dance.

## System Administration

### Check disk space
```
/shell wmic logicaldisk get size,freespace,caption    # Windows
/shell df -h                                           # Linux/Mac
```

### Check running processes
```
/shell tasklist | findstr <name>       # Windows
/shell ps aux | grep <name>            # Linux/Mac
```

### Check network
```
/shell netstat -ano | findstr :<port>  # what's on a port
/shell curl http://localhost:<port>    # test an endpoint
```

---

_Add new workflows as you discover them. Remove ones that are never used._
