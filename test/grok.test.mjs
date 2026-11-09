// grok.test.mjs — the third provider, and above all its billing guarantee:
// grok runs on the SuperGrok subscription or not at all, never on an API key.
import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';

import {
  grokAuthFrom, grokRpc, grokWindowsFrom, lockGrokEnv, offSubscriptionReason, parseGrokModels,
  parseGrokStream, probeGrok, startedOffSubscription,
} from '../src/grok.mjs';
import { readGrokLimits, readLimits } from '../src/limits.mjs';
import { decide, providerState, pressure } from '../src/policy.mjs';
import { buildCommand, childEnv, classifyFailure, runAgent } from '../src/run.mjs';
import { parseDispatchFile } from '../src/dispatch-file.mjs';
import { findings, readAudit, summarise } from '../src/audit.mjs';
import { snapshot } from '../src/ledger.mjs';

// ── fixtures, shaped on what grok 1.0.77 actually returned ───────────────

const BILLING = {
  config: {
    creditUsagePercent: 9,
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-11-07T03:26:11.085+00:00',
      end: '2026-11-14T03:26:11.085+00:00',
    },
    prepaidBalance: { val: 0 },
    isUnifiedBillingUser: true,
  },
  subscription_tier: 'SuperGrok Plus',
};
const SUBSCRIPTION = {
  authenticated: true,
  meta: { email: 'someone@example.com', auth_mode: 'Oidc', subscription_tier: 'SuperGrok Plus', backend_billed: false },
};
const STREAM_OK = [
  '{"type":"system","subtype":"init","session_id":"s1","apiKeySource":"oauth","model":"grok-4.7","permissionMode":"bypassPermissions"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}',
  '{"type":"result","subtype":"success","is_error":false,"result":"ok","stop_reason":"end_turn","usage":{"input_tokens":20865,"output_tokens":307,"cache_read_input_tokens":2304,"cache_creation_input_tokens":0}}',
].join('\n');
const STREAM_SIGNED_OUT = [
  '{"type":"system","subtype":"init","session_id":"","apiKeySource":"user","model":"unknown"}',
  '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["Not signed in. To authenticate without a browser, run:\\n  grok login --device-code"]}',
].join('\n');
const STREAM_ON_KEY = STREAM_OK.replace('"apiKeySource":"oauth"', '"apiKeySource":"user"');

const HOUR = 3_600_000;
const healthy = (percent = 5) => ({
  available: true, worstPercent: percent, nextResetAt: null, hardBlocked: false,
  windows: [{ key: '5h', percentUsed: percent }],
});
const spent = () => ({ ...healthy(99), hardBlocked: true });
const grokReading = (auth = grokAuthFrom(SUBSCRIPTION), percent = 9) => ({
  provider: 'grok',
  available: true,
  worstPercent: percent,
  hardBlocked: false,
  windows: [{ key: 'weekly', label: 'Wkly', percentUsed: percent, resetsAt: new Date(Date.now() + 100 * HOUR).toISOString() }],
  auth,
});

// ── auth ─────────────────────────────────────────────────────────────────

test('a signed-in OAuth subscription passes, and the email is not kept', () => {
  const a = grokAuthFrom(SUBSCRIPTION);
  assert.equal(a.ok, true);
  assert.equal(a.method, 'oauth');
  assert.equal(a.tier, 'SuperGrok Plus');
  assert.ok(!JSON.stringify(a).includes('example.com'), 'the account email must not reach the ledger');
});

test('every other sign-in state fails closed', () => {
  assert.equal(grokAuthFrom(null).ok, false);
  assert.equal(grokAuthFrom({ authenticated: false }).method, 'none');
  assert.equal(grokAuthFrom({ authenticated: true, meta: { auth_mode: 'ApiKey', subscription_tier: 'x' } }).method, 'api-key');
  assert.equal(grokAuthFrom({ authenticated: true, meta: { auth_mode: 'DeploymentKey', subscription_tier: 'x' } }).ok, false);
  assert.equal(grokAuthFrom({ authenticated: true, meta: { auth_mode: 'Mystery', subscription_tier: 'x' } }).ok, false,
    'an auth mode cmo does not recognise is not assumed to be the subscription');
  assert.equal(grokAuthFrom({ authenticated: true, meta: { auth_mode: 'Oidc', subscription_tier: null } }).ok, false,
    'signed in with no subscription tier is not a subscription');
  assert.equal(grokAuthFrom({ ...SUBSCRIPTION, meta: { ...SUBSCRIPTION.meta, backend_billed: true } }).ok, false);
  const { backend_billed: _, ...noBilling } = SUBSCRIPTION.meta;
  assert.equal(grokAuthFrom({ ...SUBSCRIPTION, meta: noBilling }).ok, false, 'an absent billing flag is not evidence');
});

test('`grok models` status lines classify every sign-in the CLI can report', () => {
  assert.equal(parseGrokModels('You are logged in with grok.com.\n\nDefault model: grok-4.7\n').method, 'oauth');
  assert.equal(parseGrokModels('You are using XAI_API_KEY.\n').method, 'api-key');
  assert.equal(parseGrokModels('You are authenticated via XAI_API_KEY (environment variable).\n').method, 'api-key');
  assert.equal(parseGrokModels('You are authenticated via deployment key.\n').method, 'api-key');
  assert.equal(parseGrokModels('You are not authenticated.\n').method, 'none');
  assert.equal(parseGrokModels('You are using a deprecated authentication method (WebLogin).\n').method, 'web-login');
  const listing = parseGrokModels([
    'You are logged in with grok.com.',
    "Model 'grok-4.6' is using its own API key.",
    '',
    'Default model: grok-4.7',
    '',
    'Available models:',
    '  * grok-4.7 (default)',
    '  - grok-4.7-build-fast',
  ].join('\n'));
  assert.deepEqual(listing.modelKeys, ['grok-4.6']);
  assert.deepEqual(listing.models, ['grok-4.7', 'grok-4.7-build-fast']);
  assert.equal(listing.defaultModel, 'grok-4.7');
});

// ── the locks ────────────────────────────────────────────────────────────

test('grok children never see an xAI key and are told to refuse one', () => {
  const base = { XAI_API_KEY: 'xai-x', GROK_CODE_XAI_API_KEY: 'xai-y', HOME: '/h' };
  for (const env of [lockGrokEnv(base), childEnv(base)]) {
    assert.ok(!('XAI_API_KEY' in env));
    assert.ok(!('GROK_CODE_XAI_API_KEY' in env));
    assert.equal(env.GROK_DISABLE_API_KEY_AUTH, '1');
    assert.equal(env.HOME, '/h');
  }
  assert.equal(base.XAI_API_KEY, 'xai-x', 'the caller environment is not modified');
});

test('a key-billed session is caught on its init line; a failed start is not mistaken for one', () => {
  assert.equal(startedOffSubscription(parseGrokStream(STREAM_ON_KEY)), true);
  assert.equal(startedOffSubscription(parseGrokStream(STREAM_OK)), false);
  // Signed out prints an init with a placeholder source and model "unknown".
  // That is an auth failure, and must classify as one, not as API billing.
  assert.equal(startedOffSubscription(parseGrokStream(STREAM_SIGNED_OUT)), false);
  assert.match(offSubscriptionReason(`${STREAM_ON_KEY.split('\n')[0]}\n`), /not the subscription/);
  assert.equal(offSubscriptionReason(STREAM_OK.split('\n')[0]), null, 'half a line is not a verdict');
});

// ── the stream ───────────────────────────────────────────────────────────

test('a finished grok stream yields its answer and usage', () => {
  const s = parseGrokStream(STREAM_OK);
  assert.equal(s.text, 'ok');
  assert.equal(s.apiKeySource, 'oauth');
  assert.equal(s.usage.input_tokens, 20865);
  assert.equal(s.finished, true);
});

test('a failed grok stream yields no text and the CLI error', () => {
  const s = parseGrokStream(STREAM_SIGNED_OUT);
  assert.equal(s.text, '');
  assert.equal(s.isError, true);
  assert.match(s.error, /Not signed in/);
  assert.equal(classifyFailure({ code: 1, stdout: STREAM_SIGNED_OUT, stderr: s.error }), 'auth');
});

test("grok's limit error codes are rate limits", () => {
  for (const code of ['usage_limit_reached', 'usage_pool_exhausted', 'rate_limited', 'global_rate_limit']) {
    assert.equal(classifyFailure({ code: 1, stderr: `error: ${code}` }), 'rate-limit', code);
  }
});

// ── the meter ────────────────────────────────────────────────────────────

test('the billing answer becomes one weekly window with its reset', () => {
  const b = grokWindowsFrom(BILLING);
  assert.deepEqual(b.windows, [{
    key: 'weekly', label: 'Wkly', percentUsed: 9, resetsAt: '2026-11-14T03:26:11.085Z',
  }]);
  assert.equal(b.plan, 'SuperGrok Plus');
  assert.equal(b.unifiedBilling, true);
  assert.equal(b.prepaidBalance, 0);
  assert.equal(grokWindowsFrom({ config: {} }), null);
});

/** A stand-in `grok agent stdio` that answers JSON-RPC from a table. */
function fakeAgent(answers) {
  const calls = [];
  const spawnImpl = (binary, args, opts) => {
    calls.push({ binary, args, env: opts.env });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => { child.stdout.end(); setImmediate(() => child.emit('close', 0)); };
    let buf = '';
    child.stdin.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        const reply = msg.method === 'initialize'
          ? { result: { protocolVersion: 1 } }
          : (answers[msg.method] ?? { error: { code: -32601, message: 'Method not found' } });
        child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply })}\n`);
      }
    });
    return child;
  };
  return { spawnImpl, calls };
}

test('the probe asks the agent protocol, under the locked env, and reads both answers', async () => {
  const agent = fakeAgent({
    '_x.ai/billing': { result: BILLING },
    '_x.ai/auth/check_subscription': { result: SUBSCRIPTION },
  });
  const out = await probeGrok('/fake/grok', { spawnImpl: agent.spawnImpl, env: { XAI_API_KEY: 'xai-z' } });
  assert.equal(out.auth.ok, true);
  assert.equal(out.billing.windows[0].percentUsed, 9);
  assert.deepEqual(agent.calls[0].args, ['agent', '--no-leader', 'stdio']);
  assert.ok(!('XAI_API_KEY' in agent.calls[0].env), 'even the meter never runs with a key available');
});

test('a CLI that no longer has the methods leaves grok unverified, not trusted', async () => {
  const agent = fakeAgent({});
  const out = await probeGrok('/fake/grok', { spawnImpl: agent.spawnImpl });
  assert.equal(out.auth.ok, false);
  assert.equal(out.billing, null);
  assert.equal(out.errors.length, 2);
});

test('grokRpc rejects when the CLI is not there', async () => {
  const spawnImpl = () => { const e = new Error('spawn grok ENOENT'); e.code = 'ENOENT'; throw e; };
  await assert.rejects(grokRpc('grok', ['_x.ai/billing'], { spawnImpl }), /ENOENT/);
});

test('readGrokLimits carries auth on every reading', async () => {
  const ok = await readGrokLimits({ probe: async () => ({ auth: grokAuthFrom(SUBSCRIPTION), billing: grokWindowsFrom(BILLING) }) });
  assert.equal(ok.available, true);
  assert.equal(ok.worstPercent, 9);
  assert.equal(ok.auth.ok, true);
  assert.equal(ok.plan, 'SuperGrok Plus');

  const signedOut = await readGrokLimits({ probe: async () => ({ auth: grokAuthFrom({ authenticated: false }), billing: null }) });
  assert.equal(signedOut.available, false);
  assert.equal(signedOut.auth.method, 'none');

  const missing = await readGrokLimits({ probe: async () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } });
  assert.equal(missing.installed, false);
  assert.equal(missing.auth.ok, false);
});

test('the test suite never probes the real grok CLI', async () => {
  const r = await readGrokLimits();
  assert.equal(r.auth.ok, false);
  assert.match(r.auth.reason, /disabled/);
});

test('readLimits reports grok alongside the others, unverified unless a reader says otherwise', async () => {
  const codex = async () => healthy();
  const claude = async () => healthy();
  const without = await readLimits({ readers: { codex, claude }, refresh: true });
  assert.equal(without.grok.auth.ok, false);
  const withGrok = await readLimits({
    readers: { codex, claude, grok: async () => grokReading() },
    refresh: true,
  });
  assert.equal(withGrok.grok.auth.ok, true);
  assert.equal(typeof withGrok.grok.pressurePercent, 'number');
  assert.equal(withGrok.inFlight.grok, 0);
});

// ── routing ──────────────────────────────────────────────────────────────

test('an unverified grok is unauthenticated, whatever its meter says', () => {
  const bands = pressure();
  assert.equal(providerState(undefined, bands, Date.now(), 'grok').state, 'unauthenticated');
  assert.equal(providerState({ ...grokReading(), auth: undefined }, bands, Date.now(), 'grok').state, 'unauthenticated');
  assert.equal(providerState(grokReading(), bands, Date.now(), 'grok').state, 'ok');
  // The other vendors are not asked to prove anything they never could.
  assert.equal(providerState(undefined, bands, Date.now(), 'codex').state, 'unknown');
});

test('an unverified grok is never a candidate or a fallback', () => {
  const d = decide({ role: 'implement', complexity: 3, length: 'm' }, { codex: healthy(), claude: healthy() });
  assert.equal(d.provider, 'codex');
  assert.deepEqual(d.fallbacks.map((f) => f.provider), ['claude']);
  const pinned = decide({ role: 'research', pin: 'grok' }, { codex: healthy(), claude: healthy(), grok: grokReading({ ok: false, reason: 'not signed in' }) });
  assert.equal(pinned.ok, false, 'a pin does not override the billing gate');
});

test('research and web work lean to a signed-in grok', () => {
  const limits = { codex: healthy(0), claude: healthy(0), grok: grokReading() };
  assert.equal(decide({ role: 'research', complexity: 2, length: 's' }, limits).provider, 'grok');
  assert.equal(decide({ role: 'implement', complexity: 3, length: 'm', needsWeb: true }, limits).provider, 'grok');
  // Not for ordinary implementation when the windows are level: the tie breaks
  // to codex, and claude is held back for the orchestrator.
  assert.equal(decide({ role: 'implement', complexity: 3, length: 'm' }, limits).provider, 'codex');
});

test('a tight grok loses research to the others', () => {
  const tight = { ...grokReading(), worstPercent: 80, windows: [{ key: '5h', percentUsed: 80 }] };
  const d = decide({ role: 'research', complexity: 2, length: 's' }, { codex: healthy(), claude: healthy(), grok: tight });
  assert.notEqual(d.provider, 'grok');
});

test('web work never lands on a sandboxed codex, pinned or not', () => {
  const d = decide({ role: 'research', needsWeb: true }, { codex: healthy(), claude: spent() });
  assert.equal(d.ok, false, 'codex alone cannot do web work, so the run defers');
  const pinned = decide({ role: 'research', needsWeb: true, pin: 'codex' }, { codex: healthy(), claude: healthy() });
  assert.equal(pinned.ok, false, 'a pin does not give the sandbox a network');
  assert.match(pinned.reason, /without --full-access/);
  // --full-access is codex with a network: then it can.
  const open = decide({ role: 'research', needsWeb: true, pin: 'codex', fullAccess: true }, { codex: healthy(), claude: healthy() });
  assert.equal(open.provider, 'codex');
});

test('a review pinned onto its producer is labelled same-vendor, or refused when strict', () => {
  const limits = { codex: healthy(), claude: healthy(), grok: grokReading() };
  const d = decide({ role: 'review', independentOf: 'codex', pin: 'codex' }, limits);
  assert.equal(d.provider, 'codex');
  assert.equal(d.independence, 'same-vendor');
  assert.equal(d.degradedReview, true);
  const strict = decide({ role: 'review', independentOf: 'codex', pin: 'codex', strictIndependence: true }, limits);
  assert.equal(strict.ok, false);
  assert.match(strict.reason, /strict-independence/);
});

test('a failed pin is reported as the pin, not as independence', () => {
  const d = decide(
    { role: 'review', independentOf: 'codex', pin: 'grok' },
    { codex: healthy(), claude: healthy(), grok: grokReading({ ok: false, reason: 'not signed in' }) },
  );
  assert.equal(d.ok, false);
  assert.match(d.reason, /pinned provider grok cannot run/);
});

test('a review keeps off the producer and may use either other vendor', () => {
  const limits = { codex: healthy(), claude: healthy(), grok: grokReading() };
  const ofCodex = decide({ role: 'review', independentOf: 'codex' }, limits);
  assert.notEqual(ofCodex.provider, 'codex');
  assert.ok(!ofCodex.fallbacks.some((f) => f.provider === 'codex'), 'never fails over onto the producer');
  assert.equal(ofCodex.independence, 'cross-vendor');
  const ofGrok = decide({ role: 'review', independentOf: 'grok' }, limits);
  assert.notEqual(ofGrok.provider, 'grok');
  assert.ok(!ofGrok.fallbacks.some((f) => f.provider === 'grok'));
});

test('a review degrades only when every other vendor is unusable', () => {
  const limits = { codex: healthy(), claude: spent(), grok: grokReading({ ok: false, reason: 'not signed in' }) };
  const d = decide({ role: 'review', independentOf: 'codex' }, limits);
  assert.equal(d.provider, 'codex');
  assert.equal(d.independence, 'same-vendor');
  assert.ok(d.notes.some((n) => /grok not signed in/.test(n)));
  const strict = decide({ role: 'review', independentOf: 'codex', strictIndependence: true }, limits);
  assert.equal(strict.ok, false);
});

test('the failover ladder walks every usable vendor', () => {
  const d = decide({ role: 'implement' }, { codex: healthy(), claude: healthy(), grok: grokReading() });
  assert.equal(d.fallbacks.length, 2);
  assert.equal(d.fallback.provider, d.fallbacks[0].provider);
});

// ── the dispatch ─────────────────────────────────────────────────────────

test('the grok argv is headless, file-fed and names its stream format', () => {
  const { binary, args } = buildCommand(
    { provider: 'grok', model: 'grok-4.7', effort: 'high' },
    { cwd: '/repo', promptFile: '/w/prompt.md', grokBinary: '/h/.grok/bin/grok' },
  );
  assert.equal(binary, '/h/.grok/bin/grok');
  assert.deepEqual(args, [
    '--prompt-file', '/w/prompt.md',
    '--output-format', 'streaming-messages-json',
    '--model', 'grok-4.7',
    '--reasoning-effort', 'high',
    '--cwd', '/repo',
    '--permission-mode', 'bypassPermissions',
    '--no-auto-update',
  ]);
  assert.ok(!args.includes('-p') && !args.includes('--json-schema'));
});

function fakeSpawn(script) {
  const calls = [];
  const impl = async (invocation) => {
    calls.push(invocation);
    const next = script.shift();
    if (!next) throw new Error('fakeSpawn ran out of scripted responses');
    return { code: 0, signal: null, timedOut: false, aborted: null, stdout: '', stderr: '', ...next };
  };
  impl.calls = calls;
  return impl;
}

const SUBSCRIBED_GATE = async () => grokAuthFrom(SUBSCRIPTION);
const GROK = { provider: 'grok', model: 'grok-4.7', tier: 'balanced', effort: 'medium' };
const CLAUDE = { provider: 'claude', model: 'sonnet', tier: 'balanced', effort: 'medium' };

test('a grok dispatch reads its prompt from the file and leaves an oauth receipt', async () => {
  let promptOnDisk = null;
  const spawnImpl = async (inv) => {
    promptOnDisk = await readFile(inv.args[inv.args.indexOf('--prompt-file') + 1], 'utf8');
    assert.equal(inv.prompt, '', 'nothing goes down stdin');
    assert.equal(typeof inv.abortIf, 'function', 'the tripwire rides along');
    assert.ok(!('XAI_API_KEY' in inv.env));
    return { code: 0, signal: null, timedOut: false, aborted: null, stdout: STREAM_OK, stderr: '' };
  };
  const out = await runAgent({ ...GROK, fallbacks: [] }, 'check the links', {
    spawnImpl, sleep: async () => {}, grokGate: SUBSCRIBED_GATE,
  });
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'grok');
  assert.equal(out.result, 'ok');
  assert.equal(promptOnDisk, 'check the links');
  const receipt = (await readAudit()).find((r) => r.id === out.dispatchId);
  assert.equal(receipt.provider, 'grok');
  assert.equal(receipt.auth, 'oauth');
});

test('an unverified grok is never spawned; the ladder moves on', async () => {
  const spawnImpl = fakeSpawn([{ stdout: JSON.stringify({ type: 'result', result: 'from claude' }) }]);
  const out = await runAgent({ ...GROK, fallbacks: [CLAUDE] }, 'task', {
    spawnImpl,
    sleep: async () => {},
    grokGate: async () => ({ ok: false, reason: 'grok is not signed in — run `grok login`' }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'claude');
  assert.equal(spawnImpl.calls.length, 1);
  assert.equal(spawnImpl.calls[0].binary, 'claude');
  assert.equal(out.attempts[0].failure, 'not-subscription');
});

test('a grok session that started on a key is discarded, flagged, and never retried', async () => {
  const spawnImpl = fakeSpawn([
    { stdout: STREAM_ON_KEY },
    { stdout: JSON.stringify({ type: 'result', result: 'from claude' }) },
  ]);
  const out = await runAgent({ ...GROK, fallbacks: [CLAUDE] }, 'task', {
    spawnImpl, sleep: async () => {}, grokGate: SUBSCRIBED_GATE, maxAttempts: 3,
  });
  assert.equal(out.provider, 'claude', 'the key-billed answer is not returned');
  assert.equal(spawnImpl.calls.length, 2, 'one grok attempt, then the next vendor');
  assert.equal(out.attempts[0].failure, 'not-subscription');
  const st = await snapshot();
  assert.equal(st.probes.grok.value.auth.ok, false, 'every orchestrator on the machine now refuses grok');
});

test('an answer from a stream that never said oauth is not returned', async () => {
  const noInit = STREAM_OK.split('\n').slice(1).join('\n');
  const spawnImpl = fakeSpawn([{ stdout: noInit }]);
  const out = await runAgent({ ...GROK, fallbacks: [] }, 'task', {
    spawnImpl, sleep: async () => {}, grokGate: SUBSCRIBED_GATE,
  });
  assert.equal(out.ok, false);
  assert.equal(out.attempts[0].failure, 'not-subscription');
  assert.match(out.error, /did not confirm/);
});

test('the sign-in is re-checked before every attempt, not once per vendor', async () => {
  let checks = 0;
  const spawnImpl = fakeSpawn([{ code: 1, stderr: 'ECONNRESET' }, { stdout: STREAM_OK }]);
  const out = await runAgent({ ...GROK, fallbacks: [] }, 'task', {
    spawnImpl, sleep: async () => {}, maxAttempts: 3,
    grokGate: async () => { checks += 1; return grokAuthFrom(SUBSCRIPTION); },
  });
  assert.equal(out.ok, true);
  assert.equal(checks, 2);
});

test('the in-flight tripwire kill is a not-subscription failure too', async () => {
  const spawnImpl = fakeSpawn([{ code: null, signal: 'SIGTERM', aborted: 'grok session authenticated with "user"', stdout: STREAM_ON_KEY.split('\n')[0] }]);
  const out = await runAgent({ ...GROK, fallbacks: [] }, 'task', {
    spawnImpl, sleep: async () => {}, grokGate: SUBSCRIBED_GATE,
  });
  assert.equal(out.ok, false);
  assert.equal(out.attempts[0].failure, 'not-subscription');
});

test('a grok usage limit fails over at once', async () => {
  const limited = '{"type":"system","subtype":"init","apiKeySource":"oauth","model":"grok-4.7"}\n'
    + '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["usage_limit_reached"]}';
  const spawnImpl = fakeSpawn([
    { code: 1, stdout: limited },
    { stdout: JSON.stringify({ type: 'result', result: 'from claude' }) },
  ]);
  const out = await runAgent({ ...GROK, fallbacks: [CLAUDE] }, 'task', {
    spawnImpl, sleep: async () => {}, grokGate: SUBSCRIBED_GATE,
  });
  assert.equal(out.provider, 'claude');
  assert.equal(out.attempts[0].failure, 'rate-limit');
  assert.equal(spawnImpl.calls.length, 2);
});

test('a dispatch file can ask for web access', () => {
  const { meta } = parseDispatchFile('DISPATCH\nrole: research\nweb: true\nindependent-of: grok\nTASK\ncheck these');
  assert.equal(meta.web, true);
  assert.equal(meta['independent-of'], 'grok');
});

// ── the receipts ─────────────────────────────────────────────────────────

test('audit counts grok and whether each grok dispatch was proven subscription-billed', () => {
  const rows = [
    { provider: 'codex', model: 'terra', ok: true },
    { provider: 'grok', model: 'grok-4.7', ok: true, auth: 'oauth' },
    { provider: 'grok', model: 'grok-4.7', ok: true, auth: 'unknown' },
    { provider: 'claude', model: 'sonnet', ok: true },
  ];
  const sum = summarise(rows);
  assert.deepEqual(sum.shares, { codex: 25, claude: 25, grok: 50 });
  assert.deepEqual(sum.grokAuth, { oauth: 1, unverified: 1 });
  const f = findings(rows);
  assert.ok(f.some((x) => x.severity === 'high' && /without the stream confirming/.test(x.finding)));
  assert.ok(!f.some((x) => /went off claude/.test(x.finding)), 'codex + grok is 75% off claude');
});

test('the report says when grok is not routable, and why', () => {
  const f = findings([], { limits: { grok: { available: false, auth: { ok: false, reason: 'grok is not signed in — run `grok login` (browser OAuth)' } } } });
  assert.equal(f.length, 1);
  assert.match(f[0].finding, /grok is not routable/);
  assert.match(f[0].action, /grok login/);
});
