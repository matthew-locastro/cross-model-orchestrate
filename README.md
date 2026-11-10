# cross-model-orchestrate

**Run agent fan-outs across two AI subscriptions at once — three, with Grok.**

If you pay for both Claude and ChatGPT/Codex, you have two rate-limit windows and
one agent using one of them. `cmo` spends both: it picks each subagent's model
from the task's complexity, length and token cost, checks what's actually left on
each subscription before dispatching, power-uses whichever subscription is least
used, keeps Claude's window in reserve for the orchestrator, and — the part that changes output quality —
**always grades work on the vendor that didn't produce it.**

## First, the two CLIs this drives

`cmo` has no API keys and no models of its own. It drives the **Claude Code** and
**Codex** CLIs you are already paying for, so both have to be installed *and
logged in* before it can do anything. Skip this and `cmo doctor` will tell you —
but you will have installed a tool that can only reach one vendor, and grading
work on the vendor that did not produce it is the entire point.

Node 20 or newer, then:

```bash
npm install -g @anthropic-ai/claude-code   # or Claude Code's native installer
npm install -g @openai/codex

claude    # log in, then quit
codex     # log in, send it one message, then quit
```

That message to Codex is not ceremony. It writes Codex's first session file, and
that file is where `cmo` reads your Codex usage from — until one exists, the
Codex meter reads "no codex session rollouts found" and routing has to guess.

## Then the tool itself

```bash
npm install -g cross-model-orchestrate
cmo install     # wires the skill into Claude Code, Codex, Kilo, OpenCode
cmo doctor      # every row should read ok
```

Global, not `npx`: the `codex-runner` shim needs `cmo` on `PATH`, and paying
npx's unpack cost once per subagent across a 250-agent fan-out is not free.

Two steps, both needed. The npm install puts `cmo` on your path and nothing
else; `cmo install` is what wires the skill and the `codex-runner` subagent into
your agent tools, which is what makes the command below exist. Running `cmo`
with no arguments reprints these steps at any time.

`cmo doctor` is the gate: if it is green, a fan-out will work, and if it is not,
it names the command that fixes each row. Run it before your first dispatch and
any time something behaves oddly.

(Two harmless things npm may say on the way in. It hides our postinstall banner
unless you pass `--foreground-scripts`, and newer npm warns that the package
"has install scripts not yet covered by allowScripts". Both are fine to ignore:
that script only prints text — it writes nothing, touches no directory outside
the package, and cannot fail your install. `cmo install`, which you type
yourself, is what actually wires anything up.)

**The orchestration runs from Claude Code, and only from Claude Code.** Codex is
a worker here, not a driver — it executes subagents, it does not run the
workflow. (The `cmo` CLI itself works anywhere with a shell; see
[what's portable](#whats-portable-and-what-isnt).)

```
claude --model opus --effort high
/cross-model-orchestrate build me X, fan it out
```

Zero dependencies. Plain Node ESM, no build step, no API keys — it drives the
`codex` and `claude` CLIs you logged into above.

## Optional: Grok as a third vendor

If you also pay for **SuperGrok**, `cmo` can dispatch to xAI's Grok Build CLI.
It earns its place with one thing the other two don't do well from a fan-out:
it runs on your machine with **live web search and fetch**, so it can open a URL
and look. Codex's sandbox has no network (no DNS), and a Codex agent asked to
check links guesses them in prose that reads exactly like having checked.

```bash
curl -fsSL https://x.ai/cli/install.sh | bash   # xAI's installer
grok login                                       # browser OAuth to your SuperGrok account
cmo doctor                                       # "grok sign-in  ok  Oidc (OAuth) on SuperGrok …"
```

**Subscription only, never API spend.** The grok CLI falls back to pay-per-token
billing through `XAI_API_KEY` whenever it isn't signed in. `cmo` closes that
path four ways:

1. every child process starts with `XAI_API_KEY` and `GROK_CODE_XAI_API_KEY`
   removed and `GROK_DISABLE_API_KEY_AUTH=1` set, so the CLI has no key to fall
   back to and refuses one anyway (checked: with a key present and the lock set,
   a headless run fails "Not signed in" rather than using it);
2. before routing, `cmo` asks the CLI's own agent protocol whether the session
   is an OAuth sign-in on a subscription tier — no sign-in, no grok;
3. every dispatch's stream names its auth source on its first line, and a
   session that isn't `oauth` is killed on that line and grok is marked
   unroutable for every orchestrator on the machine;
4. every grok receipt records that source, and `cmo audit` / `cmo report`
   flag any grok dispatch not proven to be subscription-billed.

`cmo` never reads, stores or sets a key, and never reads `~/.grok/auth.json`.

What goes to Grok: `research`-role work and anything dispatched with `--web`
(`web: true` in a dispatch file) lean to it while its window is healthy, and it
joins the pool of cross-vendor reviewers. Ordinary work follows the same
least-used rule as everything else, so Grok takes it whenever its subscription
is the differentially idle one, not only after Codex is spent. Its weekly
allowance is shared with the Grok apps, so `cmo limits` shows the same number
the app does.

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

Vendor selection filters first, then scores whoever can run:

1. `--pin` — you forced it.
2. `--independent-of <vendor>` — cross-model review. Only the *other* vendors are
   candidates; if none of them can run the call **degrades** to a fresh agent on
   the producer's vendor, labels the verdict `same-vendor`, raises a tier, and
   tells the agent it shares the producer's blind spots. A same-vendor
   independent grader is still worth having — one rejected 38 of 57 candidates
   on the run this came from. What's dangerous is an *unlabelled* fallback, so
   it's always labelled. `--strict-independence` refuses instead.
3. Can it run — a provider ≥95% used, or flagged `rate_limit_reached`, isn't a
   candidate. Nor is a missing CLI, an unverified Grok, or Codex on `--web` work.
4. **Least-used wins.** The dominant term is headroom:
   `headroomWeight` (default 40) × (100 − pressure) / 100. When one competing
   provider's pressure is at least `powerGap` points (default 20) below every
   other provider that is actually competing, it also gets `powerBonus`
   (default 25). The reason reads, for example,
   `power-use: grok is 61 points less used than codex`.
5. **Orchestrator reserve.** The vendor driving the run (`orchestrator.vendor`,
   default `claude`) loses `penalty` points (default 30) on every dispatch. At
   or above `reserveAt` pressure (default 60) it ranks below every usable
   alternative and is chosen only when nothing else can run:
   `claude reserved for the orchestrator (pressure 62% ≥ 60%)`.
   `vendor: null` turns the reserve off.
6. **Affinity** — Grok gets 25 points for `research` and for `--web`, so a
   healthy Grok still takes that work when no other subscription is
   differentially idle.
7. **Tie-break** — `preference.first` (default `codex`), worth
   `weightPoints / 10` score points (default 2.5). It settles a near-tie and
   nothing wider.
8. **Time fit** — a vendor whose own recent receipts say it will not finish
   inside the dispatch's `--timeout` is tried after one that will. The
   estimate is the p75 of that vendor's last 14 days on the same role, tier and
   effort (3 samples minimum; a tier with fewer takes the nearest cheaper
   tier's estimate as a floor), and "will not finish" means over 90% of the
   timeout. The slow vendor stays on the failover ladder, a pin still wins,
   and the orchestrator's reserved vendor is never promoted past it. The reason reads, for example,
   `grok usually overruns a 10.0 min timeout on review·balanced (grok 18.5 min
   at p75 over 4), so it runs only if codex cannot`. It exists because Grok
   takes three to four times as long as Codex at the same tier (review p50
   876s against 202s): power-use sent it reviews with Codex-sized 600s and
   900s timeouts, it was killed with nothing to show, and Codex did the work
   anyway. (Since 0.1.30 a run still producing output is not killed at its
   timeout at all: see the watchdog under Hardening.)

`cmo limits --human` ends with that call:

```text
routing: power-use grok (6%) · codex 67% · claude reserved for orchestrator
```

`cmo plan --human` repeats the power-use and reserve reasons under `notes`.

Headroom is **pace-aware**. Both vendors have a 5-hour and a weekly window, and
a raw percentage can't tell 80% of a week with five days to go (20% must last
five days: 4%/day against an even pace of 14.3%/day) from 80% with twelve hours
to go (plenty, and whatever is left at the reset is lost). So each window gets a
*pressure* — usage weighed against time to reset, on the same 0–100 scale — and
the headroom term, the bands and the model downgrade all act on the
most-pressured window. A weekly squeeze outranks a 5-hour blip that is about to
clear; budget about to expire counts as room; and pace alone never takes a
provider out of the running, so it can still serve the cross-vendor reviews
only it can do. `cmo limits --human` prints the pace line for every window:

```text
codex   critical  pressure 94% (weekly) plan=pro
        Wkly   ████████··  80% resets 2026-10-14 03:35Z
               pace: 20% left for 5.0d = 4%/day vs 14.3%/day even → pressure 94%
```

The arithmetic and a table of worked cases are in
[`skill/references/dispatch-policy.md`](skill/references/dispatch-policy.md).

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
    "claude": { "frontier": "opus", "balanced": "sonnet", "fast": "haiku" },
    "grok":   { "frontier": { "model": "grok-4.7", "effort": "high" },
                "balanced": { "model": "grok-4.7", "effort": "medium" },
                "fast":     { "model": "grok-4.7", "effort": "low" } }
  },
  "preference": { "first": "codex", "weightPoints": 25 },
  "routing": { "headroomWeight": 40, "powerGap": 20, "powerBonus": 25 },
  "orchestrator": { "vendor": "claude", "penalty": 30, "reserveAt": 60 },
  "affinity": { "grok": { "roles": ["research"], "web": true, "points": 25 } },
  "durationFit": { "enabled": true, "quantile": 0.75, "margin": 0.9, "minSamples": 3, "windowDays": 14 },
  "pressure": { "tight": 65, "critical": 85, "exhausted": 95 }
}
```

`routing`, `orchestrator` and `durationFit` merge the same way `preference` and `affinity` do:
a key you set replaces that key, and the rest stay at the defaults.
`orchestrator.vendor` set to `null` turns the reserve off.

Or per-tier via the environment: `CMO_CODEX_FRONTIER`, `CMO_CLAUDE_BALANCED`,
`CMO_GROK_FAST`, …; `CMO_GROK_BIN` names the grok binary if it is neither on
`PATH` nor in `~/.grok/bin`; `CMO_GROK_PROBE=0` stops the grok meter (and with it,
grok routing);
and `CMO_PREFER=claude` flips the near-tie only. If you drive this from a shell
script or cron, set `"orchestrator": { "vendor": null }` — the default assumes
the process doing the dispatching is itself a Claude session.

Claude Fable is deliberately outside the tier map (Anthropic documents it as
substantially more consumption-intensive than Sonnet); reach it with
`--pin claude --model fable`. Likewise `grok-4.7-build-fast`, which the grok CLI
lists as "2x the price": `--pin grok --model grok-4.7-build-fast`.

---

## Where the numbers come from

None of the probes costs a model turn, except Claude's on macOS (below).

**Grok** — two JSON-RPC calls to a short-lived `grok agent --no-leader stdio`,
the account queries behind the TUI's `/usage` panel: `_x.ai/billing` returns the
weekly `creditUsagePercent` and the period's end, and
`_x.ai/auth/check_subscription` says whether the session is an OAuth sign-in on
a subscription tier. About three seconds, reused for a minute (fifteen seconds
while signed out, so `grok login` takes effect quickly).

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

On **macOS** that file does not exist: Claude Code keeps its credentials in the
login Keychain, so the endpoint cannot be read and the meter used to stay dark on
every Mac. There, `cmo` asks the CLI instead. `claude -p --output-format
stream-json` emits a `rate_limit_event` carrying both windows on every turn, so
one minimal haiku turn — tools and MCP switched off, about a thousand input
tokens — yields the same reading without `cmo` ever touching the Keychain. A
reading taken this way is reused for two minutes rather than 45 seconds
(`freshness.claudeCli`), and `CMO_CLAUDE_CLI_PROBE=0` switches the fallback off.

### The one exception: a lapsed OAuth token

That token lives for hours, not days, and when it expires the usage endpoint
stops answering. The meter goes dark — and because unknown headroom is treated
as usable, a dark meter fails toward *over*-dispatching into a window nobody can
see any more. On the first morning of a soak that is exactly what happened.

So an expired token now repairs itself. Which repair is cheapest took measuring
rather than guessing: against a deliberately expired token, `claude auth status`,
`claude doctor`, `claude agents list` and `claude mcp list` all leave it expired
— they read the credentials file without authenticating. Only a real inference
call refreshes it.

`cmo` therefore spends the smallest turn there is: Haiku, an empty working
directory so no project `CLAUDE.md` or git status is loaded, a one-line system
prompt in place of the agent preamble, and no skills. A few hundred tokens
against a five-hour window measured in millions — and only when the token has
already lapsed, at most once a minute. Measured end to end, a dark meter goes
back to reporting in about seven seconds.

(`--bare` is the obvious way to make it cheaper still, and it does not work: it
deliberately never reads OAuth, so it refreshes nothing.)

If the refresh can't run — no `claude` on `PATH` — nothing is hidden. The probe
reports `claude oauth token expired and auto-refresh could not run`, and `cmo
report` ranks a dark meter above every other finding, because every number
underneath it was computed against headroom the tool could not see.

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
cmo serve --host <tailnet-address>      # never a public interface
```

On every other box, write the config file rather than exporting variables — it
persists across shells, and there is no `export` keyword to drop. (Setting three
env vars by hand is how the first real fleet join failed: two of the three lines
lost their `export` and the token never reached the process.)

```bash
mkdir -p ~/.config/cross-model-orchestrate
cat > ~/.config/cross-model-orchestrate/config.json <<'EOF'
{"fleet":{"url":"http://<reachable-host>:7867","token":"<the same token>","nodeId":"<this-box>"}}
EOF
cmo doctor
```

`CMO_FLEET_URL` / `CMO_FLEET_TOKEN` / `CMO_NODE_ID` still work and still win
over the file, which is useful for a one-off or in CI.

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
agent that does — `agentType: 'codex-runner'`, installed by `cmo install`.

**Write the task to a file and give the shim only the path.**

```js
// the orchestrator writes /tmp/run-7/task-001.md containing a DISPATCH
// header and the work, then:
const verdict = await agent(
  `Run: cmo run --dispatch ${args.tasks[i]}`,
  { agentType: 'codex-runner', phase: 'Verify', schema: VERDICT },
)
```

This is the whole design, and it was learned the hard way. Earlier versions put
the task in the shim's prompt and instructed it not to do the work. On measured
runs a third, then two thirds, of agents ignored that and answered from their
own weights — output indistinguishable from a real dispatch, including for a
grader whose verdict then carried no rubric discipline and no independence.

Telling a capable model not to use its capability does not work. A model that
never sees the task cannot answer it.

**Dispatch through the shim by default.** Claude's window is reserved for the
orchestrator: the dispatcher docks it 30 points and, at 60% pressure or above,
uses it only when nothing else can run. A plain `agent()` bypasses that and
spends the window directly. On one measured fan-out, 9.6k tokens went through
the shim against 557k on plain `agent()` calls; Codex ended at 10% consumed,
Claude at 96%.

Keep a plain `agent()` only when the task needs something none of the CLIs can
reach: an MCP server wired into the Claude session, the harness's browser, or
an agent you plan to resume. Ordinary file work is not on that list. Web
research goes in the dispatch file as `web: true` and lands on a healthy Grok.

The shim costs ~10–15k Haiku tokens per dispatch, mostly its own prompt —
trivial against a real agent, absurd against a five-second one.

## Talking to it while it works

Once `/cross-model-orchestrate` is invoked, the chat stays the orchestrator for
the rest of the session: it plans, dispatches, watches and reports, and every
piece of real work runs in a background subagent or `cmo run`. The point is that
you can keep talking — send a correction, a new task or a question at any time —
without stopping the work. Corrections reach a running agent if it can take
messages, and otherwise queue for that unit's next stage; a new task that would
touch files a running agent owns waits behind it.

For a run of notes, say **Start Feedback Batch**, send screenshots and notes one
at a time (each gets a one-line receipt and nothing else), then **End Feedback
Batch**. The orchestrator reads the whole batch back, groups the items by the
files they touch, asks once about anything that blocks, and sends one work
package per group to subagents in parallel, each item with a check that proves
it done. As packages land, a reviewer on another vendor checks every item and
you get a per-item report. Batches are kept on disk under
`~/.cache/cross-model-orchestrate/feedback/`, so a long one survives a context
reset.

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
| **watchdog** | Progress-aware, `SIGTERM` then `SIGKILL`. Within its `--timeout` budget (default 30 min) nothing is stopped; past it, an agent still producing output keeps going, and only `--idle-timeout` of silence (default 15 min, never more than the budget) or the `--max-runtime` ceiling (default 4 h) stops it. Claude runs with `stream-json` so its progress shows. One agent waiting on an interactive confirmation once held a `parallel()` barrier for 91 minutes while two hundred finished agents idled behind it; a slow agent that is working is not that, and cutting it off wastes the whole run. Configurable as `watchdog: { idleMinutes, maxMinutes }`. |
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
npm test        # 237 offline tests: no network, no spawn, nothing spent
cmo selftest    # the decision table, printed
cmo doctor      # the live half: CLIs, auth, model IDs, headroom
```

Everything that decides where quota goes is a pure function, and the runner takes
an injectable spawn, so the policy is fully testable without spending anything.

---

## The soak loop

Run it as your daily driver, then read the log back. `cmo report` turns the
dispatch receipts into findings, and each finding names what was measured so you
can argue with it rather than just obey it.

```
$ cmo report --since 7d

cross-model-orchestrate — last 7d
────────────────────────────────────────────────────────────
412 dispatches · 7 failed · codex share 71%

  codex    291   gpt-5.6-terra x203  gpt-5.6-luna x74  gpt-5.6-sol x14
  claude   121   sonnet x98  opus x23

  by role: implement x186  research x94  judge x71  mechanical x61
  timing:  fast p50 9s/p95 14s   balanced p50 41s/p95 96s   frontier p50 88s/p95 240s
  failures: timeout x5  transient x2
  reviews: 64 cross-vendor, 7 same-vendor

────────────────────────────────────────────────────────────
2 finding(s)

  [medium] 7 of 71 reviews ran same-vendor (10%)
          → Those verdicts are provisional — the grader shared the producer's
            blind spots. Re-grade them when the other window reopens, and start
            fan-outs earlier in the window.

  [low] measured cost is 0.19 points per agent against a 1 default
          → The default is being carried by the floor. Reservations are
            over-reserving, which makes concurrent fan-outs defer earlier than
            they need to.
```

`--json` gives the same thing structured, which is the point: paste it to the
agent that runs your orchestration and it can act on the findings — adjust the
tier map, change a role's complexity, re-grade the provisional verdicts — rather
than you reading counts and guessing.

What it looks for, in order: a **dark meter** first — a provider whose headroom
can no longer be read, which invalidates everything below it — then failure rate
and its commonest kind, retries as wasted spend, whether the fan-out actually
reached Codex, how many reviews degraded to same-vendor, tiers whose p95 says the
work never needed them, and a reservation cost that has drifted from what agents
really consume.

It changes nothing on its own. Same posture as `doctor`: measure, recommend,
let a person decide.

## Keeping the CLIs current

`doctor` never changes anything — it is a diagnostic, and `codex` and `claude`
are not our packages. `cmo update` does, explicitly:

```
$ cmo update
would run:
  plan   codex                    npm install -g @openai/codex@latest
  plan   claude                   claude update

Nothing has changed. Re-run with --yes to execute.
```

Four guards make it safe to hand to a fleet:

- **Refuses while dispatches are running on this machine.** Swapping the codex
  binary mid-run can change model ids underneath agents that already resolved
  them. `--force` if you know what those agents are doing.
- **Only runs a command it detected.** npm global tree → npm; Homebrew cellar →
  brew; Claude → its own updater. An install it does not recognise is skipped
  with the path, not guessed at — sending a Homebrew user to `npm install -g`
  leaves two copies and a PATH puzzle.
- **Prints the plan and stops.** Nothing executes without `--yes`.
- **Reports before → after**, so "updated" means a version changed rather than
  that a command exited 0.

`--self` includes cross-model-orchestrate itself.

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

## Before a real release

[`COMMERCIALIZATION_GATE.md`](COMMERCIALIZATION_GATE.md) is the checklist to come
back to before this goes to people who will run it unattended on their own
machines and their own subscriptions. It holds the eight validation phases, which
version each last passed against, and what has drifted since.

Its gate is one sentence, and it is currently unmet: *every phase passed against
the version you are actually publishing, not an earlier one.*

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
