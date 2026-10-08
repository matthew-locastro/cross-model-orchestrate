// pace.mjs — how much room a usage window REALLY has, given when it resets.
//
// A raw percentage answers "how much is used". Routing needs the other
// question: "how long does what is left have to last?" The two diverge badly:
//
//   weekly 80% used, 5 days to reset   → 20% must last 5 days. Even pace would
//                                        be 14.3%/day; this allows 4%/day. Scarce.
//   weekly 80% used, 12 hours to reset → 20% for half a day. Generous — and any
//                                        of it left at the reset is simply lost.
//   5-hour 70% used, 20 minutes left   → relief is imminent. Barely a constraint.
//
// Treating all three as "80%, tight" drained a weekly window days early on one
// side while a 5-hour blip that was about to clear steered work away from the
// other. So every window gets a pace-adjusted PRESSURE on the same 0–100 scale
// the bands already use, and routing reads that instead of the raw figure.
//
//   runway r = (fraction of budget left) / (fraction of window time left)
//
//   r = 1   exactly on even pace                         → pressure = raw
//   r < 1   the remainder must be rationed               → pressure rises toward 100
//             pressure = 100 − (100 − raw) · r
//           capped just under `exhausted`: pace alone never takes a provider
//           out of the candidate list, because budget that exists can still be
//           spent on the work only that vendor can do (a cross-vendor review).
//   r > 1   the reset arrives before even-pace use would run out
//             pressure = raw / √r
//           so budget that is about to expire is spent rather than stranded.
//
// A raw reading at or past `exhausted` is never relaxed: the meter lags, other
// orchestrators share it, and the last few points are how agents die mid-run.
//
// Pace is computed at decision time, from a window's key and reset time. It is
// never cached — a cached pace would be wrong one minute later.

export const WINDOW_MINUTES = { '5h': 300, daily: 1440, weekly: 10080 };

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function round1(n) {
  return Math.round(n * 10) / 10 + 0; // + 0 turns -0 into 0
}

/** "5.0d", "7.2h", "18m" — the largest unit that reads naturally. */
export function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return '?';
  if (minutes >= 2880) return `${(minutes / 1440).toFixed(1)}d`;
  if (minutes >= 90) return `${(minutes / 60).toFixed(1)}h`;
  return `${Math.max(0, Math.round(minutes))}m`;
}

/**
 * Pace facts for one window.
 *
 * @param {object} window  { key, label, percentUsed, resetsAt } from limits.mjs
 * @param {object} opts
 *   now          epoch ms
 *   extraPoints  committed-but-unbilled points to add to the reading
 * @returns null when the window has no usable percentage; otherwise an object
 *   whose `known` is false when the reset time or window length is not usable
 *   (unknown key, missing reset, or a reset already in the past — a stale
 *   reading). Callers fall back to the raw percentage in that case.
 */
// A reset further away than the window is long cannot be true of a rolling
// window; it means clock skew or a reset time paired with a reading from the
// window before. A little skew is tolerated and clamped. Beyond that the pair
// is inconsistent, and reasoning about its pace would manufacture scarcity out
// of bad data — measured: a weekly reading whose reset sat a day past the
// window read as critical and pushed work off the emptier provider.
export const RESET_SKEW_TOLERANCE = 0.02;

/**
 * Pace facts plus the unrounded runway. Internal: the displayed figures are
 * rounded for people, and pressure must not inherit that rounding or it steps
 * at the even-pace boundary where the formula itself is continuous.
 */
function computePace(window, { now = Date.now(), extraPoints = 0 } = {}) {
  if (!window || !Number.isFinite(window.percentUsed)) return null;
  const extra = Number.isFinite(Number(extraPoints)) ? Number(extraPoints) : 0;
  const usedExact = clamp(window.percentUsed + extra, 0, 100);
  const percentUsed = round1(usedExact);
  const base = {
    key: window.key ?? null,
    label: window.label ?? window.key ?? null,
    percentUsed,
    resetsAt: window.resetsAt ?? null,
  };
  const windowMinutes = WINDOW_MINUTES[window.key];
  const resetMs = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  if (!windowMinutes || !Number.isFinite(resetMs) || !Number.isFinite(now)) {
    return { pace: { ...base, known: false }, runway: null };
  }

  const minutesLeft = (resetMs - now) / 60_000;
  // A reset in the past means the reading predates the reset: it is stale, and
  // the honest thing to do with a stale figure is not to reason about its pace.
  if (!(minutesLeft > 0)) return { pace: { ...base, known: false, stale: true }, runway: null };
  if (minutesLeft > windowMinutes * (1 + RESET_SKEW_TOLERANCE)) {
    return { pace: { ...base, known: false, inconsistent: true }, runway: null };
  }

  const timeLeft = clamp(minutesLeft / windowMinutes, 0, 1);
  const runway = ((100 - usedExact) / 100) / timeLeft; // timeLeft > 0 here
  const daysLeft = minutesLeft / 1440;
  return {
    runway,
    pace: {
      ...base,
      known: true,
      windowMinutes,
      minutesLeft: round1(minutesLeft),
      timeLeft: Number(timeLeft.toFixed(4)),
      // What usage would read right now had the window been spent at an even rate.
      evenPacePercent: round1((1 - timeLeft) * 100),
      // Positive = further along the budget than the calendar.
      aheadOfPacePoints: round1(percentUsed - (1 - timeLeft) * 100),
      runway: Number(runway.toFixed(3)),
      // The rate the remainder allows vs the rate an untouched window allows.
      leftPerDay: round1((100 - percentUsed) / daysLeft),
      evenPerDay: round1(100 / (windowMinutes / 1440)),
    },
  };
}

/**
 * Pace facts for one window.
 *
 * @param {object} window  { key, label, percentUsed, resetsAt } from limits.mjs
 * @param {object} opts
 *   now          epoch ms
 *   extraPoints  committed-but-unbilled points to add to the reading
 * @returns null when the window has no finite percentage; otherwise an object
 *   whose `known` is false when the reset time or window length is not usable:
 *   an unknown key, a missing reset, a reset already in the past (`stale`), or
 *   one further away than the window is long (`inconsistent`). Callers fall
 *   back to the raw percentage in every such case.
 */
export function paceOf(window, opts = {}) {
  return computePace(window, opts)?.pace ?? null;
}

/**
 * Pace-adjusted pressure for one window, 0–100. Falls back to the raw
 * percentage whenever pace is not known.
 */
export function pressureOf(window, { now = Date.now(), extraPoints = 0, exhausted = 95 } = {}) {
  const computed = computePace(window, { now, extraPoints });
  if (!computed) return null;
  const { pace } = computed;
  const raw = pace.percentUsed;
  if (!pace.known || raw >= exhausted) return { ...pace, pressure: raw, adjusted: false };

  const r = computed.runway;
  const pressure = r < 1
    ? Math.max(raw, Math.min(exhausted - 1, 100 - (100 - raw) * r))
    : raw / Math.sqrt(r);
  const rounded = round1(clamp(pressure, 0, 100));
  return { ...pace, pressure: rounded, adjusted: Math.abs(rounded - raw) >= 1 };
}

/** One clause explaining a window's pace, for `why` lines and `cmo limits`. */
export function describePace(p) {
  if (!p || !p.known) return null;
  const left = round1(100 - p.percentUsed);
  const span = formatDuration(p.minutesLeft);
  const unit = p.windowMinutes >= 2880 ? 'day' : 'hour';
  const per = unit === 'day' ? 1 : 24;
  const leftRate = round1(p.leftPerDay / per);
  const evenRate = round1(p.evenPerDay / per);
  return `${p.label ?? p.key} ${p.percentUsed}% used, ${left}% left for ${span}`
    + ` = ${leftRate}%/${unit} vs ${evenRate}%/${unit} even pace`;
}

/**
 * Reduce a provider's reading to the figure routing should use.
 *
 * `limits` is a reading from limits.mjs (optionally with committed spend folded
 * in by ledger.applyCommitted). Committed points are expressed in the units of
 * the worst raw window, so that is the window they are added to.
 *
 * @returns {{
 *   percent: number,          pace-adjusted pressure of the binding window
 *   window: string|null,      which window binds
 *   resetsAt: string|null,    when the binding window resets
 *   rawPercent: number|null,  the worst raw reading, for display
 *   rawWindow: string|null,
 *   paceAware: boolean,       false ⇒ percent is just the raw figure
 *   windows: object[],        per-window pressureOf() results
 *   note: string|null,        describePace() of the binding window when pace moved it
 * }}
 */
export function providerPressure(limits, { now = Date.now(), exhausted = 95 } = {}) {
  const rawPercent = Number.isFinite(limits?.worstPercent) ? limits.worstPercent : null;
  const rawWindow = limits?.worstWindow ?? null;
  const committed = Number.isFinite(limits?.committedPoints) ? limits.committedPoints : 0;
  const source = Array.isArray(limits?.windows) ? limits.windows : [];
  const windows = source
    .map((w) => pressureOf(w, {
      now,
      exhausted,
      // Without a named worst window, a single-window reading is unambiguous.
      extraPoints: (w.key === rawWindow || (rawWindow == null && source.length === 1)) ? committed : 0,
    }))
    .filter(Boolean);

  const fallback = {
    percent: rawPercent ?? 0,
    window: rawWindow,
    resetsAt: limits?.nextResetAt ?? null,
    rawPercent,
    rawWindow,
    paceAware: false,
    windows,
    note: null,
  };
  if (windows.length === 0 || !windows.some((w) => w.known)) return fallback;

  const binding = windows.reduce((a, b) => (b.pressure > a.pressure ? b : a));
  // A reading forced to "spent" out of band (an explicit rate-limit error marks
  // the provider exhausted without touching its windows) outranks any pace
  // arithmetic done on windows that no longer describe it.
  if (rawPercent != null && rawPercent >= exhausted && binding.pressure < rawPercent) return fallback;

  return {
    percent: binding.pressure,
    window: binding.key,
    resetsAt: binding.resetsAt ?? limits?.nextResetAt ?? null,
    rawPercent,
    rawWindow,
    paceAware: true,
    windows,
    note: binding.adjusted ? describePace(binding) : null,
  };
}
