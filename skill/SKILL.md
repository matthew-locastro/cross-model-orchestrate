---
name: cross-model-orchestrate
description: >
  Run a request as a dynamic workflow: a deterministic script that fans out to
  disposable subagents, dispatching each one to Codex, Claude or Grok by a
  multi-factor analysis of complexity, task length and token efficiency against
  live subscription headroom. Power-uses whichever subscription is least used,
  keeps Claude's window in reserve for the orchestrator, leans research and
  web checks toward Grok, fails over to the next usable vendor, and always
  reviews on a vendor that did not produce the work.
when_to_use: >
  Invoke when the user says orchestrate this, run a dynamic workflow, spin up
  subagents, fan this out, or use all my subscriptions, and when the user says
  Start Feedback Batch or End Feedback Batch. This chat then stays the
  orchestrator: every piece of real work runs in background subagents so the
  user can keep talking. A sequential queue runs as one background agent rather
  than a fan.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash Read Write Edit Glob Grep Agent Workflow
argument-hint: "[request]"
---

# cross-model-orchestrate

You are the only author of control flow. The script you write owns the loops,
the branches and the fan-out; the subagents do only the fuzzy part and are
thrown away afterwards. No subagent decides what happens next.

Every piece of work, and every End Feedback Batch, runs the same four steps in
order. Do not skip step 0 before any dispatch. Start Feedback Batch only opens a
batch; it runs none of them.

```text
0  headroom      cmo limits --refresh --human
1  shape         is this a fan or a queue?  either way it runs in the background
2  dispatch      per subagent: role · complexity · length · efficiency → provider+model
3  run           background dispatch, background loop, or Workflow script; re-check headroom as it drains
```

## This chat is the orchestrator: it never does the work

Once this skill is invoked, this conversation is the orchestrator for the rest
of the session, until the user says otherwise ("do this one yourself", "stop
orchestrating"). It plans, briefs, dispatches, watches, checks results and talks
to the user. It does no product work itself: no editing the product's files, no
substantive research, no builds, no reviewing the work. It does the control
reads a brief or a check needs: results, diffs, receipts, the roster. A
one-line fix is a cheap subagent on the fast tier, not an exception.

The reason is the user. They will keep sending new information, corrections and
feedback while the work runs. A chat busy doing the work cannot take that in
without stopping the work; a chat that only orchestrates answers at once and
steers the agents.

**Everything runs in the background.** Never block the chat on the work:

- one unit, or a handful: write a dispatch file (see *Spending the other
  subscription*) and run `cmo run --dispatch <file>` as a **background** shell
  command. No shim, no Haiku tokens; the harness tells you when it exits.
- a queue (unit two needs unit one landed): one background agent working the
  checklist, a commit per unit.
- a fan of about a dozen or more: a `Workflow` script, which runs in the
  background by itself.
- a Claude subagent you may need to steer mid-run: the `Agent` tool in the
  background, so `SendMessage` can reach it.

What the orchestrator does itself: read enough of the code to write a precise
brief; run `cmo limits`, `cmo plan`, `cmo audit`, `cmo report`; write dispatch
files and workflow scripts; read results and diffs to check what an agent
claims; keep the roster; commit finished work when the user has asked for
commits. Quick reads only: anything that takes more than a minute is a subagent.

**Keep a roster** in `~/.cache/cross-model-orchestrate/runs/<run-id>.md` (under
`CMO_CACHE_DIR` if set): each unit's task, the files it owns, its status, anything
queued for it, and a handle you can act on: the agent id for an `Agent`, the
background task id and dispatch-file path for a `cmo run`, the run id and script
path for a `Workflow`. Write the entry, claiming its files, **before** launching
the unit; a file another unit already owns means the new unit waits behind that
one. Update it as results land, and release a unit's files only once it has
finished or been confirmed stopped. The roster is how you answer "where are
we?" without guessing, steer or stop the right thing, and pick the run back up
after a context reset.

**Every user message gets an answer in the same turn.** Sort it:

| the message is | do this |
| --- | --- |
| a question about progress | answer from the roster and the results you have; never predict an agent's result |
| new information or a correction for running work | Record it in the roster against the unit it is for. A steerable `Agent`: `SendMessage` it. A `cmo run` or `Workflow` unit cannot take messages: if its current work is still useful, let it finish and launch the correction as that unit's follow-up before releasing its files; if the work would be wasted, stop it (`TaskStop` on its task id), confirm it stopped, and re-dispatch with the correction. Say which you did. |
| a new task | dispatch it now in the background, unless it touches files a running unit owns: then queue it behind that unit and say so. Two writers never share a file. |
| Start Feedback Batch | open a batch (next section) |
| End Feedback Batch | close and act on the open batch (next section); if none is open, say so |

## Feedback batches

The user can send a run of notes and screenshots as one package instead of a
stream of separate requests: **Start Feedback Batch**, the items one at a time,
then **End Feedback Batch**. Match the markers loosely ("start feedback",
"feedback batch start", "end batch", any casing).

**On Start.** Create `~/.cache/cross-model-orchestrate/feedback/<YYYYMMDD-HHMM>/`
with a `batch.md` whose header records `status: open`, the run id, the working
directory and the time. Reply in one line: the batch is open; send items one at
a time; say End Feedback Batch when done.

After a context reset, or whenever you are unsure a batch is open, look in that
folder for a `status: open` batch for this working directory before treating a
message as an ordinary request. One match is the open batch; more than one, ask
which. On End, set `status: closed`.

**While the batch is open, collect; do not act.** For each message:

- Log it as the next numbered item in `batch.md`. A screenshot with its note is
  one item. A note that plainly refers to the screenshot just before it joins
  that item. A message with several separate points becomes several items.
- Subagents cannot see images in this chat, so every screenshot gets a written
  description precise enough to act on: which screen or URL, phone or desktop
  (and width if you can tell), the element, its visible text, where it sits on
  screen, and what the note says is wrong. If the image came with a readable
  file path (dragged in, or a path the harness shows for a pasted image), copy
  it into the batch folder as `<item>.<ext>` and record that absolute path;
  otherwise record `image: not available to subagents`. If you cannot tell which
  screen it is from the image and the note, ask that one question, briefly.
- Acknowledge in one short line: `#4 logged: checkout button overlaps the footer
  at phone width.` No plan, no questions, no work. Ask only when an item is
  unintelligible, briefly, and keep the batch open.
- `#3: actually …` amends item 3; `scratch #3` drops it; `show batch` lists the
  items; `cancel feedback batch` discards the lot.
- Anything else still gets answered: a question is answered normally and the
  batch stays open; "stop that agent" is done at once.

**On End.** Read the whole batch back from `batch.md`, not from memory, then:

1. **Consolidate.** Group items by screen, component or file. Merge duplicates.
   Where two items conflict, the later one wins; flag the conflict in the
   report. Separate bugs, changes of taste and questions.
2. **Ask once, only what blocks.** Collect the questions that genuinely block an
   item into one message, and mark those items `blocked` in `batch.md`. Every
   group with nothing blocked goes ahead now; a blocked group is dispatched when
   the answer comes.
3. **Locate.** Find the files behind each group: a quick read if it is obvious,
   a background research dispatch if it is not.
4. **Package.** One work package per group of items that touch the same files;
   two packages never edit the same file, and each claims its files in the roster
   before it launches (a file already owned queues the package). Each package carries the items
   verbatim with their numbers (note, screenshot description, image path), a
   check per item that proves it done (`at 375px the button sits above the
   footer and is at least 44px tall`), the files in scope and what is out of
   scope, and how to verify (look at the same screen at the same width).
5. **Dispatch** the packages in parallel by the normal rules: `cmo plan` per
   package, background runs, cross-vendor review of each.
6. **Report** in a few lines, one per package: `A, header (#1 #4 #7) →
   codex/gpt-5.6-terra; B, checkout form (#2 #3) → grok/grok-4.7`. Then keep
   talking.
7. **Close the loop.** As packages land, a reviewer on a vendor that did not do
   the work checks every item against its own check. A visual item is checked
   the way the screenshot saw it: the package names a page to open, the state
   and the width, and the check goes to an agent that can render it (a plain
   `agent()` with the harness's browser). With nothing to open and no image to
   compare, the item is `needs the user's call`, not `done`. Report per item:
   done, not done, or needs the user's call. A `not done` item goes back out
   once as a follow-up package; if that fails too, it is the user's call.

`batch.md` looks like this:

```text
FEEDBACK BATCH 20261109-1430 · open
#1  [screenshot: feedback/20261109-1430/01.png]  pricing page, phone ~390px
    shows: the hero headline wrapping onto three lines over the photo
    note: "headline too big on phone"
#2  note only: "the contact link in the footer goes nowhere"
#3  amended by #5
```

## Who can run this

The **dispatcher** is provider-agnostic: `cmo` is a plain CLI, so any agent with
a shell gets the full cross-provider behaviour — headroom check, model
selection, least-used power-use with the orchestrator held in reserve,
failover, cross-model review.

The **orchestration** is Claude Code-native, deliberately. `pipeline()`,
`parallel()`, the `(prompt, options)` resume cache and the `agentType` registry
are harness primitives; nothing else has them, and the cache is what lets a
nine-hour run survive an interruption.

So if you are **not** running inside Claude Code — this file also installs under
`~/.codex/skills`, `~/.agents/skills`, `~/.kilo/skills` and opencode — do not
try to emulate the workflow. Instead:

1. run step 0 and step 2 below; they are just CLI calls and work anywhere;
2. either hand the fan-out to a Claude Code session, or run the units yourself
   with `cmo run`, one shell call per unit, in the background if the host can,
   so the conversation stays free for the user (see the orchestrator rule above);
3. say plainly that you have no barrier semantics and no resume cache, so keep
   the run short and expect an interruption to cost the whole thing;
4. say that steering running work and feedback batches need Claude Code: offer
   to hand an interactive run to a Claude Code session, and otherwise run only
   bounded `cmo run` dispatches.

Everything below assumes the Claude Code harness.

## 0 — Headroom before anything else

```bash
cmo limits --refresh --human
```

This costs next to nothing: Codex is read from local session logs, Claude from an
OAuth usage endpoint that runs no inference — or, on macOS, where Claude Code
keeps its credentials in the Keychain and there is no file to read, from one
minimal haiku turn through the `claude` CLI — and Grok from two account queries
to the `grok` CLI's agent protocol, also no inference. Report every number to
the user in your first message, because they decide how big a run you are
allowed to plan.

Grok's line also says whether it is **routable**. Grok runs only on a verified
SuperGrok sign-in, never on an API key; if the line says `NOT ROUTABLE`, tell
the user to run `grok login` themselves and plan the run without Grok. Never
sign in for them, and never set or suggest `XAI_API_KEY`.

**Those numbers are contended, and they lag.** Other orchestrators on other
projects are draining the same two windows right now, and the vendor's figure
only reflects spend already billed — not the agents someone else launched thirty
seconds ago. So treat step 0 as a snapshot for *sizing the plan*, never as a
budget you own, and never cache it in your head: `cmo run` re-reads shared,
machine-wide state at the moment of every dispatch, and that reading is the one
that decides. When the effective figure sits well above the reported one, other
runs are in flight — plan smaller and say so.

**Read the pressure, not the bar.** Each provider has two windows — a 5-hour one
and a weekly one — and the raw percentage alone says nothing about how long what
is left has to last. So every window carries a second line:

```text
codex   critical  pressure 94% (weekly) plan=pro
        Wkly   ████████··  80% resets 2026-10-14 03:35Z
               pace: 20% left for 5.0d = 4%/day vs 14.3%/day even → pressure 94%
```

*Pressure* is the raw figure weighed against time to reset, on the same 0–100
scale, and it is what the bands and the dispatcher act on:

- a window whose remainder must be rationed reads **higher** than its raw
  number — 80% of a week with five days to go is critical, not "20% free";
- a window about to reset reads **lower** — a 5-hour window at 70% with twenty
  minutes left barely constrains, and weekly budget still unused twelve hours
  before its reset is budget to spend, because the reset destroys it;
- a raw reading at ≥95% is never relaxed.

The provider's figure is its most-pressured window, so both windows of both
vendors are balanced at once. When you size a run against a weekly window, the
number to plan with is the `%/day` allowance on the pace line, not the raw
remainder: a fan-out that spends three days of allowance in an afternoon is the
mistake this line exists to prevent. Report it to the user in those terms.

If a fleet coordinator is configured, those figures cover every machine, and
`cmo limits` names which box and project the in-flight work belongs to. If it
warns that the coordinator is unreachable, you are seeing only this machine —
say so before planning a large run, because the real number is higher.

All bands below are bands of **pressure**:

- Either provider **exhausted** (≥95%) — plan the run for the other one alone
  and say so. Halve the fan-out width.
- A provider **critical on its weekly window** (≥85% pressure, days to reset) —
  that is a durable squeeze, not a blip. Plan the bulk of the run for the other
  vendor and keep this one for the work only it can do: the cross-vendor
  reviews. Say how many days the squeeze lasts.
- Both **tight** (≥65%) — propose the smaller version of the run and let the
  user choose. Do not quietly start a 250-agent fan-out on a quarter tank.
- A window that is tight only on its **5-hour** reading and resets soon — say
  when it clears; a run that can wait until then should.
- The probe **fails** — proceed, and say the meter is unavailable. A broken
  meter never blocks work. `cmo doctor` explains why it failed.

## 1 — Shape: a fan, or a queue?

A dynamic workflow earns its cost when you can name **the fan**: the independent
units, the several attempts each needs, and the judge who did not make them. If
you cannot name all three, you have a queue, and queues want loops.

Do not fan out when:

| the work is | do this instead |
| --- | --- |
| a sequential chain where unit two needs unit one landed | one background agent loops against a checklist; a commit per unit |
| one bounded change | one background `cmo run --dispatch`; no workflow script |
| shape unknown — the task list has to be discovered | a background scout discovers and writes the list, then come back |
| under about a dozen independent units | background dispatches, one per unit; a workflow script starts paying around a dozen |

Say which one and why. The shape decides the form of the delegation, never
whether to delegate: this chat does not take the work on itself. The two
compose: scout with a loop, fan out with a script.

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
- **web** — `--web` (or `web: true` in a dispatch file) when the agent must open
  live URLs: link checks, citations, "is this still true", vendor docs. Codex's
  sandbox has no network at all, so web work is never routed there.

The tool combines them into a tier (fast / balanced / frontier), maps that to a
model and an effort level per vendor, and picks the vendor from live headroom.
Least-used wins: headroom is the dominant score, and a subscription whose
pressure sits 20 points or more below every other competing subscription gets
a power-use bonus. Claude, the vendor driving the run, loses 30 points on
every dispatch and, at 60% pressure or above, is a candidate only when nothing
else can run. Research and web work still lean to a healthy Grok. A near-tie
breaks to Codex. Every other usable vendor is the failover ladder, in that
rank order, and a **defer** with a reset time comes back when none can finish
the job. The power-use and reserve reasons are in `notes` — put the ones that
changed the outcome in your plan.

Full rubric, bands and the reason behind each correction:
`references/dispatch-policy.md`.

### When Grok is the right vendor

Grok (xAI's Grok Build CLI on the SuperGrok plan) is the third subscription. It
runs unsandboxed on this machine with live web search and fetch, so it can open
a URL and see what is actually there. Codex cannot: its sandbox has no DNS, and
a Codex agent asked to verify links guesses them, in prose indistinguishable
from having checked.

Send these to Grok — the dispatcher already leans them there when Grok is
signed in and healthy, so describe the task honestly rather than pinning.
Ordinary implementation follows least-used instead: if Codex or Claude is the
differentially idle subscription, it takes that work even when Grok is fine.

- **research** that reads the web: vendor docs, release notes, prices, "what
  does the current API look like";
- **link and fact verification**: every URL in a document resolves, every
  citation says what it is cited for (`role: research`, `web: true`);
- **cross-vendor review** of Codex or Claude work, as a third grader — it
  spreads review load off the two windows the build itself is draining.

Keep these off it: anything that must not touch the network or the wider
filesystem (Grok, like Claude, is not sandboxed), and work whose output must be
a schema-enforced object (Grok gets the schema as a prompt contract, as Claude
does, not a hard constraint like Codex's).

Grok's allowance is shared with the Grok apps (`isUnifiedBillingUser`), so the
`cmo limits` figure is what the user sees in the app. Spend the window that
resets soonest: the pace line already prices that in.

### Cross-model review is not optional

An artifact is reviewed by a subagent on **another vendor** — with three, the
dispatcher picks whichever of the other two has more room. Pass
`--independent-of <the vendor that produced it>`. A grader that shares a model
with the producer shares its blind spots: it has already decided that the thing
in front of it is correct. This is the single largest quality lever in the
pattern, and it is why the dispatcher exists rather than a hardcoded model name.

If no other vendor can run it — spent, not installed, or (Grok) not signed in —
the dispatcher **degrades rather than refuses**: a fresh agent on the producer's own vendor still did not make the
thing, which is the larger half of independence, and a good review beats no
review. It is labelled `independence: same-vendor`, raised a tier (a grader
sharing the producer's priors needs the headroom), and told about its own
handicap in the prompt.

Two obligations follow, and they are the whole reason degrading is safe:

- **Report it.** Say how many verdicts were cross-vendor and how many were
  same-vendor. An unlabelled fallback is the actual hazard — it looks exactly
  like a real cross-vendor verdict.
- **Consider re-running them.** A same-vendor verdict is provisional. When the
  other vendor's window reopens, re-grading the degraded ones is cheap.

Pass `--strict-independence` when a verdict must be cross-vendor or absent —
then it defers as before.

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

Workflow scripts have no shell, so a Codex or Grok subagent is reached through a
shim — the `codex-runner` agent runs `cmo run --dispatch`, which goes wherever
the decision says, Grok included. **Write each task to a file first, and give
the shim only the path.**

```js
// Before invoking Workflow, the orchestrator writes one file per unit:
//
//   /tmp/run-7/task-001.md
//   ------------------------
//   DISPATCH
//   role: judge
//   complexity: 4
//   independent-of: codex
//   cwd: /repo
//   schema: /repo/verdict.json
//   timeout: 600
//   TASK
//   ...the actual work...
//
// and passes the paths in through args. Each agent then gets only this:

const verdict = await agent(
  `Run: cmo run --dispatch ${args.tasks[i]}`,
  { agentType: 'codex-runner', phase: 'Verify', schema: VERDICT },
)
```

This is not a style preference. Earlier versions put the task in the shim's
prompt and told it not to do the work itself; on measured runs a third, then two
thirds, of agents answered from their own weights instead of dispatching. The
output was indistinguishable from a real dispatch — including for a grader,
whose verdict then had no rubric discipline and no independence whatsoever.

A model told not to use a capability will use it. A model that never sees the
task cannot answer it. Give it the path.

**Dispatch through the shim by default. A plain `agent()` needs a reason.**

Claude's window is reserved for the orchestrator. The dispatcher already
enforces that: Claude loses score on every dispatch, and once its pressure
reaches 60% it is used only when Codex and Grok cannot run. A plain `agent()`
bypasses the dispatcher and spends that window anyway. On one measured
fan-out, 9.6k tokens went through the shim and 557k to plain `agent()` calls;
Codex ended at 10% consumed and Claude at 96%.

So generation, research, implementation, mechanical passes, grading and
synthesis all go through the shim unless they *cannot*. The shim runs `cmo`,
which power-uses whichever of Codex, Claude and Grok is least used. Keep a
plain `agent()` only for work none of those CLIs can do:

- MCP servers wired into this Claude session;
- the harness's own browser, for looking at a rendered page;
- an agent you intend to resume later with `SendMessage`.

Ordinary file work is not on that list — Codex reads, writes and greps fine.
Neither is web research: put `web: true` in the dispatch file and it goes to
Grok, off the Claude window.

The shim costs roughly 10–15k Haiku tokens per dispatch, mostly its own prompt.
Trivial against a substantial agent, absurd against a trivial one: batch small
work into one dispatch rather than shimming each crumb.

### Audit the fan-out — do not trust the shim

The shim is a language model told not to do the task itself, and it does not
always obey. On a measured 12-agent run, four agents never called the dispatcher
at all: three generators and one judge answered from their own weights, and the
workflow could not tell, because a self-written answer looks exactly like a
dispatched one.

So count receipts. Every real dispatch writes one; a shim that answered by
itself writes nothing.

```bash
cmo audit --since 30 --expected <number of subagents you spawned> --human
```

`undispatched` above zero means that many subagents lied. Treat their output as
unverified: re-dispatch them, and say so in your report. Also read the two other
lines it prints — the `share` line answers whether the run actually balanced,
`grok billing` confirms every Grok dispatch ran on the subscription (its stream
said `oauth`), and the cross-vendor / same-vendor split tells you how many
verdicts were degraded. A Grok dispatch that is not verified is a bug: stop and
tell the user.

### After a run, read the log back

```bash
cmo report --since 24h        # or --json, to act on the findings directly
```

It reports what actually happened — failure kinds, retry rate, codex share,
how many reviews degraded, whether a tier's timings say the work never needed
it — and names a specific change for each. Over a multi-day soak this is what
makes the orchestration improve rather than merely continue: the same three
mistakes stop being invisible.

When you act on a finding, say which one and what you changed. A finding acted
on silently looks exactly like a finding ignored.

### Keep watching the meter

Re-run `cmo limits` between phases, and at least every ~25 agents in a long
fan-out. On a busy machine it reports two figures per provider: what the vendor
said, and the effective figure once dispatches already committed by every
orchestrator on this box are counted. Plan against the effective one — a run
that looks affordable on the reported number and impossible on the effective one
is competing with something else, so shrink it or wait.

Codex readings refresh themselves for free after every Codex subagent, and
Claude and Grok re-read theirs after a dispatch at most every ninety seconds,
so this is nearly free.

React to what you see — in pressure, which moves with the clock as well as
with spend, so a window can cross a band without a single new token:

- a provider crosses **tight** — send the next stage to the other one;
- a **weekly** window's `%/day` allowance drops below what the remaining stages
  will cost — shrink the remaining stages or move them, and say which;
- a provider crosses **critical** — the dispatcher downgrades its model
  automatically; note it in the run log so the drop in quality is not a mystery;
- every provider **exhausted** — stop dispatching, report the earliest reset time, and
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
- Never send link or citation checking to Codex: it cannot reach the network.
- Grok runs on the SuperGrok subscription or not at all. If `cmo` says Grok is
  not routable, the fix is the user running `grok login`; never an API key.
- Never start a fan-out you have not costed against the current headroom.
- This chat does no product work. Every change, research pass, build and review
  runs in a background subagent or dispatch, so the user can keep talking.
- Never act on a feedback-batch item before End Feedback Batch.

## Required output before you start work

```text
CROSS_MODEL_ORCHESTRATE
HEADROOM: codex <pressure>% (<binding window>, raw <n>%, resets in <t>) · claude <pressure>% (…) · grok <pressure>% (…) | grok not routable: <why>
SHAPE: fan <N units × K attempts, judged by <vendor>> | queue → <what instead>
DISPATCH: <role>→<provider>/<model>, … (one per distinct subagent kind)
BARRIERS: <where, and why the whole set is needed there>
DELEGATION: <background dispatch | background loop | workflow> · roster <path>
```

Then run it.
