---
name: cross-model-orchestrate
description: >
  Run a request as a dynamic workflow: a deterministic script that fans out to
  disposable subagents, dispatching each one to Codex or Claude by a
  multi-factor analysis of complexity, task length and token efficiency against
  live subscription headroom. Preferred vendor first, the other on failover, and
  adversarial review always on the vendor that did not produce the work.
when_to_use: >
  Invoke when the user says orchestrate this, run a dynamic workflow, spin up
  subagents, fan this out, or use both my subscriptions. This skill plans and
  executes the fan-out itself; it hands the work back when the work is a
  sequential queue rather than a fan.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash Read Write Edit Glob Grep Agent Workflow
argument-hint: "[request]"
---

# cross-model-orchestrate

You are the only author of control flow. The script you write owns the loops,
the branches and the fan-out; the subagents do only the fuzzy part and are
thrown away afterwards. No subagent decides what happens next.

Every invocation runs the same four steps in order. Do not skip step 0.

```text
0  headroom      cmo limits --refresh --human
1  shape         is this a fan or a queue?  a queue is handed back, not fanned out
2  dispatch      per subagent: role · complexity · length · efficiency → provider+model
3  run           author the workflow script, run it, re-check headroom as it drains
```

## Who can run this

The **dispatcher** is provider-agnostic: `cmo` is a plain CLI, so any agent with
a shell gets the full cross-provider behaviour — headroom check, model
selection, preferred-vendor-first with failover, cross-model review.

The **orchestration** is Claude Code-native, deliberately. `pipeline()`,
`parallel()`, the `(prompt, options)` resume cache and the `agentType` registry
are harness primitives; nothing else has them, and the cache is what lets a
nine-hour run survive an interruption.

So if you are **not** running inside Claude Code — this file also installs under
`~/.codex/skills`, `~/.agents/skills`, `~/.kilo/skills` and opencode — do not
try to emulate the workflow. Instead:

1. run step 0 and step 2 below; they are just CLI calls and work anywhere;
2. either hand the fan-out to a Claude Code session, or run the units yourself
   with `cmo run`, one shell call per unit;
3. say plainly that you have no barrier semantics and no resume cache, so keep
   the run short and expect an interruption to cost the whole thing.

Everything below assumes the Claude Code harness.

## 0 — Headroom before anything else

```bash
cmo limits --refresh --human
```

This costs nothing: Codex is read from local session logs, Claude from an OAuth
usage endpoint that runs no inference. Report both numbers to the user in your
first message, because they decide how big a run you are allowed to plan.

**Those numbers are contended, and they lag.** Other orchestrators on other
projects are draining the same two windows right now, and the vendor's figure
only reflects spend already billed — not the agents someone else launched thirty
seconds ago. So treat step 0 as a snapshot for *sizing the plan*, never as a
budget you own, and never cache it in your head: `cmo run` re-reads shared,
machine-wide state at the moment of every dispatch, and that reading is the one
that decides. When the effective figure sits well above the reported one, other
runs are in flight — plan smaller and say so.

- Either provider **exhausted** (≥95%) — plan the run for the other one alone
  and say so. Halve the fan-out width.
- Both **tight** (≥65%) — propose the smaller version of the run and let the
  user choose. Do not quietly start a 250-agent fan-out on a quarter tank.
- The probe **fails** — proceed, and say the meter is unavailable. A broken
  meter never blocks work. `cmo doctor` explains why it failed.

## 1 — Shape: a fan, or a queue?

A dynamic workflow earns its cost when you can name **the fan**: the independent
units, the several attempts each needs, and the judge who did not make them. If
you cannot name all three, you have a queue, and queues want loops.

Do not fan out when:

| the work is | do this instead |
| --- | --- |
| a sequential chain where unit two needs unit one landed | loop one agent against a checklist; less code, a commit per unit |
| one bounded change finishing in this session | just do it — no orchestration |
| shape unknown — the task list has to be discovered | let a loop discover and write the list, then come back |
| under about a dozen independent units | do it inline; orchestration starts paying around a dozen |

Say which one and why. That is a correct outcome for this skill, not a failure
of it. The two compose: scout with a loop, fan out with a script.

Otherwise state the fan in one line — *N independent units × K attempts, judged
by an independent grader* — and continue.

## 2 — Dispatch: analyse every subagent before you spawn it

Never guess a model. For each distinct kind of subagent in the plan, describe
the task and read back the decision:

```bash
cmo plan --role judge --complexity 4 --length s --independent-of codex --human
```

The four factors you are analysing, and what each one means:

- **complexity** (1–5) — how much reasoning the task needs, independent of size.
- **length** (`xs`–`xl`) — how much work and output it produces.
- **role** — `mechanical`, `research`, `implement`, `review`, `synthesis`,
  `judge`, `architecture`. A judge needs headroom a rename does not, at
  identical size.
- **token efficiency** — `--context-tokens` for how much the agent must read.
  Bulk reading on an expensive model is the most common way a fan-out wastes a
  subscription.

The tool combines them into a tier (fast / balanced / frontier), maps that to a
model and an effort level per vendor, and picks the vendor from live headroom:
preferred vendor first, the other on failover, the emptier subscription when
they are uneven, and a **defer** with a reset time when neither can finish the
job. Its reasoning is in `notes` — put the ones that changed the outcome in your
plan.

Full rubric, bands and the reason behind each correction:
`references/dispatch-policy.md`.

### Cross-model review is not optional

An artifact is reviewed by a subagent on the **other vendor**. Pass
`--independent-of <the vendor that produced it>`. A grader that shares a model
with the producer shares its blind spots: it has already decided that the thing
in front of it is correct. This is the single largest quality lever in the
pattern, and it is why the dispatcher exists rather than a hardcoded model name.

If the required side is out of headroom, the dispatcher **defers** rather than
falling back to the producer's vendor. Honour that: report the deferral, do not
route the review back to the producer.

## 3 — Run

Author a `Workflow` script. Rules that decide whether a long run finishes:

**`pipeline()` by default, `parallel()` only for a genuine barrier.** A barrier
is correct when the next step needs the whole set at once — a corpus-wide
cohesion review does, a per-item hand-off does not. Barriers are where
autonomous runs die: one stalled agent holds every finished branch behind it.

**Nothing interactive, ever.** Every subagent command passes its non-interactive
flag or does not get the tool. There is nobody there to press `y`. `cmo run`
enforces this and kills on a wall clock; hand-rolled `Bash` inside a subagent
does not.

**Schemas on anything the script branches on.** A verdict is a typed object with
a score and an enum, never prose parsed with a regex at three in the morning.

**Judge the artifact in its final context.** The last stage assembles the real
thing and looks at it the way a human will. A pipeline that only inspects the
files ships perfect assets into a page that ruins them.

### Spending the other subscription

Workflow scripts have no shell, so a Codex subagent is reached through a shim:

```js
const verdict = await agent(
  [
    'DISPATCH',
    'role: judge',
    'complexity: 4',
    'length: s',
    'independent-of: codex',
    `cwd: ${repoRoot}`,
    'timeout: 600',
    'TASK',
    gradePrompt,
  ].join('\n'),
  { agentType: 'codex-runner', phase: 'Verify', schema: VERDICT },
);
```

`codex-runner` is a Haiku shim with `Bash` only: it runs `cmo run` and returns
the result verbatim. Its cost is a rounding error against the agent it
dispatches.

Omit `agentType` for an ordinary Claude subagent. That is the right choice when
the agent needs the harness's own tools — Read, Edit, Glob, the browser — rather
than a shell. Reach for the shim when the work is self-contained and you want it
billed to the other subscription.

Patterns and worked scripts: `references/workflow-patterns.md`.

### Keep watching the meter

Re-run `cmo limits` between phases, and at least every ~25 agents in a long
fan-out. On a busy machine it reports two figures per provider: what the vendor
said, and the effective figure once dispatches already committed by every
orchestrator on this box are counted. Plan against the effective one — a run
that looks affordable on the reported number and impossible on the effective one
is competing with something else, so shrink it or wait.

Codex readings refresh themselves for free after every Codex subagent,
so this is nearly free.

React to what you see:

- a provider crosses **tight** — send the next stage to the other one;
- a provider crosses **critical** — the dispatcher downgrades its model
  automatically; note it in the run log so the drop in quality is not a mystery;
- both **exhausted** — stop dispatching, report the earliest reset time, and
  tell the user the run resumes from cache. Do not spend the last of a window on
  agents that will die halfway.

A run that stops with 40 steps cached and a stated resume time is a good
outcome. A run that discovers its limit by having agents killed mid-flight is
not.

## Hard rules

- Invoking this skill is not approval to merge, deploy, or push. Whatever
  approval gates the project has still apply.
- Do not pin a model by name because it feels right. Pin only when you can say
  what the dispatcher got wrong, and say it in the plan.
- Never run a review on the vendor that produced the work.
- Never start a fan-out you have not costed against the current headroom.

## Required output before you start work

```text
CROSS_MODEL_ORCHESTRATE
HEADROOM: codex <n>% · claude <n>%
SHAPE: fan <N units × K attempts, judged by <vendor>> | queue → <what instead>
DISPATCH: <role>→<provider>/<model>, … (one per distinct subagent kind)
BARRIERS: <where, and why the whole set is needed there>
```

Then run it.
