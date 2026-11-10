// durations.test.mjs — a vendor that will not finish inside the timeout is not
// tried first.
//
// The bug this guards: on 2026-11-09 two read-only reviews were power-used onto
// Grok with 600s and 900s timeouts. Grok reviews take 12–19 minutes (p50 876s,
// against Codex's 202s at the same tier), so both ran out of clock, were killed
// with nothing to show, and Codex did the reviews anyway.
import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_DURATION_FIT, durationProfile, expectedDuration, formatElapsed } from '../src/durations.mjs';
import { grokAuthFrom } from '../src/grok.mjs';
import { decide, fitToTimeout } from '../src/policy.mjs';
import { runAgent } from '../src/run.mjs';
import { AUDIT_FILE, readAudit, record } from '../src/audit.mjs';
import { stat } from 'node:fs/promises';

const NOW = Date.parse('2026-11-10T00:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;

const SUBSCRIPTION = {
  authenticated: true,
  meta: { auth_mode: 'Oidc', subscription_tier: 'SuperGrok Plus', backend_billed: false },
};
const healthy = (percent = 5) => ({
  available: true, worstPercent: percent, nextResetAt: null, hardBlocked: false,
  windows: [{ key: '5h', percentUsed: percent }],
});
const grokReading = (percent = 9) => ({
  provider: 'grok', available: true, worstPercent: percent, hardBlocked: false,
  windows: [{ key: 'weekly', label: 'Wkly', percentUsed: percent, resetsAt: new Date(NOW + 100 * 3_600_000).toISOString() }],
  auth: grokAuthFrom(SUBSCRIPTION),
});
// The evening of the incident: Grok far less used than Codex, Claude driving.
const LIMITS = { codex: healthy(45), claude: healthy(20), grok: grokReading(9) };
const REVIEW = { role: 'review', complexity: 3, length: 's', independentOf: 'claude' }; // → balanced

/** A legacy receipt: no attemptLog, as every receipt before this change. */
const legacy = (provider, ms, extra = {}) => ({
  at: NOW - DAY, ok: true, provider, role: 'review', tier: 'balanced', failedOver: false, attempts: 1, durationMs: ms, ...extra,
});
// Grok's four real balanced reviews that day, and Codex's typical ones.
const RECEIPTS = [
  ...[766, 876, 719, 1112].map((s) => legacy('grok', s * 1000)),
  ...[182, 225, 200, 256, 202, 280].map((s) => legacy('codex', s * 1000)),
];

// ── the profile ─────────────────────────────────────────────────────────

test('a clean legacy success is a sample; a retried or failed-over one is not', () => {
  const p = durationProfile([
    legacy('grok', 800_000),
    legacy('grok', 900_000, { attempts: 2, retried: true }),
    legacy('codex', 300_000, { failedOver: true }),
    { ...legacy('grok', 100_000), ok: false },
  ], { now: NOW });
  assert.deepEqual(p.grok['review·balanced'].map((s) => s.ms), [800_000]);
  assert.equal(p.codex, undefined);
});

test('attempt logs count completions and timeouts, and nothing that says nothing about speed', () => {
  const p = durationProfile([{
    at: NOW - DAY, ok: true, role: 'review', provider: 'codex', failedOver: true, durationMs: 840_000,
    attemptLog: [
      { provider: 'grok', tier: 'frontier', effort: 'high', ms: 600_000, failure: 'timeout' },
      { provider: 'grok', tier: 'frontier', effort: 'high', ms: 3_000, failure: 'rate-limit' },
      { provider: 'codex', tier: 'frontier', effort: null, ms: 240_000, failure: null },
    ],
  }], { now: NOW });
  assert.deepEqual(p.grok['review·frontier'], [{ ms: 600_000, effort: 'high', timedOut: true }]);
  assert.deepEqual(p.codex['review·frontier'], [{ ms: 240_000, effort: null, timedOut: false }]);
});

test('receipts older than the window are not evidence', () => {
  const p = durationProfile([legacy('grok', 800_000, { at: NOW - 15 * DAY })], { now: NOW, windowDays: 14 });
  assert.deepEqual(p, {});
});

// ── the estimate ────────────────────────────────────────────────────────

test('too few samples is no estimate; enough gives the configured quantile', () => {
  const p = durationProfile(RECEIPTS, { now: NOW });
  assert.equal(expectedDuration(p, { provider: 'grok', role: 'review', tier: 'balanced' }, { minSamples: 5 }), null);
  const e = expectedDuration(p, { provider: 'grok', role: 'review', tier: 'balanced' });
  assert.equal(e.n, 4);
  assert.equal(e.ms, 1_112_000, 'p75 of four is the slowest');
  assert.equal(expectedDuration(p, { provider: 'codex', role: 'review', tier: 'balanced' }).ms, 256_000);
  assert.equal(expectedDuration(p, { provider: 'grok', role: 'implement', tier: 'balanced' }), null, 'another role is not evidence');
});

test('samples at another effort are left out, so a lowered effort is not judged by the old runs', () => {
  const p = durationProfile([700, 800, 900].map((s) => legacy('grok', s * 1000, { effort: 'medium' })), { now: NOW });
  assert.equal(expectedDuration(p, { provider: 'grok', role: 'review', tier: 'balanced', effort: 'low' }), null);
  assert.equal(expectedDuration(p, { provider: 'grok', role: 'review', tier: 'balanced', effort: 'medium' }).n, 3);
});

test('a dearer tier with too few samples takes a cheaper tier\'s estimate as a floor, never the other way', () => {
  const p = durationProfile(RECEIPTS, { now: NOW });
  const frontier = expectedDuration(p, { provider: 'grok', role: 'review', tier: 'frontier', effort: 'high' });
  assert.equal(frontier.ms, 1_112_000);
  assert.equal(frontier.floorFrom, 'balanced');
  assert.equal(expectedDuration(p, { provider: 'grok', role: 'review', tier: 'fast' }), null);
});

test('the floor is one tier\'s own estimate: tiers are not mixed to reach minSamples', () => {
  // Two frontier samples and one balanced: neither tier alone has three.
  const p = durationProfile([
    legacy('grok', 2_000_000, { tier: 'frontier', effort: 'high' }),
    legacy('grok', 2_100_000, { tier: 'frontier', effort: 'high' }),
    legacy('grok', 300_000, { tier: 'balanced', effort: 'low' }),
  ], { now: NOW });
  assert.equal(expectedDuration(p, { provider: 'grok', role: 'review', tier: 'frontier', effort: 'high' }), null);
});

test('a cheaper-tier sample at a higher effort than this dispatch is not a floor for it', () => {
  // Frontier lowered to medium; the balanced samples were recorded at high.
  const p = durationProfile([700, 800, 900].map((s) => legacy('grok', s * 1000, { effort: 'high' })), { now: NOW });
  assert.equal(expectedDuration(p, { provider: 'grok', role: 'review', tier: 'frontier', effort: 'medium' }), null);
  assert.equal(expectedDuration(p, { provider: 'grok', role: 'review', tier: 'frontier', effort: 'high' }).floorFrom, 'balanced');
});

test('elapsed times read as minutes once they are long', () => {
  assert.equal(formatElapsed(45_000), '45s');
  assert.equal(formatElapsed(1_112_000), '18.5 min');
});

// ── routing ─────────────────────────────────────────────────────────────

test('the incident: a 600s review goes to codex first, with grok still on the ladder', () => {
  const durations = durationProfile(RECEIPTS, { now: NOW });
  const before = decide(REVIEW, LIMITS, { now: NOW });
  assert.equal(before.provider, 'grok', 'without timing, power-use sends the review to grok');

  const d = decide(REVIEW, LIMITS, { now: NOW, timeoutMs: 600_000, durations });
  assert.equal(d.provider, 'codex');
  assert.deepEqual(d.fallbacks.map((f) => f.provider), ['grok'], 'grok is tried if codex fails');
  const note = d.notes.find((n) => n.startsWith('time fit:'));
  assert.match(note, /grok usually overruns a 10\.0 min timeout on review·balanced \(grok 18\.5 min at p75 over 4\)/);
});

test('the 900s frontier review moves too, on the balanced floor', () => {
  const durations = durationProfile(RECEIPTS, { now: NOW });
  const d = decide({ ...REVIEW, complexity: 4, length: 'm' }, LIMITS, { now: NOW, timeoutMs: 900_000, durations });
  assert.equal(d.tier, 'frontier');
  assert.equal(d.provider, 'codex');
  assert.match(d.notes.join('\n'), /on balanced, as a floor/);
});

test('a timeout with room keeps grok first, so the idle subscription is still spent', () => {
  const durations = durationProfile(RECEIPTS, { now: NOW });
  const d = decide(REVIEW, LIMITS, { now: NOW, timeoutMs: 30 * MIN, durations });
  assert.equal(d.provider, 'grok');
  assert.ok(!d.notes.some((n) => n.startsWith('time fit:')));
});

test('no evidence, no move', () => {
  const durations = durationProfile(RECEIPTS.slice(0, 2), { now: NOW });
  assert.equal(decide(REVIEW, LIMITS, { now: NOW, timeoutMs: 600_000, durations }).provider, 'grok');
  assert.equal(decide(REVIEW, LIMITS, { now: NOW, timeoutMs: 600_000 }).provider, 'grok', 'no profile at all');
});

test('a pin is obeyed whatever the clock', () => {
  const durations = durationProfile(RECEIPTS, { now: NOW });
  const d = decide({ ...REVIEW, pin: 'grok' }, LIMITS, { now: NOW, timeoutMs: 600_000, durations });
  assert.equal(d.provider, 'grok');
});

test('timed-out attempts teach routing: three 600s timeouts and grok stops going first', () => {
  const timeouts = [1, 2, 3].map((i) => ({
    at: NOW - i * MIN, ok: true, role: 'review', provider: 'codex', failedOver: true,
    attemptLog: [
      { provider: 'grok', tier: 'balanced', effort: 'medium', ms: 600_000, failure: 'timeout' },
      { provider: 'codex', tier: 'balanced', effort: 'medium', ms: 200_000, failure: null },
    ],
  }));
  const durations = durationProfile(timeouts, { now: NOW });
  const d = decide(REVIEW, LIMITS, { now: NOW, timeoutMs: 600_000, durations });
  assert.equal(d.provider, 'codex');
  assert.match(d.notes.join('\n'), /3 timed out/);
});

test('a reserved orchestrator is not promoted past a slow vendor', () => {
  // Review of codex's work: grok or claude. Claude is past reserveAt.
  const limits = { codex: healthy(10), claude: healthy(70), grok: grokReading(9) };
  const durations = durationProfile(RECEIPTS, { now: NOW });
  const d = decide({ ...REVIEW, independentOf: 'codex' }, limits, { now: NOW, timeoutMs: 600_000, durations });
  assert.equal(d.provider, 'grok');
  assert.match(d.notes.join('\n'), /claude would fit but is reserved for the orchestrator — raise --timeout/);
});

test('when nobody fits, nothing moves and the note says to raise the timeout', () => {
  const durations = durationProfile(RECEIPTS, { now: NOW });
  const d = decide(REVIEW, LIMITS, { now: NOW, timeoutMs: 60_000, durations });
  assert.equal(d.provider, 'grok');
  assert.match(d.notes.join('\n'), /usually over the 60s timeout for review·balanced — raise --timeout/);
});

test('the fit can be switched off in config', () => {
  const durations = durationProfile(RECEIPTS, { now: NOW });
  const usable = [{ provider: 'grok', why: [] }, { provider: 'codex', why: [] }];
  const off = fitToTimeout(usable, {
    role: 'review', tier: 'balanced', timeoutMs: 600_000, durations, fit: { ...DEFAULT_DURATION_FIT, enabled: false },
  });
  assert.deepEqual(off.ordered.map((c) => c.provider), ['grok', 'codex']);
  const on = fitToTimeout(usable, { role: 'review', tier: 'balanced', timeoutMs: 600_000, durations, fit: DEFAULT_DURATION_FIT });
  assert.deepEqual(on.ordered.map((c) => c.provider), ['codex', 'grok']);
});

// ── the receipt that feeds it ───────────────────────────────────────────

test('every attempt is timed in the receipt, a timeout included', async () => {
  let clock = NOW;
  const INIT = '{"type":"system","subtype":"init","session_id":"s1","apiKeySource":"oauth","model":"grok-4.7"}';
  const spawnImpl = async (inv) => {
    if (inv.binary === 'claude') {
      clock += 2 * MIN;
      return { code: 0, signal: null, timedOut: false, aborted: null, stdout: JSON.stringify({ type: 'result', result: 'reviewed' }), stderr: '' };
    }
    clock += 10 * MIN;
    return { code: null, signal: 'SIGTERM', timedOut: true, aborted: null, stdout: INIT, stderr: 'cancelled' };
  };
  const out = await runAgent(
    {
      provider: 'grok', model: 'grok-4.7', tier: 'balanced', effort: 'medium', factors: { role: 'review' },
      fallbacks: [{ provider: 'claude', model: 'sonnet', tier: 'balanced', effort: 'medium' }],
    },
    'review it',
    { spawnImpl, sleep: async () => {}, now: () => clock, grokGate: async () => grokAuthFrom(SUBSCRIPTION), timeoutMs: 10 * MIN },
  );
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'claude');
  assert.equal(out.attempts[0].ms, 10 * MIN);
  const receipt = (await readAudit()).find((r) => r.id === out.dispatchId);
  assert.deepEqual(receipt.attemptLog, [
    { provider: 'grok', tier: 'balanced', effort: 'medium', ms: 10 * MIN, failure: 'timeout' },
    { provider: 'claude', tier: 'balanced', effort: 'medium', ms: 2 * MIN, failure: null },
  ]);
  const p = durationProfile([receipt], { now: clock });
  assert.deepEqual(p.grok['review·balanced'], [{ ms: 10 * MIN, effort: 'medium', timedOut: true }]);
});

test('routing reads only the tail of the audit log, from a line boundary', async () => {
  for (let i = 0; i < 40; i += 1) await record({ at: NOW + i, id: `tail-${i}`, ok: true, pad: 'x'.repeat(200) });
  const { size } = await stat(AUDIT_FILE);
  const tail = await readAudit({ tailBytes: 2_000 });
  assert.ok(tail.length > 0 && tail.length < 40, `read ${tail.length} rows of 40`);
  assert.equal(tail.at(-1).id, 'tail-39');
  assert.ok(tail.every((r) => typeof r.id === 'string'), 'no torn first line');
  assert.ok((await readAudit({ tailBytes: size * 2 })).some((r) => r.id === 'tail-0'), 'a tail larger than the file reads it all');
});

test('a run stopped short of the budget being judged says nothing; one stopped past it is an overrun', async () => {
  const { expectedDuration } = await import('../src/durations.mjs');
  const MIN_ = 60_000;
  const sample = (ms, timedOut = false) => ({ ms, effort: null, timedOut });
  const profile = { grok: { 'review·balanced': [sample(10 * MIN_), sample(11 * MIN_), sample(12 * MIN_), sample(2 * MIN_, true)] } };
  const at = (judgeMs) => expectedDuration(profile, { provider: 'grok', role: 'review', tier: 'balanced' }, { quantile: 0.75, minSamples: 3, judgeMs });
  // Judged at 27 min, the two-minute test stop is dropped: p75 of 10/11/12.
  assert.equal(at(27 * MIN_).ms, 12 * MIN_);
  assert.equal(at(27 * MIN_).n, 3);
  // Judged at 90 s, the stop at 2 min is an overrun.
  const short = expectedDuration(
    { grok: { 'review·balanced': [sample(2 * MIN_, true), sample(2 * MIN_, true), sample(2 * MIN_, true)] } },
    { provider: 'grok', role: 'review', tier: 'balanced' }, { quantile: 0.75, minSamples: 3, judgeMs: 90_000 },
  );
  assert.equal(short.ms, Infinity);
});
