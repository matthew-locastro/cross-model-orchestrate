---
description: Smart workflow router — detects state and suggests the next command
---

You are the orchestrator. Look at git state and project mode, then tell me which command to run next. Be brief.

Run these in parallel:
- `git branch --show-current`
- `git status --short`
- `git log --oneline @{upstream}..HEAD 2>/dev/null || true`
- `git log --oneline main..HEAD 2>/dev/null || true`
- `grep -Eq 'VIBEHUB:TEAM-GUARDRAILS|TERMROAM:TEAM-GUARDRAILS' CLAUDE.md 2>/dev/null && echo team || echo solo`

Decide based on the result:

| Branch | Working tree | Commits ahead of main | Mode | Suggest |
|---|---|---|---|---|
| main | clean | 0 | any | "Ready to start. What feature?" then run /start-feature |
| main | dirty | any | any | "Uncommitted on main. Commit, then I'll suggest next steps." |
| main | clean | >0 (unpushed) | any | "main is ahead of origin. Run `git push` to ship." |
| feat/* | clean | 0 | any | "Branch created, no work yet. Tell me what to build." |
| feat/* | dirty | any | any | "Work in progress. Commit when ready." |
| feat/* | clean | >0 | solo | "Ready to ship. Run /ship-solo." |
| feat/* | clean | >0 | team | "Ready for review. Run /ship to open a PR." |

Always end with: `**Phase:** <one-line description>` and `**Next:** /<command>`.

Do NOT run the next command yourself. Only suggest it.
