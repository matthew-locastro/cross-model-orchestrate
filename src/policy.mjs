// policy.mjs — which model runs this subagent, and on whose subscription.
//
// One pure function, `decide()`, so the choice is deterministic, inspectable and
// testable. The orchestrator never eyeballs a model name; it describes the task
// and reads back a decision with its reasoning attached.
//
// Three factors set the TIER, live subscription headroom sets the PROVIDER:
//
//   complexity (45%)  how much reasoning the task needs, 1..5
//   length     (30%)  how much work/output it produces, xs..xl
//   role       (25%)  what kind of work it is — a judge needs headroom a
//                     mechanical edit does not, at identical size
//
//   weight <  0.30 → fast
//   weight <  0.62 → balanced
//   otherwise      → frontier
//
// The tier→model map is CONFIG, not code: see config.mjs. A different Codex
// plan or Claude account exposes a different model list, so anything hardcoded
// here would be wrong on somebody else's machine.
//
// Provider selection, in strict precedence:
//
//   1. pin              — caller forced it
//   2. independentOf    — adversarial review MUST run on the other vendor
//   3. headroom         — an exhausted provider is not a candidate
//   4. preferred vendor — default codex, because the orchestrator is usually
//                         itself a Claude session, so Claude's window is already
//                         being spent by the run doing the dispatching
//
// Token efficiency is not a fourth weight; it is a set of corrections applied
// after the tier is set (see `applyEfficiency`). Bulk reading is cheap work on
// an expensive model, and that is the most common way a fan-out wastes quota.

import { loadConfig, TIERS } from './config.mjs';

export { TIERS };

export const BINARIES = { codex: 'codex', claude: 'claude' };

export const ROLES = {
  mechanical: 0.05, // renames, formatting, fixture generation, file moves
  research: 0.25, // read the repo/web and report; volume, not depth
  implement: 0.55, // write code that has to work
  review: 0.70, // find what is wrong with someone else's work
  judge: 0.80, // score against a rubric and reject — must not be generous
  architecture: 0.95, // decide the shape; the expensive thing to get wrong
  synthesis: 0.75, // fold many results into one coherent answer
};

export const LENGTHS = { xs: 0.05, s: 0.25, m: 0.5, l: 0.8, xl: 1 };

/** Headroom bands, from config (defaults live in config.mjs). */
export function pressure() {
  return loadConfig().pressure;
}

export function providerState(limits, bands = pressure()) {
  if (!limits || limits.available !== true) {
    // A dead probe must not stop the run. Unknown means usable.
    return { state: 'unknown', percent: null, resetsAt: null };
  }
  const percent = typeof limits.worstPercent === 'number' ? limits.worstPercent : 0;
  const resetsAt = limits.nextResetAt ?? null;
  if (limits.hardBlocked || percent >= bands.exhausted) {
    return { state: 'exhausted', percent, resetsAt };
  }
  if (percent >= bands.critical) return { state: 'critical', percent, resetsAt };
  if (percent >= bands.tight) return { state: 'tight', percent, resetsAt };
  return { state: 'ok', percent, resetsAt };
}

function clampComplexity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

export function tierFor(weight) {
  if (weight < 0.3) return 'fast';
  if (weight < 0.62) return 'balanced';
  return 'frontier';
}

function shiftTier(tier, delta) {
  const i = TIERS.indexOf(tier);
  return TIERS[Math.max(0, Math.min(TIERS.length - 1, i + delta))];
}

/**
 * Token-efficiency corrections, applied after the weighted tier.
 * Each one returns a note so `decide()` can explain itself.
 */
export function applyEfficiency(tier, task) {
  const notes = [];
  let next = tier;

  // A big pile of input with shallow reasoning is bulk reading. Paying frontier
  // rates to skim 300k tokens is the single most wasteful thing a fan-out does.
  if (task.contextTokens >= 120_000 && task.complexity <= 3 && next === 'frontier') {
    next = shiftTier(next, -1);
    notes.push('large low-complexity context — bulk reading does not need a frontier model');
  }

  // Structured verdicts are short and schema-bound. The rubric does the work.
  if (task.needsSchema && task.length === 'xs' && next === 'frontier' && task.role !== 'judge') {
    next = shiftTier(next, -1);
    notes.push('schema-bound xs output — the schema constrains it more than the model does');
  }

  // Never grade with a cheap model. A generous judge silently destroys the run,
  // and this is the one place the article's 65 rejections came from.
  if ((task.role === 'judge' || task.role === 'review') && next === 'fast') {
    next = shiftTier(next, 1);
    notes.push('judging on the fast tier produces generous verdicts — raised one tier');
  }

  // Repo writes need enough capability to not leave the tree broken.
  if (task.needsRepoWrite && next === 'fast' && task.complexity >= 3) {
    next = shiftTier(next, 1);
    notes.push('writes to the repo at complexity ≥3 — raised off the fast tier');
  }

  return { tier: next, notes };
}

function otherProvider(id) {
  return id === 'codex' ? 'claude' : 'codex';
}

function modelFor(providerId, tier, models = loadConfig().models) {
  const spec = models[providerId][tier];
  return {
    provider: providerId,
    binary: BINARIES[providerId],
    tier,
    model: spec.model,
    ...(spec.effort ? { effort: spec.effort } : {}),
    ...(spec.reasoning ? { reasoning: spec.reasoning } : {}),
  };
}

/**
 * Rank the two providers for this task. Returns candidates best-first, each with
 * the reason it landed where it did.
 */
export function rankProviders(task, states, preference = loadConfig().preference) {
  const ids = ['codex', 'claude'];
  const scored = ids.map((id) => {
    const s = states[id];
    let score = 0;
    const why = [];

    if (s.state === 'exhausted') {
      score -= 1000;
      why.push(`${id} exhausted (${s.percent ?? '?'}%)`);
    } else if (s.state === 'critical') {
      score -= 40;
      why.push(`${id} critical (${s.percent}%)`);
    } else if (s.state === 'tight') {
      score -= 15;
      why.push(`${id} tight (${s.percent}%)`);
    } else if (s.state === 'unknown') {
      score -= 2;
      why.push(`${id} headroom unknown`);
    } else {
      why.push(`${id} healthy (${s.percent}%)`);
    }

    // The configured tie-break vendor. Worth `weightPoints` percentage points
    // of headroom, so the preferred side only loses once it is meaningfully
    // more consumed than the other.
    if (id === preference.first) {
      score += preference.weightPoints / 10;
      why.push(`${id} preferred by default so the fan-out does not compete with the orchestrator`);
    }

    // Prefer whichever provider is genuinely emptier when both are usable.
    if (typeof s.percent === 'number') score += (100 - s.percent) / 10;

    return { provider: id, score, state: s.state, percent: s.percent, resetsAt: s.resetsAt, why };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * @param {object} task
 *   role            one of ROLES (default 'implement')
 *   complexity      1..5 (default 3)
 *   length          xs|s|m|l|xl (default 'm')
 *   contextTokens   rough size of what the agent must read (default 0)
 *   needsSchema     the caller wants a validated object back
 *   needsRepoWrite  the agent edits files in the working tree
 *   independentOf   'codex'|'claude' — must NOT run on that vendor
 *   pin             'codex'|'claude' — caller overrides provider selection
 *   pinModel        exact model id, bypassing the tier map
 * @param {object} limits  { codex, claude } from limits.mjs
 */
export function decide(task = {}, limits = {}) {
  const normalized = {
    role: ROLES[task.role] != null ? task.role : 'implement',
    complexity: clampComplexity(task.complexity),
    length: LENGTHS[task.length] != null ? task.length : 'm',
    contextTokens: Number.isFinite(Number(task.contextTokens)) ? Number(task.contextTokens) : 0,
    needsSchema: Boolean(task.needsSchema),
    needsRepoWrite: Boolean(task.needsRepoWrite),
    independentOf: task.independentOf === 'codex' || task.independentOf === 'claude'
      ? task.independentOf
      : null,
    pin: task.pin === 'codex' || task.pin === 'claude' ? task.pin : null,
    pinModel: typeof task.pinModel === 'string' && task.pinModel ? task.pinModel : null,
  };

  const complexityNorm = (normalized.complexity - 1) / 4;
  const weight = Number(
    (
      0.45 * complexityNorm
      + 0.3 * LENGTHS[normalized.length]
      + 0.25 * ROLES[normalized.role]
    ).toFixed(3),
  );

  const base = tierFor(weight);
  const efficiency = applyEfficiency(base, normalized);
  let tier = efficiency.tier;
  const notes = [...efficiency.notes];

  const states = {
    codex: providerState(limits.codex),
    claude: providerState(limits.claude),
  };

  let ranked = rankProviders(normalized, states);

  // Adversarial independence outranks everything except an explicit pin: a
  // review of codex's work must be judged by claude and vice versa, so the
  // failure modes of one vendor are not also the failure modes of its grader.
  if (normalized.independentOf && !normalized.pin) {
    const required = otherProvider(normalized.independentOf);
    ranked = ranked.filter((c) => c.provider === required);
    notes.push(`cross-model review: forced onto ${required} because the artifact came from ${normalized.independentOf}`);
  }

  if (normalized.pin) {
    ranked = ranked.filter((c) => c.provider === normalized.pin);
    notes.push(`provider pinned to ${normalized.pin} by the caller`);
  }

  const usable = ranked.filter((c) => c.state !== 'exhausted');

  if (usable.length === 0) {
    const soonest = ranked
      .map((c) => c.resetsAt)
      .filter(Boolean)
      .sort()[0] ?? null;
    return {
      ok: false,
      defer: true,
      reason: normalized.independentOf
        ? `the only provider allowed for this cross-model review is exhausted`
        : 'both providers are out of headroom',
      resumeAfter: soonest,
      weight,
      tier,
      factors: normalized,
      states,
      candidates: ranked,
      notes,
    };
  }

  const chosen = usable[0];

  // A provider we are only using because it is all that is left gets a cheaper
  // model, so the last of the quota goes further.
  if (chosen.state === 'critical' && tier === 'frontier' && normalized.role !== 'judge') {
    tier = shiftTier(tier, -1);
    notes.push(`${chosen.provider} is at ${chosen.percent}% — downgraded frontier→balanced to stretch the remaining window`);
  }

  const primary = modelFor(chosen.provider, tier);
  if (normalized.pinModel) {
    primary.model = normalized.pinModel;
    notes.push(`model pinned to ${normalized.pinModel} by the caller`);
  }

  // The failover target: same tier, other vendor. `run.mjs` uses this when the
  // primary returns an explicit rate-limit error mid-run.
  const fallbackCandidate = usable[1] ?? null;
  const fallback = fallbackCandidate ? modelFor(fallbackCandidate.provider, tier) : null;

  return {
    ok: true,
    defer: false,
    ...primary,
    weight,
    reason: [
      `${normalized.role} · complexity ${normalized.complexity}/5 · length ${normalized.length} → ${tier}`,
      chosen.why.join('; '),
    ].join(' | '),
    fallback,
    factors: normalized,
    states,
    candidates: ranked,
    notes,
  };
}
