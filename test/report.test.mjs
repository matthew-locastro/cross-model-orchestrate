import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findings, tierStats, failureTaxonomy } from '../src/audit.mjs';

// A soak that ends with "it felt fine" taught nothing. These assert that the
// log turns into specific changes rather than a wall of counts.

const row = (o) => ({ at: Date.now(), ok: true, provider: 'codex', model: 'terra', ...o });
const many = (n, o) => Array.from({ length: n }, () => row(o));

test('a healthy window produces no findings', () => {
  const rows = many(20, { tier: 'balanced', durationMs: 60_000, role: 'implement' });
  assert.deepEqual(findings(rows), []);
});

test('failures are surfaced with the commonest kind named', () => {
  const rows = [...many(18, { tier: 'balanced', durationMs: 60_000 }),
    ...many(3, { ok: false, failures: ['timeout'], tier: 'balanced', durationMs: 30_000 })];
  const f = findings(rows).find((x) => /failed/.test(x.finding));
  assert.ok(f, 'a failure rate above 5% must be reported');
  assert.equal(f.severity, 'high');
  assert.match(f.finding, /timeout/);
  assert.match(f.action, /Raise --timeout/);
});

test('a Claude-heavy window is called out, because that is the whole point', () => {
  const rows = [...many(3, { provider: 'codex' }), ...many(17, { provider: 'claude', model: 'sonnet' })];
  const f = findings(rows).find((x) => /codex/.test(x.finding));
  assert.equal(f.severity, 'high');
  assert.match(f.finding, /only 15%/);
  assert.match(f.action, /codex-runner/);
});

test('degraded reviews are flagged as provisional', () => {
  const rows = [
    ...many(2, { independence: 'cross-vendor', role: 'judge' }),
    ...many(2, { independence: 'same-vendor', role: 'judge', degradedReview: true }),
  ];
  const f = findings(rows).find((x) => /same-vendor/.test(x.finding));
  assert.equal(f.severity, 'high', 'half the reviews degraded is not a footnote');
  assert.match(f.action, /Re-grade/);
});

test('retries are treated as waste, not noise', () => {
  const rows = [...many(14, {}), ...many(6, { retried: true, attempts: 2 })];
  const f = findings(rows).find((x) => /more than one attempt/.test(x.finding));
  assert.equal(f.severity, 'medium');
});

test('a tier that always finishes instantly is over-provisioned', () => {
  const rows = many(12, { tier: 'frontier', durationMs: 5_000 });
  const f = findings(rows).find((x) => /frontier tier/.test(x.finding));
  assert.ok(f, 'frontier work finishing in 5s did not need frontier');
  assert.match(f.action, /lowering complexity/);
});

test('the fast tier is never called over-provisioned — there is nothing below it', () => {
  const rows = many(12, { tier: 'fast', durationMs: 3_000 });
  assert.equal(findings(rows).find((x) => /fast tier/.test(x.finding)), undefined);
});

test('a measured cost far under the default means reservations over-reserve', () => {
  const f = findings(many(10, {}), { perAgentCost: 0.19 }).find((x) => /measured cost/.test(x.finding));
  assert.match(f.action, /over-reserving/);
});

test('timing is reported per tier as a spread, not an average', () => {
  const rows = [...many(9, { tier: 'balanced', durationMs: 10_000 }), row({ tier: 'balanced', durationMs: 90_000 })];
  const s = tierStats(rows).balanced;
  assert.equal(s.count, 10);
  assert.equal(s.p50, 10_000);
  assert.equal(s.p95, 90_000, 'the slow one must not be averaged away');
});

test('every failure kind is counted, commonest first', () => {
  const t = failureTaxonomy([
    row({ failures: ['timeout'] }), row({ failures: ['timeout'] }),
    row({ failures: ['rate-limit'] }), row({ ok: false, failures: [] }),
  ]);
  assert.deepEqual(Object.keys(t), ['timeout', 'rate-limit', 'unknown']);
  assert.equal(t.timeout, 2);
});

test('an empty window says nothing rather than inventing findings', () => {
  assert.deepEqual(findings([]), []);
});

test('a dark meter outranks every other finding', () => {
  // Everything else is computed against headroom the tool can no longer see,
  // and unknown headroom is treated as usable — so a blind meter fails toward
  // over-dispatching rather than stopping.
  const f = findings(many(10, {}), {
    limits: { claude: { available: false, error: 'claude oauth token expired — run `claude` once to refresh' } },
  });
  assert.equal(f[0].severity, 'high');
  assert.match(f[0].finding, /claude meter is dark/);
  assert.match(f[0].action, /refresh the OAuth token/);
});

test('a dark meter is reported even with no dispatches at all', () => {
  const f = findings([], { limits: { codex: { available: false, error: 'no rollouts' } } });
  assert.equal(f.length, 1);
  assert.match(f[0].finding, /codex meter is dark/);
});
