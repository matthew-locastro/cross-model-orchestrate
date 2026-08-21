---
description: Pull latest main into current branch (avoids merge surprises later)
---

Pull the latest main into my current branch.

Steps:
1. Run `git branch --show-current`. If it's `main`, just `git pull origin main` and stop.
2. Otherwise, run `git fetch origin main`.
3. Run `git merge origin/main` (creates a merge commit if there are new commits).
4. If there are conflicts, STOP. List the conflicting files and ask me to resolve. Do not attempt automatic resolution.
5. After clean merge, report: "Merged `origin/main` into `<current-branch>`. <N> new commits incorporated."

If working tree is dirty before step 2, ask to stash first.
