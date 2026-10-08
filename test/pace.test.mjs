import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { describePace, formatDuration, paceOf, pressureOf, providerPressure, RESET_SKEW_TOLERANCE } from '../src/pace.mjs';
import { decide, providerState } from '../src/policy.mjs';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (ms) => new Date(NOW + ms).toISOString();
const win = (key, percentUsed, leftMs) => ({
  key,
  label: key === 'weekly' ? 'Wkly' : '5hr',
  percentUsed,
  resetsAt: leftMs == null ? null : at(leftMs),
});
const BANDS = { tight: 65, critical: 85, exhausted: 95 };
const reading = (windows, extra = {}) => {
  const worst = windows.reduce((a, w) => (a == null || w.percentUsed > a.percentUsed ? w : a), null);
  return {
    available: true,
    windows,
    worstPercent: worst.percentUsed,
    worstWindow: worst.key,
    nextResetAt: worst.resetsAt,
    hardBlocked: false,
    ...extra,
  };
};

test('the case this exists for: 80% of a weekly window with five days to go is critical, not merely tight', () => {
  const p = pressureOf(win('weekly', 80, 5 * DAY), { now: NOW });
  assert.equal(p.known, true);
  assert.ok(p.pressure >= BANDS.critical, `pressure ${p.pressure} should be critical`);
  assert.ok(p.pressure < BANDS.exhausted, 'pace alone must never read as exhausted');
  assert.equal(p.leftPerDay, 4, '20% over 5 days is 4%/day');
  assert.equal(p.evenPerDay, 14.3);
  assert.match(describePace(p), /80% used, 20% left for 5\.0d = 4%\/day vs 14\.3%\/day even pace/);
});

test('the same 80% with twelve hours to go is relaxed — budget about to expire is room, not scarcity', () => {
  const p = pressureOf(win('weekly', 80, 12 * HOUR), { now: NOW });
  assert.ok(p.pressure < BANDS.tight, `pressure ${p.pressure} should be below tight`);
  assert.ok(p.runway > 1);
});

test('a 5-hour window that resets in twenty minutes barely constrains; the same reading early in the window does', () => {
  const late = pressureOf(win('5h', 70, 20 * MIN), { now: NOW });
  const early = pressureOf(win('5h', 70, 4 * HOUR), { now: NOW });
  assert.ok(late.pressure < BANDS.tight, `late ${late.pressure}`);
  assert.ok(early.pressure > 70, `early ${early.pressure} should exceed the raw 70`);
  assert.ok(early.pressure >= BANDS.critical);
});

test('exactly on even pace, pressure is the raw figure', () => {
  // 30% of the window elapsed, 30% used.
  const p = pressureOf(win('weekly', 30, 0.7 * 7 * DAY), { now: NOW });
  assert.equal(p.pressure, 30);
  assert.equal(p.adjusted, false);
  assert.equal(p.aheadOfPacePoints, 0);
});

test('a fresh window reads as empty, and half the week burned in half a day reads as tight', () => {
  assert.equal(pressureOf(win('weekly', 0, 7 * DAY), { now: NOW }).pressure, 0);
  const burned = pressureOf(win('weekly', 50, 6.5 * DAY), { now: NOW });
  assert.ok(burned.pressure >= BANDS.tight && burned.pressure < BANDS.critical, `got ${burned.pressure}`);
});

test('a raw reading at or past exhausted is never relaxed, however close the reset', () => {
  const p = pressureOf(win('5h', 97, 2 * MIN), { now: NOW, exhausted: 95 });
  assert.equal(p.pressure, 97);
});

test('pace alone never pushes a window into exhausted', () => {
  for (const used of [85, 90, 94]) {
    const p = pressureOf(win('weekly', used, 6.9 * DAY), { now: NOW, exhausted: 95 });
    assert.ok(p.pressure <= 94, `${used}% → ${p.pressure}`);
    assert.ok(p.pressure >= used);
  }
});

test('pressure is monotonic: more used is never less pressure, and more time to wait is never less pressure', () => {
  let last = -1;
  for (let used = 0; used <= 100; used += 5) {
    const p = pressureOf(win('weekly', used, 3 * DAY), { now: NOW }).pressure;
    assert.ok(p >= last, `used ${used}: ${p} < ${last}`);
    last = p;
  }
  last = -1;
  for (let hours = 1; hours <= 168; hours += 6) {
    const p = pressureOf(win('weekly', 60, hours * HOUR), { now: NOW }).pressure;
    assert.ok(p >= last, `hours ${hours}: ${p} < ${last}`);
    last = p;
  }
});

test('without a usable reset time the raw percentage stands', () => {
  assert.deepEqual(
    [pressureOf(win('weekly', 72, null), { now: NOW }).pressure, pressureOf(win('weekly', 72, null), { now: NOW }).known],
    [72, false],
  );
  const stale = pressureOf(win('5h', 72, -10 * MIN), { now: NOW });
  assert.equal(stale.pressure, 72);
  assert.equal(stale.stale, true);
  const odd = pressureOf({ key: 'window', percentUsed: 72, resetsAt: at(HOUR) }, { now: NOW });
  assert.equal(odd.pressure, 72);
  assert.equal(paceOf({ key: 'weekly' }, { now: NOW }), null);
});

test('the binding window is the one with the most pressure, not the highest raw number', () => {
  // Raw worst is the 5-hour window, but it clears in 20 minutes; the weekly one has to last six days.
  const claude = reading([win('5h', 69, 20 * MIN), win('weekly', 60, 6 * DAY)]);
  const p = providerPressure(claude, { now: NOW });
  assert.equal(p.rawWindow, '5h');
  assert.equal(p.window, 'weekly');
  assert.equal(p.resetsAt, at(6 * DAY));
  assert.ok(p.percent > 69);
  assert.equal(p.paceAware, true);
  assert.match(p.note, /Wkly 60% used/);
});

test('committed-but-unbilled points land on the worst raw window before pace is applied', () => {
  const base = reading([win('weekly', 40, 3 * DAY)]);
  const calm = providerPressure(base, { now: NOW }).percent;
  const busy = providerPressure({ ...base, worstPercent: 50, committedPoints: 10 }, { now: NOW }).percent;
  assert.ok(busy > calm);
  assert.equal(busy, pressureOf(win('weekly', 50, 3 * DAY), { now: NOW }).pressure);
});

test('a reading forced to spent out of band is not talked down by its old windows', () => {
  const spent = { ...reading([win('5h', 40, 10 * MIN)]), worstPercent: 100, hardBlocked: true };
  assert.equal(providerPressure(spent, { now: NOW }).percent, 100);
  assert.equal(providerState(spent, BANDS, NOW).state, 'exhausted');
});

test('a reading with no windows falls back to its raw worst percent', () => {
  const p = providerPressure({ available: true, worstPercent: 72, nextResetAt: null }, { now: NOW });
  assert.equal(p.percent, 72);
  assert.equal(p.paceAware, false);
  assert.equal(providerState({ available: true, worstPercent: 72, windows: [{ key: '5h', percentUsed: 72 }] }, BANDS, NOW).state, 'tight');
});

test('routing: a durable weekly squeeze on codex loses to a claude 5-hour blip that is about to clear', () => {
  const limits = {
    codex: reading([win('weekly', 80, 5 * DAY)]),
    claude: reading([win('5h', 70, 20 * MIN), win('weekly', 10, 6 * DAY)]),
  };
  const d = decide({ role: 'implement', complexity: 3, length: 'm' }, limits, { now: NOW });
  assert.equal(d.states.codex.state, 'critical');
  assert.equal(d.states.codex.rawPercent, 80);
  assert.equal(d.states.claude.state, 'ok');
  assert.equal(d.provider, 'claude', 'raw percentages would have called both tight and kept codex');
  assert.match(d.candidates.find((c) => c.provider === 'codex').why.join(' '), /pressure .*Wkly 80% used, 20% left for 5\.0d/);
});

test('routing: budget that expires soon is spent, not hoarded', () => {
  const limits = {
    codex: reading([win('weekly', 80, 12 * HOUR)]),
    claude: reading([win('5h', 30, 3 * HOUR), win('weekly', 30, 5 * DAY)]),
  };
  const d = decide({ role: 'implement', complexity: 3, length: 'm' }, limits, { now: NOW });
  assert.equal(d.states.codex.state, 'ok');
  assert.equal(d.provider, 'codex');
});

test('routing: a provider that is critical by pace still runs, on a cheaper tier, and still serves cross-vendor review', () => {
  const limits = {
    codex: reading([win('weekly', 80, 5 * DAY)]),
    claude: reading([win('5h', 99, 3 * HOUR)], { hardBlocked: true }),
  };
  const build = decide({ role: 'implement', complexity: 4, length: 'xl' }, limits, { now: NOW });
  assert.equal(build.provider, 'codex');
  assert.equal(build.tier, 'balanced', 'frontier is downgraded to stretch a pace-critical window');
  assert.ok(build.notes.some((n) => /pressure — downgraded frontier→balanced/.test(n)));

  const review = decide(
    { role: 'review', complexity: 3, length: 'm', independentOf: 'claude' },
    limits,
    { now: NOW },
  );
  assert.equal(review.provider, 'codex');
  assert.equal(review.independence, 'cross-vendor', 'pace pressure must not degrade a review to same-vendor');
});

test('a reset further away than the window is long is inconsistent data, not scarcity', () => {
  // Found in review: this read as 91% (critical) and pushed work off the emptier provider.
  const skewed = pressureOf(win('weekly', 70, 8 * DAY), { now: NOW });
  assert.equal(skewed.pressure, 70);
  assert.equal(skewed.known, false);
  assert.equal(skewed.inconsistent, true);

  const limits = {
    codex: reading([win('weekly', 70, 8 * DAY)]),
    claude: reading([win('5h', 80, 2.5 * HOUR), win('weekly', 80, 3.5 * DAY)]),
  };
  const d = decide({ role: 'implement', complexity: 3, length: 'm' }, limits, { now: NOW });
  assert.equal(d.states.codex.percent, 70);
  assert.equal(d.provider, 'codex');

  // A sliver of clock skew is tolerated and clamped to a full window.
  const sliver = pressureOf(win('weekly', 10, 7 * DAY * (1 + RESET_SKEW_TOLERANCE / 2)), { now: NOW });
  assert.equal(sliver.known, true);
  assert.equal(sliver.timeLeft, 1);
});

test('non-finite inputs never become a pressure', () => {
  assert.equal(pressureOf({ key: 'weekly', percentUsed: NaN, resetsAt: at(DAY) }, { now: NOW }), null);
  assert.equal(pressureOf({ key: 'weekly', percentUsed: Infinity, resetsAt: at(DAY) }, { now: NOW }), null);
  const p = providerPressure({ available: true, worstPercent: NaN, committedPoints: NaN, windows: [win('weekly', 40, 3 * DAY)] }, { now: NOW });
  assert.ok(Number.isFinite(p.percent));
  assert.equal(p.rawPercent, null);
  const junkExtra = pressureOf(win('weekly', 40, 3 * DAY), { now: NOW, extraPoints: 'abc' });
  assert.equal(junkExtra.percentUsed, 40);
  for (const used of [0, 0.4, 33.3, 99.9, 100]) {
    for (const left of [1 * MIN, HOUR, 3 * DAY, 7 * DAY]) {
      const v = pressureOf(win('weekly', used, left), { now: NOW }).pressure;
      assert.ok(Number.isFinite(v) && v >= 0 && v <= 100, `${used}% / ${left}ms → ${v}`);
    }
  }
});

test('pressure is continuous across the even-pace boundary', () => {
  // Found in review: rounding the runway before using it made pressure step here.
  // 1% used; sweep the reset time across runway = 1 one second at a time.
  const onPaceLeft = 0.99 * 7 * DAY;
  let last = null;
  for (let s = -120; s <= 120; s += 1) {
    const v = pressureOf(win('weekly', 1, onPaceLeft + s * 1000), { now: NOW }).pressure;
    if (last != null) assert.ok(Math.abs(v - last) <= 0.1, `step of ${Math.abs(v - last)} at ${s}s`);
    last = v;
  }
  assert.equal(pressureOf(win('weekly', 1, onPaceLeft), { now: NOW }).pressure, 1);
});

test('formatDuration picks the unit a person would', () => {
  assert.equal(formatDuration(5 * 1440), '5.0d');
  assert.equal(formatDuration(7.2 * 60), '7.2h');
  assert.equal(formatDuration(18), '18m');
  assert.equal(formatDuration(NaN), '?');
});
