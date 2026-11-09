// A signed-out claude CLI: read as signed out, never routed to, and reported
// with its remedy. The fixtures are the CLI's real output (2.1.289, 2026-11-09)
// with session ids and timestamps removed.

import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseClaudeAuthFailure, readClaudeLimits, readClaudeLimitsViaCli,
} from '../src/limits.mjs';
import { decide, providerState } from '../src/policy.mjs';
import { classifyFailure, parseClaudeStdout, runAgent } from '../src/run.mjs';
import { snapshot } from '../src/ledger.mjs';
import { grokAuthFrom } from '../src/grok.mjs';

const REASON = 'Failed to authenticate: OAuth session expired and could not be refreshed';

/** `claude -p … --output-format stream-json --verbose` with a lapsed login. */
const PROBE_SIGNED_OUT = [
  '{"type":"system","subtype":"init","apiKeySource":"none","model":"claude-haiku-4-5-20251001"}',
  JSON.stringify({
    type: 'assistant',
    message: { model: '<synthetic>', content: [{ type: 'text', text: REASON }], stop_reason: 'stop_sequence' },
    error: 'authentication_failed',
    is_api_error_message: true,
  }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: REASON, total_cost_usd: 0 }),
].join('\n');

/** `claude -p … --output-format json` with a lapsed login: one line, exit 1. */
const RUN_SIGNED_OUT = JSON.stringify({
  type: 'result', subtype: 'success', is_error: true, result: REASON,
  terminal_reason: 'api_error', total_cost_usd: 0,
});

const PROBE_OK = [
  '{"type":"system","subtype":"init","apiKeySource":"none","model":"claude-haiku-4-5-20251001"}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.1,"resetsAt":1791404400},"seven_day":{"utilization":0.62,"resetsAt":1791475200}}}}',
  '{"type":"result","subtype":"success","is_error":false,"result":"ok"}',
].join('\n');

const HEALTHY = {
  available: true, worstPercent: 5, nextResetAt: null, hardBlocked: false,
  windows: [{ key: '5h', percentUsed: 5 }],
};
const SIGNED_OUT = {
  available: false, provider: 'claude', windows: [],
  auth: { ok: false, method: 'none', reason: 'the claude CLI is signed out' },
};

test('the CLI\'s own words are read out of a signed-out turn', () => {
  assert.equal(parseClaudeAuthFailure(PROBE_SIGNED_OUT), REASON);
  assert.equal(parseClaudeAuthFailure(RUN_SIGNED_OUT), REASON);
});

test('a healthy turn, or one that failed for another reason, is not a sign-out', () => {
  assert.equal(parseClaudeAuthFailure(PROBE_OK), null);
  assert.equal(parseClaudeAuthFailure(''), null);
  const overloaded = JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 529 overloaded' });
  assert.equal(parseClaudeAuthFailure(overloaded), null);
  // An answer that merely discusses logins is work product, not a failure.
  const prose = JSON.stringify({ type: 'result', is_error: false, result: 'Failed to authenticate is a common error' });
  assert.equal(parseClaudeAuthFailure(prose), null);
});

test('a signed-out meter says so, names the fix, and does not run the costlier turn', async () => {
  const calls = [];
  const reading = await readClaudeLimitsViaCli({
    probe: async (opts) => { calls.push(opts); return PROBE_SIGNED_OUT; },
  });
  assert.equal(reading.available, false);
  assert.equal(reading.auth.ok, false);
  assert.match(reading.error, /signed out/);
  assert.match(reading.error, /\/login/);
  assert.deepEqual(calls, [{ lean: true }], 'the plain turn would fail the same way');
});

test('a sign-out seen only on the plain turn is still reported as one', async () => {
  const outputs = ['', PROBE_SIGNED_OUT];
  const reading = await readClaudeLimitsViaCli({ probe: async () => outputs.shift() });
  assert.equal(reading.auth?.ok, false);
});

test('a CLI with plan windows still reads normally', async () => {
  const reading = await readClaudeLimitsViaCli({ probe: async () => PROBE_OK });
  assert.equal(reading.available, true);
  assert.equal(reading.auth, undefined);
});

test('the sign-out outranks the missing credentials file in the combined reading', async () => {
  const reading = await readClaudeLimits({
    credentialsPath: '/nonexistent/.credentials.json',
    cli: async () => readClaudeLimitsViaCli({ probe: async () => PROBE_SIGNED_OUT }),
  });
  assert.equal(reading.auth?.ok, false);
  assert.doesNotMatch(reading.error, /ENOENT/);
});

test('a signed-out vendor is not routable; one with no auth field is merely unknown', () => {
  assert.equal(providerState(SIGNED_OUT, undefined, Date.now(), 'claude').state, 'unauthenticated');
  const dark = { available: false, provider: 'claude', windows: [], error: 'no reading' };
  assert.equal(providerState(dark, undefined, Date.now(), 'claude').state, 'unknown');
});

test('work pinned to a signed-out claude defers instead of failing on auth', () => {
  const d = decide(
    { role: 'implement', complexity: 3, length: 'm', pin: 'claude' },
    { codex: HEALTHY, claude: SIGNED_OUT },
  );
  assert.equal(d.ok, false);
  assert.equal(d.defer, true);
});

test('cross-vendor review of codex work skips a signed-out claude', () => {
  const grok = {
    ...HEALTHY, provider: 'grok',
    auth: grokAuthFrom({ authenticated: true, meta: { auth_mode: 'Oidc', subscription_tier: 'SuperGrok Plus', backend_billed: false } }),
  };
  const d = decide(
    { role: 'review', complexity: 3, length: 's', independentOf: 'codex' },
    { codex: HEALTHY, claude: SIGNED_OUT, grok },
  );
  assert.equal(d.provider, 'grok');
  assert.ok(!d.fallbacks.some((f) => f.provider === 'claude'));
});

test('a failed claude run is a diagnosis, never an answer', () => {
  const parsed = parseClaudeStdout(RUN_SIGNED_OUT);
  assert.equal(parsed.text, '');
  assert.equal(parsed.error, REASON);
  assert.equal(classifyFailure({ code: 1, stderr: parsed.error }), 'auth');
  // A successful run is untouched.
  assert.equal(parseClaudeStdout(JSON.stringify({ type: 'result', is_error: false, result: 'done' })).text, 'done');
});

test('a dispatch that meets a signed-out claude reports why and warns the whole machine', async () => {
  const spawnImpl = async () => ({
    code: 1, signal: null, timedOut: false, aborted: null, stdout: RUN_SIGNED_OUT, stderr: '',
  });
  const out = await runAgent(
    { provider: 'claude', model: 'sonnet', tier: 'balanced', effort: 'medium', fallbacks: [] },
    'task',
    { spawnImpl, sleep: async () => {}, maxAttempts: 3 },
  );
  assert.equal(out.ok, false);
  assert.equal(out.attempts.length, 1, 'an auth failure is not retried');
  assert.equal(out.attempts[0].failure, 'auth');
  assert.match(out.error, /OAuth session expired/);
  const st = await snapshot();
  assert.equal(st.probes.claude.value.auth.ok, false, 'the next decision routes around claude');
});
