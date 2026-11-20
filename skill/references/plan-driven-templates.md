# Plan-driven templates

Fill-in templates for `plan-driven-development.md`. Angle brackets are
placeholders. Paths are absolute. Schemas live beside this file in `schemas/`;
copy them into the run folder so a dispatch file can name a stable path.

## plan.md

```markdown
# <Feature> plan

Spec: <run folder>/spec.md
Base: <branch> at <sha> · worktree <path>
Test command: <the command that runs this work's tests>
Full suite: <the command the final review runs>

## Global constraints
- <rule every task keeps, e.g. "no change to the outgoing email bytes when nothing is edited">
- <house style, compatibility, security boundaries, what the spec forbids>

## File map
| file | responsibility | task |
| --- | --- | --- |
| <path> | <what it owns> | T1 |

## T1 — <name>
Owns: <files>
Decisions: <names, signatures, values from the spec>
Test first: <the test, its file and name; the code when known>
Red: `<command>` fails with <the expected failure>
Build: <what to implement; the code when known>
Verify: `<command>`, `<command>`
Commit: <message>
Depends on: none | T<n>
```

## Implement (dispatch file)

```text
DISPATCH
role: implement
complexity: <1–2 when the plan has the code, 3+ when it is prose>
length: <xs–l>
write: true
cwd: <worktree>
schema: <run folder>/implementer-report.json
timeout: <seconds you can wait>
TASK
You are implementing one task of a written plan in <repo> (worktree <path>).
Nobody can answer questions during this run.

Task:
<the task's section of plan.md, verbatim>

Global constraints:
<the plan's list, verbatim>

Rules:
1. Red first. Write the test, run `<red command>`, and keep the failing output.
   It must fail for the reason the task names; if it passes, the test is wrong.
2. Write the smallest code that makes it pass. Run `<test command>`.
3. Run every verify command.
4. Touch only: <owned files>. One commit: "<message>".
5. Decide anything the plan leaves open and record it in rulings with what it
   costs if wrong. If the task cannot be done honestly, return status "blocked"
   with the reason rather than a partial or faked result.
Return the report object. Paste command output verbatim; never summarise a
failure as a pass.
```

## Review (dispatch file, written after the implement envelope returns)

```text
DISPATCH
role: review
complexity: <3; 4 for subtle or risky diffs>
length: s
independent-of: <provider from the implement envelope>
cwd: <worktree>
schema: <run folder>/task-verdict.json
timeout: <seconds>
TASK
Review one task of a written plan. You did not write this code.

Read, in this order:
- the task brief: <run folder>/T<n>/brief.md
- the implementer's report (a claim, not evidence): <run folder>/T<n>/report.json
- the diff under review, <task-base>..<task-head>: <run folder>/T<n>/diff.patch

1. Spec compliance: everything the task asked for, nothing it did not. Extra
   scope is a finding.
2. Quality: correctness, tests that would catch a regression, the global
   constraints, the codebase's conventions.
3. Evidence: confirm the commit exists and is the diff's head; list any file
   changed outside <owned files>; re-run `<verify commands>` and record each
   exit code.
Do not edit, stage, commit or delete anything. Run `git status --porcelain`
last and set tree_clean_after_review from it (build output the commands write
to ignored paths is fine).
approve is true only when spec and quality both pass and no critical or
important finding is open. Be exact: file, line, the issue and the fix.
```

## Fix (dispatch file)

```text
DISPATCH
role: implement
complexity: <the task's complexity, +1 from round two>
length: s
write: true
cwd: <worktree>
schema: <run folder>/implementer-report.json
timeout: <seconds>
TASK
Round <n> fixes for task T<n> in <repo>. The orchestrator has checked each
finding below against the code; fix exactly these, nothing else.

Findings:
<confirmed findings, verbatim, numbered>

Same rules as the task: a failing test first where a finding is a behaviour
bug, owned files only, one commit "fix(T<n>): round <n> review findings",
verbatim command output in the report.
```

## Re-review

The review file again, with `independent-of` set from the fix envelope's
provider, and the diff narrowed to the fix commit. Tell the reviewer which
findings the fix claims to address and ask it to check each one, plus anything
the fix broke.

## Final review (dispatch file)

```text
DISPATCH
role: review
complexity: <4–5>
length: <m–l by diff size>
independent-of: <the provider that wrote most of the branch>
cwd: <worktree>
schema: <run folder>/task-verdict.json
timeout: <seconds>
TASK
Final review of a whole branch against its spec. Set task to "final".

Read: the spec <path>, the plan <path>, the ledger <path>, and the branch
diff <base>..<head> at <path>.
1. Spec: walk the spec line by line; every requirement is met somewhere in the
   diff, or listed in spec.missing. A requirement the plan missed counts.
2. Quality across tasks: interfaces that drifted between tasks, duplicated
   code, dead code, tests that only test mocks.
3. Run the full suite: `<command>`. Record the exit code and the pass, fail
   and skip counts.
Do not edit anything. Same approve rule as a task review.
```
