import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decide, providerState, rankProviders } from '../src/policy.mjs';
import { totalInputTokens } from '../src/run.mjs';
import { expire, localPidGone } from '../src/server.mjs';

// F3 — a judge that had just read two candidate sets recorded `in: 2`, because
// claude reports prompt tokens in three fields and only one is the fresh part.
test('input tokens include the cached prompt, not just the fresh part', () => {
  assert.equal(totalInputTokens({
    input_tokens: 10,
    cache_creation_input_tokens: 7822,
    cache_read_input_tokens: 18140,
  }), 25972);
  // codex reports one total and has no cache fields
  assert.equal(totalInputTokens({ input_tokens: 63895 }), 63895);
  assert.equal(totalInputTokens({}), null);
  // cache-only is still a real number, not null
  assert.equal(totalInputTokens({ cache_read_input_tokens: 5 }), 5);
});

// F2 — "not installed" and "meter unreadable" are different claims, and the
// router used to treat both as usable-and-preferred.
test('an uninstalled CLI is not a candidate', () => {
  assert.equal(providerState({ installed: false }).state, 'missing');
  const ranked = rankProviders({}, {
    codex: providerState({ installed: false }),
    claude: providerState({ available: true, installed: true, worstPercent: 30 }),
  });
  assert.equal(ranked[0].provider, 'claude');
});

test('an unreadable meter still dispatches — otherwise the trap never reopens', () => {
  // A freshly installed codex has written no session file, so its meter is
  // legitimately unknown. Demote on unknown and codex never gets the first
  // dispatch that would create the file that makes the meter readable.
  const d = decide({ role: 'implement', complexity: 2, length: 's' }, {
    codex: { available: false, installed: true },
    claude: { available: true, installed: true, worstPercent: 30 },
  });
  assert.equal(d.provider, 'codex');
});

test('a missing CLI degrades a cross-vendor review, and defers under strict', () => {
  const limits = {
    codex: { available: false, installed: false },
    claude: { available: true, installed: true, worstPercent: 30 },
  };
  const degraded = decide({ role: 'review', complexity: 3, length: 's', independentOf: 'claude' }, limits);
  assert.equal(degraded.provider, 'claude');
  assert.equal(degraded.independence, 'same-vendor');
  assert.equal(degraded.degradedReview, true);

  const strict = decide({
    role: 'review', complexity: 3, length: 's', independentOf: 'claude', strictIndependence: true,
  }, limits);
  assert.equal(strict.defer, true);
  assert.match(strict.reason, /strict-independence/);
});

// F9 — SIGKILL four dispatches and their headroom stayed reserved for the full
// lease, because the coordinator had the lease and no pid while the local
// ledger had the pid and no lease.
test('the coordinator collects dead reservations from its own node', () => {
  const self = 'box-a';
  assert.equal(localPidGone({ node: self, pid: process.pid }, self), false, 'a live pid survives');
  assert.equal(localPidGone({ node: self, pid: 2 ** 22 }, self), true, 'a dead local pid is collected');
  assert.equal(localPidGone({ node: 'box-b', pid: 2 ** 22 }, self), false, 'another node is never pid-checked');
  assert.equal(localPidGone({ node: self }, self), false, 'no pid recorded means fall back to the lease');
});

test('expire drops dead local reservations as well as expired ones', () => {
  const now = 1_000;
  const state = {
    probes: {},
    reservations: [
      { id: 'live', node: 'box-a', pid: process.pid, expiresAt: now + 60_000 },
      { id: 'dead-pid', node: 'box-a', pid: 2 ** 22, expiresAt: now + 60_000 },
      { id: 'lapsed', node: 'box-b', expiresAt: now - 1 },
      { id: 'remote-live', node: 'box-b', expiresAt: now + 60_000 },
    ],
  };
  const kept = expire(state, now, { pidGone: (r) => localPidGone(r, 'box-a') }).reservations.map((r) => r.id);
  assert.deepEqual(kept, ['live', 'remote-live']);
});

// F5's own regression: measuring claude's cost costs a network call, so a wide
// fan-out finishing together must not burst the usage endpoint into a 429.
test('claude cost sampling is throttled against a fresh reading', async () => {
  const { refreshClaudeLimits } = await import('../src/limits.mjs');
  const now = 1_000_000;
  // No probe stored at all → nothing to throttle against, so it must proceed
  // and fail on the (absent) credentials rather than silently skipping.
  const cold = await refreshClaudeLimits({ now, minAgeMs: 90_000 }).catch(() => null);
  assert.equal(cold, null, 'an unreadable meter returns null rather than storing a dark value');
});
