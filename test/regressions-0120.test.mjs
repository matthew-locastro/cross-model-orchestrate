import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetConfigCache } from '../src/config.mjs';
import { mutate, snapshot } from '../src/ledger.mjs';
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
test('claude cost sampling throttles a fresh reading and fetches on the cold path', async () => {
  const { refreshClaudeLimits } = await import('../src/limits.mjs');
  const now = 1_000_000;
  await mutate((state) => {
    state.probes.claude = { storedAt: now - 1_000, value: { available: true } };
  }, { now: () => now });

  // The old test assumed credentials were absent. That passes in CI and fails
  // on a developer machine where the live endpoint answers, without testing
  // throttling at all. Give the unthrottled path valid credentials and a fake
  // endpoint so crossing that boundary is deterministic and observable.
  const dir = await mkdtemp(join(tmpdir(), 'cmo-throttle-'));
  const credentialsPath = join(dir, '.credentials.json');
  await writeFile(credentialsPath, JSON.stringify({
    claudeAiOauth: { accessToken: 'tok-live', expiresAt: Date.now() + 3_600_000 },
  }));
  const oldCredentials = process.env.CMO_CLAUDE_CREDENTIALS;
  const oldFetch = globalThis.fetch;
  let fetches = 0;
  let fetchFails = false;
  process.env.CMO_CLAUDE_CREDENTIALS = credentialsPath;
  globalThis.fetch = async () => {
    fetches += 1;
    if (fetchFails) return { ok: false, status: 429 };
    return {
      ok: true,
      json: async () => ({ limits: [{ group: 'session', percent: 20 }] }),
    };
  };
  resetConfigCache();

  try {
    const skipped = await refreshClaudeLimits({ now, minAgeMs: 90_000 });
    assert.equal(skipped, null, 'a fresh reading skips the cost-sampling probe');
    assert.equal(fetches, 0, 'throttling must happen before the usage endpoint is called');

    await mutate((state) => {
      delete state.probes.claude;
    }, { now: () => now });
    const refreshed = await refreshClaudeLimits({ now, minAgeMs: 90_000 });
    assert.equal(refreshed?.available, true, 'the cold path returns the successful reading');
    assert.equal(fetches, 1, 'without a stored probe the usage endpoint is called exactly once');

    fetchFails = true;
    const failedAt = now + 90_001;
    const dark = await refreshClaudeLimits({ now: failedAt, minAgeMs: 90_000 });
    assert.equal(dark, null, 'a failed refresh returns no reading');
    assert.equal(fetches, 2, 'a stale reading reaches the usage endpoint');
    const retained = await snapshot({ now: () => failedAt, local: true });
    assert.equal(retained.probes.claude.storedAt, now,
      'a failed refresh must not replace the last good reading');
    assert.equal(retained.probes.claude.value.available, true,
      'the stored meter must never be overwritten by a dark reading');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldCredentials === undefined) delete process.env.CMO_CLAUDE_CREDENTIALS;
    else process.env.CMO_CLAUDE_CREDENTIALS = oldCredentials;
    resetConfigCache();
    await mutate((state) => {
      delete state.probes.claude;
    });
    await rm(dir, { recursive: true, force: true });
  }
});
