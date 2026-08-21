# Workflow patterns

Shapes for the script you write in step 3. Compose them; this is not a menu of
four options.

## The default: pipeline with a cross-model judge

Each item walks every stage on its own schedule, and the judge runs on the
vendor that did not generate the work.

```js
export const meta = {
  name: 'generate-and-grade',
  description: 'Generate N candidates per slot, graded by an independent vendor',
  phases: [{ title: 'Generate' }, { title: 'Judge' }],
}

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['winner', 'score', 'promote', 'corrections'],
  properties: {
    winner: { type: 'integer' },
    score: { type: 'integer' },
    promote: { type: 'boolean' },
    corrections: { type: 'string' },
  },
}

const dispatch = (meta, task) => [...meta, 'TASK', task].join('\n')

const results = await pipeline(
  slots,
  (slot) => parallel([1, 2, 3].map((take) => () => agent(
    dispatch(
      ['DISPATCH', 'role: implement', 'complexity: 3', 'length: m',
       `cwd: ${repoRoot}`, 'timeout: 900'],
      briefFor(slot, take),
    ),
    { agentType: 'codex-runner', label: `gen:${slot.id}#${take}`, phase: 'Generate' },
  ))),
  (takes, slot) => agent(
    dispatch(
      ['DISPATCH', 'role: judge', 'complexity: 4', 'length: s',
       'independent-of: codex',            // codex generated these
       `cwd: ${repoRoot}`, 'timeout: 600'],
      gradePrompt(slot, takes.filter(Boolean)),
    ),
    { agentType: 'codex-runner', label: `judge:${slot.id}`, phase: 'Judge', schema: VERDICT },
  ),
)
```

`independent-of: codex` sends the judge to Claude even though the shim is
`codex-runner` — the shim dispatches, the policy decides.

Note that **every** stage here goes through the shim, including the generators.
That is the default, not a flourish: a workflow that reaches for a plain
`agent()` out of habit spends Claude on work Codex could have done, and the
orchestrator needs that window for itself. Slot A can be in the
judge stage while slot B is still generating; a stall costs one slot, not the
run.

## Where a barrier is genuinely correct

Only when the next step needs the whole set at once.

```js
const winners = (await pipeline(slots, generate, judge)).filter(Boolean)

// A corpus-wide review really does need every finished item. This is the one
// place a barrier earns its latency.
const cohesion = await agent(cohesionPrompt(winners), { schema: RESHOOT_LIST })
const reshot = await pipeline(cohesion.slots, generate, judge)
```

Not a barrier: "I need to flatten the array first." Do that inside a stage.

## Adversarial verification, across vendors

Redundancy catches noise; *diversity* catches blind spots. Give each verifier a
distinct lens, and put at least one on the other vendor.

```js
const LENSES = [
  { lens: 'correctness', independentOf: 'codex' },
  { lens: 'security',    independentOf: 'codex' },
  { lens: 'does it reproduce', independentOf: 'claude' },
]

const votes = await parallel(LENSES.map((l) => () => agent(
  dispatch(
    ['DISPATCH', 'role: review', 'complexity: 4', 'length: s',
     `independent-of: ${l.independentOf}`, `cwd: ${repoRoot}`, 'timeout: 600'],
    `Try to REFUTE this finding through the ${l.lens} lens. Default to refuted:true if uncertain.\n\n${finding}`,
  ),
  { agentType: 'codex-runner', phase: 'Verify', schema: VERDICT },
)))

const survives = votes.filter(Boolean).filter((v) => !v.refuted).length >= 2
```

## Budget-aware fan-out

Scale the run to what is actually left. Read headroom once at the top, in the
orchestrator, and pass the numbers in as `args` — workflow scripts have no shell
and cannot run `cmo` themselves.

```js
// args = { codexPercent: 12, claudePercent: 27 }
const headroom = 100 - Math.min(args.codexPercent, args.claudePercent)
const WIDTH = headroom > 60 ? 3 : headroom > 30 ? 2 : 1   // takes per slot
log(`generating ${WIDTH} candidate(s) per slot — ${headroom}% headroom`)
```

Announce anything you dropped. A silent cap reads as "covered everything" when
it did not.

## Loop until dry

For unknown-size discovery, keep going until K consecutive rounds find nothing
new. Dedupe against everything *seen*, not everything *confirmed* — otherwise
judge-rejected findings reappear every round and the loop never converges.

```js
const seen = new Set(), confirmed = []
let dry = 0
while (dry < 2) {
  const found = (await parallel(FINDERS.map((f) => () => agent(f.prompt, { schema: FINDINGS }))))
    .filter(Boolean).flatMap((r) => r.findings)
  const fresh = found.filter((b) => !seen.has(key(b)))
  if (!fresh.length) { dry += 1; continue }
  dry = 0
  fresh.forEach((b) => seen.add(key(b)))
  confirmed.push(...await verifyAcrossVendors(fresh))
}
```

## Things that end runs

**A barrier around a stalled agent.** One subagent waiting on an interactive
confirmation held a `parallel()` barrier for 91 minutes while two hundred
finished agents idled behind it. Same stall in a `pipeline()` costs one item.
Pass the non-interactive flag, pre-answer the prompt, or do not give it the
tool — `cmo run` does all three and kills on a wall clock.

**Prose where the script expected a verdict.** Anything the script branches on
gets a schema. Without one, a differently-phrased refusal reads as approval.

**A judge that made the thing.** A generator asked to grade its own output
approves it. Not vanity — the context that produced the choices is being asked
to find fault with them.

**Grading the file instead of the page.** Every asset can pass on its own and
still be destroyed by the thing that assembles them. The last stage opens the
real artifact and looks at it.

**Discovering the usage limit by being killed.** Re-check headroom between
phases. Stopping with 40 steps cached and a stated reset time is a good outcome.

## Resume

Every `agent()` call is cached on `(prompt, options)`. A stopped run replays its
unchanged prefix in seconds and executes only what is new or edited — relaunch
with `{ scriptPath, resumeFromRunId }`. This is what makes a nine-hour run
survivable, and it is why hitting a usage limit is an interruption rather than a
loss. Edit stage four and re-run the whole script; stages one to three cost
nothing the second time.
