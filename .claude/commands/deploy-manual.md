---
description: Run scripts/deploy.sh manually (for when auto-pull is asleep)
---

Manually deploy the current state of `main` to the VPS.

1. Check current branch is `main` (warn if not, ask whether to continue).
2. Tell me the script needs my SSH password. The user must run it themselves so the password prompt works:

   "Run this in your shell — the `!` prefix runs it inside our session:
   `! ./scripts/deploy.sh`"

3. Wait for the user to confirm the deploy succeeded or paste the output.
4. After deploy, optionally curl the health endpoint to verify:
   `curl -s http://100.97.92.7:3000/api/health | jq .`

Do not try to ssh from inside Claude — interactive password prompts don't work here.
