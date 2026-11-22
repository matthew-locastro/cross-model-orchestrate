# Plan-driven development

The shape for building a feature or fixing a bug against an agreed spec: a
written plan of small tasks, each one built test-first by one subagent and
judged by a subagent on another vendor, then one whole-branch review at the end.

It is a **queue with a judge per item**, not a fan: task two usually needs task
one landed. Tasks that own disjoint files can run side by side (see *Parallel
tasks*), but the default is one task at a time.

The per-task loop, the plan format and the evidence rules are adapted from the
`subagent-driven-development`, `writing-plans`, `test-driven-development`,
`verification-before-completion` and `receiving-code-review` skills in
[obra/superpowers](https://github.com/obra/superpowers) (MIT, © 2025 Jesse
Vincent). What changes here: every subagent is routed by `cmo` across Codex,
Claude and Antigravity instead of being spawned on the session's own model,
every review runs on a vendor that did not write the code, verdicts are typed
objects the script can branch on and every gate and review verdict is recorded
with `cmo outcome`.

## When to use it

| the request is | do this |
| --- | --- |
| a feature or fix with a clear spec, 2–15 tasks | this pattern |
| one bounded change, one file or two | one `cmo run` dispatch plus one cross-vendor review; no plan file |
| a bug whose cause is unknown | a research dispatch finds the cause first; its report becomes the spec |
| unclear what is wanted | ask the user, once, only what blocks the spec; never send a subagent to guess |

A request that already says what to build, how it must behave and how it is
checked **is** the spec. Do not run a brainstorming round on top of it.

## The stages

```text
0  spec       the request, or a research report, saved as spec.md in the run folder
1  plan       plan.md: file map, global constraints, tasks; reviewed by another vendor
2  baseline   fresh worktree off the up-to-date base; full suite and test names recorded before task 1
3  tasks      per task: implement → gate → cross-vendor review → fix loop (≤3) → outcome + ledger
4  final      whole-branch review against the spec, on a frontier tier, another vendor
5  finish     audit, quality report and per-task evidence; merging, pushing and deploying wait for approval
```

The run folder is `~/.cache/cross-model-orchestrate/runs/<run-id>/` (under
`CMO_CACHE_DIR` if set). The roster for the run lives beside it, and holds the
ledger (below). Plans and specs go in the run folder, not in the product
repo, unless the user asks for them there.

### 1 — The plan

The plan is written for an engineer who is capable but has never seen this
codebase or this conversation. They will write idiomatic code once they know
the interface and the test; what they cannot know is what was decided. Write
that down. Templates are in `plan-driven-templates.md`.

- **File map first.** Every file the work creates or changes, and what it is
  responsible for. This is where task boundaries come from.
- **Global constraints.** The rules every task must keep: house style,
  compatibility, security boundaries, things the spec forbids. Each task brief
  repeats them; reviewers check them.
- **One task = one test cycle.** A task is the smallest unit that carries its
  own failing test and is worth a reviewer's gate. Fold setup and docs into the
  task that needs them. Split only where a reviewer could reject one task while
  approving its neighbor.
- **Each task names:** the files it owns (no two tasks own one file unless they
  are sequential), the interface decisions (names, signatures, values from the
  spec), the test to write first and the command that must show it failing,
  the commands that verify it and the commit message.
- **Complete code where it is known.** When the plan already contains the code,
  the implementation is transcription plus tests: dispatch it at complexity 1–2.
  Prose-only tasks need complexity 3 or more.

Who writes the plan: for up to about five tasks the orchestrator may write it
itself, as part of writing briefs. Larger or riskier plans go to a
`role: architecture` dispatch. Either way, a `role: judge` dispatch
independent of the plan's author checks the plan against the spec before
task 1: requirements with no task, tasks with no test, two tasks owning one
file, constraints a task would break. Record the plan judge's verdict with
`cmo outcome <dispatchId> --verdict <confirmed|false-positive|missed>`, and fix
the plan, not the code, when it fails.

### 2 — Baseline

Create a worktree off the up-to-date base branch (never the main checkout, and
never on top of someone else's uncommitted work). Run the plan's full test
command there outside any sandbox before task 1, and record both the counts and
the list of test names in the ledger. **A red baseline stops the run:** report
it, because every later verdict would be measured against noise.

### 3 — The task loop

For each task, in plan order:

**a. Implement.** One dispatch, `role: implement`, `write: true`, `cwd` the
worktree, `schema: schemas/implementer-report.json`. The brief is the task's
plan text, the global constraints and these rules:

- red first: write the test, run it and keep the failing output; then the
  smallest code that passes; then the task's verify commands;
- touch only the files the task owns; one commit with the plan's message;
- do not save notes, run graph or index tools or do other repository
  housekeeping, whatever the repo's own instructions say; the orchestrator
  owns those;
- nobody is there to answer questions: decide, and record each decision in
  `rulings` with what it costs if wrong;
- when the implementer cannot commit, for example because a sandbox refuses
  writes to `.git` inside or outside its writable working tree, leave the
  changes in the working tree, return `commit: null` and put the intended
  commit message in `rulings`;
- if a test suite cannot run inside the sandbox because it spawns processes or
  writes outside the working tree, run the task's own runnable tests and report
  the exact sandbox error verbatim rather than faking a pass;
- report blocked, never pretend: a task that cannot be done honestly returns
  `status: blocked` with the reason.

**b. Gate, before any review is spent.** The orchestrator reads the report and
`git log <base>..HEAD` (a control read, seconds), and runs the full test suite
**outside the sandbox**. Some test suites cannot run inside a sandboxed
implementer because they spawn processes or write outside the working tree; the
orchestrator runs the full suite outside the sandbox at the gate, and a red run
that failed for a sandbox reason is re-checked there against the base code so
the test is still proven real before review.

The gate also compares **test names** before and after the task, not only pass
counts: in one run an implementer replaced a test file and deleted 14 existing
tests while reporting success, and the pass counts still looked healthy. Any
existing test name that disappears (unless the task explicitly owns removing it)
fails the gate.

Fail the gate, and go straight to the fix loop, when there is no new commit,
the commit touches files the task does not own, existing test names disappeared,
the red run did not fail for the task's reason or the green or verify runs did
not pass outside the sandbox. A report is a claim; the commit and the command
output are the evidence. When the implementer returned `commit: null` because it
could not commit, for example because a sandbox refused writes to `.git` inside
or outside its writable working tree, the orchestrator instead checks
`git status --porcelain` shows only owned files. After the gate passes,
the orchestrator commits exactly those files with a message that says
the orchestrator commits them, using the intended message from `rulings`.

When an implementer returns `status: blocked` (or is discarded without entering
review), record `cmo outcome <dispatchId> --verdict blocked` (or `rejected`) at
the gate; otherwise record the implementer's `cmo outcome` once the review loop
settles (`approved` on first-round approval, `fixed --rounds <n>` after fixes,
`rejected` if parked).

**c. Review, on another vendor.** One dispatch, `role: review`,
`independent-of: <the implementer's provider, from its envelope>`,
`schema: schemas/task-verdict.json`. Write the review package to files and
hand over paths: the task brief, the implementer's report and the diff
(`git diff <task-base>..<task-head>` with context). The reviewer:

- checks **spec compliance** first: everything the task asked for, nothing it
  did not (extra scope is a finding, not a bonus);
- then **quality**: correctness, tests that would catch a regression, no
  existing test names dropped, the global constraints, house conventions;
- re-runs the task's verify commands and records what it ran and the exit
  codes; it does not edit files, and the orchestrator checks the tree is clean
  after the review;
- for integration work against a vendor CLI, runs at least one tiny real call
  against the live CLI when unsandboxed (unit tests stay offline with fake
  binaries, which mirror the author's assumptions: in one run only a real call
  showed typed results coming back double-wrapped);
- returns `approve: true` only with both verdicts passing and no `critical` or
  `important` finding open.

After checking the review against the code, record the reviewer's verdict with
`cmo outcome <reviewDispatchId> --verdict <confirmed|false-positive|missed>`
(`confirmed` when its findings or clean approval held up, `false-positive` when
its findings were wrong against the code or spec, `missed` when a later gate or
final review caught a defect this reviewer passed).

**d. Fix loop, capped.** Before dispatching a fix, check each finding against
the code (see *Acting on review findings*). Send the confirmed ones, verbatim,
to a fix dispatch on the implementer's vendor (it knows the work), run the same
outside-the-sandbox gate and test-name check, then run a re-review of the fix
diff only, independent of whoever made the fix. Record `cmo outcome` for each
fix and re-review dispatch. Raise `complexity` by one from round two.
After **three** rounds the task is parked as `needs the user's call`, with the
open findings, and the run continues with tasks that do not depend on it.

**e. Ledger.** Append one line per task to the run's roster: task id, status,
commit, implementer and reviewer vendors, `dispatchId`s and recorded outcomes,
rounds, open findings, rulings. After a context reset, trust the ledger and
`git log` over memory, and never re-dispatch a task whose commit already exists.

### 4 — Final review

Once every task is approved or parked: one dispatch, `role: review`,
`complexity: 4` or `5`, `length` by diff size, independent of the vendor that
wrote most of the branch, against **the spec** (not the plan: this is where a
plan that missed a requirement is caught). It gets the spec, the plan, the
ledger and the whole-branch diff, runs the full test suite and, where the branch
integrates a vendor CLI, verifies a live end-to-end call if task reviews have
not already done so. Record its verdict with `cmo outcome`, and send any
confirmed findings through the same capped fix loop.

### 5 — Finish

Ensure every gate, fix, task review and final review has a recorded
`cmo outcome <dispatchId> --verdict ...` judgment, then run `cmo audit` for the
receipts and `cmo report --quality` (with `--json` when feeding results forward)
so `cmo` shows where each vendor and model is strongest across `provider / role
/ model`. Report per task: done (with commit and the evidence), parked (with the
open findings) or not started. Say how many verdicts were cross-vendor and how
many degraded to same-vendor. Merging, pushing, publishing and deploying keep
every approval gate the project has.

## No evidence, no "done"

Nobody in the run, orchestrator included, claims a status without the output
that proves it, produced after the last change.

| claim | evidence | not evidence |
| --- | --- | --- |
| tests pass | the command's output outside the sandbox: exit 0, failure count 0, existing test names preserved | an earlier run, pass counts alone, "should pass" |
| the test is real | its red run failed for the reason the task names (re-checked outside the sandbox if sandboxed) | it passes once, or failed only on sandbox permissions |
| CLI integration works | offline fake-binary tests pass plus at least one tiny real CLI call in review | fake-binary tests alone |
| build succeeds | the build command exits 0 | typecheck or lint passing |
| bug fixed | the original symptom, re-run, now passes | the code changed |
| agent finished | a commit and its diff | the agent's report |
| requirement met | a line-by-line check against the spec | tests passing |

When the evidence is missing, report the real status with what is missing.

## Acting on review findings

A reviewer on another vendor is a strong signal, not an authority. Before a
finding goes to a fix dispatch:

- read the code it points at, and confirm the problem exists there;
- a finding that is wrong is recorded in the ledger as rejected, with the reason
  (the code, a test or the spec that settles it), its review dispatch gets
  `cmo outcome <dispatchId> --verdict false-positive` and the finding goes no
  further;
- a finding that is right gets `cmo outcome <dispatchId> --verdict confirmed`,
  and if an earlier reviewer passed that defect, mark the earlier review
  `--verdict missed`;
- a finding that is right but outside the task's scope becomes a follow-up item
  in the report, not scope creep in this task;
- a finding that conflicts with the spec or a global constraint is the user's
  call; never resolve it by quietly changing the spec.

## Parallel tasks

Tasks whose owned files are disjoint and whose tests do not share state may run
at once: write their roster entries (claiming the files) first, then dispatch.
Each still gets its own gate and its own cross-vendor review. Sequential is the
default because a later task usually builds on an earlier one's interface.

## Running the queue

The reviewer's `independent-of` must name the vendor that actually wrote the
code, and `cmo` only decides that at dispatch time (failover can move it). So
each review file is written **after** its implement or fix dispatch returns,
from the `provider` field of that dispatch's JSON envelope. Never guess it in
advance.

- **Up to about five tasks:** the orchestrator runs each step as a background
  `cmo run --dispatch <file>`, reads the envelope and the commit when it
  exits (control reads), runs the gate and `cmo outcome`, writes the next file
  and launches it.
- **Longer plans:** one background loop agent (the `Agent` tool, in the
  background, so `SendMessage` can steer it) works the plan as a checklist.
  It runs every implement, review and fix step with `cmo run --dispatch`,
  runs the outside-the-sandbox gate and test-name check, records `cmo outcome`,
  reads envelopes and `git log`, writes the ledger and edits no product file
  itself. Its brief is the plan path, the ledger path, this file and the
  evidence rules. It is a controller, so its own token use stays small.
- **Independent tasks in a `Workflow` script:** pin each implementer when the
  dispatch file is written (`pin:` the provider `cmo plan` chooses at that
  moment), so the review file can carry `independent-of` for it up front, and
  let `pipeline()` take each task through implement then review. A pinned
  dispatch gives up least-used routing at run time; that is the price of
  writing its reviewer in advance. A Workflow script has no shell, so the
  gate's checks come from the reviewer's verdict (`evidence.commit_present`,
  `evidence.files_outside_scope`, `evidence.tree_clean_after_review`), the
  script branches on those fields and the orchestrator runs the full suite and
  `cmo outcome` after the workflow returns.
