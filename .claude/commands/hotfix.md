---
description: Quick fix directly on main — solo only
argument-hint: <short description>
---

Make a small urgent fix directly on main and push.

**Refuse on team projects.** First check:
```
grep -Eq 'VIBEHUB:TEAM-GUARDRAILS|TERMROAM:TEAM-GUARDRAILS' CLAUDE.md 2>/dev/null && echo TEAM || echo SOLO
```
If `TEAM`, STOP and reply: "Team project — hotfixes still go through PR. Use `/start-feature hotfix-<name>` then `/ship`."

If `SOLO`:

1. If working tree is dirty, ask whether to stash or commit existing changes first. Wait for my answer.
2. `git checkout main && git pull origin main`.
3. Investigate what `$ARGUMENTS` describes. Find the file, the bug, the fix.
4. Show me the diff. STOP and ask me to confirm before proceeding.
5. After I approve: commit with message `fix: $ARGUMENTS`.
6. `git push origin main`.
7. Report: "Hotfix on main. Auto-pull rebuilds in ~10s."

Do NOT push without my explicit confirmation in step 4.
