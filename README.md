# cross-model-orchestrate

**Run agent fan-outs across two AI subscriptions at once.**

If you pay for both Claude and ChatGPT/Codex, you have two rate-limit windows and
one agent using one of them. `cmo` spends both: it picks each subagent's model
from the task's complexity, length and token cost, checks what's actually left on
each subscription before dispatching, sends work to Codex first so your Claude
session keeps its own headroom, and — the part that changes output quality —
**always grades work on the vendor that didn't produce it.**

```bash
npm install -g github:matthew-locastro/cross-model-orchestrate
cmo install     # wires the skill into Claude Code, Codex, Kilo, OpenCode
cmo doctor      # checks both CLIs, auth, model IDs, headroom
```

Not on the npm registry yet, so install from GitHub. Global, not `npx`: the
`codex-runner` shim needs `cmo` on `PATH`, and paying npx's unpack cost once per
subagent across a 250-agent fan-out is not free.

Then, in Claude Code:

```
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
2. `--independent-of <vendor>` — cross-model review. The *other* vendor is the
   only candidate, and there is **no fallback**: if that side is out of headroom
   the call defers, because a review that quietly self-judges is worse than a
   review that didn't happen.
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

Cached in `~/.cache/cross-model-orchestrate/limits.json` (60s Codex, 5min Claude)
so a 250-agent fan-out shares one probe.

---

## Using it from a Claude Code workflow

Workflow scripts have no shell, so a Codex subagent is reached through a shim
agent that does — `agentType: 'codex-runner'`, installed by `cmo install`. It's
Haiku with `Bash` only; it runs `cmo run` and returns the result verbatim, at a
cost that's a rounding error against the agent it dispatches.

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

Omit `agentType` for an ordinary Claude subagent — right when the agent needs the
harness's own tools rather than a shell.

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

## License

MIT.
