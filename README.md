# cross-model-orchestrate

**Run agent fan-outs across three AI subscriptions at once: Codex, Claude and Antigravity.**

If you pay for Claude, ChatGPT/Codex and Antigravity (Gemini), you have three
rate-limit pools and one agent session spending one of them. `cmo` spends all
three: it picks each subagent's model from the task's complexity, length and
token cost, checks what is actually left on each subscription before
dispatching, power-uses whichever subscription is least used, keeps Claude's
window in reserve for the orchestrator and — the part that changes output
quality — **always grades work on a vendor that did not produce it.**

## First, the three CLIs this drives

`cmo` has no API keys and no models of its own. It drives the **Claude Code**,
**Codex** and **Antigravity** (`agy`) CLIs you are already paying for, so the
ones you want to route across must be installed *and logged in* before `cmo` can
use them. Any two give you cross-vendor review; all three give you a third
independent model family and a dedicated web-capable pool outside Claude's
orchestrator window.

Node 20 or newer, then install and sign in to your CLIs:

```bash
npm install -g @anthropic-ai/claude-code   # or Claude Code's native installer
npm install -g @openai/codex
# plus Antigravity (`agy` on PATH or ~/.local/bin/agy)

claude    # log in, then quit
codex     # log in, send it one message, then quit
agy       # sign in with your subscription account (never GEMINI_API_KEY)
```

That message to Codex is not ceremony. It writes Codex's first session file, and
that file is where `cmo` reads your Codex usage from — until one exists, the
Codex meter reads "no codex session rollouts found" and routing has to guess.

## Then the tool itself

```bash
npm install -g cross-model-orchestrate
cmo install     # wires the skill into Claude Code, Codex, ~/.agents, Kilo, OpenCode and Antigravity
cmo doctor      # checks active vendors, auth, model IDs, headroom and skill links
```

Global, not `npx`: the `codex-runner` shim needs `cmo` on `PATH`, and paying
npx's unpack cost once per subagent across a 250-agent fan-out is not free.

Two steps, both needed. The npm install puts `cmo` on your path and nothing
else; `cmo install` wires the skill into Claude Code, Codex, `~/.agents`, Kilo,
OpenCode and Antigravity (`~/.gemini/config/skills`, skipped and reported when
`~/.gemini` is absent so machines without Antigravity stay clean), plus the
`codex-runner` subagent for Claude Code. Running `cmo` with no arguments
reprints these steps at any time.

`cmo doctor` checks only your active vendors (`codex`, `claude` and
`antigravity` by default): if it is green, a fan-out will work, and if it is
not, it names the command that fixes each row. Run it before your first dispatch
and any time something behaves oddly.

(Two harmless things npm may say on the way in. It hides our postinstall banner
unless you pass `--foreground-scripts`, and newer npm warns that the package
"has install scripts not yet covered by allowScripts". Both are fine to ignore:
that script only prints text — it writes nothing, touches no directory outside
the package and cannot fail your install. `cmo install`, which you type
yourself, is what actually wires anything up.)

**Any host with the skill can orchestrate with `cmo run` units.** Claude Code
adds `Workflow` fan-outs (`pipeline()`, `parallel()`, resume cache) and live
subagent steering; Antigravity (`agy`) can run `/cross-model-orchestrate`
directly inside repositories too; and a Codex orchestrator needs full access
(network enabled) so it can read the meters and dispatch to the other CLIs (see
[what's portable](#whats-portable-and-what-isnt)).

```text
claude --model opus --effort high
/cross-model-orchestrate build me X, fan it out
```

Zero dependencies. Plain Node ESM, no build step, no API keys — it drives the
`codex`, `claude` and `agy` CLIs you logged into above.

## Antigravity as the third vendor

Antigravity (`agy`) gives `cmo` a third subscription and a third model family.
Antigravity dispatches run `agy -p` for short prompts and switch prompts over
100,000 bytes to `--input-format stream-json` (`--output-format stream-json`) on
stdin with no `-p`. Every dispatch passes an explicit allowlisted **Gemini**
model (`^gemini-`: default frontier `gemini-4-neon` effort `xhigh`, balanced
`gemini-4-carbon` effort `high`, fast `gemini-4-hydrogen` effort `low`), and
`cmo` refuses any non-Gemini slug (`claude-*`, `gpt-oss-*` or an omitted
`--model`) before spawning, so a review routed to Antigravity is never secretly
graded by Claude or GPT under another CLI wrapper.

**Subscription only, never API spend.** `cmo` closes the pay-per-token path in
two places:

1. every child process starts with `GEMINI_API_KEY` and `GOOGLE_API_KEY` (along
   with `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `OPENAI_API_KEY` and xAI key
   variables) removed from its environment;
2. before routing, `cmo limits` runs `agy -p /usage --output-format json` (zero
   tokens, no inference) and reads only the `"Gemini Models"` group's
   `gemini-5h` and `gemini-weekly` buckets. With an API-key login `/usage` exits
   2 because an API key has no subscription quota; `cmo` marks Antigravity
   unauthenticated and unroutable.

What goes to Antigravity: `research`-role dispatches (with or without `--web`)
and anything dispatched with `--web` (`web: true` in a dispatch file) exclude
Codex's networkless sandbox unless full access is on (`--full-access`,
`codex.fullAccess: true`, or `CMO_CODEX_FULL_ACCESS=1`), so Antigravity and
Claude serve them by default — with Antigravity ahead while Claude pays the
orchestrator penalty and reserve. Antigravity also joins the cross-vendor
reviewer pool and takes ordinary implementation work whenever its window is
least used.

For permissions, `cmo` passes `--dangerously-skip-permissions` to `agy` only on
writing roles (`implement` and `mechanical` with `--write`) and omits it on
read-only roles (`review`, `judge`, `research`, `synthesis`, `architecture`),
where unapprovable actions are soft-denied in headless mode and recorded as a
receipt warning. Antigravity's `--sandbox` flag constrains shell commands the
agent spawns rather than `agy`'s own file tools, so after reviews the reviewer
runs `git status` and the orchestrator checks working-tree cleanliness at the
gate instead of relying on `--sandbox` as a write barrier.

---

## Why

A grader that did not make the thing rejects work a self-assessing agent ships.
On the run this came out of, an independent grader rejected 38 of 57 generated
images — that rejection loop *was* the quality.

But an independent *Claude* agent grading a *Claude* agent's work still shares
its blind spots. It is the same model, with the same opinions about what good
looks like, arriving at the same wrong conclusion by a different route. Put the
grader on another vendor and the failure modes stop being correlated.

That needs multiple subscriptions, which means knowing what is left on each one.
Hence this tool.

The second reason is cheaper and more boring: a 250-agent fan-out that hits a
usage limit at agent 180 has wasted the run. `cmo` watches the meter and stops
with a reset time instead of finding out the hard way.

---

## What you get

```bash
cmo limits --human      # what's left across codex, claude and antigravity, zero token cost
cmo plan --role judge --complexity 4 --length s --independent-of codex --human
echo "the task" | cmo run --role implement --complexity 3 --write
cmo outcome <dispatchId> --verdict approved --rounds 1
cmo report --quality --since 7d
cmo selftest            # print the whole decision table, offline
cmo doctor              # will this work on my machine?
```

`cmo limits` on a normal day:

```text
codex       ok        plan=pro
            Wkly   ··········   2% resets 2026-08-28 07:36Z
claude      ok
            5hr    ··········   3% resets 2026-08-21 17:20Z
            Wkly   ███·······  27% resets 2026-08-27 16:00Z
antigravity ok
            5hr    ··········   2% resets 2026-08-21 18:10Z
            Wkly   █·········   9% resets 2026-08-28 00:11Z

bands (on pressure — usage weighed against time to reset): tight ≥65%  critical ≥85%  exhausted ≥95%
```

`cmo plan` tells you what it would do and why, before spending anything:

```text
$ cmo plan --role judge --complexity 4 --length s --independent-of codex --human
antigravity gemini-4-carbon effort=high (tier balanced, weight 0.613)
independence: cross-vendor
why: judge · complexity 4/5 · length s → balanced | antigravity healthy (9%)
notes:
  - cross-model review: forced onto antigravity or claude because the artifact came from codex
fallback: claude sonnet
```

---

## How it decides

Three factors set the **tier**. Live subscription headroom picks the **vendor**.

| factor | weight | flag |
| --- | --- | --- |
| complexity | 45% | `--complexity 1..5` |
| length | 30% | `--length xs\|s\|m\|l\|xl` |
| role | 25% | `--role mechanical\|research\|implement\|review\|synthesis\|judge\|architecture` |

```text
weight < 0.30 → fast       weight < 0.62 → balanced       else → frontier
```

Vendor selection filters first across `activeProviders()` (`codex`, `claude` and
`antigravity` by default), then scores whoever can run:

1. `--pin` — you forced it.
2. `--independent-of <vendor>` — cross-model review. Only the *other* active
   vendors are candidates; if none of them can run, the call **degrades** to a
   fresh agent on the producer's vendor, labels the verdict `same-vendor`,
   raises a tier and tells the agent it shares the producer's blind spots. A
   same-vendor independent grader is still worth having — one rejected 38 of 57
   candidates on the run this came from. What is dangerous is an *unlabeled*
   fallback, so it is always labeled. `--strict-independence` refuses instead.
3. Can it run — a provider ≥95% used, or flagged `rate_limit_reached`, is not a
   candidate. Neither is a missing CLI, an unverified Antigravity subscription,
   a signed-out Claude CLI or sandboxed Codex on `research` or `--web` work
   (without `--full-access` or `codex.fullAccess`).
4. **Least-used wins.** The dominant term is headroom:
   `headroomWeight` (default 40) × (100 − pressure) / 100. When one competing
   provider's pressure is at least `powerGap` points (default 20) below every
   other provider that is actually competing, it also gets `powerBonus`
   (default 25). The reason reads, for example,
   `power-use: antigravity is 61 points less used than codex`.
5. **Orchestrator reserve.** The vendor driving the run (`orchestrator.vendor`,
   default `claude`) loses `penalty` points (default 30) on every dispatch. At
   or above `reserveAt` pressure (default 60) it ranks below every usable
   alternative and is chosen only when nothing else can run:
   `claude reserved for the orchestrator (pressure 62% ≥ 60%)`.
   `vendor: null` turns the reserve off.
6. **Network capability and affinity** — `research` and `--web` require network
   access, excluding Codex unless full access is on (`--full-access`,
   `codex.fullAccess: true`, or `CMO_CODEX_FULL_ACCESS=1`); optional `affinity`
   entries in config can add role or web points for a specific vendor.
7. **Tie-break** — `preference.first` (default `codex`), worth
   `weightPoints / 10` score points (default 2.5). It settles a near-tie and
   nothing wider.
8. **Time fit** — a vendor whose own recent receipts say it will not finish
   inside the dispatch's `--timeout` is tried after one that will. The estimate
   is the p75 of that vendor's last 14 days on the same role, tier and effort
   (3 samples minimum; a tier with fewer takes the nearest cheaper tier's
   estimate as a floor), and "will not finish" means over 90% of the timeout.
   The slow vendor stays on the failover ladder, a pin still wins and the
   orchestrator's reserved vendor is never promoted past it. (A run still
   producing output is not killed at its timeout: see the watchdog under
   Hardening.)

`cmo limits --human` ends with that call:

```text
routing: power-use antigravity (6%) · codex 67% · claude reserved for orchestrator
```

`cmo plan --human` repeats the power-use and reserve reasons under `notes`.

Headroom is **pace-aware**. Vendors can expose 5-hour and weekly windows (Codex
may report only one), and routing uses every window a vendor reports. A raw
percentage cannot tell 80% of a week with five days to go (20% must last five
days: 4%/day against an even pace of 14.3%/day) from 80% with twelve hours to go
(plenty, and whatever is left at the reset is lost). So each reported window
gets a *pressure* — usage weighed against time to reset, on the same 0–100 scale
— and the headroom term, the bands and the model downgrade all act on the
most-pressured window. A weekly squeeze outranks a 5-hour blip that is
about to clear; budget about to expire counts as room; and pace alone never
takes a provider out of the running, so it can still serve the cross-vendor
reviews only it can do. `cmo limits --human` prints the pace line for every
window:

```text
codex   critical  pressure 94% (weekly) plan=pro
        Wkly   ████████··  80% resets 2026-10-14 03:35Z
               pace: 20% left for 5.0d = 4%/day vs 14.3%/day even → pressure 94%
```

The arithmetic and a table of worked cases are in
[`skill/references/dispatch-policy.md`](skill/references/dispatch-policy.md).

Plus four token-efficiency corrections, each of which shows up in `notes`:

- large context (≥120k) at complexity ≤3 drops off the frontier tier — bulk
  reading does not need an expensive model;
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
expose different model lists, and vendors rename things. So the tier→model map
is data, not code. Antigravity's default Gemini tier map is provisional until
measured outcomes confirm the ordering. `cmo doctor` prints the resolved map and
flags any Codex model ID your account does not actually have.

`~/.config/cross-model-orchestrate/config.json`:

```json
{
  "providers": ["codex", "claude", "antigravity"],
  "models": {
    "codex":       { "frontier": "gpt-5.6-sol", "balanced": "gpt-5.6-terra", "fast": "gpt-5.6-luna" },
    "claude":      { "frontier": "opus", "balanced": "sonnet", "fast": "haiku" },
    "antigravity": { "frontier": { "model": "gemini-4-neon", "effort": "xhigh" },
                     "balanced": { "model": "gemini-4-carbon", "effort": "high" },
                     "fast":     { "model": "gemini-4-hydrogen", "effort": "low" } }
  },
  "preference": { "first": "codex", "weightPoints": 25 },
  "codex": { "fullAccess": false },
  "routing": { "headroomWeight": 40, "powerGap": 20, "powerBonus": 25 },
  "orchestrator": { "vendor": "claude", "penalty": 30, "reserveAt": 60 },
  "durationFit": { "enabled": true, "quantile": 0.75, "margin": 0.9, "minSamples": 3, "windowDays": 14 },
  "pressure": { "tight": 65, "critical": 85, "exhausted": 95 },
  "resets": { "codex": ["2026-12-01", "2026-12-10T12:00:00Z"] }
}
```

`routing`, `orchestrator` and `durationFit` merge the same way `preference` and
`affinity` do: a key you set replaces that key, and the rest stay at the
defaults. `orchestrator.vendor` set to `null` turns the reserve off. Legacy
`grok` support stays dormant unless you add `"grok"` to `"providers"`
explicitly.

Or per-tier via the environment: `CMO_CODEX_FRONTIER`, `CMO_CLAUDE_BALANCED`,
`CMO_ANTIGRAVITY_FAST`, … (Antigravity overrides must still match `^gemini-`);
`CMO_AGY_BIN` names the `agy` binary if it is neither on `PATH` nor in
`~/.local/bin/agy`; `CMO_AGY_PROBE=0` disables the Antigravity meter (and with
it, Antigravity routing); `CMO_CODEX_FULL_ACCESS=1` or `0` overrides
`codex.fullAccess` per shell or process; and `CMO_PREFER=claude` flips the
near-tie only. If
you drive this from a shell script or cron, set
`"orchestrator": { "vendor": null }` — the default assumes the process doing the
dispatching is itself a Claude session.

**`codex.fullAccess` (default `false`).** By default Codex dispatches run in
Codex's `workspace-write` sandbox (no network). Setting
`"codex": { "fullAccess": true }` in `config.json` (or
`CMO_CODEX_FULL_ACCESS=1`; `CMO_CODEX_FULL_ACCESS=0` forces the setting off)
makes full access the machine default: effective full access for a dispatch is
`true` when `--full-access` or `full-access: true` is set on the dispatch, and
otherwise uses the setting. When on, `cmo run` launches Codex with
`--dangerously-bypass-approvals-and-sandbox` and both `cmo plan` and `cmo run`
treat Codex as network-capable for `research` and `--web` work. `cmo plan --human`
shows the effective value in `notes` and `cmo doctor` prints the machine
setting. The trade-off is plain: Codex then runs without its sandbox and has the
same full user access that Claude and Antigravity already have under `cmo`.

Claude Fable is deliberately outside the tier map (Anthropic documents it as
substantially more consumption-intensive than Sonnet); reach it with
`--pin claude --model fable`.

### Redeemable resets and burn mode

Some subscriptions (such as Codex) include redeemable "full resets" that each
restore the weekly limit and expire on fixed dates. Any reset that expires
before the provider's next natural weekly reset is "use or lose": unless the
current weekly window is spent first and a reset is redeemed in the vendor's
app, that reset expires unused. `cmo` cannot redeem resets on your behalf, and
never plans to spend paid credits.

Track your reset inventory in `config.json` under `resets.<provider>` (ISO 8601
dates or datetimes; a bare `YYYY-MM-DD` date means `00:00 UTC` of that date,
deliberately conservative) or with the CLI:

```bash
cmo resets list
cmo resets add codex 2026-12-01
cmo resets used codex                 # removes the earliest, or pass <expiry>
```

`cmo limits --human` lists configured resets under each provider, marks each
unexpired entry that expires before that provider's next natural weekly reset as
`(use or lose)` and prints a one-line suggestion:
`N <provider> resets expire before the weekly reset; run \`cmo burn <provider>\` to use them.`

Burn mode starts only when requested and shares its state across every `cmo`
process via `~/.cache/cross-model-orchestrate/burn.json` (or `CMO_CACHE_DIR`),
ending at `--until` or `--off`:

```bash
cmo burn codex --until 36h            # ISO datetime/date or duration (s/m/h/d/w)
cmo burn                              # status
cmo burn --off                        # stop burning
```

While active, routing strongly prefers the burn provider for every task it is
able to run (still respecting network/sandbox capability rules, `--independent-of`
cross-vendor review and Claude's orchestrator reserve) and ignores its `tight`
and `critical` pressure bands until its binding window is exhausted (raw ≥95% or
hard-blocked). Once exhausted with resets remaining, `cmo limits --human` and
the `notes` of every `cmo run` envelope report
`<provider> exhausted; N resets left (earliest expires <date>): redeem one in the app to keep burning`
while routing falls back to the other vendors as usual. After you redeem a reset
in the vendor's app and usage drops, burning resumes automatically; run
`cmo resets used <provider>` to remove the redeemed entry.

---

## Where the numbers come from

None of the probes costs a model turn, except Claude's on macOS (below).

**Antigravity** — `agy -p /usage --output-format json`, the CLI's built-in quota
command. Zero tokens and no model turn. `cmo` reads only the `"Gemini Models"`
group's `gemini-5h` and `gemini-weekly` buckets (`remaining_fraction` and
`reset_time`), ignoring the third-party model bucket group and epoch-1970
placeholder resets. Reused for 60 seconds (`freshness.antigravity`). An API-key
session exits 2 with no subscription quota and marks Antigravity unroutable.

**Codex** — local only. Every `codex exec` writes a session rollout under
`~/.codex/sessions/YYYY/MM/DD/` recording the current rolling-window snapshot, so
the reading refreshes itself after every Codex subagent.

> Don't assume `primary` is the 5-hour window. codex-cli 0.149 emits the
> **weekly** window as `primary` with `secondary: null`; older builds put the
> 5-hour window there. This reader classifies by `window_minutes`.

**Claude** — `GET https://api.anthropic.com/api/oauth/usage` with the OAuth token
from `~/.claude/.credentials.json`. No inference, so no token cost. Claude Code
does not persist the rolling-window snapshot locally, so there is no offline
alternative. If you are not comfortable with that call, `cmo` degrades
gracefully: an unavailable probe reports `unknown` and is treated as usable.

On **macOS** that file does not exist: Claude Code keeps its credentials in the
login Keychain, so the endpoint cannot be read and the meter used to stay dark on
every Mac. There, `cmo` asks the CLI instead. `claude -p --output-format
stream-json` emits a `rate_limit_event` carrying both windows on every turn, so
one minimal Haiku turn — tools and MCP switched off, about a thousand input
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
prompt in place of the agent preamble and no skills. A few hundred tokens
against a five-hour window measured in millions — and only when the token has
already lapsed, at most once a minute. Measured end to end, a dark meter goes
back to reporting in about seven seconds.

(`--bare` is the obvious way to make it cheaper still, and it does not work: it
deliberately never reads OAuth, so it refreshes nothing.)

If the refresh cannot run — no `claude` on `PATH` — nothing is hidden. The probe
reports `claude oauth token expired and auto-refresh could not run`, and `cmo
report` ranks a dark meter above every other finding, because every number
underneath it was computed against headroom the tool could not see.

---

## Many orchestrators, three subscriptions

The case this is really built for: several orchestrators, on several projects,
draining the same subscriptions at once, none of them aware of the others.

All readings live in one machine-wide file, locked and written atomically so
concurrent processes cannot clobber each other. Freshness windows are short —
10s Codex, 45s Claude, 60s Antigravity — and single-flighted, so a hundred
simultaneous dispatches produce one probe, not a hundred.

Short freshness is still not enough, because **the vendor's number is a lagging
indicator.** It describes spend already billed and says nothing about the forty
agents another orchestrator launched thirty seconds ago. Two runs both read 80%,
both see room, both sail through the limit.

So every dispatch **reserves** against its provider for the duration of the call
and releases afterwards. Effective headroom is what the vendor reported plus what
this machine has committed but not yet been billed for — and that is the number
the decision sees:

```text
codex   ok        plan=pro
        Wkly   █·········   5% resets 2026-08-28 07:35Z
        in-flight 3 agent(s) across this machine · reported 5% → effective 8%

3 dispatch(es) in flight across this machine — effective figures include them
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

```text
codex   ok        plan=pro
        Wkly   █·········   6% resets 2026-08-28 07:35Z
        in-flight 2 agent(s) across the fleet · reported 6% → effective 8%

2 dispatch(es) in flight across the fleet — effective figures include them
  codex: host-alpha:checkout-flow×1  host-beta:billing-api×1
```

- **A box is a machine.** `hostname()` by default, override with `CMO_NODE_ID`.
  Directories, terminal sessions and agent sessions are not units of
  coordination — every dispatch on one machine already shares its ledger.
- **Projects need no registration.** The project label is derived from each
  dispatch's working directory, so a directory created five minutes from now
  appears in the fleet view with no configuration.
- **One coordinator per account set, not per company.** Boxes logged into
  *different* Codex, Claude or Antigravity accounts are not contending for the
  same windows, and sharing a coordinator would make them throttle each other
  over nothing.
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

Workflow scripts have no shell, so a Codex or Antigravity subagent is reached
through a shim agent that does — `agentType: 'codex-runner'`, installed by
`cmo install`.

**Write the task to a file and give the shim only the path.**

```js
// the orchestrator writes /tmp/run-7/task-001.md containing a DISPATCH
// header and the work, then:
const verdict = await agent(
  `Run: cmo run --dispatch ${args.tasks[i]}`,
  { agentType: 'codex-runner', phase: 'Verify', schema: VERDICT },
)
```

Every dispatch saves its final envelope and raw vendor streams under
`~/.cache/cross-model-orchestrate/dispatch/<dispatchId>/` (`envelope.json`,
`stdout.log` and `stderr.log`, or under `CMO_CACHE_DIR`). Add
`idempotency-key: <key>` to the `DISPATCH` header (or pass
`--idempotency-key <key>` to `cmo run`) so retried steps never pay twice: `cmo`
records the key in the receipt and, before running a vendor, if an earlier
receipt with the same key finished `ok` and its saved `envelope.json` exists,
prints that envelope with `"replayed": true` and the original `dispatchId`,
exits `0` and runs nothing. No locking is taken — callers own concurrency.

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
reach: an MCP server wired into the Claude session, the harness's browser or an
agent you plan to resume. Ordinary file work is not on that list. Web research
goes in the dispatch file as `web: true` (or `role: research`) and lands on
Antigravity or Claude rather than sandboxed Codex.

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
files they touch, asks once about anything that blocks and sends one work
package per group to subagents in parallel, each item with a check that proves
it done. As packages land, a reviewer on another vendor checks every item and
you get a per-item report. Batches are kept on disk under
`~/.cache/cross-model-orchestrate/feedback/`, so a long one survives a context
reset.

## Building a feature from a plan

Ask for a feature or a fix against a spec and the orchestrator runs it as
**plan-driven development**: a written plan of small tasks, each built
test-first by one dispatch, gated on its commit, test names and command output,
reviewed by a dispatch on a vendor that did not write it, recorded with
`cmo outcome`, fixed in at most three rounds, then a whole-branch review against
the spec. Implementers return a typed report and reviewers a typed verdict
(`skill/references/schemas/`), so a run branches on fields, not prose. The
pattern is in `skill/references/plan-driven-development.md`, with templates
beside it.

## What's portable and what isn't

| | Claude Code | Antigravity / Codex (full access) / Kilo / OpenCode |
| --- | :-: | :-: |
| `cmo limits` / `plan` / `run` / `outcome` / `report` | ✅ | ✅ |
| Orchestration via `cmo run --dispatch` units | ✅ | ✅ |
| Subagents billed across all active subscriptions | ✅ | ✅ |
| Cross-model adversarial review | ✅ | ✅ |
| `pipeline()` / `parallel()` barrier semantics | ✅ | ❌ |
| `(prompt, options)` resume cache | ✅ | ❌ |
| `codex-runner` shim and `SendMessage` steering | ✅ | ❌ |

The **dispatcher** is a plain CLI — any host with a shell and network access
gets the full cross-provider behavior. `cmo install` links the skill into
Claude Code, Codex, `~/.agents`, Kilo, OpenCode and Antigravity
(`~/.gemini/config/skills`, skipped when `~/.gemini` is absent), so every host
can call `/cross-model-orchestrate` and drive bounded `cmo run` units directly.
A **Codex** session acting as orchestrator must run with full access (network
enabled), because Codex's default `workspace-write` sandbox blocks network calls
and writes outside the workspace. `Workflow` fan-out primitives (`pipeline()`,
`parallel()` and the resume cache) remain Claude Code-specific.

---

## Hardening

Everything in `cmo run` is there because of something that actually went wrong:

| | |
| --- | --- |
| **watchdog** | Progress-aware, `SIGTERM` then `SIGKILL`. Within its `--timeout` budget (default 30 min) nothing is stopped; past it, an agent still producing output keeps going, and only `--idle-timeout` of silence (default 15 min, never more than the budget) or the `--max-runtime` ceiling (default 4 h) stops it. Claude runs with `stream-json` so its progress shows; Antigravity also sets `--print-timeout`. One agent waiting on an interactive confirmation once held a `parallel()` barrier for 91 minutes while two hundred finished agents idled behind it; a slow agent that is working is not that, and cutting it off wastes the whole run. Configurable as `watchdog: { idleMinutes, maxMinutes }`. |
| **prompt channels** | Codex and Claude read prompts over stdin. Antigravity passes short prompts with `-p` and switches prompts over 100 KB to `--input-format stream-json` and `--output-format stream-json` over stdin so large briefs never hit argv limits. |
| **no interactive path** | Codex gets `--sandbox` + `--skip-git-repo-check`; Claude gets `--dangerously-skip-permissions`; Antigravity gets `--disable-slash-commands`, `--print-timeout` and (for writing roles only) `--dangerously-skip-permissions`. There is nobody there to press `y`. |
| **classified retries** | A rate limit switches vendor instead of sleeping. A deterministic error (bad flag, malformed prompt, non-Gemini slug on Antigravity) is not retried — that just burns quota three times and fails anyway. |
| **schema enforcement** | Codex gets `--output-schema`; Antigravity gets `--json-schema` (`structured_output` with text-JSON recovery as fallback); Claude gets the schema contract in the prompt. Either way an unparseable answer is a *failure*, not prose handed to a script about to branch on it. |
| **key scrubbing** | `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` and xAI API key variables are stripped from the child env — with a key present a CLI can bill an API account instead of the subscription this tool exists to balance. |

`cmo run` passes `--dangerously-skip-permissions` to Claude (and to Antigravity
for writing roles) and passes `--dangerously-bypass-approvals-and-sandbox` to
Codex under `--full-access`, `codex.fullAccess: true`, or
`CMO_CODEX_FULL_ACCESS=1`. That is the price of unattended execution. Run it on
a box you are willing to let an agent write to; Codex defaults to
`workspace-write`, and enabling full access gives Codex the same full user
access that Claude and Antigravity already have under `cmo`.

Exit codes: `0` success · `1` the agent failed · `2` bad usage · `3` deferred, no
provider had the headroom.

---

## Tests

```bash
npm test          # offline test suite: fake binaries and injected probes, nothing spent
npm run selftest  # the decision table, printed
cmo doctor        # the live half: CLIs, auth, model IDs, headroom
```

Everything that decides where quota goes is a pure function, and the runner takes
an injectable spawn, so the policy is fully testable without spending anything.

---

## The soak loop and quality evaluation

Run it as your daily driver, then read the log back. `cmo report` turns the
dispatch receipts into operational findings, and each finding names what was
measured so you can argue with it rather than just obey it.

```text
$ cmo report --since 7d

cross-model-orchestrate — last 7d
────────────────────────────────────────────────────────────
412 dispatches · 7 failed · share codex 52% / claude 19% / antigravity 29%

  codex        214   gpt-5.6-terra x151  gpt-5.6-luna x51  gpt-5.6-sol x12
  antigravity  120   gemini-4-carbon x82  gemini-4-hydrogen x28  gemini-4-neon x10
  claude        78   sonnet x64  opus x14

  by role: implement x186  research x94  judge x71  mechanical x61
  timing:  fast p50 9s/p95 14s   balanced p50 41s/p95 96s   frontier p50 88s/p95 240s
  failures: timeout x5  transient x2
  reviews: 64 cross-vendor, 7 same-vendor
```

`--json` gives the same thing structured, so the orchestrating agent can act on
the findings — adjust the tier map, change a role's complexity or re-grade
provisional verdicts — rather than you reading counts and guessing.

### Evaluating where each model is strongest

Operational receipts show whether a dispatch finished; `cmo outcome` records
whether the work was actually good. After every implementation gate and every
review or judge check, log the verdict against the receipt's `dispatchId`:

```bash
cmo outcome d-8f3a1c9e02b4 --verdict approved --rounds 1
cmo outcome d-41c09ab77e12 --verdict confirmed --note "caught missing boundary check"
cmo report --quality --since 7d          # or add --json
```

Supported `--verdict` values are `approved`, `fixed`, `rejected` and `blocked`
for implementers (with `--rounds <N>` when fixes took multiple rounds), and
`confirmed`, `false-positive` and `missed` for reviewers and judges. Outcomes
append to `~/.cache/cross-model-orchestrate/outcomes.jsonl`; an unknown
`dispatchId` is refused unless `--force`, and forced orphans are counted
separately so imported history never inflates a provider's stats.
`cmo report --quality` joins outcomes to local receipts and summarizes `n`,
first-round approvals, mean rounds, blocked runs and reviewer `confirmed`,
`false-positive` and `missed` counts for each `provider / role / model`.

Neither report changes config on its own. Same posture as `doctor`: measure,
recommend, let a person decide.

## Keeping the CLIs current

`doctor` never changes anything — it is a diagnostic, and `codex` and `claude`
are not our packages. `cmo update` does, explicitly:

```text
$ cmo update
would run:
  plan   codex                    npm install -g @openai/codex@latest
  plan   claude                   claude update
  plan   cross-model-orchestrate  npm install -g cross-model-orchestrate@latest

Nothing has changed. Re-run with --yes to execute.
```

Four guards make it safe to hand to a fleet:

- **Refuses while dispatches are running on this machine.** Swapping the codex
  binary mid-run can change model ids underneath agents that already resolved
  them. `--force` if you know what those agents are doing.
- **Only runs a command it detected.** npm global tree → npm; Homebrew cellar →
  brew; Claude → its own updater. An install it does not recognize is skipped
  with the path, not guessed at — sending a Homebrew user to `npm install -g`
  leaves two copies and a PATH puzzle.
- **Prints the plan and stops.** Nothing executes without `--yes`.
- **Reports before → after**, so "updated" means a version changed rather than
  that a command exited 0.

`--clis-only` upgrades only the vendor CLIs, leaving this package alone.

## Auditing a fan-out

The shim is a language model asked not to do the task itself, and it does not
always comply — on a measured 12-agent run, four agents never called the
dispatcher and answered from their own weights instead. A self-written answer
looks exactly like a dispatched one, so the only reliable check is counting
receipts:

```text
$ cmo audit --since 30 --expected 12 --human
dispatches in the last 30 min: 8
  codex         5   gpt-5.6-terra x5
  antigravity   3   gemini-4-carbon x3

share: codex 63% · claude 0% · antigravity 38%
reviews: 3 cross-vendor, 0 same-vendor

WARNING: 4 of 12 subagents left NO receipt —
they never called the dispatcher and answered by themselves.
```

Every real dispatch writes one line to
`~/.cache/cross-model-orchestrate/dispatches.jsonl` with a random id that also
comes back in the envelope as `dispatchId`. `--since` accepts plain minutes
(`30`) or durations (`30m`, `2h`, `1d`), matching `cmo report --since`. The gap
between agents you spawned and receipts on record is the number that never ran.

## Before a real release

[`COMMERCIALIZATION_GATE.md`](COMMERCIALIZATION_GATE.md) is the checklist to come
back to before this goes to people who will run it unattended on their own
machines and their own subscriptions. It holds the eight validation phases, which
version each last passed against and what has drifted since.

Its gate is one sentence, and it is currently unmet: *every phase passed against
the version you are actually publishing, not an earlier one.*

## Releasing

Published via npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
from `.github/workflows/release.yml` — GitHub mints a short-lived OIDC token at
run time, so no npm credential exists in this repo, in Actions secrets or on
any machine.

```bash
npm version patch
git push --follow-tags origin main
```

The tag push runs the tests and publishes. The workflow refuses to publish if
the tag and `package.json` disagree.

## License

MIT.

## Acknowledgments

The plan-driven pattern (the plan format, the per-task implement and review
loop, red-green test evidence, "no evidence, no done" and how review findings
are acted on) is adapted from the `subagent-driven-development`,
`writing-plans`, `test-driven-development`, `verification-before-completion` and
`receiving-code-review` skills in
[obra/superpowers](https://github.com/obra/superpowers), MIT licensed,
copyright (c) 2025 Jesse Vincent. The text here is rewritten for cross-vendor
dispatch rather than copied.
