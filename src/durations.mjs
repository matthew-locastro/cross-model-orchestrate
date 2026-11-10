// durations.mjs — how long each vendor actually takes, from its own receipts.
//
// Routing used to treat the vendors as interchangeable in time. They are not.
// Measured from the receipts on 2026-11-09, at the same tier and role:
//
//   review    · balanced   codex p50  202s   grok p50  876s
//   implement · balanced   codex p50  293s   grok p50 1056s
//   implement · frontier   codex p50  830s   grok p50 2780s
//
// Grok is three to four times slower, and not because it hangs: its own session
// logs show 3–5s to first token and a steady stream, spent on long reasoning
// between tool calls (a high-effort review wrote 108K characters of reasoning in
// 17 turns). So when the power-use bonus handed Grok a review with a 600s or
// 900s timeout — numbers sized for Codex — it ran out of clock, was killed with
// nothing to show, and Codex did the review anyway: 10 to 15 minutes and a
// Grok dispatch spent to learn nothing.
//
// The receipts already hold the answer. This module turns them into an expected
// duration per vendor, role, tier and effort, and policy.mjs moves a vendor that
// would not finish inside the dispatch's timeout behind one that would. It stays
// in the failover ladder; it is just not tried first.

/** Defaults; config `durationFit` overrides any of them. */
export const DEFAULT_DURATION_FIT = {
  enabled: true,
  // A vendor is "expected to overrun" when this quantile of its recent
  // durations exceeds `margin` × the timeout. p75 against 90% of the clock:
  // a vendor that overruns one dispatch in four is not the one to try first.
  quantile: 0.75,
  margin: 0.9,
  // Fewer samples than this is no evidence either way, and changes nothing.
  minSamples: 3,
  // Old receipts describe old models and old CLIs.
  windowDays: 14,
};

const key = (role, tier) => `${role ?? 'unknown'}·${tier ?? 'unknown'}`;

/**
 * Durations per vendor, from audit receipts.
 *
 * Two kinds of receipt carry evidence:
 *
 *   attemptLog   (receipts since this change) one entry per attempt, with the
 *                vendor, tier, effort, wall time and failure. A completed
 *                attempt is a sample; a timed-out one is a sample too, at the
 *                time it was killed — a lower bound, which still says "at
 *                least this long". Rate limits, auth and fatal errors say
 *                nothing about speed and are skipped.
 *   legacy       older receipts with no attemptLog: only a clean first-attempt
 *                success is a sample, because a retried or failed-over
 *                receipt's duration mixes vendors and backoff.
 *
 * Returns `{ [provider]: { 'role·tier': [{ ms, effort, timedOut }] } }`.
 */
export function durationProfile(rows, { now = Date.now(), windowDays = DEFAULT_DURATION_FIT.windowDays } = {}) {
  const since = now - windowDays * 86_400_000;
  const out = {};
  const add = (provider, role, tier, sample) => {
    if (!provider || !Number.isFinite(sample.ms) || sample.ms <= 0) return;
    ((out[provider] ??= {})[key(role, tier)] ??= []).push(sample);
  };
  for (const row of rows ?? []) {
    if (!row || typeof row !== 'object' || (row.at ?? 0) < since) continue;
    if (Array.isArray(row.attemptLog)) {
      for (const a of row.attemptLog) {
        if (!a || (a.failure && a.failure !== 'timeout')) continue;
        add(a.provider, row.role, a.tier, { ms: a.ms, effort: a.effort ?? null, timedOut: a.failure === 'timeout' });
      }
      continue;
    }
    if (row.ok === true && !row.failedOver && (row.attempts ?? 1) === 1) {
      add(row.provider, row.role, row.tier, { ms: row.durationMs, effort: row.effort ?? null, timedOut: false });
    }
  }
  return out;
}

/** Cheapest first. A higher tier runs a bigger model or a higher effort. */
const TIER_ORDER = ['fast', 'balanced', 'frontier'];

/** Effort and reasoning levels across the three CLIs, least work first. */
const EFFORT_RANK = { none: 0, minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

function estimate(samples, quantile) {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * quantile));
  return { ms: sorted[i], n: sorted.length, timeouts: samples.filter((s) => s.timedOut).length };
}

/**
 * The expected duration of one vendor on one kind of work, or null when there
 * is not enough evidence.
 *
 * Samples recorded at a different effort than the one this dispatch would run
 * at are left out: lowering grok's review effort must not keep being judged by
 * the slow runs it replaced.
 *
 * When this tier has too few samples, the nearest cheaper tier that has enough
 * stands in, as a floor: a frontier review is never faster than a balanced one
 * on the same vendor. Without that, a vendor would have to time out
 * `minSamples` times at every tier before routing learned anything — and each
 * of those lessons is a full timeout. The floor is that tier's own estimate,
 * never a mix of tiers, so `minSamples` still means what it says; and a sample
 * recorded at a higher effort than this dispatch's is not a floor for it, so it
 * is left out. `floorFrom` names the tier when this happened.
 */
export function expectedDuration(profile, { provider, role, tier, effort = null }, opts = {}) {
  const { quantile = DEFAULT_DURATION_FIT.quantile, minSamples = DEFAULT_DURATION_FIT.minSamples, judgeMs = null } = opts;
  // A stopped run says only "at least this long". Judged against a limit, one
  // stopped past it is an overrun (counted as endless); one stopped short of it,
  // under some smaller budget, says nothing about whether this one fits, and is
  // left out — otherwise a two-minute test budget would read as a fast finish.
  const judged = (samples) => (Number.isFinite(judgeMs) && judgeMs > 0
    ? samples.flatMap((s) => (!s.timedOut ? [s] : s.ms >= judgeMs ? [{ ...s, ms: Infinity }] : []))
    : samples);
  const at = (t) => judged(profile?.[provider]?.[key(role, t)] ?? []);
  const own = at(tier).filter((s) => !s.effort || !effort || s.effort === effort);
  if (own.length >= minSamples) return estimate(own, quantile);

  const ceiling = EFFORT_RANK[effort];
  const notAbove = (s) => !s.effort || ceiling == null || EFFORT_RANK[s.effort] == null || EFFORT_RANK[s.effort] <= ceiling;
  for (let i = TIER_ORDER.indexOf(tier) - 1; i >= 0; i -= 1) {
    const cheaper = at(TIER_ORDER[i]).filter(notAbove);
    if (cheaper.length >= minSamples) return { ...estimate(cheaper, quantile), floorFrom: TIER_ORDER[i] };
  }
  return null;
}

/** "14.6 min" or "45s". */
export function formatElapsed(ms) {
  if (!Number.isFinite(ms)) return '?';
  return ms >= 90_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)}s`;
}
