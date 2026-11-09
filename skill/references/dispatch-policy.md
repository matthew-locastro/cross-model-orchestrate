# Dispatch policy

The full rubric behind `cmo plan`. Read this when a decision surprises you, when
you want to argue with one, or before pinning a model by hand. Implementation
and tests live in the cross-model-orchestrate package.

## The decision, in two halves

**Three factors set the tier.** Live subscription headroom sets the provider.

| factor | weight | flag | what it measures |
| --- | --- | --- | --- |
| complexity | 45% | `--complexity 1..5` | reasoning depth, independent of size |
| length | 30% | `--length xs\|s\|m\|l\|xl` | how much work and output it produces |
| role | 25% | `--role <role>` | what kind of work it is |

```
weight = 0.45·((complexity−1)/4) + 0.30·length + 0.25·role

weight < 0.30 → fast
weight < 0.62 → balanced
otherwise     → frontier
```

The tier→model map is configuration, not code — a different Codex plan or Claude
account exposes a different model list. `cmo doctor` prints the resolved map and
flags any model ID your account does not actually have. Override it in
`~/.config/cross-model-orchestrate/config.json`, or per-tier with
`CMO_CODEX_FRONTIER` / `CMO_CLAUDE_BALANCED` / … environment variables.

Role weights, cheapest first:

| role | weight | use for |
| --- | --- | --- |
| `mechanical` | 0.05 | renames, formatting, fixtures, file moves |
| `research` | 0.25 | read the repo or the web and report; volume, not depth |
| `implement` | 0.55 | write code that has to work |
| `review` | 0.70 | find what is wrong with someone else's work |
| `synthesis` | 0.75 | fold many results into one coherent answer |
| `judge` | 0.80 | score against a rubric and reject |
| `architecture` | 0.95 | decide the shape — the expensive thing to get wrong |

Claude Fable is deliberately outside the tier map: Anthropic documents it as
substantially more consumption-intensive than Sonnet, so it is reachable only
via `--pin claude --model fable`, and only when you can say why.

## Provider selection

Strict precedence:

1. **`--pin`** — you forced it.
2. **`--independent-of <vendor>`** — cross-model review. Only the other vendors
   are candidates, ranked against each other as usual. If none of them can run
   (spent, not installed, Grok not signed in) the call **degrades** to a fresh agent on
   the producer's vendor, marks the result `independence: same-vendor`, raises a
   tier, and warns the agent that it shares the producer's priors. That is
   strictly better than no review — a same-vendor independent grader rejected 38
   of 57 candidates on the run this tool came from. The hazard was never that a
   same-vendor verdict is weak; it is that an *unlabelled* one is
   indistinguishable from a real cross-vendor verdict. `--strict-independence`
   restores the refuse-instead behaviour.
3. **Can it run** — a provider at ≥95% used, or flagged `rate_limit_reached`, is
   not a candidate; nor is one whose CLI is missing; nor Grok unless its CLI
   reports a subscription (OAuth) sign-in; nor Codex for `--web` work, because
   its sandbox has no network.
4. **Least-used wins.** Among providers that can run, pressure (below) is the
   dominant score:

   ```text
   headroom = headroomWeight × (100 − pressure) / 100     default weight 40
   ```

   A provider whose pressure is at least `powerGap` points (default 20) below
   every other provider that is actually competing gets `powerBonus` (default
   25). The reason names the gap, for example
   `power-use: grok is 61 points less used than codex`. State penalties still
   apply on top: tight −15, critical −40.
5. **Orchestrator reserve.** `orchestrator.vendor` (default `claude`) is the
   vendor driving the run, so every dispatch costs it `penalty` points
   (default 30). At or above `reserveAt` pressure (default 60) it is placed
   below every usable alternative — still above anyone who cannot run — and
   the reason says
   `claude reserved for the orchestrator (pressure 62% ≥ 60%)`. It is not a
   power-use competitor in that state. It is still chosen when nothing else
   can run, including a cross-vendor review only it can serve. Set `vendor`
   to `null` when a cron job or a shell script is the driver and no Claude
   session needs the window kept.
6. **Affinity** — Grok gets 25 points for `research` and for `--web` work: it
   searches and fetches live URLs. That wins those roles while Grok is healthy
   and no other subscription is differentially idle (a power-use gap, or a
   tight window of Grok's own, still takes the work away). Configurable as
   `affinity.grok` (`roles`, `web`, `points`).
7. **Tie-break** — `preference.first`, Codex by default, worth
   `preference.weightPoints / 10` score points (default 2.5). It decides a
   near-tie and nothing wider. `CMO_PREFER=claude` flips which side of the tie
   wins. It does not protect Claude's window; the reserve does.

### Pressure: usage weighed against time to reset

Every band and every comparison below acts on **pressure**, not on the raw
percentage. A raw number says how much is used; routing needs to know how long
what is left has to last. For each window:

```text
runway r = (fraction of budget left) / (fraction of the window's time left)

r = 1   on even pace                      pressure = raw
r < 1   the remainder must be rationed    pressure = 100 − (100 − raw) · r   (capped at 94)
r > 1   the reset beats even-pace use     pressure = raw / √r
raw ≥ 95                                  never adjusted
```

| window | raw | time to reset | allowance vs even pace | pressure | band |
| --- | --- | --- | --- | --- | --- |
| weekly | 80% | 5 days | 4%/day vs 14.3%/day | 94% | critical |
| weekly | 80% | 12 hours | 40%/day vs 14.3%/day | 48% | ok |
| weekly | 50% | 6.5 days | 7.7%/day vs 14.3%/day | 73% | tight |
| weekly | 30% | 4.9 days (on pace) | 14.3%/day vs 14.3%/day | 30% | ok |
| 5-hour | 70% | 4 hours | 7.5%/hour vs 20%/hour | 89% | critical |
| 5-hour | 70% | 20 minutes | 90%/hour vs 20%/hour | 33% | ok |
| 5-hour | 97% | 2 minutes | — | 97% | exhausted |

A provider's pressure is that of its most-pressured window, so the 5-hour and
weekly windows of both vendors are balanced together. Three consequences worth
knowing:

- **A weekly squeeze outranks a 5-hour blip.** Raw percentages called "codex 80%
  weekly, five days left" and "claude 70% of five hours, twenty minutes left"
  the same thing. Pressure sends the work to Claude and stretches Codex's week.
- **Pace alone never exhausts a provider.** The cap at 94 keeps a rationed
  window in the candidate list on a cheaper tier, because budget that exists
  can still be spent on what only that vendor can do — a cross-vendor review.
  Only a raw reading ≥95%, or an explicit rate-limit error, removes it.
- **Budget about to expire is room.** Unused weekly budget hours before its
  reset is the cheapest quota there is; pressure falls, so the least-used
  score treats it as room. A subscription that is still differentially idle
  keeps the work — power-use is computed on this pressure, not on the raw
  percentage.

Pace is computed at decision time from the window's reset time, never cached. A
window whose reset time is missing, already in the past (a stale reading), or
further away than the window is long (clock skew, or a reset paired with the
previous window's usage) falls back to its raw percentage: inconsistent data
must not be turned into scarcity. `cmo limits --human` prints the pace line per
window; `cmo limits` (JSON) carries `pressurePercent`, `pressureWindow` and a
`pace` array per provider; `cmo plan` shows the binding window in its `why`.

### Headroom bands

Bands of pressure, as defined above.

| band | pressure | effect |
| --- | --- | --- |
| ok | <65% | normal |
| tight | ≥65% | deprioritised by 15 points, on top of the headroom term |
| critical | ≥85% | model downgraded one tier to stretch the window |
| exhausted | ≥95% or hard-blocked | not a candidate at all |
| unknown | probe failed | treated as usable — a broken meter never stops a run |

## Token-efficiency corrections

Applied after the weighted tier. Each one appears in the decision's `notes`.

| correction | when | why |
| --- | --- | --- |
| drop off frontier | `--context-tokens` ≥120k and complexity ≤3 | bulk reading does not need an expensive model, and skimming 250k tokens on a frontier tier is the most common way a fan-out wastes quota |
| drop one tier | schema-bound `xs` output, not a judge | the schema constrains the answer more than the model does |
| raise off fast | role `judge` or `review` | a cheap grader is a generous grader, and a generous grader silently ships the work |
| raise off fast | `--write` at complexity ≥3 | an agent editing the tree needs enough capability not to leave it broken |
| downgrade | chosen provider in the critical band | the last of a window goes further on a cheaper model — **judges are exempt**, since downgrading the grader defeats the purpose |

## Worked examples

```
mechanical · 1 · xs                          → codex gpt-5.6-luna     (even headroom: tie-break)
research   · 2 · l  · 180k context           → codex gpt-5.6-terra    (grok not signed in)
implement  · 3 · m  · --write                → codex gpt-5.6-terra    (even headroom: tie-break)
implement  · grok 6% · codex 67% · claude 60% → grok, power-use; claude reserved
implement  · codex 10% · grok 50% · claude 30% → codex, power-use
implement  · codex 40% · grok 45% · claude 5%  → claude (the gap beats the penalty)
implement  · codex 40% · grok 45% · claude 70% → codex, never claude
implement  · codex and grok exhausted, claude 72% → claude, last resort
judge      · 4 · s  · --independent-of codex → claude sonnet, medium  (grok not signed in)
architecture · 5 · l                         → codex gpt-5.6-sol
judge      · 1 · xs                          → codex gpt-5.6-terra  (never fast)
implement  · 3 · m  · codex at 99%           → claude sonnet (grok fallback if signed in)
research   · 2 · s  · grok signed in, windows level → grok grok-4.7, low
research   · grok healthy, codex 15%, claude 20%, grok 25% → grok, on affinity
research   · 1 · xs · --web, grok signed out  → claude haiku   (never codex: no network)
review     · 3 · s  · --independent-of codex, grok healthy, claude ≥60% → grok, never claude
review     · 3 · s  · --independent-of codex, claude at 99%, grok signed out → codex, DEGRADED
```

Grok maps every tier to `grok-4.7` and varies only `--reasoning-effort`
(low / medium / high). `grok-4.7-build-fast` is not a cheap tier — the CLI lists
it as "2x the price" — so it is reachable only through `--model`.

Print the whole table any time with `cmo selftest` — it uses your configured
model IDs, so it doubles as a check that an override landed.

## Where the headroom numbers come from

**codex** — local, zero cost. Every `codex exec` writes a session rollout under
`~/.codex/sessions/YYYY/MM/DD/`, and each turn records the rolling-window
snapshot. The reading therefore refreshes itself after every codex subagent.

Do not assume `primary` is the 5-hour window: codex-cli 0.149 emits the
**weekly** window as `primary` with `secondary: null`, while older builds put
the 5-hour window there. The reader classifies by `window_minutes`, and any code
that keys off the field name will mislabel the current shape.

**claude** — `GET https://api.anthropic.com/api/oauth/usage` with the OAuth
token from `~/.claude/.credentials.json`. No inference, so no token cost. Claude
Code does not persist the rolling-window snapshot locally, so there is no
offline alternative.

On macOS the credentials are in the Keychain and that file never exists, so the
reader falls back to the CLI: one minimal `claude -p --output-format stream-json`
turn, whose `rate_limit_event` carries the same two windows. About a thousand
input tokens, reused for two minutes.

**grok** — two JSON-RPC calls to a short-lived `grok agent --no-leader stdio`,
the same account queries the TUI's `/usage` panel makes. No session, no model
call:

- `_x.ai/billing` → `creditUsagePercent` and `currentPeriod` (type
  `USAGE_PERIOD_TYPE_WEEKLY`, start, end). One weekly window, resetting at the
  period end. `isUnifiedBillingUser: true` means the allowance is shared with
  the Grok apps.
- `_x.ai/auth/check_subscription` → `authenticated`, `auth_mode` (`Oidc` for a
  `grok login` session), `subscription_tier`. This is the billing gate: only an
  OIDC/OAuth sign-in with a tier is routable. A signed-out reading is re-checked
  every 15 seconds, a good one every 60.

The probe and every grok dispatch run with `XAI_API_KEY` and
`GROK_CODE_XAI_API_KEY` removed and `GROK_DISABLE_API_KEY_AUTH=1` set, so the
CLI has no key to fall back to and would refuse one anyway. A dispatch's own
stream then names its auth source (`apiKeySource`) on its first line; anything
but `oauth` is killed there and marks Grok unroutable machine-wide.

### Contention

Both readings live in one machine-wide file, `~/.cache/cross-model-orchestrate/state.json`,
locked and written atomically so concurrent orchestrators cannot clobber each
other. Freshness windows are deliberately short — 10s codex, 45s claude — and
single-flighted: a hundred simultaneous dispatches produce one probe, not a
hundred. `--refresh` forces one.

Short freshness is still not enough on its own, because **the vendor's number is
a lagging indicator**. It describes spend that has already been billed and says
nothing about agents other orchestrators launched moments ago. Two runs both
read 80%, both see room, and both sail through the limit.

So every dispatch **reserves** against its provider for the duration of the call
and releases afterwards. Effective headroom is what the vendor reported plus what
this machine has committed but not yet been billed for, and that is the number
`decide()` sees. Reservations carry a pid and a lease, so a crashed run cannot
hold headroom hostage — entries are collected once the process is gone or the
lease expires.

The per-agent cost of a reservation starts at a deliberately conservative
configured default (1.0 percentage point) and is replaced by a measured median
once there is evidence: every Codex dispatch rewrites its session rollout, which
gives a free before/after sample. Overestimating stops a run early with its work
cached; underestimating gets it killed mid-flight. Prefer the former.

## Verifying the live path

The test suite is entirely offline. The two real CLIs need a hand check after
a codex or Claude Code upgrade, because their flags are the part that drifts:

```bash
cmo doctor                                  # CLIs, auth, model IDs, install

printf '{"type":"object","required":["answer"],"properties":{"answer":{"type":"string"}}}' > /tmp/s.json
echo "What is 17 * 23? answer field only." \
  | cmo run --role mechanical --complexity 1 --length xs \
      --pin codex --schema /tmp/s.json --timeout 240
echo "Reply with the single word: pong" \
  | cmo run --role mechanical --complexity 1 --length xs \
      --pin claude --timeout 240 --no-failover
```

Both must return `"ok": true` with a populated `usage` block. A failure here is
almost always a renamed flag, not a broken policy.

One more that only a live run can prove — a stopped dispatcher must take its
vendor process with it, or a cancelled run carries on billing:

```bash
cmo run --dispatch /tmp/slow-task.md &    # something that takes a while
CMO=$!
sleep 12 && pgrep -x codex | wc -l        # >0, and one reservation is held
kill -TERM $CMO
sleep 4  && pgrep -x codex | wc -l        # back down, reservation released
```

SIGKILL is not covered and cannot be — nothing runs on SIGKILL. SIGTERM and
SIGINT are the ordinary ways a run stops, and those release cleanly.

> **Kill by PID, never by pattern.** `pgrep -f 'codex exec'` matches the shell
> you typed it in, and `pgrep -x codex` matches every Codex session on the
> machine — including ones you did not start. Capture the PID when you launch
> the thing. Both mistakes were made while testing this, and the second one
> killed unrelated sessions.
