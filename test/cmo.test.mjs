// npm test
//
// Everything here is offline: no CLI is spawned, no network is touched. The
// policy is a pure function and the runner takes an injectable spawn, so the
// parts that decide where quota goes are testable without spending any.

import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractLatestRateLimits,
  parseCodexRateLimits,
  parseOAuthUsage,
  windowKeyForMinutes,
  normalizeReset,
} from '../src/limits.mjs';
import { decide, providerState, tierFor, pressure } from '../src/policy.mjs';
import { DEFAULT_MODELS, loadConfig, resetConfigCache } from '../src/config.mjs';
import { packageIsEphemeral } from '../src/install.mjs';
import {
  backoffMs,
  buildCommand,
  childEnv,
  classifyFailure,
  extractJson,
  parseClaudeStdout,
  parseCodexStream,
  runAgent,
} from '../src/run.mjs';

const healthy = (percent = 5) => ({
  available: true,
  worstPercent: percent,
  nextResetAt: null,
  hardBlocked: false,
  windows: [{ key: '5h', label: '5hr', percentUsed: percent, resetsAt: null }],
});
const spent = (resetsAt = '2026-08-22T00:00:00.000Z') => ({
  available: true,
  worstPercent: 99,
  nextResetAt: resetsAt,
  hardBlocked: true,
  windows: [{ key: 'weekly', label: 'Wkly', percentUsed: 99, resetsAt }],
});

// ── limits parsing ────────────────────────────────────────────────────────

test('codex windows are named by length, not by which field carried them', () => {
  // codex-cli 0.149 puts the WEEKLY window in `primary` with `secondary: null`.
  // Keying off the field name (as availability-codex.ts does) labels this 5hr.
  const parsed = parseCodexRateLimits({
    primary: { used_percent: 1.0, window_minutes: 10080, resets_at: 1787902559 },
    secondary: null,
    plan_type: 'pro',
    rate_limit_reached_type: null,
  });
  assert.equal(parsed.windows.length, 1);
  assert.equal(parsed.windows[0].key, 'weekly');
  assert.equal(parsed.windows[0].percentUsed, 1);
  assert.equal(parsed.plan, 'pro');
  assert.equal(parsed.hardBlocked, false);
});

test('the older codex shape (primary = 5h) still parses', () => {
  const parsed = parseCodexRateLimits({
    primary: { used_percent: 12.4, window_minutes: 300, resets_at: 1781287262 },
    secondary: { used_percent: 2.0, window_minutes: 10080, resets_at: 1781862218 },
  });
  assert.deepEqual(parsed.windows.map((w) => w.key), ['5h', 'weekly']);
  assert.equal(parsed.windows[0].percentUsed, 12);
});

test('codex reports a hard block when the limit was actually reached', () => {
  const parsed = parseCodexRateLimits({
    primary: { used_percent: 100, window_minutes: 300 },
    rate_limit_reached_type: 'primary',
  });
  assert.equal(parsed.hardBlocked, true);
});

test('window naming', () => {
  assert.equal(windowKeyForMinutes(300).key, '5h');
  assert.equal(windowKeyForMinutes(10080).key, 'weekly');
  assert.equal(windowKeyForMinutes(1440).key, 'daily');
});

test('reset stamps normalise from seconds, millis and ISO', () => {
  assert.equal(normalizeReset(1787902559), '2026-08-28T07:35:59.000Z');
  assert.equal(normalizeReset('2026-08-27T15:59:59.867806+00:00'), '2026-08-27T15:59:59.867Z');
  assert.equal(normalizeReset(null), null);
  assert.equal(normalizeReset('not a date'), null);
});

test('a rollout is scanned backwards for the newest snapshot', () => {
  const content = [
    JSON.stringify({ payload: { type: 'token_count', rate_limits: { primary: { used_percent: 10, window_minutes: 300 } } } }),
    JSON.stringify({ payload: { type: 'other' } }),
    JSON.stringify({ payload: { type: 'token_count', rate_limits: { primary: { used_percent: 40, window_minutes: 300 } } } }),
    '',
  ].join('\n');
  assert.equal(extractLatestRateLimits(content).primary.used_percent, 40);
});

test('claude usage prefers the limits[] array and falls back to named fields', () => {
  const fromArray = parseOAuthUsage({
    five_hour: { utilization: 2 },
    limits: [
      { kind: 'session', group: 'session', percent: 2, severity: 'normal', resets_at: '2026-08-21T17:19:59Z' },
      { kind: 'weekly_all', group: 'weekly', percent: 27, severity: 'normal', resets_at: '2026-08-27T15:59:59Z' },
    ],
  });
  assert.deepEqual(fromArray.windows.map((w) => w.key), ['5h', 'weekly']);
  assert.equal(fromArray.windows[1].percentUsed, 27);

  const fromNamed = parseOAuthUsage({
    five_hour: { utilization: 8, resets_at: '2026-08-21T17:19:59Z' },
    seven_day: { utilization: 55, resets_at: '2026-08-27T15:59:59Z' },
  });
  assert.deepEqual(fromNamed.windows.map((w) => w.percentUsed), [8, 55]);

  assert.equal(parseOAuthUsage({}), null);
});

test('a severity of exhausted is a hard block even below 100%', () => {
  const parsed = parseOAuthUsage({
    limits: [{ group: 'weekly', percent: 96, severity: 'exhausted', resets_at: null }],
  });
  assert.equal(parsed.hardBlocked, true);
});

// ── policy ────────────────────────────────────────────────────────────────

test('provider state bands', () => {
  const bands = pressure();
  assert.equal(providerState(healthy(10)).state, 'ok');
  assert.equal(providerState(healthy(bands.tight)).state, 'tight');
  assert.equal(providerState(healthy(bands.critical)).state, 'critical');
  assert.equal(providerState(healthy(bands.exhausted)).state, 'exhausted');
  assert.equal(providerState(spent()).state, 'exhausted');
  // A failed probe must never stop a run.
  assert.equal(providerState({ available: false, error: 'nope' }).state, 'unknown');
});

test('tier thresholds', () => {
  assert.equal(tierFor(0.1), 'fast');
  assert.equal(tierFor(0.45), 'balanced');
  assert.equal(tierFor(0.9), 'frontier');
});

test('codex is preferred when both providers are healthy', () => {
  const d = decide({ role: 'implement', complexity: 3, length: 'm' }, { codex: healthy(), claude: healthy() });
  assert.equal(d.provider, 'codex');
  assert.equal(d.model, DEFAULT_MODELS.codex.balanced.model);
  assert.equal(d.fallback.provider, 'claude');
});

test('claude takes over once codex is exhausted', () => {
  const d = decide({ role: 'implement', complexity: 3, length: 'm' }, { codex: spent(), claude: healthy() });
  assert.equal(d.provider, 'claude');
  assert.equal(d.model, DEFAULT_MODELS.claude.balanced.model);
  assert.equal(d.effort, DEFAULT_MODELS.claude.balanced.effort);
  // No fallback: the other rung is exhausted, so there is nowhere to fail over.
  assert.equal(d.fallback, null);
});

test('the emptier subscription wins when both are usable but uneven', () => {
  // codex's +10 default preference is worth 100 percentage points of headroom,
  // so it only loses once it is meaningfully more consumed than claude.
  const d = decide({ role: 'implement', complexity: 3, length: 'm' }, { codex: healthy(90), claude: healthy(5) });
  assert.equal(d.provider, 'claude');
});

test('adversarial review is forced onto the other vendor', () => {
  const reviewCodex = decide(
    { role: 'review', complexity: 3, length: 's', independentOf: 'codex' },
    { codex: healthy(), claude: healthy() },
  );
  assert.equal(reviewCodex.provider, 'claude');

  const reviewClaude = decide(
    { role: 'review', complexity: 3, length: 's', independentOf: 'claude' },
    { codex: healthy(70), claude: healthy() },
  );
  // Still codex even though codex is the tighter of the two — independence wins.
  assert.equal(reviewClaude.provider, 'codex');
  assert.equal(reviewClaude.fallback, null, 'a cross-model review must not fail over to the producer');
});

test('a cross-model review degrades to the producer\'s vendor rather than not happening', () => {
  // A fresh same-vendor agent still did not make the thing, which is the larger
  // half of independence. Refusing outright trades a good review for none.
  const d = decide(
    { role: 'review', complexity: 3, length: 's', independentOf: 'codex' },
    { codex: healthy(), claude: spent() },
  );
  assert.equal(d.ok, true);
  assert.equal(d.provider, 'codex', 'falls back to the vendor that produced it');
  assert.equal(d.independence, 'same-vendor');
  assert.equal(d.degradedReview, true, 'and says so, because the hazard is an unlabelled verdict');
  assert.ok(d.notes.some((n) => /DEGRADED REVIEW/.test(n)));
});

test('a healthy cross-model review is labelled cross-vendor', () => {
  const d = decide(
    { role: 'review', complexity: 3, length: 's', independentOf: 'codex' },
    { codex: healthy(), claude: healthy() },
  );
  assert.equal(d.provider, 'claude');
  assert.equal(d.independence, 'cross-vendor');
  assert.equal(d.degradedReview, false);
});

test('a degraded grader is given MORE model, not less', () => {
  // It has to catch what it is predisposed to miss, so this is the one place
  // a constrained provider gets spent up rather than down.
  const strong = decide(
    { role: 'review', complexity: 3, length: 's', independentOf: 'codex' },
    { codex: healthy(), claude: healthy() },
  );
  const weak = decide(
    { role: 'review', complexity: 3, length: 's', independentOf: 'codex' },
    { codex: healthy(), claude: spent() },
  );
  const rank = (t) => ['fast', 'balanced', 'frontier'].indexOf(t);
  assert.ok(rank(weak.tier) > rank(strong.tier), `${weak.tier} should outrank ${strong.tier}`);
});

test('--strict-independence still refuses rather than degrading', () => {
  // For verdicts that must be cross-vendor or absent.
  const d = decide(
    { role: 'review', complexity: 3, length: 's', independentOf: 'codex', strictIndependence: true },
    { codex: healthy(), claude: spent() },
  );
  assert.equal(d.ok, false);
  assert.equal(d.defer, true);
  assert.equal(d.independence, 'none');
  assert.match(d.reason, /strict-independence/);
});

test('with both vendors spent even a degraded review cannot run', () => {
  const d = decide(
    { role: 'review', complexity: 3, length: 's', independentOf: 'codex' },
    { codex: spent(), claude: spent() },
  );
  assert.equal(d.ok, false);
  assert.equal(d.independence, 'none');
  assert.equal(d.resumeAfter, '2026-08-22T00:00:00.000Z');
});

test('both providers spent defers with the soonest reset', () => {
  const d = decide(
    { role: 'implement', complexity: 3, length: 'm' },
    { codex: spent('2026-08-23T00:00:00.000Z'), claude: spent('2026-08-22T00:00:00.000Z') },
  );
  assert.equal(d.ok, false);
  assert.equal(d.resumeAfter, '2026-08-22T00:00:00.000Z');
});

test('a judge is never dispatched to the fast tier', () => {
  const d = decide({ role: 'judge', complexity: 1, length: 'xs' }, { codex: healthy(), claude: healthy() });
  assert.notEqual(d.tier, 'fast');
  assert.ok(d.notes.some((n) => /generous verdicts/.test(n)));
});

test('bulk low-complexity reading is dropped off the frontier tier', () => {
  // Big corpus, shallow reasoning: the role would otherwise buy a frontier model
  // to skim a quarter of a million tokens.
  const d = decide(
    { role: 'synthesis', complexity: 3, length: 'xl', contextTokens: 250_000 },
    { codex: healthy(), claude: healthy() },
  );
  assert.equal(d.tier, 'balanced');
  assert.ok(d.notes.some((n) => /bulk reading/.test(n)));

  // The same shape at complexity 4 is real reasoning, and keeps its model.
  const hard = decide(
    { role: 'synthesis', complexity: 4, length: 'xl', contextTokens: 250_000 },
    { codex: healthy(), claude: healthy() },
  );
  assert.equal(hard.tier, 'frontier');
});

test('a critical provider gets a cheaper model to stretch what is left', () => {
  const d = decide(
    { role: 'architecture', complexity: 5, length: 'l' },
    { codex: healthy(88), claude: spent() },
  );
  assert.equal(d.provider, 'codex');
  assert.equal(d.tier, 'balanced');
  assert.ok(d.notes.some((n) => /downgraded frontier/.test(n)));
});

test('a judge keeps its tier even on a critical provider', () => {
  const d = decide(
    { role: 'judge', complexity: 5, length: 'm' },
    { codex: healthy(88), claude: spent() },
  );
  assert.equal(d.tier, 'frontier');
});

test('pins override provider and model selection', () => {
  const d = decide(
    { role: 'implement', complexity: 2, length: 's', pin: 'claude', pinModel: 'fable' },
    { codex: healthy(), claude: healthy() },
  );
  assert.equal(d.provider, 'claude');
  assert.equal(d.model, 'fable');
});

test('unknown headroom still dispatches', () => {
  const d = decide(
    { role: 'implement', complexity: 3, length: 'm' },
    { codex: { available: false, error: 'no rollouts' }, claude: { available: false, error: 'offline' } },
  );
  assert.equal(d.ok, true);
});

// ── command construction ──────────────────────────────────────────────────

test('the codex command is non-interactive and takes its prompt on stdin', () => {
  const { binary, args } = buildCommand(
    { provider: 'codex', model: 'gpt-5.6-terra', reasoning: 'medium' },
    { cwd: '/repo', lastMessageFile: '/tmp/last.txt', schemaFile: '/tmp/s.json' },
  );
  assert.equal(binary, 'codex');
  assert.equal(args[0], 'exec');
  assert.equal(args.at(-1), '-', 'prompt must come from stdin, never argv');
  assert.ok(args.includes('--json'));
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.deepEqual(args.slice(args.indexOf('--output-schema'), args.indexOf('--output-schema') + 2), ['--output-schema', '/tmp/s.json']);
  assert.deepEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), ['-c', 'model_reasoning_effort=medium']);
  assert.ok(args.includes('--sandbox'));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('full access is opt-in and replaces the sandbox flag', () => {
  const { args } = buildCommand(
    { provider: 'codex', model: 'gpt-5.6-luna' },
    { cwd: '/repo', lastMessageFile: '/tmp/last.txt', fullAccess: true },
  );
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!args.includes('--sandbox'));
});

test('the claude command cannot stop for a permission prompt', () => {
  const { binary, args } = buildCommand(
    { provider: 'claude', model: 'sonnet', effort: 'high' },
    { cwd: '/repo', lastMessageFile: '/tmp/last.txt' },
  );
  assert.equal(binary, 'claude');
  assert.ok(args.includes('-p'));
  assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), ['--effort', 'high']);
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(args.includes('--output-format'));
});

test('api keys are stripped so the subscription is what gets spent', () => {
  const env = childEnv({ ANTHROPIC_API_KEY: 'x', CLAUDE_API_KEY: 'y', OPENAI_API_KEY: 'z', PATH: '/bin' });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.PATH, '/bin');
});

// ── failure handling ──────────────────────────────────────────────────────

test('failures are classified so the right recovery runs', () => {
  assert.equal(classifyFailure({ code: 0 }), 'none');
  assert.equal(classifyFailure({ code: null, timedOut: true }), 'timeout');
  assert.equal(classifyFailure({ code: 1, stderr: 'You have hit your usage limit' }), 'rate-limit');
  assert.equal(classifyFailure({ code: 1, stderr: 'HTTP 429 Too Many Requests' }), 'rate-limit');
  assert.equal(classifyFailure({ code: 1, stderr: 'ECONNRESET while streaming' }), 'transient');
  assert.equal(classifyFailure({ code: 1, stderr: 'Please run codex login' }), 'auth');
  assert.equal(classifyFailure({ code: 2, stderr: 'unknown flag --nope' }), 'fatal');

  // The regression that cost two completed 20-minute Codex runs: an agent's
  // stdout is its work product, and a storefront full of HTTP status codes is
  // not a rate limit. A clean exit with output is a success, whatever it says.
  const workProduct = 'return new Response(null, { status: 429 }); // 401 and 403 handled above; retry after 503';
  assert.equal(
    classifyFailure({ code: 0, stdout: workProduct, stderr: '', hasOutput: true }),
    'none',
    'completed work must not be reclassified as a failure by its own contents',
  );
  assert.equal(
    classifyFailure({ code: 0, stdout: 'edited line 510 of 567', stderr: '', hasOutput: true }),
    'none',
    '5xx-looking numbers in ordinary prose are not transient errors',
  );
  // Real CLI failures still classify, because they land on stderr.
  assert.equal(
    classifyFailure({ code: 1, stderr: 'HTTP error: 401 Unauthorized', stdout: workProduct, hasOutput: true }),
    'auth',
    'stderr is still read when the process actually failed',
  );
  // And when there is no output at all, stdout is a log again — some CLIs
  // print their error there and exit.
  assert.equal(
    classifyFailure({ code: 1, stdout: 'You have hit your usage limit', stderr: '', hasOutput: false }),
    'rate-limit',
  );
  // 5xx narrowed to the statuses that actually mean retry.
  assert.equal(classifyFailure({ code: 1, stderr: 'HTTP 503 from upstream' }), 'transient');
  assert.equal(classifyFailure({ code: 1, stderr: 'compilation failed at offset 555' }), 'fatal');
});

test('backoff grows and stays bounded', () => {
  const r = () => 0;
  assert.equal(backoffMs(0, { random: r }), 2_000);
  assert.equal(backoffMs(1, { random: r }), 4_000);
  assert.equal(backoffMs(10, { random: r }), 60_000);
});

test('a JSON verdict is recovered from prose, fences, or neither', () => {
  assert.deepEqual(extractJson('{"score":22}'), { score: 22 });
  assert.deepEqual(extractJson('```json\n{"score":22}\n```'), { score: 22 });
  assert.deepEqual(extractJson('Here you go: {"score":22} — hope that helps'), { score: 22 });
  assert.equal(extractJson('no json at all'), null);
  assert.equal(extractJson(''), null);
});

test('claude and codex stdout both yield text and usage', () => {
  const claude = parseClaudeStdout(JSON.stringify({ type: 'result', result: 'pong', usage: { output_tokens: 3 } }));
  assert.equal(claude.text, 'pong');
  assert.equal(claude.usage.output_tokens, 3);
  assert.equal(parseClaudeStdout('plain text').text, 'plain text');

  const codex = parseCodexStream([
    JSON.stringify({ type: 'thread.started', thread_id: 'x' }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 18861, output_tokens: 19 } }),
  ].join('\n'));
  assert.equal(codex.usage.output_tokens, 19);
});

// ── runner ────────────────────────────────────────────────────────────────

function fakeSpawn(script) {
  const calls = [];
  const impl = async (invocation) => {
    calls.push(invocation);
    const next = script.shift();
    if (!next) throw new Error('fakeSpawn ran out of scripted responses');
    return { code: 0, signal: null, timedOut: false, stdout: '', stderr: '', ...next };
  };
  impl.calls = calls;
  return impl;
}

const claudeOut = (text) => JSON.stringify({ type: 'result', result: text });

test('a rate-limited primary fails over to the other vendor immediately', async () => {
  const spawnImpl = fakeSpawn([
    { code: 1, stderr: 'You have hit your usage limit for this window' },
    { code: 0, stdout: claudeOut('done') },
  ]);
  let slept = 0;
  const decision = {
    provider: 'codex',
    model: 'gpt-5.6-terra',
    tier: 'balanced',
    fallback: { provider: 'claude', model: 'sonnet', tier: 'balanced', effort: 'medium' },
  };
  const out = await runAgent(decision, 'go', {
    spawnImpl,
    sleep: async (ms) => { slept += ms; },
  });
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'claude');
  assert.equal(out.failedOver, true);
  assert.equal(slept, 0, 'a rate limit must switch vendor, not sleep out the window');
  assert.equal(spawnImpl.calls.length, 2);
});

test('a transient error is retried on the same provider', async () => {
  const spawnImpl = fakeSpawn([
    { code: 1, stderr: 'socket hang up' },
    { code: 0, stdout: claudeOut('recovered') },
  ]);
  const out = await runAgent(
    { provider: 'claude', model: 'sonnet', tier: 'balanced', effort: 'medium', fallback: null },
    'go',
    { spawnImpl, sleep: async () => {} },
  );
  assert.equal(out.ok, true);
  assert.equal(out.result, 'recovered');
  assert.equal(out.attempts.length, 2);
});

test('a deterministic error is not retried', async () => {
  const spawnImpl = fakeSpawn([
    { code: 2, stderr: 'error: unexpected argument --nope' },
    { code: 0, stdout: claudeOut('never reached') },
  ]);
  const out = await runAgent(
    { provider: 'claude', model: 'sonnet', tier: 'balanced', fallback: null },
    'go',
    { spawnImpl, sleep: async () => {} },
  );
  assert.equal(out.ok, false);
  assert.equal(spawnImpl.calls.length, 1, 'retrying a bad flag just burns quota');
});

test('a schema violation fails rather than handing the script unparseable prose', async () => {
  const spawnImpl = fakeSpawn([
    { code: 0, stdout: claudeOut('I think it is fine, honestly') },
    { code: 0, stdout: claudeOut('still no json') },
  ]);
  const out = await runAgent(
    { provider: 'claude', model: 'sonnet', tier: 'balanced', fallback: null },
    'grade it',
    {
      spawnImpl,
      sleep: async () => {},
      maxAttempts: 2,
      schema: { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string' } } },
    },
  );
  assert.equal(out.ok, false);
  assert.ok(out.attempts.every((a) => a.failure === 'schema-violation'));
});

test('the schema contract reaches the agent even on the vendor with no schema flag', async () => {
  const spawnImpl = fakeSpawn([{ code: 0, stdout: claudeOut('{"verdict":"promote"}') }]);
  const out = await runAgent(
    { provider: 'claude', model: 'sonnet', tier: 'balanced', fallback: null },
    'grade it',
    { spawnImpl, sleep: async () => {}, schema: { type: 'object', properties: { verdict: { type: 'string' } } } },
  );
  assert.deepEqual(out.resultJson, { verdict: 'promote' });
  assert.match(spawnImpl.calls[0].prompt, /RETURN FORMAT \(hard requirement\)/);
});

test('a degraded review is TOLD it is degraded', async () => {
  // The label alone is for the caller. This is the mitigation for the agent,
  // and it shipped missing once because nothing asserted the prompt.
  const spawnImpl = fakeSpawn([{ code: 0, stdout: claudeOut('3/5, here is why') }]);
  await runAgent(
    { provider: 'claude', model: 'sonnet', tier: 'balanced', fallback: null,
      independence: 'same-vendor', degradedReview: true },
    'grade this',
    { spawnImpl, sleep: async () => {} },
  );
  const sent = spawnImpl.calls[0].prompt;
  assert.match(sent, /INDEPENDENCE NOTICE/);
  assert.match(sent, /resolve it AGAINST the artifact/);
  assert.match(sent, /^grade this/, 'the task itself still comes first');
});

test('a cross-vendor review is not given the handicap notice', async () => {
  const spawnImpl = fakeSpawn([{ code: 0, stdout: claudeOut('ok') }]);
  await runAgent(
    { provider: 'claude', model: 'sonnet', tier: 'balanced', fallback: null,
      independence: 'cross-vendor', degradedReview: false },
    'grade this',
    { spawnImpl, sleep: async () => {} },
  );
  assert.doesNotMatch(spawnImpl.calls[0].prompt, /INDEPENDENCE NOTICE/);
});

test('the handicap and a schema contract coexist', async () => {
  const spawnImpl = fakeSpawn([{ code: 0, stdout: claudeOut('{"score":3}') }]);
  const out = await runAgent(
    { provider: 'claude', model: 'sonnet', tier: 'balanced', fallback: null,
      independence: 'same-vendor', degradedReview: true },
    'grade this',
    { spawnImpl, sleep: async () => {}, schema: { type: 'object', properties: { score: { type: 'integer' } } } },
  );
  const sent = spawnImpl.calls[0].prompt;
  assert.match(sent, /INDEPENDENCE NOTICE/);
  assert.match(sent, /RETURN FORMAT \(hard requirement\)/);
  assert.deepEqual(out.resultJson, { score: 3 });
});

test('a timeout is reported, not swallowed as an empty answer', async () => {
  const spawnImpl = fakeSpawn([
    { code: null, signal: 'SIGKILL', timedOut: true, stderr: '' },
    { code: null, signal: 'SIGKILL', timedOut: true, stderr: '' },
  ]);
  const out = await runAgent(
    { provider: 'claude', model: 'sonnet', tier: 'balanced', fallback: null },
    'go',
    { spawnImpl, sleep: async () => {}, maxAttempts: 2 },
  );
  assert.equal(out.ok, false);
  assert.ok(out.attempts.every((a) => a.failure === 'timeout'));
});
