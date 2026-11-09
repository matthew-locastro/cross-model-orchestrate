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
// Provider selection:
//
//   1. pin              — caller forced it
//   2. independentOf    — adversarial review MUST run on a vendor other than the
//                         one that produced the artifact (any of the others)
//   3. can it run       — not installed, not signed in to a subscription (grok),
//                         exhausted, or unable to do the task (codex has no
//                         network, so it cannot do web work): not a candidate
//   4. least-used       — headroom is the dominant score. A provider whose
//                         pressure sits `powerGap` points below every other
//                         provider that is actually competing gets a power-use
//                         bonus, so a differentially idle subscription is spent.
//                         The bonus is withheld when any usable competitor's
//                         pressure is unknown: an unread meter is still in the race
//   5. orchestrator     — the vendor driving the run loses `penalty` points on
//                         every dispatch, and at or above `reserveAt` pressure
//                         it ranks below every usable alternative
//   6. affinity         — grok is preferred for research and web work, because
//                         it can open and check URLs live
//   7. tie-break        — `preference` settles a near-tie and nothing wider
//
// "Headroom" is pace-aware. A provider is judged on the PRESSURE of its most
// binding window — the raw percentage adjusted for how long the remainder has
// to last (see pace.mjs). 80% of a weekly window with five days to go is a
// durable constraint and reads as critical; 80% with twelve hours to go, or a
// 5-hour window that resets in twenty minutes, is not. Both windows of both
// vendors are weighed this way, so the weekly budgets are balanced across the
// week instead of the side with the lower raw number being drained days early.
//
// Token efficiency is not a fourth weight; it is a set of corrections applied
// after the tier is set (see `applyEfficiency`). Bulk reading is cheap work on
// an expensive model, and that is the most common way a fan-out wastes quota.

import { loadConfig, PROVIDERS, TIERS } from './config.mjs';
import { providerPressure } from './pace.mjs';

export { PROVIDERS, TIERS };

export const BINARIES = { codex: 'codex', claude: 'claude', grok: 'grok' };

/**
 * What each vendor's agent can reach. Codex runs in a sandbox with no network —
 * no DNS at all — so a Codex agent asked to check a link cannot, and guesses.
 * Claude has WebFetch and WebSearch; grok has web search and fetch and runs
 * unsandboxed on this machine.
 */
export const CAPABILITIES = {
  codex: { web: false },
  claude: { web: true },
  grok: { web: true },
};

/**
 * Vendors that must prove a subscription sign-in before they are routable.
 * The grok CLI falls back to pay-per-token API billing when it is not signed
 * in, so an unverified grok is treated exactly like an uninstalled one.
 */
export const REQUIRES_SUBSCRIPTION_CHECK = new Set(['grok']);

const UNUSABLE = new Set(['exhausted', 'missing', 'unauthenticated']);

/** Can a candidate run at all? */
export function isUsable(candidate) {
  return !UNUSABLE.has(candidate.state) && !candidate.incapable;
}

const isProvider = (value) => PROVIDERS.includes(value);

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

export function providerState(limits, bands = pressure(), now = Date.now(), id = limits?.provider ?? null) {
  // A CLI that is not installed cannot run anything, which is a stronger claim
  // than "its meter did not answer" and has to outrank the default preference.
  if (limits && limits.installed === false) {
    return { state: 'missing', percent: null, resetsAt: null };
  }
  // Fail closed on billing. A vendor that can silently bill an API key when its
  // sign-in lapses is routable only on a verified subscription session — and an
  // absent or unreadable reading is NOT verification.
  if (REQUIRES_SUBSCRIPTION_CHECK.has(id) && limits?.auth?.ok !== true) {
    return {
      state: 'unauthenticated',
      percent: null,
      resetsAt: null,
      reason: limits?.auth?.reason ?? `${id} has not been checked for a subscription sign-in`,
    };
  }
  // Any vendor whose own CLI said it is signed out cannot run anything: every
  // dispatch to it would fail on auth. Explicit evidence only — a reading with
  // no auth field is "unknown", not signed out.
  if (limits?.auth?.ok === false) {
    return {
      state: 'unauthenticated',
      percent: null,
      resetsAt: null,
      reason: limits.auth.reason ?? `${id} is signed out`,
    };
  }
  if (!limits || limits.available !== true) {
    // A dead probe must not stop the run. Unknown means usable.
    return { state: 'unknown', percent: null, resetsAt: null };
  }
  // `percent` is pace-adjusted pressure, not the raw reading: how much is used,
  // weighed against how long what is left has to last. The raw figure and the
  // window that binds travel alongside so every message can show both.
  const p = providerPressure(limits, { now, exhausted: bands.exhausted });
  const percent = Number.isFinite(p.percent) ? p.percent : null;
  const resetsAt = p.resetsAt ?? limits.nextResetAt ?? null;
  // A probe that answered but produced no finite pressure is the same fact as
  // one that did not answer. Treating it as 0% would crown it least-used.
  if (percent == null && !limits.hardBlocked) {
    return { state: 'unknown', percent: null, resetsAt };
  }
  const detail = {
    percent,
    resetsAt,
    rawPercent: p.rawPercent,
    window: p.window,
    paceAware: p.paceAware,
    ...(p.note ? { pace: p.note } : {}),
  };
  if (limits.hardBlocked || percent >= bands.exhausted) return { state: 'exhausted', ...detail };
  if (percent >= bands.critical) return { state: 'critical', ...detail };
  if (percent >= bands.tight) return { state: 'tight', ...detail };
  return { state: 'ok', ...detail };
}

/** "94% — Wkly 80% used, 20% left for 5.0d = …" when pace moved the figure, else "80%". */
function describeHeadroom(s) {
  const pct = `${s.percent ?? '?'}%`;
  return s.pace ? `pressure ${pct} — ${s.pace}` : pct;
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

/** "61" or "42.8" — integer gaps stay integers. */
function formatPoints(n) {
  const rounded = Math.round(n * 10) / 10;
  return String(rounded);
}

/**
 * Rank every provider for this task. Returns candidates best-first, each with
 * the reason it landed where it did.
 *
 * Score, for a provider that can run:
 *
 *   headroomWeight × (100 − pressure) / 100     default weight 40
 *   − state penalty                             tight 15, critical 40
 *   − orchestrator penalty                      default 30, on that vendor only
 *   + powerBonus                                default 25, when its pressure is
 *                                               ≥ powerGap (default 20) below
 *                                               every other competing provider
 *                                               AND every usable competitor has
 *                                               a finite pressure
 *   + affinity                                  research and web, on grok
 *   + preference.weightPoints / 10              tie-break, default 2.5
 *
 * `pressure` is the pace-adjusted percent already on the state. A provider
 * that cannot run sits at −1000, under everyone.
 *
 * The orchestrator's vendor, once its pressure reaches `reserveAt`, is placed
 * one point below the lowest usable alternative — still above anyone who
 * cannot run — so it is chosen only when nothing else can take the dispatch.
 * It is not a power-use peer in that state: it is not competing, and the
 * bonus is about the gap to the subscriptions that are.
 */
export function rankProviders(task, states, preference = loadConfig().preference, affinity = loadConfig().affinity) {
  const routing = loadConfig().routing;
  const orchestrator = loadConfig().orchestrator;
  const headroomWeight = Number(routing.headroomWeight) || 0;
  const powerGap = Number(routing.powerGap);
  const powerBonus = Number(routing.powerBonus) || 0;
  const reserveVendor = orchestrator?.vendor || null;
  const reservePenalty = Number(orchestrator?.penalty) || 0;
  const reserveAt = Number(orchestrator?.reserveAt);
  const tieBreak = Number(preference?.weightPoints) > 0 ? Number(preference.weightPoints) / 10 : 0;

  const scored = PROVIDERS.map((id) => {
    const s = states[id] ?? { state: 'unknown', percent: null, resetsAt: null };
    let score = 0;
    const why = [];
    let incapable = false;

    if (s.state === 'missing') {
      score -= 1000;
      why.push(`${id} CLI is not installed`);
    } else if (s.state === 'unauthenticated') {
      score -= 1000;
      why.push(`${id} is not verified as a subscription sign-in: ${s.reason}`);
    } else if (s.state === 'exhausted') {
      score -= 1000;
      why.push(`${id} exhausted (${describeHeadroom(s)})`);
    } else if (s.state === 'critical') {
      score -= 40;
      why.push(`${id} critical (${describeHeadroom(s)})`);
    } else if (s.state === 'tight') {
      score -= 15;
      why.push(`${id} tight (${describeHeadroom(s)})`);
    } else if (s.state === 'unknown') {
      score -= 2;
      why.push(`${id} headroom unknown`);
    } else {
      why.push(`${id} healthy (${describeHeadroom(s)})`);
    }

    // Work that has to open live URLs cannot run where there is no network.
    if (task.needsWeb && CAPABILITIES[id]?.web === false && !(id === 'codex' && task.fullAccess)) {
      incapable = true;
      score -= 1000;
      why.push(`${id} has no network in its sandbox, so it cannot open or verify URLs`);
    }

    // What a vendor is better placed to do than the others. Applied only to a
    // candidate that can run, so it reorders the usable field and never
    // resurrects a spent or unverified one.
    const aff = affinity?.[id];
    if (aff && !incapable && !UNUSABLE.has(s.state)) {
      const roleMatch = Array.isArray(aff.roles) && aff.roles.includes(task.role);
      const webMatch = aff.web && task.needsWeb;
      if (roleMatch || webMatch) {
        score += Number(aff.points) || 0;
        why.push(`${id} preferred for ${webMatch ? 'web work' : task.role}: it can search and fetch live URLs`);
      }
    }

    // Near-ties only. A couple of points, not a reason to drain the fuller window.
    if (id === preference.first && tieBreak) {
      score += tieBreak;
      why.push(`${id} tie-break preference (+${tieBreak})`);
    }

    // Dominant term. `percent` is pace-adjusted, so budget that expires soon
    // counts as room and budget that must last days does not.
    if (typeof s.percent === 'number' && headroomWeight) {
      score += headroomWeight * (100 - s.percent) / 100;
    }

    // Spare the vendor that is already spending its window on the run itself.
    if (reserveVendor && id === reserveVendor && reservePenalty && !incapable && !UNUSABLE.has(s.state)) {
      score -= reservePenalty;
      why.push(`${id} loses ${reservePenalty} to keep orchestrator headroom`);
    }

    return {
      provider: id,
      score,
      state: s.state,
      ...(incapable ? { incapable: true } : {}),
      percent: s.percent,
      rawPercent: s.rawPercent ?? null,
      window: s.window ?? null,
      resetsAt: s.resetsAt,
      why,
    };
  });

  const reserved = (c) => reserveVendor
    && c.provider === reserveVendor
    && isUsable(c)
    && typeof c.percent === 'number'
    && Number.isFinite(reserveAt)
    && c.percent >= reserveAt;

  // Power-use peers are the providers that can actually take the work. The
  // orchestrator's vendor, once it has crossed reserveAt, is held back, so it
  // is not a competitor the gap has to clear. A usable provider with unknown
  // pressure still is: the bonus waits until every competitor has a finite
  // pressure, so an unread meter cannot be skipped and then lose to the bonus.
  const competitors = scored.filter((c) => isUsable(c) && !reserved(c));
  const peers = competitors.filter((c) => Number.isFinite(c.percent));
  if (peers.length === competitors.length && peers.length >= 2 && Number.isFinite(powerGap) && powerBonus) {
    let winner = null;
    let nearest = null;
    let nearestGap = Infinity;
    for (const candidate of peers) {
      let gap = Infinity;
      let other = null;
      let clears = true;
      for (const peer of peers) {
        if (peer === candidate) continue;
        const g = peer.percent - candidate.percent;
        if (g < powerGap) {
          clears = false;
          break;
        }
        if (g < gap) {
          gap = g;
          other = peer;
        }
      }
      if (clears && other && gap < nearestGap) {
        winner = candidate;
        nearest = other;
        nearestGap = gap;
      }
    }
    if (winner) {
      winner.score += powerBonus;
      winner.why.push(
        `power-use: ${winner.provider} is ${formatPoints(nearestGap)} points less used than ${nearest.provider}`,
      );
    }
  }

  for (const candidate of scored) {
    if (!reserved(candidate)) continue;
    const heldBack = `${candidate.provider} reserved for the orchestrator (pressure ${candidate.percent}% ≥ ${reserveAt}%)`;
    const others = scored.filter((o) => isUsable(o) && o.provider !== candidate.provider);
    if (others.length === 0) {
      candidate.why.push(`${heldBack}, used because nothing else can run`);
      continue;
    }
    candidate.why.push(heldBack);
    const floor = Math.min(...others.map((o) => o.score));
    candidate.score = Math.min(candidate.score, floor - 1);
  }

  scored.sort((a, b) => b.score - a.score || PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider));
  return scored;
}

/**
 * One line for `cmo limits --human`: who the router would power-use, and
 * whether the orchestrator's vendor is being held back.
 */
export function formatRoutingLine(ranked) {
  const power = ranked.find((c) => c.why.some((w) => w.startsWith('power-use:')));
  const lead = power ?? ranked.find((c) => isUsable(c)) ?? null;
  const piece = (c, asLead) => {
    const held = c.why.some((w) => w.includes('reserved for the orchestrator'));
    // A reserved vendor that is also the only usable one is who would run, so
    // name it as least-used. Otherwise the reserve is the whole status line.
    if (held && !(asLead && !power)) return `${c.provider} reserved for orchestrator`;
    if (!isUsable(c)) return `${c.provider} ${c.state}`;
    const pct = Number.isFinite(c.percent) ? `${c.percent}%` : 'unknown';
    // No numeric lead means no least-used comparison happened. Name the
    // tie-break vendor in parentheses so the line still says who would run.
    if (asLead && !Number.isFinite(c.percent)) return `headroom unknown (${c.provider})`;
    if (asLead && power) return `power-use ${c.provider} (${pct})`;
    if (asLead) return `least-used ${c.provider} (${pct})`;
    return `${c.provider} ${pct}`;
  };
  const parts = [];
  if (lead) parts.push(piece(lead, true));
  for (const candidate of ranked) {
    if (lead && candidate.provider === lead.provider) continue;
    parts.push(piece(candidate, false));
  }
  return `routing: ${parts.join(' · ')}`;
}

/** Routing line for a limits reading, using the same ranker `decide()` uses. */
export function routingLine(limits, now = Date.now()) {
  const bands = pressure();
  const states = Object.fromEntries(
    PROVIDERS.map((id) => [id, providerState(limits?.[id], bands, now, id)]),
  );
  return formatRoutingLine(rankProviders({ role: 'implement' }, states));
}

/**
 * @param {object} task
 *   role            one of ROLES (default 'implement')
 *   complexity      1..5 (default 3)
 *   length          xs|s|m|l|xl (default 'm')
 *   contextTokens   rough size of what the agent must read (default 0)
 *   needsSchema     the caller wants a validated object back
 *   needsRepoWrite  the agent edits files in the working tree
 *   needsWeb        the agent must open live URLs (research, link checks)
 *   independentOf   'codex'|'claude'|'grok' — must NOT run on that vendor
 *   pin             'codex'|'claude'|'grok' — caller overrides provider selection
 *   pinModel        exact model id, bypassing the tier map
 * @param {object} limits  { codex, claude, grok } from limits.mjs
 * @param {object} opts    { now } — epoch ms, so pace is testable; defaults to the clock
 */
export function decide(task = {}, limits = {}, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const normalized = {
    role: ROLES[task.role] != null ? task.role : 'implement',
    complexity: clampComplexity(task.complexity),
    length: LENGTHS[task.length] != null ? task.length : 'm',
    contextTokens: Number.isFinite(Number(task.contextTokens)) ? Number(task.contextTokens) : 0,
    needsSchema: Boolean(task.needsSchema),
    needsRepoWrite: Boolean(task.needsRepoWrite),
    needsWeb: Boolean(task.needsWeb),
    // codex run with --full-access has a network, so it can do web work.
    fullAccess: Boolean(task.fullAccess),
    independentOf: isProvider(task.independentOf) ? task.independentOf : null,
    // Opt out of degrading: refuse rather than review on the producer's vendor.
    strictIndependence: Boolean(task.strictIndependence),
    pin: isProvider(task.pin) ? task.pin : null,
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

  const bands = pressure();
  const states = Object.fromEntries(PROVIDERS.map((id) => [id, providerState(limits[id], bands, now, id)]));

  let ranked = rankProviders(normalized, states);
  for (const candidate of ranked) {
    for (const line of candidate.why) {
      if (line.startsWith('power-use:') || line.includes('reserved for the orchestrator')) notes.push(line);
    }
  }

  // Adversarial independence outranks everything except an explicit pin: a
  // review of codex's work should be judged by claude and vice versa, so the
  // failure modes of one vendor are not also the failure modes of its grader.
  //
  // When the required vendor has no headroom we DEGRADE rather than refuse.
  // A fresh same-vendor agent still did not make the thing, and that is the
  // larger half of independence — it is what rejected 38 of 57 candidates on
  // the run this tool came from. Refusing outright trades a good review for no
  // review, which is worse.
  //
  // The real hazard was never that a same-vendor verdict is weak. It is that it
  // is INDISTINGUISHABLE from a cross-vendor one. So it is labelled, the caller
  // can branch on it, and the agent is told about its own handicap.
  let independence = normalized.independentOf ? 'cross-vendor' : null;
  let degraded = false;

  if (normalized.independentOf && !normalized.pin) {
    const producer = normalized.independentOf;
    const others = ranked.filter((c) => c.provider !== producer);
    // "Not installed", "not signed in" and "cannot do this task" are as
    // impossible as "spent", and have to reach the same branch: otherwise a
    // box with one CLI silently forces every review onto a vendor that cannot
    // run, and the run defers instead of degrading.
    const anyOtherUsable = others.some(isUsable);
    if (!anyOtherUsable && !normalized.strictIndependence) {
      independence = 'same-vendor';
      degraded = true;
      ranked = ranked.filter((c) => c.provider === producer);
      const why = others.map((c) => `${c.provider} ${c.state === 'missing' ? 'not installed'
        : c.state === 'unauthenticated' ? 'not signed in'
          : c.incapable ? 'cannot do this task' : 'exhausted'}`).join(', ');
      notes.push(
        `DEGRADED REVIEW: no other vendor can run (${why}),`
        + ` so this runs on ${producer} —`
        + ' the same vendor that produced the artifact. Fresh context, shared blind spots.',
      );
    } else {
      ranked = others;
      const usableOthers = others.filter(isUsable).map((c) => c.provider);
      notes.push(`cross-model review: forced onto ${usableOthers.join(' or ') || others.map((c) => c.provider).join(' or ')}`
        + ` because the artifact came from ${producer}`);
    }
  }

  if (normalized.pin) {
    ranked = ranked.filter((c) => c.provider === normalized.pin);
    notes.push(`provider pinned to ${normalized.pin} by the caller`);
    // A review pinned onto the vendor that produced the artifact is not
    // independent, whatever the caller wanted. Say so — or, strictly, refuse.
    if (normalized.independentOf === normalized.pin) {
      if (normalized.strictIndependence) ranked = [];
      else {
        independence = 'same-vendor';
        degraded = true;
        notes.push(`DEGRADED REVIEW: pinned to ${normalized.pin}, the vendor that produced the artifact`);
      }
    }
  }

  // A missing CLI is as unusable as a spent one — filtering only on
  // 'exhausted' let --strict-independence hand back a provider that cannot run.
  // The same goes for an unverified grok and for codex on web work.
  const usable = ranked.filter(isUsable);

  if (usable.length === 0) {
    const soonest = ranked
      .map((c) => c.resetsAt)
      .filter(Boolean)
      .sort()[0] ?? null;
    return {
      ok: false,
      defer: true,
      reason: normalized.pin
        ? (normalized.independentOf === normalized.pin && normalized.strictIndependence
          ? `the review is pinned to ${normalized.pin}, the producer, and --strict-independence forbids that`
          : `the pinned provider ${normalized.pin} cannot run${normalized.needsWeb && normalized.pin === 'codex'
            ? ' web work without --full-access' : ''}`)
        : normalized.independentOf
        ? (normalized.strictIndependence
          ? 'no provider allowed for this cross-model review can run, and --strict-independence forbids degrading to the producer\'s vendor'
          : 'no provider can run, so not even a degraded review can run')
        : 'every provider is out of headroom or cannot run',
      ...(normalized.independentOf ? { independence: 'none' } : {}),
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

  // A same-vendor grader is handicapped by construction, so give it more
  // capability rather than less — it has to catch what it is predisposed to
  // miss. This is the one place we spend UP on a constrained provider.
  if (degraded && tier !== 'frontier') {
    tier = shiftTier(tier, 1);
    notes.push('degraded review raised a tier — a grader sharing the producer\'s priors needs the headroom');
  }

  // A provider we are only using because it is all that is left gets a cheaper
  // model, so the last of the quota goes further.
  if (chosen.state === 'critical' && tier === 'frontier' && normalized.role !== 'judge') {
    tier = shiftTier(tier, -1);
    notes.push(`${chosen.provider} is at ${chosen.percent}% pressure — downgraded frontier→balanced to stretch the remaining window`);
  }

  const primary = modelFor(chosen.provider, tier);
  if (normalized.pinModel) {
    primary.model = normalized.pinModel;
    notes.push(`model pinned to ${normalized.pinModel} by the caller`);
  }

  // The failover ladder: same tier, every other usable vendor in rank order.
  // `run.mjs` walks it when the primary returns an explicit rate-limit error
  // mid-run. `fallback` is its first rung, kept for callers that read one.
  const fallbacks = usable.slice(1).map((c) => modelFor(c.provider, tier));
  const fallback = fallbacks[0] ?? null;

  return {
    ok: true,
    defer: false,
    ...primary,
    ...(independence ? { independence, degradedReview: degraded } : {}),
    weight,
    reason: [
      `${normalized.role} · complexity ${normalized.complexity}/5 · length ${normalized.length} → ${tier}`,
      chosen.why.join('; '),
    ].join(' | '),
    fallback,
    fallbacks,
    factors: normalized,
    states,
    candidates: ranked,
    notes,
  };
}
