# cross-model-orchestrate

**Run agent fan-outs across two AI subscriptions at once.**

If you pay for both Claude and ChatGPT/Codex, you have two rate-limit windows and
one agent using one of them. `cmo` spends both: it picks each subagent's model
from the task's complexity, length and token cost, checks what's actually left on
each subscription before dispatching, sends work to Codex first so your Claude
session keeps its own headroom, and — the part that changes output quality —
**always grades work on the vendor that didn't produce it.**

```bash
npm install -g cross-model-orchestrate
cmo install     # wires the skill into Claude Code, Codex, Kilo, OpenCode
cmo doctor      # checks both CLIs, auth, model IDs, headroom
```

Global, not `npx`: the `codex-runner` shim needs `cmo` on `PATH`, and paying
npx's unpack cost once per subagent across a 250-agent fan-out is not free.

Two steps, both needed. The npm install puts `cmo` on your path and nothing
else; `cmo install` is what wires the skill and the `codex-runner` subagent into
your agent tools, which is what makes the command below exist. Running `cmo`
with no arguments reprints these steps at any time. (There is a postinstall
banner too, but npm 7+ hides lifecycle output unless you pass
`--foreground-scripts`, so do not rely on seeing it.)

**The orchestration runs from Claude Code, and only from Claude Code.** Codex is
a worker here, not a driver — it executes subagents, it does not run the
workflow. (The `cmo` CLI itself works anywhere with a shell; see
[what's portable](#whats-portable-and-what-isnt).)

```
claude --model opus --effort high
/cross-model-orchestrate build me X, fan it out
```

Zero dependencies. Plain Node ESM, no build step, no API keys — it drives the
`codex` and `claude` CLIs you already have logged in.

---

## Why

A grader that didn't make the thing rejects work a self-assessing agent ships. On
the run this came out of, an independent grader rejected 38 of 57 generated
images — that rejection loop *was* the quality.

But an independent *Claude* agent grading a *Claude* agent's work still shares
its blind spots. It's the same model, with the same opinions about what good
looks like, arriving at the same wrong conclusion by a different route. Put the
grader on the other vendor and the failure modes stop being correlated.

That needs two subscriptions, which means it needs to know what's left on each
one. Hence this tool.

The second reason is cheaper and more boring: a 250-agent fan-out that hits a
usage limit at agent 180 has wasted the run. `cmo` watches the meter and stops
with a reset time instead of finding out the hard way.

---

## What you get

```bash
cmo limits --human      # what's left, both providers, zero token cost
cmo plan --role judge --complexity 4 --length s --independent-of codex --human
echo "the task" | cmo run --role implement --complexity 3 --write
cmo selftest            # print the whole decision table, offline
cmo doctor              # will this work on my machine?
```

`cmo limits` on a normal day:

```
codex   ok        plan=pro
        Wkly   ··········   2% resets 2026-08-28 07:36Z
claude  ok
        5hr    ··········   3% resets 2026-08-21 17:20Z
        Wkly   ███·······  27% resets 2026-08-27 16:00Z

bands: tight ≥65%  critical ≥85%  exhausted ≥95%
```

`cmo plan` tells you what it would do and why, before spending anything:

```
$ cmo plan --role judge --complexity 4 --length s --independent-of codex --human
claude sonnet effort=medium (tier balanced, weight 0.613)
why: judge · complexity 4/5 · length s → balanced | claude healthy (27%)
notes:
  - cross-model review: forced onto claude because the artifact came from codex
```

---

## How it decides

Three factors set the **tier**. Live subscription headroom picks the **vendor**.

| factor | weight | flag |
| --- | --- | --- |
| complexity | 45% | `--complexity 1..5` |
| length | 30% | `--length xs\|s\|m\|l\|xl` |
| role | 25% | `--role mechanical\|research\|implement\|review\|synthesis\|judge\|architecture` |

```
weight < 0.30 → fast       weight < 0.62 → balanced       else → frontier
```

Vendor, in strict precedence:

1. `--pin` — you forced it.
2. `--independent-of <vendor>` — cross-model review. The *other* vendor is
   preferred; if it's out of headroom the call **degrades** to a fresh agent on
   the producer's vendor, labels the verdict `same-vendor`, raises a tier, and
   tells the agent it shares the producer's blind spots. A same-vendor
   independent grader is still worth having — one rejected 38 of 57 candidates
   on the run this came from. What's dangerous is an *unlabelled* fallback, so
   it's always labelled. `--strict-independence` refuses instead.
3. Headroom — a provider ≥95% used, or flagged `rate_limit_reached`, isn't a
   candidate.
4. Preferred vendor (Codex by default), then whichever is genuinely emptier.

Plus four token-efficiency corrections, each of which shows up in `notes`:

- large context (≥120k) at complexity ≤3 drops off the frontier tier — bulk
  reading doesn't need an expensive model;
- a schema-bound `xs` output drops one tier — the schema constrains the answer
  more than the model does;
- `judge` and `review` never run on the fast tier — a cheap grader is a generous
  grader, and a generous grader silently ships the work;
- a provider in the critical band gets a cheaper model, so the last of the window
  goes further (judges exempt).

Run `cmo selftest` to print the whole table with *your* configured models.

---

## Configuration

Model IDs are the thing most likely to be wrong on your machine — Codex plans
expose different model lists, and both vendors rename things. So the tier→model
map is data, not code. `cmo doctor` prints the resolved map and flags any Codex
model ID your account doesn't actually have.

`~/.config/cross-model-orchestrate/config.json`:

```json
{
  "models": {
    "codex":  { "frontier": "gpt-5.6-sol", "balanced": "gpt-5.6-terra", "fast": "gpt-5.6-luna" },
    "claude": { "frontier": "opus", "balanced": "sonnet", "fast": "haiku" }
  },
  "preference": { "first": "codex", "weightPoints": 100 },
  "pressure": { "tight": 65, "critical": 85, "exhausted": 95 }
}
```

Or per-tier via the environment: `CMO_CODEX_FRONTIER`, `CMO_CLAUDE_BALANCED`, …,
and `CMO_PREFER=claude` to flip the tie-break. Flip it if you drive this from a
shell script or cron rather than from a Claude session — the Codex-first default
exists because the orchestrator is usually itself burning Claude quota.

Claude Fable is deliberately outside the tier map (Anthropic documents it as
substantially more consumption-intensive than Sonnet); reach it with
`--pin claude --model fable`.

---

## Where the numbers come from

Neither probe costs a token.

**Codex** — local only. Every `codex exec` writes a session rollout under
`~/.codex/sessions/YYYY/MM/DD/` recording the current rolling-window snapshot, so
the reading refreshes itself after every Codex subagent.

> Don't assume `primary` is the 5-hour window. codex-cli 0.149 emits the
> **weekly** window as `primary` with `secondary: null`; older builds put the
> 5-hour window there. This reader classifies by `window_minutes`.

**Claude** — `GET https://api.anthropic.com/api/oauth/usage` with the OAuth token
from `~/.claude/.credentials.json`. No inference, so no token cost. Claude Code
doesn't persist the rolling-window snapshot locally, so there's no offline
alternative. If you're not comfortable with that call, `cmo` degrades gracefully:
an unavailable probe reports `unknown` and is treated as usable.

---

## Many orchestrators, two subscriptions

The case this is really built for: several orchestrators, on several projects,
draining the same two windows at once, none of them aware of the others.

Both readings live in one machine-wide file, locked and written atomically so
concurrent processes cannot clobber each other. Freshness windows are short —
10s Codex, 45s Claude — and single-flighted, so a hundred simultaneous
dispatches produce one probe, not a hundred.

Short freshness is still not enough, because **the vendor's number is a lagging
indicator.** It describes spend already billed and says nothing about the forty
agents another orchestrator launched thirty seconds ago. Two runs both read 80%,
both see room, both sail through the limit.

So every dispatch **reserves** against its provider for the duration of the call
and releases afterwards. Effective headroom is what the vendor reported plus what
this machine has committed but not yet been billed for — and that is the number
the decision sees:

```
codex   ok        plan=pro
        Wkly   █·········   5% resets 2026-08-28 07:35Z
        in-flight 3 agent(s) on this machine · reported 5% → effective 8%

3 dispatch(es) in flight from this machine — effective figures include them
```

Reservations carry a pid and a lease, so a crashed run cannot hold headroom
hostage. The per-agent cost starts at a conservative 1.0 percentage point and is
replaced by a measured average once there is evidence — every Codex dispatch
rewrites its session rollout, which gives a free before/after sample. Vendors
report whole percents, so one small agent usually measures as zero; the average
over many samples recovers the sub-resolution cost, floored, because "too small
to measure" is not "free".

Overestimating stops a run early with its work cached. Underestimating gets it
killed mid-flight. This errs toward the first.

Everything lives in `~/.cache/cross-model-orchestrate/state.json`.

### Across machines

One box's file only knows about one box. If you run orchestrators on several
machines against the *same* subscriptions, run a coordinator and point them all
at it:

```bash
# on whichever machine is always up
export CMO_FLEET_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '=+/')
cmo serve --host 0.0.0.0          # or a tailnet address

# on every box, including that one
export CMO_FLEET_URL=http://<reachable-host>:7867
export CMO_FLEET_TOKEN=<the same token>
```

Now `cmo limits` is a fleet view:

```
codex   ok        plan=pro
        Wkly   █·········   6% resets 2026-08-28 07:35Z
        in-flight 2 agent(s) across the fleet · reported 6% → effective 8%

2 dispatch(es) in flight across the fleet — effective figures include them
  codex: vps-alpha:checkout-flow×1  vps-beta:termroam×1
```

- **A box is a machine.** `hostname()` by default, override with `CMO_NODE_ID`.
  Directories, terminal sessions and agent sessions are not units of
  coordination — every dispatch on one machine already shares its ledger.
- **Projects need no registration.** The project label is derived from each
  dispatch's working directory, so a directory created five minutes from now
  appears in the fleet view with no configuration.
- **One coordinator per account pair, not per company.** Boxes logged into
  *different* Codex or Claude accounts are not contending for the same windows,
  and sharing a coordinator would make them throttle each other over nothing.
- **Liveness is a lease, not a pid.** One machine cannot ask another whether a
  process is alive, so each reservation carries its own expiry, set from the
  dispatch's timeout. A box that dies mid-run releases its headroom when the
  lease runs out. No heartbeat to get wrong.
- **The token is required** and there is no way to start without one. An open
  coordinator lets anyone who can reach it reserve 100% of your headroom and
  stall every orchestrator you own. Bind to a private interface — a tailnet
  address, not `0.0.0.0` on a public IP.
- **An unreachable coordinator degrades to single-box.** Dispatches keep
  running against the local ledger and `cmo limits` says the view is local only.
  `cmo doctor` reports "configured but unreachable" as a failure, because that
  is worse than not configuring it: every box silently reverts to seeing only
  itself, which is exactly when they overrun.

---

## Using it from a Claude Code workflow

Workflow scripts have no shell, so a Codex subagent is reached through a shim
agent that does — `agentType: 'codex-runner'`, installed by `cmo install`. It's
Haiku with `Bash` only; it copies the block to a file, runs
`cmo run --dispatch <file>`, and returns the result verbatim, at a cost that's a
rounding error against the agent it dispatches.

The shim copies rather than transcribes on purpose. An earlier version read the
parameters out of the prompt and retyped them as flags; on the first real
fan-out one agent in four dropped `--independent-of codex`, so a review of
Codex's work went back to Codex and returned a verdict with no label on it.
Copying a block is reliable; transcribing eight parameters is not.

```js
const verdict = await agent(
  [
    'DISPATCH',
    'role: judge',
    'complexity: 4',
    'length: s',
    'independent-of: codex',        // this artifact was generated by codex
    `cwd: ${repoRoot}`,
    'timeout: 600',
    'TASK',
    gradePrompt,
  ].join('\n'),
  { agentType: 'codex-runner', phase: 'Verify', schema: VERDICT },
);
```

**Dispatch through the shim by default.** This is the decision that determines
whether a run balances at all. Claude's window is the scarce one — the
orchestrator is a Claude session spending it continuously, and it is the only
thing that cannot be moved — so every subagent left on Claude competes with the
thing driving the run.

A measured example: one fan-out spent 9.6k tokens on a `codex-runner` dispatch
and 557k on a workflow whose stages were plain `agent()` calls. Codex ended the
hour at 10% consumed, Claude at 96%. Nothing was misconfigured; the workflow
just defaulted to Claude for everything but one stage.

Keep a plain `agent()` only when the task needs something Codex has no access
to: an MCP server wired into the Claude session, the harness's browser, or an
agent you plan to resume later. Ordinary file work is not on that list — Codex
reads, writes and greps fine through `cmo run`.

The shim costs ~10–15k Haiku tokens per dispatch, mostly its own prompt. Trivial
against a real agent, absurd against a five-second one — batch small work rather
than shimming each piece.

---

## What's portable and what isn't

| | Claude Code | Codex / Kilo / OpenCode |
| --- | :-: | :-: |
| `cmo limits` / `plan` / `run` | ✅ | ✅ |
| Subagents billed across both subscriptions | ✅ | ✅ |
| Cross-model adversarial review | ✅ | ✅ |
| `pipeline()` / `parallel()` barrier semantics | ✅ | ❌ |
| `(prompt, options)` resume cache | ✅ | ❌ |
| `codex-runner` shim | ✅ | ❌ |

The **dispatcher** is a plain CLI — anything with a shell gets the full
cross-provider behaviour. The **orchestration** is Claude Code-native, because
`pipeline()`, `parallel()` and the resume cache are harness primitives and the
cache is what lets a nine-hour run survive an interruption. The skill installs
everywhere and tells non-Claude hosts to drive `cmo run` directly rather than
improvise a fan-out they can't checkpoint.

---

## Hardening

Everything in `cmo run` is there because of something that actually went wrong:

| | |
| --- | --- |
| **watchdog** | Hard wall-clock timeout, `SIGTERM` then `SIGKILL`. One agent waiting on an interactive confirmation once held a `parallel()` barrier for 91 minutes while two hundred finished agents idled behind it. |
| **stdin prompts** | Prompts go down stdin, never argv. Long prompts blow argv limits and shell quoting corrupts them silently. |
| **no interactive path** | Codex gets `--sandbox` + `--skip-git-repo-check`; Claude gets `--dangerously-skip-permissions`. There's nobody there to press `y`. |
| **classified retries** | A rate limit switches vendor instead of sleeping. A deterministic error (bad flag, malformed prompt) isn't retried — that just burns quota three times and fails anyway. |
| **schema enforcement** | Codex gets `--output-schema`; Claude gets the same contract in the prompt. Either way an unparseable answer is a *failure*, not prose handed to a script about to branch on it. |
| **key scrubbing** | `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` / `OPENAI_API_KEY` are stripped from the child env — with a key present the CLI bills the API account instead of the subscription this whole tool exists to balance. |

`cmo run` passes `--dangerously-skip-permissions` to Claude and can pass
`--dangerously-bypass-approvals-and-sandbox` to Codex under `--full-access`.
That is the price of unattended execution. Run it on a box you're willing to let
an agent write to; Codex defaults to `workspace-write`, not full access.

Exit codes: `0` success · `1` the agent failed · `2` bad usage · `3` deferred, no
provider had the headroom.

---

## Tests

```bash
npm test        # 49 offline tests: no network, no spawn, nothing spent
cmo selftest    # the decision table, printed
cmo doctor      # the live half: CLIs, auth, model IDs, headroom
```

Everything that decides where quota goes is a pure function, and the runner takes
an injectable spawn, so the policy is fully testable without spending anything.

---

## Auditing a fan-out

The shim is a language model asked not to do the task itself, and it does not
always comply — on a measured 12-agent run, four agents never called the
dispatcher and answered from their own weights instead. A self-written answer
looks exactly like a dispatched one, so the only reliable check is counting
receipts:

```
$ cmo audit --since 30 --expected 12 --human
dispatches in the last 30 min: 8
  codex     5   gpt-5.6-terra x5
  claude    3   sonnet x3

codex share: 62%
reviews: 3 cross-vendor, 0 same-vendor

WARNING: 4 of 12 subagents left NO receipt —
they never called the dispatcher and answered by themselves.
```

Every real dispatch writes one line to
`~/.cache/cross-model-orchestrate/dispatches.jsonl` with a random id that also
comes back in the envelope as `dispatchId`. The gap between agents you spawned
and receipts on record is the number that never ran.

## Releasing

Published via npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
from `.github/workflows/release.yml` — GitHub mints a short-lived OIDC token at
run time, so no npm credential exists in this repo, in Actions secrets, or on
any machine.

```bash
npm version patch
git push --follow-tags origin main
```

The tag push runs the tests and publishes. The workflow refuses to publish if
the tag and `package.json` disagree.

## License

MIT.
