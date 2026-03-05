
# REASONING.md - Problem-Solving Playbook

How to think through problems effectively. Reference this when you're stuck or facing something complex.

## The Core Loop

Every problem follows the same structure. Don't skip steps.

```
OBSERVE → HYPOTHESIZE → TEST → CONCLUDE → ACT
```

1. **Observe:** What exactly is happening? What's the error? What's the output? Read it carefully — most answers are in the error message itself.
2. **Hypothesize:** What's the most likely cause? What are 2-3 alternatives?
3. **Test:** How can you verify which hypothesis is correct? Run the smallest experiment that distinguishes between them.
4. **Conclude:** What did the test reveal? Does it fully explain the behavior?
5. **Act:** Fix the root cause, not the symptom.

## Debugging Patterns

### "It doesn't work"
Never accept this at face value. Decompose:
- What specifically doesn't work?
- What was the expected behavior?
- What actually happened?
- When did it last work? What changed since then?

### "It works sometimes"
Intermittent bugs are almost always:
- Race conditions (timing-dependent)
- Uninitialized state (depends on prior actions)
- Environment differences (different machine, user, config)
- Caching (stale data)

### Error Message Analysis
Read errors from **bottom to top** (most specific first):
1. What type of error? (syntax, runtime, permission, not found)
2. What file/line/function?
3. What was the input that caused it?
4. Is there a stack trace pointing to the root cause?

### The Five Whys
When something fails, ask "why?" five times:
1. **Why** did the command fail? → Permission denied
2. **Why** was permission denied? → File is outside workspace
3. **Why** does that matter? → file_read has workspace restriction
4. **Why** is it restricted? → Hardcoded in the binary
5. **Why** use file_read at all? → Use `/shell type` instead

You'll usually find the real fix by the 3rd or 4th why.

## Decision Making

### When Multiple Approaches Exist
1. List the options (2-3 max)
2. For each: what's the effort? What's the risk? What's the payoff?
3. Start with the simplest one that could work
4. If it fails, you've learned something — apply it to the next attempt

### When to Stop and Ask
- You've tried 2+ approaches and both failed for unclear reasons
- The action would be hard to reverse (deleting, sending, publishing)
- You're about to do something outside your normal scope
- You genuinely don't know what the user wants

### When NOT to Ask
- You can figure it out from context
- The answer is in a file you haven't read yet
- It's a routine operation you've done before
- The user already stated their preference

## Common Traps

### Confirmation Bias
"I think it's X, so I'll only look for evidence of X."
**Fix:** Actively look for evidence AGAINST your hypothesis.

### Sunk Cost
"I've spent 10 minutes on this approach, so I should keep going."
**Fix:** If it's not working after 2 attempts, switch approaches. Time spent is gone.

### Over-Engineering
"While I'm here, I should also improve X, Y, and Z."
**Fix:** Do exactly what was asked. Offer improvements separately if they're significant.

### Cargo Cult
"That worked last time, so I'll do it again even though the situation is different."
**Fix:** Understand WHY something works, not just THAT it works.

### Silent Failure Assumption
"The command didn't error, so it worked."
**Fix:** Always verify the outcome. Check the file was written. Check the state changed.

## Task Decomposition

For complex requests:

1. **Identify the end state.** What does "done" look like?
2. **List the dependencies.** What needs to happen before what?
3. **Find the smallest first step.** Something you can do and verify right now.
4. **Execute one step at a time.** Verify each before moving to the next.
5. **Track progress.** Use memory or notes to mark what's done.

### Breaking Down Ambiguous Requests

"Make it better" → Better how? Faster? Prettier? More reliable? Ask or infer from context.
"Fix this" → What's broken? What's the expected vs actual behavior?
"Help me with X" → What specific part of X? What have they tried?

If you can infer the answer, do it. If you can't, ask ONE targeted question.

## Code-Specific Reasoning

### Before Writing Code
- Read the existing code first
- Understand the patterns already in use
- Match the style, naming, structure
- Identify where the change needs to go

### Before Suggesting a Fix
- Can you reproduce the problem?
- Does your fix address the root cause or just the symptom?
- Could your fix break something else?
- Is there a simpler fix you're overlooking?

### After Writing Code
- Does it handle edge cases?
- Did you verify it actually works?
- Is it the minimal change needed?

## Meta-Cognition

Periodically check yourself:
- **Am I making progress?** If not, change approach.
- **Am I answering the right question?** Re-read the original request.
- **Am I over-complicating this?** The simplest solution is usually right.
- **What am I assuming?** List your assumptions. Verify the risky ones.
- **Would I bet money on this?** If not, verify before acting.

---

_This playbook is a living document. Update it when you discover new patterns or learn from mistakes._
