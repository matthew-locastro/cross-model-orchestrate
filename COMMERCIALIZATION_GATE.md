# Commercialization gate

**Come back to this before any real release.** Not before a patch that fixes a
typo — before the release where strangers start running this unattended on their
own machines and their own subscriptions.

The gate is one sentence, and it is the one that is currently unmet:

> Every phase below passed against **the version you are actually publishing**,
> not an earlier one.

Phases 00–05 were run and passed. They were run against **0.1.8 – 0.1.11**. The
shipping version is **0.1.18**. Seven releases of drift sit between the evidence
and the artifact, and some of that drift lands directly on the code paths those
phases exercise. That is the whole reason this file exists: the work was done,
and it no longer proves what it proved.

---

## Status at a glance

| Phase | What it buys | Passed against | Re-run needed |
|---|---|---|---|
| 00 Freeze the build | You are testing what you publish | 0.1.8 | **Yes** — cheap, always first |
| 01 One real fan-out | The core product claim | 0.1.8 | **Yes** |
| 02 Make it fail on purpose | Failure paths are real, not described | 0.1.8 | **Yes** |
| 03 Width and contention | Sixteen real agents on one ledger | ~0.1.8–0.1.11 | **Yes** |
| 04 Interrupt it | Resume is a real property | ~0.1.11 | **Yes** |
| 05 Two real machines | The fleet story | 0.1.11 + lease test | Probably — see drift |
| 06 Somebody else's computer | The documentation | **never run** | **Yes — needs a second person** |
| 07 Soak | Time | running since 2026-08-22 | Needs 3 clean consecutive days |
| 08 Ship | — | — | Blocked on all of the above |

---

## The drift ledger

What landed after the phases were validated, and what it invalidates.

| Release | Change | Invalidates |
|---|---|---|
| 0.1.12–0.1.13 | doctor: actionable model-unavailable advice, install-method-aware upgrades | 00 (doctor is 00's gate) |
| 0.1.14 | `cmo update` — mutates the vendor CLIs | 00, 03 (its in-flight guard reads the same ledger) |
| 0.1.15 | doctor: stale model cache, shadowed binaries on PATH | 00 |
| 0.1.16 | `cmo report` — reads the dispatch log back as findings | 07 (this is the soak's instrument) |
| 0.1.17 | a dark meter outranks every other finding | 07 |
| 0.1.18 | **an expired Claude OAuth token repairs itself** | **00, 01, 02, 03** |
| 0.1.19 | **the classifier no longer greps the agent's work product** | **01, 02** |

0.1.18 is the one to take seriously. It puts a **subprocess spawn inside the
limits probe** — the probe that 00 gates on, that 01 depends on for every routing
decision, that 02 deliberately corrupts with `markExhausted`, and that 03 hammers
from sixteen concurrent writers. It is rate-limited to one attempt a minute per
process and only fires on an already-lapsed token, so under normal conditions it
never runs. "Under normal conditions it never runs" is exactly the property that
wants a real fan-out to confirm rather than a unit test.

---

## Run it in this order

### The soak conflict — read before starting

**Phase 02 injects deliberate failures** (exhausted meters, killed agents) and
they land in the same dispatch log the soak reads. Run 02 during the soak and day
N of the soak reports a failure rate that is an artifact of testing.

So either:

- **finish the soak first**, then run 00–05 as a block, or
- **restart the soak** after the phases, and treat everything before the restart
  as discarded.

Phase 01 is exempt — it is an ordinary fan-out, indistinguishable from real
traffic. It can run any time.

### 00 — Freeze the build · ~5 min

Every later phase is worthless if you are testing a different build than you
think you are. This already bit us once: the global install sat at 0.1.5 while
the registry was on 0.1.6, and a feature appeared missing that had shipped an
hour earlier.

```bash
npm install -g cross-model-orchestrate@latest --prefer-online
node -p "require('$(npm root -g)/cross-model-orchestrate/package.json').version"
npm view cross-model-orchestrate version --prefer-online
cmo doctor
mkdir -p ~/cmo-evidence && cmo limits --refresh > ~/cmo-evidence/00-baseline.json
```

Gate:
- Installed version equals registry version.
- `cmo doctor` reports zero failures.
- Both providers return a reading. If either says unavailable, **stop** — the
  meter is the thing under test.

> Check the version in **the tree the work actually uses**, not the first one on
> `PATH`. On the second box the soak runs as a different user with its own npm
> prefix; a global install as root landed somewhere that user never looks, and
> `cmo` kept running 0.1.17 while root reported 0.1.18.

### 01 — One real fan-out · ~30 min · the core claim

Everything else proven is a single dispatch. The product claim is a fan. Run it
from a directory with nothing precious in it, on a **fresh** Claude Code session
so the skill loads clean.

```bash
mkdir -p ~/cmo-test && cd ~/cmo-test && touch .t0
claude --model opus --effort high
```

Then, as the first thing you type:

```
/cross-model-orchestrate Write six short technical definitions for a
glossary: idempotent, race condition, backpressure, memoization, tail
latency, eventual consistency. Each 40-60 words, plain English, with one
concrete example. Produce two independent candidate versions of each,
then have an independent grader score both and promote one. Write the
promoted set to glossary.md. Tell me which vendor and model every
subagent ran on.
```

Evidence:

```bash
cd ~/cmo-test
find ~/.codex/sessions -name 'rollout-*.jsonl' -newer .t0 | while read f; do
  grep -o '"model":"[^"]*"' "$f" | head -1 | cut -d'"' -f4
done | sort | uniq -c

cmo audit --expected 12     # receipts vs what you believe you dispatched
```

Gate:
- Codex dispatches > 0. Zero means nothing reached Codex and the shim is broken.
- The **majority** of subagents ran on Codex.
- Every review reports its independence, cross-vendor or same-vendor.
- No `DISPATCH_FAILED` lines.
- The grader rejected something. A grader that promotes every candidate is not
  grading.
- `cmo audit --expected N` shows no gap. A gap is the shim answering by itself,
  which looks identical to a real dispatch without the receipt.

Watch the clock, not just the output. Note wall-clock against summed agent time.
Roughly equal means the work ran sequentially and the fan-out bought nothing —
a finding, not a failure.

### 02 — Make it fail on purpose · ~20 min

Every failure path is proven by unit test and by plan, not by a real agent
hitting it. Inject the states rather than meeting them at 3am. Each block uses a
throwaway ledger so real headroom is untouched.

```bash
D=$(mktemp -d); SRC=$(npm root -g)/cross-model-orchestrate/src

# a. cross-model review degrades when the required vendor is spent
CMO_CACHE_DIR=$D node --input-type=module -e "
import { markExhausted } from '$SRC/limits.mjs'; await markExhausted('claude');"
CMO_CACHE_DIR=$D cmo plan --role review --complexity 3 --length s \
  --independent-of codex --human

# b. and refuses instead, when told to
CMO_CACHE_DIR=$D cmo plan --role review --complexity 3 --length s \
  --independent-of codex --strict-independence --human

# c. a real degraded review actually executes
echo "Grade this sentence for clarity: 'The thing was done by the system.'" \
  | CMO_CACHE_DIR=$D cmo run --role review --complexity 3 --length s \
    --independent-of codex --cwd . --timeout 300

# d. a hung command dies on the clock instead of holding a slot
echo "Run: read -p 'press enter' x" | cmo run --role mechanical \
  --complexity 1 --length xs --cwd . --timeout 60
```

Gate:
- **a.** Falls back to Codex, prints `independence: same-vendor`, and lands a
  higher tier than the healthy case.
- **b.** Defers, and the reason names `--strict-independence`.
- **c.** Returns a verdict carrying `"independence": "same-vendor"`. Then confirm
  the handicap actually reached the model:
  `grep -l "INDEPENDENCE NOTICE" ~/.codex/sessions/**/rollout-*.jsonl`
- **d.** Killed at ~60s with `"failure": "timeout"` — not hanging, not silently
  empty.

The one that would hurt most: a degraded review that returns a verdict **without
the label**. That is the exact failure the design exists to prevent, and it would
look completely normal. Read the envelope, not the prose.

**Add for 0.1.18** — the auto-refresh path, which did not exist when 02 last ran:

```bash
# with a BACKUP of ~/.claude/.credentials.json, force the token expired,
# then confirm the meter heals itself rather than going dark
cmo limits --refresh | python3 -c "import json,sys; d=json.load(sys.stdin); \
print(d['claude']['available'], d['claude'].get('error'))"
```

Gate: `available` returns true within ~10s, and no dispatch is made against an
unread meter. With `claude` removed from `PATH`, the error must read
`auto-refresh could not run` — the failure is stated, not hidden.

### 03 — Width and contention · ~20 min

The ledger is locked, atomic and single-flighted, proven synthetically with
twelve concurrent writers. It has never met sixteen real agents with real
latency competing for the same file.

```bash
for i in $(seq 1 16); do
  ( echo "Reply with exactly: unit-$i" | cmo run --role mechanical \
      --complexity 1 --length xs --cwd . --timeout 300 \
      > ~/cmo-evidence/03-$i.json 2>&1 ) &
done
sleep 20 && cmo limits --human   # mid-flight, from a third shell
wait

python3 -c "import json,os;d=json.load(open(os.path.expanduser(
'~/.cache/cross-model-orchestrate/state.json')));print(len(d['reservations']),'left')"
```

Gate:
- Mid-flight, `cmo limits` shows in-flight agents and an effective figure above
  the reported one.
- All 16 return `"ok": true`.
- Reservations return to zero. Anything left is an orphan that will suppress
  dispatch for up to 30 minutes.
- Cost samples grew — the fleet learned something.

### 04 — Interrupt it · ~20 min

The resume cache is why hitting a usage limit is an interruption rather than a
loss. It is the single most-cited property of the whole approach.

1. Start a fan-out of a dozen units. Let roughly half finish.
2. Kill the orchestrator session outright — close it, do not ask it to stop.
3. Resume the workflow and watch what replays versus what re-runs.

Gate:
- Completed steps replay from cache in seconds, without re-dispatching.
- Codex rollout count does **not** jump by the number of replayed steps — that is
  how you know it cached rather than quietly redoing the work.
- No reservations orphaned by the kill (they carry a pid; the GC collects them).

> Kill by **PID**, never by pattern. `pgrep -f` matched its own shell three times
> during this work, and `pgrep -x codex` once killed seven live Codex processes
> including sessions that had nothing to do with the test.

### 05 — Two real machines · ~30 min

Fleet coordination is tested with two simulated boxes on one machine. That
validates the protocol and proves nothing about the network, the lease, or a box
that genuinely dies.

```bash
# on the always-on box
export CMO_FLEET_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '=+/')
cmo serve --host 0.0.0.0        # bind to the tailnet, not a public IP

# on each other box
export CMO_FLEET_URL=http://<tailnet-host>:7867
export CMO_FLEET_TOKEN=<the same token>
cmo doctor
```

Gate:
- `cmo doctor` on every box reports the coordinator reachable.
- A dispatch on box A is visible from box B, named by node and project.
- Kill box A mid-dispatch. Its reservation must expire **on the lease** rather
  than holding headroom forever — the one behaviour that cannot be tested on a
  single machine.
- Stop the coordinator: dispatches keep working and `cmo limits` warns the view
  is local only.

Scope it right: one coordinator per **account pair**. Boxes signed into different
Codex or Claude accounts are not competing for the same windows, and pointing
them at one coordinator makes them throttle each other over nothing.

### 06 — Somebody else's computer · ~15 min · needs a second person

**Never run.** The riskiest untested surface is a machine that has not had this
software on it since before it existed.

- Ideally **macOS** — the lock file, `process.kill(pid, 0)` liveness, and the npm
  prefix paths have only ever run on Linux.
- A different Codex plan, so `cmo doctor`'s model cross-check gets a real workout.
- Have them follow **only the published README**. Do not help. Write down every
  point where they had to ask.

Gate:
- Install → `cmo install` → `cmo doctor` green, with no intervention from you.
- First dispatch succeeds.
- Zero questions the README should have answered. Each one is a doc bug, not a
  user error.

### 07 — Soak · 3–5 days · passive

Daily driver for real work; let the rare paths find you. The bugs left need time
rather than cleverness: lease expiry under load, a window resetting mid-run, an
upgrade landing while agents are in flight.

Read it back with `cmo report --since 7d`, which ranks findings and names what
was measured for each.

| Signal | Where | What it would mean |
|---|---|---|
| Dark meter | `cmo report` (ranked first) | A provider's headroom is unreadable. Everything below it was computed against a reading that no longer exists. |
| Deferrals | run output | Correct if the meter was truly spent; a bug if it deferred with headroom. |
| Degraded reviews | `independence` field | Expected when Claude is tight. Re-grade when the window reopens. |
| Failovers | `failedOver: true` | Codex refused; check it was a real rate limit and not a misread error. |
| Orphan reservations | `state.json` | Should always be zero at rest. Anything else suppresses dispatch silently. |
| Token split | agent list | Codex should carry the bulk. If Claude does, phase 01's gate has regressed. |

> **The clock restarted at 2026-08-22 06:42 UTC.** Everything logged before that
> is contaminated by the classifier defect below: completed Codex runs were
> recorded as failures, so failure counts, retry rates, failover counts and the
> Codex share are all wrong in the same direction. Do not count those days.

Gate:
- Three consecutive days with no unexplained stall and no orphaned state.
- At least one real usage-limit event handled cleanly — the scenario the whole
  tool exists for, and one you cannot manufacture convincingly.

### 08 — Ship · ~10 min

Only after 01–07 pass **on the build you are actually publishing**.

- [ ] Tighten npm Publishing access to **require 2FA and disallow bypass tokens**.
      Trusted publishing does not need them, and it closes the credential class
      npm is deprecating. *(npmjs.com UI — operator action, cannot be automated.)*
- [ ] Re-read the README as a stranger. Every question from phase 06 should now
      be answered in it.
- [ ] Cut a release and confirm the published tarball carries provenance:
      `npm view cross-model-orchestrate@<v> dist.attestations`
- [ ] Post the message. Expect first reports within a day; keep 07's log going.

Gate:
- Every phase above passed against **this** version.
- `npm view cross-model-orchestrate version` matches the local build.

---

## The bug this file was written one day too early to include

Found 2026-08-22, after 00–05 had passed and while the soak was running. Worth
reading before trusting any earlier phase result.

`classifyFailure` decided what a dispatch's outcome was by running error regexes
over **stderr and stdout together**. An agent's stdout is its *work product*. An
agent writing web code emits `401`, `429` and `503` as content; any agent at all
emits three-digit numbers, and `5\d\d` matched every one of them from 500 to 599.

Two real dispatches ran to completion on Codex — 20 and 23 minutes, one of them
6.5M tokens, both ending in `task_complete` with a full final message in the
session rollout — and were discarded and re-run on Claude. One matched `429` and
`401` while building a storefront; the other matched `rate-limit` and `403` while
editing a test file. Both receipts read `error: "exit 0"`.

Three things make this the most instructive failure in the project so far:

- **It inverted the product's whole purpose.** The tool exists to move work onto
  Codex. This moved completed Codex work back onto Claude, and billed both.
- **It was invisible from inside.** Exit 0, empty stderr, a receipt saying
  failure. Read from outside, that is indistinguishable from a broken Codex CLI —
  and a 15-agent adversarial review was run entirely on Claude, its independence
  caveat blaming a CLI that was working perfectly.
- **The phases would not have caught it.** Phase 01's fan-out writes glossary
  definitions; phase 02's failure injection uses short, controlled prompts.
  Neither produces an agent that writes an HTTP status code. It needed real work.

**Add to phase 01's gate:** at least one agent whose output legitimately contains
`401`, `429`, `503` and a number in the 500s — have it write a fetch wrapper with
error handling — and confirm its receipt reads `ok: true`. Then check no receipt
in the run carries `error: "exit 0"`, which is the signature: clean exit, empty
stderr, failed anyway.

---

## "Which version is actually running" — check all four

Every staleness incident in this project has the same shape: the version you
check is not the version that runs. There are four independent places it can be
wrong, and phase 00 is only credible if all four agree.

1. **The global install**, from the account that does the work — not from root,
   not from your login shell. A different user has a different npm prefix.
2. **A project's `node_modules`.** A consumer repo that depends on this package
   may resolve its own copy, and a shim that prefers `node_modules/.bin` over
   `PATH` will run it. TermRoam sat on **0.1.1 for eighteen releases** this way:
   the caret range permitted the upgrade, nothing had reinstalled, and every
   dispatch from that repo silently ran a build with no receipts, no dispatch
   file (so the shim could drop `--independent-of` unnoticed), no signal
   handling, and the classifier that graded an agent by its own work product.
3. **The installed skill and subagent.** Symlinks into the global package track
   upgrades for free; `--copy` installs do not and must be re-run.
4. **A long-running `cmo serve`.** A coordinator started days ago holds the code
   it loaded at start. Before bouncing it — which briefly degrades the fleet to
   local-only and is not free while dispatches are in flight — check whether its
   code actually moved:

   ```bash
   git diff --name-only v<running-version>..HEAD -- src/server.mjs src/remote.mjs src/ledger.mjs
   ```

   Empty output means the process is functionally current; leave it alone. On
   2026-08-22 a coordinator running 0.1.11 code was byte-identical to 0.1.19's,
   because every change since had landed in `run`, `limits`, `audit`, `doctor`
   and `update` — none of which execute in the server loop.

---

## Releasing: the tag has to be annotated

`git push --follow-tags` pushes **annotated** tags only. A lightweight
`git tag v0.1.19` is silently left behind, the tag-triggered release workflow
never fires, and `npm view` keeps reporting the previous version while the commit
sits on `main` looking shipped. It looks exactly like a slow publish.

Either `git tag -a v<x> -m v<x>`, or push the tag explicitly:

```bash
git push origin v<x>
```

Confirm with `gh run list` that the **release** workflow ran, not just `ci`.

---

## If a dispatch is wrongly recorded as failed, the work may still exist

Worth knowing before anyone re-runs anything expensive. A Codex agent with write
access **edits the working tree as it goes**. When the dispatcher misjudges the
outcome, what is lost is the *report*, not the edits — the files are on disk, and
the orchestrator, believing it failed, re-dispatches the same task to the other
vendor, which then works on top of them.

So the recovery move is reconciliation, not repetition:

```bash
# the agent's own final message, from the session rollout
python3 - <<'EOF'
import json,glob
f=glob.glob('~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>*.jsonl')[0]
for line in open(f):
    e=json.loads(line); p=e.get('payload') or {}
    if p.get('type')=='task_complete': print(p['last_agent_message'])
EOF
```

Then diff that report against the tree and look for **double application** —
two implementations of the same change, one from each vendor. Both discarded
runs on 2026-08-22 turned out to have completed their file edits in full.

---

## Environment landmines found the hard way

Not part of the phases, but each one cost real time and each will recur.

- **An expired `GITHUB_TOKEN` in the environment shadows the good token in
  `gh` `hosts.yml`.** Plain `git push` fails with "Invalid username or token" on
  every repo while `gh auth status` shows a healthy login underneath. Unset it in
  the shell profile.
- **Two npm trees on one box.** The second VPS runs the soak as a different user
  with its own `~/.local` prefix; a global install as root upgrades a copy that
  user never sees. Always verify the version from **the account that runs the
  work**. `cmo doctor` warns about shadowed binaries — believe it.
- **Two Codex binaries on `PATH`** (`/usr/bin` vs `~/.local/bin`) silently pinned
  an old CLI and made `doctor` blame the wrong thing.
- **A stale `models_cache.json`** makes `doctor` report models as unavailable when
  the real problem is cache age. `doctor` now leads with that; one `codex exec`
  refreshes it.
- **Never chain a commit behind a grep of test output.** `grep -E "Tests "`
  matched the summary line regardless of pass or fail, and a failing test reached
  `main`. Gate on the exit code.

---

## If you only have an hour

Run **00, 01 and 02**. Those three cover the claims someone would actually be
burned by: that the fan-out reaches both vendors, and that a review which cannot
be cross-vendor says so.
