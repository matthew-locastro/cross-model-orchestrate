---
description: Solo ship — fast-forward current branch onto main and push
---

Land my current feature branch onto main as a fast-forward, then push so the VPS auto-pull picks it up.

**Refuse on team projects.** First check:
```
grep -Eq 'VIBEHUB:TEAM-GUARDRAILS|TERMROAM:TEAM-GUARDRAILS' CLAUDE.md 2>/dev/null && echo TEAM || echo SOLO
```
If output is `TEAM`, STOP and reply: "This is a team project. Use `/ship` (gstack) to open a PR instead." Do not proceed.

If `SOLO`:

1. Capture current branch: `BRANCH=$(git branch --show-current)`.
2. If branch is `main`, STOP and say "Already on main. Just `git push`."
3. Run `git fetch origin main`.
4. Verify fast-forward is possible: `git merge-base --is-ancestor origin/main HEAD`. If it returns non-zero, STOP and tell me to run `/sync-main` first.
5. Stash any working-tree changes: `git stash push -u -m "ship-solo wip"`. Note whether anything was stashed.
6. `git checkout main`
7. `git pull origin main`
8. `git merge --ff-only $BRANCH`
9. `git push origin main`
10. `git checkout $BRANCH`
11. If you stashed in step 5, `git stash pop`.
12. Report: "Shipped `<short-sha-range>` to main. Auto-pull rebuilds in ~10s."

If any step fails after stashing, restore the stash before reporting the error.
