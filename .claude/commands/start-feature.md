---
description: Start a new feature branch from latest main
argument-hint: <kebab-case-name>
---

Start a new feature branch named `feat/$ARGUMENTS` (or ask me for a name if $ARGUMENTS is empty).

Steps:
1. If `$ARGUMENTS` is empty, ask me for a kebab-case feature name in one short question, then proceed.
2. Run `git status --short`. If working tree is dirty, ask whether to stash or commit first. Wait for my answer.
3. Run `git checkout main`.
4. Run `git pull origin main`.
5. Run `git checkout -b feat/$ARGUMENTS`.
6. Confirm with: "On branch `feat/$ARGUMENTS`, branched from `main` at <short-sha>. Ready."

If any step fails, stop and report the error. Do not force anything.
