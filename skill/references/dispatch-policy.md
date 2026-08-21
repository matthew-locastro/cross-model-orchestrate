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
2. **`--independent-of <vendor>`** — cross-model review. The other vendor is the
   only candidate, and there is no fallback: if that side is out of headroom the
   call **defers**. A review that quietly self-judges is worse than a review
   that did not happen.
3. **Headroom** — a provider at ≥95% used, or flagged `rate_limit_reached`, is
   not a candidate.
4. **Preferred vendor first** — Codex by default. Deliberate load-balancing: the
   orchestrator is usually itself a Claude session, so Claude's window is already
   being consumed by the run doing the dispatching. The preference is worth
   `preference.weightPoints` (default 100) percentage points of headroom, so the
   other side only wins when it is meaningfully emptier. Flip it with
   `CMO_PREFER=claude` or `preference.first` in the config file — worth doing if
   you drive this from a shell script or cron rather than from a Claude session.

### Headroom bands

| band | used | effect |
| --- | --- | --- |
| ok | <65% | normal |
| tight | ≥65% | deprioritised; the other provider wins ties |
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
mechanical · 1 · xs                          → codex gpt-5.6-luna
research   · 2 · l  · 180k context           → codex gpt-5.6-terra
implement  · 3 · m  · --write                → codex gpt-5.6-terra
judge      · 4 · s  · --independent-of codex → claude sonnet, medium
architecture · 5 · l                         → codex gpt-5.6-sol
judge      · 1 · xs                          → codex gpt-5.6-terra  (never fast)
implement  · 3 · m  · codex at 99%           → claude sonnet, no fallback
review     · 3 · s  · --independent-of codex, claude at 99% → DEFER
```

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

Cached in `~/.cache/cross-model-orchestrate/limits.json` — 60s codex, 5 minutes
claude — so a large fan-out shares one probe. `--refresh` bypasses it.

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
