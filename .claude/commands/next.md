---
description: Lightweight check — what should I do next?
---

Look at git state and tell me the single next sensible step. Don't run anything.

Run:
- `git status --short`
- `git branch --show-current`
- `git log --oneline @{upstream}..HEAD 2>/dev/null | head -5 || true`

Reply in this format:

```
State: <one-line summary>
Suggested: /<command>  (or a plain shell command if no slash command fits)
Why: <one sentence>
```

That's it. No tool calls beyond the three reads. No edits.
