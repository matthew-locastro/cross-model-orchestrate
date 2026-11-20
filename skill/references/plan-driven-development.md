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
Vincent). What changes here: every subagent is routed by `cmo` instead of
being spawned on the session's own model, every review runs on a vendor that
did not write the code, and verdicts are typed objects the script can branch on.

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
2  baseline   fresh worktree off the up-to-date base; the task test command passes before task 1
3  tasks      per task: implement → gate → cross-vendor review → fix loop (≤3) → ledger
4  final      whole-branch review against the spec, on a frontier tier, another vendor
5  finish     report per task with evidence; merging, pushing and deploying wait for approval
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
  approving its neighbour.
- **Each task names:** the files it owns (no two tasks own one file unless they
  are sequential), the interface decisions (names, signatures, values from the
  spec), the test to write first and the command that must show it failing,
  the commands that verify it, and the commit message.
- **Complete code where it is known.** When the plan already contains the code,
  the implementation is transcription plus tests: dispatch it at complexity 1–2.
  Prose-only tasks need complexity 3 or more.

Who writes the plan: for up to about five tasks the orchestrator may write it
itself, as part of writing briefs. Larger or riskier plans go to a
`role: architecture` dispatch. Either way, a `role: judge` dispatch
independent of the plan's author checks the plan against the spec before
task 1: requirements with no task, tasks with no test, two tasks owning one
file, constraints a task would break. Fix the plan, not the code, when it fails.

### 2 — Baseline

Create a worktree off the up-to-date base branch (never the main checkout, and
never on top of someone else's uncommitted work). Run the plan's test command
there before task 1, and record the result in the ledger. **A red baseline
stops the run:** report it, because every later verdict would be measured
against noise.

### 3 — The task loop

For each task, in plan order:

**a. Implement.** One dispatch, `role: implement`, `write: true`, `cwd` the
worktree, `schema: schemas/implementer-report.json`. The brief is the task's
plan text, the global constraints and these rules:

- red first: write the test, run it, and keep the failing output; then the
  smallest code that passes; then the task's verify commands;
- touch only the files the task owns; one commit with the plan's message;
- nobody is there to answer questions: decide, and record each decision in
  `rulings` with what it costs if wrong;
- report blocked, never pretend: a task that cannot be done honestly returns
  `status: blocked` with the reason.

**b. Gate, before any review is spent.** The orchestrator reads the report and
`git log <base>..HEAD` (a control read, seconds). Fail the gate, and go
straight to the fix loop, when there is no new commit, the commit touches
files the task does not own, the red run did not fail, or the green or verify
runs did not pass. A report is a claim; the commit and the command output are
the evidence.

**c. Review, on another vendor.** One dispatch, `role: review`,
`independent-of: <the implementer's provider, from its envelope>`,
`schema: schemas/task-verdict.json`. Write the review package to files and
hand over paths: the task brief, the implementer's report, and the diff
(`git diff <task-base>..<task-head>` with context). The reviewer:

- checks **spec compliance** first: everything the task asked for, nothing it
  did not (extra scope is a finding, not a bonus);
- then **quality**: correctness, tests that would catch a regression, the
  global constraints, house conventions;
- re-runs the task's verify commands and records what it ran and the exit
  codes; it does not edit files, and the orchestrator checks the tree is clean
  after the review;
- returns `approve: true` only with both verdicts passing and no `critical` or
  `important` finding open.

**d. Fix loop, capped.** Before dispatching a fix, check each finding against
the code (see *Acting on review findings*). Send the confirmed ones, verbatim,
to a fix dispatch on the implementer's vendor (it knows the work), then a
re-review of the fix diff only, independent of whoever made the fix. Raise
`complexity` by one from round two. After **three** rounds the task is parked as
`needs the user's call`, with the open findings, and the run continues with
tasks that do not depend on it.

**e. Ledger.** Append one line per task to the run's roster: task id, status,
commit, implementer and reviewer vendors, rounds, open findings, rulings.
After a context reset, trust the ledger and `git log` over memory, and never
re-dispatch a task whose commit already exists.

### 4 — Final review

Once every task is approved or parked: one dispatch, `role: review`,
`complexity: 4` or `5`, `length` by diff size, independent of the vendor that
wrote most of the branch, against **the spec** (not the plan: this is where a
plan that missed a requirement is caught). It gets the spec, the plan, the
ledger and the whole-branch diff, and runs the full test suite. Its findings go
through the same capped fix loop.

### 5 — Finish

Report per task: done (with commit and the evidence), parked (with the open
findings), or not started. Say how many verdicts were cross-vendor and how many
degraded to same-vendor. Run `cmo audit` for the receipts. Merging, pushing,
publishing and deploying keep every approval gate the project has.

## No evidence, no "done"

Nobody in the run, orchestrator included, claims a status without the output
that proves it, produced after the last change.

| claim | evidence | not evidence |
| --- | --- | --- |
| tests pass | the command's output: exit 0, failure count 0 | an earlier run, "should pass" |
| the test is real | its red run failed for the reason the task names | it passes once |
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
  (the code, a test, or the spec that settles it), and goes no further;
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
  exits (control reads), writes the next file and launches it.
- **Longer plans:** one background loop agent (the `Agent` tool, in the
  background, so `SendMessage` can steer it) works the plan as a checklist.
  It runs every implement, review and fix step with `cmo run --dispatch`,
  reads envelopes and `git log`, writes the ledger, and edits no product file
  itself. Its brief is the plan path, the ledger path, this file and the
  evidence rules. It is a controller, so its own token use stays small.
- **Independent tasks in a `Workflow` script:** pin each implementer when the
  dispatch file is written (`pin:` the provider `cmo plan` chooses at that
  moment), so the review file can carry `independent-of` for it up front, and
  let `pipeline()` take each task through implement then review. A pinned
  dispatch gives up least-used routing at run time; that is the price of
  writing its reviewer in advance. A Workflow script has no shell, so the
  gate's checks come from the reviewer's verdict (`evidence.commit_present`,
  `evidence.files_outside_scope`, `evidence.tree_clean_after_review`) and the
  script branches on those fields.
