// A meter that errors for a moment (xAI's usage query answers "Internal
// error" now and then) must not send a vendor with most of its week left to
// the back of the queue: it stands on its last good reading, within limits.

import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decide, providerState } from '../src/policy.mjs';
import { grokAuthFrom } from '../src/grok.mjs';
import { holdLastGood, markExhausted, readLimits } from '../src/limits.mjs';
import { freshProbe, lastGoodReading, mutate } from '../src/ledger.mjs';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const MIN = 60_000;
const TASK = { role: 'implement', complexity: 3, length: 'm' };

const GROK_AUTH = grokAuthFrom({
  authenticated: true,
  meta: { auth_mode: 'Oidc', subscription_tier: 'SuperGrok Plus', backend_billed: false },
});

/** A reading with no reset time, so pressure is the raw figure. */
const at = (pct, extra = {}) => ({
  available: true,
  installed: true,
  worstPercent: pct,
  windows: [{ key: 'weekly', label: 'Wkly', percentUsed: pct }],
  ...extra,
});
const grokAt = (pct, extra = {}) => at(pct, { provider: 'grok', auth: GROK_AUTH, ...extra });

const GROK_GOOD = grokAt(6, {
  windows: [{ key: 'weekly', label: 'Wkly', percentUsed: 6, resetsAt: '2026-11-14T03:26:11.085Z' }],
});
const GROK_METER_FAILED = {
  available: false,
  provider: 'grok',
  windows: [],
  error: 'grok usage query failed: Internal error',
  auth: GROK_AUTH,
};

test('a meter that errors stands on its last good reading, marked stale, with the fresh auth', async () => {
  assert.equal(await holdLastGood('grok', GROK_GOOD, { now: NOW }), GROK_GOOD);
  const held = await holdLastGood('grok', GROK_METER_FAILED, { now: NOW + 10 * MIN });
  assert.equal(held.available, true);
  assert.equal(held.worstPercent, 6);
  assert.deepEqual(held.auth, GROK_AUTH);
  assert.equal(held.stale.ageMs, 10 * MIN);
  assert.match(held.stale.error, /Internal error/);
  assert.equal(providerState(held, undefined, NOW + 10 * MIN, 'grok').state, 'ok');
});

test('the last good reading never stands in past its age, across a reset, or over a sign-out', async () => {
  await holdLastGood('grok', GROK_GOOD, { now: NOW });
  assert.equal((await holdLastGood('grok', GROK_METER_FAILED, { now: NOW + 31 * MIN })).available, false, 'too old');
  assert.equal((await holdLastGood('grok', GROK_METER_FAILED, { now: NOW + 5 * MIN, maxAgeMs: 0 })).available, false, 'turned off');

  const signedOut = { ...GROK_METER_FAILED, auth: { ok: false, method: 'none', reason: 'not signed in' } };
  const out = await holdLastGood('grok', signedOut, { now: NOW + 5 * MIN });
  assert.equal(out.available, false, 'a sign-out is a fact, not a gap');
  assert.equal(out.auth.ok, false);

  const noVerdict = { available: false, provider: 'grok', windows: [], error: 'grok usage query failed: Internal error' };
  assert.equal((await holdLastGood('grok', noVerdict, { now: NOW + 5 * MIN })).available, false,
    'no fresh sign-in verdict: the old one must not vouch for it');

  const missing = { available: false, installed: false, error: 'not on PATH' };
  assert.equal((await holdLastGood('grok', missing, { now: NOW + 5 * MIN })).available, false, 'a missing CLI too');

  const resetsSoon = at(70, {
    windows: [{ key: 'weekly', label: 'Wkly', percentUsed: 70, resetsAt: new Date(NOW + 5 * MIN).toISOString() }],
  });
  await holdLastGood('codex', resetsSoon, { now: NOW });
  const after = await holdLastGood('codex', { available: false, error: 'no session file' }, { now: NOW + 10 * MIN });
  assert.equal(after.available, false, 'the window reset since, so 70% is no longer true');
});

test('readLimits routes on the held reading while the meter is down', async () => {
  let calls = 0;
  const readers = {
    codex: async () => at(50),
    claude: async () => at(50),
    grok: async () => (calls++ === 0 ? GROK_GOOD : GROK_METER_FAILED),
  };
  await readLimits({ refresh: true, readers, now: NOW });
  const later = await readLimits({ refresh: true, readers, now: NOW + 2 * MIN });
  assert.equal(calls, 2);
  assert.equal(later.grok.available, true);
  assert.ok(later.grok.stale);
  assert.equal(decide(TASK, later, { now: NOW + 2 * MIN }).provider, 'grok');
});


test('a rate-limit error moves the last good reading forward: a later meter failure stays exhausted', async () => {
  await holdLastGood('grok', GROK_GOOD, { now: NOW });
  await markExhausted('grok', { now: NOW + MIN });
  const held = await holdLastGood('grok', GROK_METER_FAILED, { now: NOW + 3 * MIN });
  assert.equal(held.hardBlocked, true, 'never the 6% from before the rate limit');
  assert.equal(providerState(held, undefined, NOW + 3 * MIN, 'grok').state, 'exhausted');
});

test('a cached stand-in is not served past its expiry', async () => {
  let calls = 0;
  const T = NOW + 10 * 24 * 60 * MIN; // a fresh stretch of this file's ledger
  const good = { ...GROK_GOOD, windows: [{ ...GROK_GOOD.windows[0], resetsAt: new Date(T + 3 * 24 * 60 * MIN).toISOString() }] };
  const readers = {
    codex: async () => at(50),
    claude: async () => at(50),
    grok: async () => { calls += 1; return calls === 1 ? good : GROK_METER_FAILED; },
  };
  await readLimits({ refresh: true, readers, now: T });
  const near = await readLimits({ refresh: true, readers, now: T + 29.8 * MIN });
  assert.ok(near.grok.stale, 'inside the window it stands in');
  // 24 seconds later: inside grok's 60s cache, but past the stand-in's expiry.
  const past = await readLimits({ readers, now: T + 30.2 * MIN });
  assert.equal(calls, 3, 'the expired stand-in was not served from cache');
  assert.equal(past.grok.available, false);
});

test('on an equal clock the later write is the last good reading', async () => {
  const T = NOW + 20 * 24 * 60 * MIN;
  await holdLastGood('grok', grokAt(6), { now: T });
  await markExhausted('grok', { now: T });
  const held = await holdLastGood('grok', GROK_METER_FAILED, { now: T + MIN });
  assert.equal(held.hardBlocked, true);
});

test('a stand-in ends exactly at its age limit', async () => {
  const T = NOW + 30 * 24 * 60 * MIN;
  await holdLastGood('grok', grokAt(6), { now: T }); // no reset time, so only age decides
  assert.equal((await holdLastGood('grok', GROK_METER_FAILED, { now: T + 30 * MIN - 1 })).available, true);
  assert.equal((await holdLastGood('grok', GROK_METER_FAILED, { now: T + 30 * MIN })).available, false);
});

test('a cached stand-in with no readable expiry is not served', async () => {
  const T = NOW + 40 * 24 * 60 * MIN;
  const legacy = { ...GROK_GOOD, stale: { since: new Date(T - MIN).toISOString(), ageMs: MIN } };
  await mutate((st) => { st.probes.grok = { storedAt: T, value: legacy }; });
  let read = 0;
  const r = await freshProbe('grok', 60_000, async () => { read += 1; return GROK_GOOD; }, { now: () => T + 1000 });
  assert.equal(read, 1, 'fail closed: re-read rather than trust a stand-in of unknown age');
  assert.equal(r.cached, false);
});

test('a probe write that is not a good reading leaves the last good one alone', async () => {
  const T = NOW + 50 * 24 * 60 * MIN;
  await holdLastGood('codex', at(30), { now: T });
  await mutate((st) => { st.probes.codex = { storedAt: T + MIN, value: { available: false, error: 'no session file' } }; });
  assert.equal((await lastGoodReading('codex')).value.worstPercent, 30);
});

