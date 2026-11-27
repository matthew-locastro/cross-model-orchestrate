// npm test
//
// Everything here is offline: no CLI is spawned, no network is touched. The
// policy is a pure function and the runner takes an injectable spawn, so the
// parts that decide where quota goes are testable without spending any.

import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  extractLatestRateLimits,
  parseCodexRateLimits,
  parseOAuthUsage,
  windowKeyForMinutes,
  normalizeReset,
} from '../src/limits.mjs';
import { decide, providerState, tierFor, pressure } from '../src/policy.mjs';
import { CACHE_DIR, CONFIG_DIR, DEFAULT_MODELS, loadConfig, resetConfigCache } from '../src/config.mjs';
import { packageIsEphemeral } from '../src/install.mjs';
import {
  backoffMs,
  buildCommand,
  childEnv,
  classifyFailure,
  extractJson,
  parseClaudeStdout,
  parseCodexStream,
  normalizeSchemaForCodex,
  runAgent,
} from '../src/run.mjs';
import { readAudit } from '../src/audit.mjs';
import {
  USAGE,
  limitsExitStatus,
  main as cmoMain,
  outcomeCommand,
  renderLimits,
} from '../bin/cmo.mjs';

function captureOutput() {
  const writes = [];
  return {
    sink(text, stream = 'stdout') { writes.push({ stream, text }); },
    text(stream) { return writes.filter((write) => write.stream === stream).map((write) => write.text).join(''); },
  };
}

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
  // Headroom dominates. A critical codex loses to a nearly empty claude even
  // after claude pays the orchestrator penalty.
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

// ── OpenAI schema dialect ─────────────────────────────────────────────────

test('codex schema normalization makes optional properties required and nullable', () => {
  assert.deepEqual(normalizeSchemaForCodex({
    type: 'object',
    required: ['ok'],
    properties: { ok: { type: 'string' }, note: { type: 'string' } },
  }), {
    type: 'object',
    required: ['ok', 'note'],
    properties: { ok: { type: 'string' }, note: { type: ['string', 'null'] } },
    additionalProperties: false,
  });
});

test('codex schema normalization recurses into nested objects', () => {
  const normalized = normalizeSchemaForCodex({
    type: 'object',
    properties: {
      child: { type: 'object', properties: { value: { type: 'number' } } },
    },
  });
  assert.deepEqual(normalized.required, ['child']);
  assert.equal(normalized.additionalProperties, false);
  assert.deepEqual(normalized.properties.child.type, ['object', 'null']);
  assert.deepEqual(normalized.properties.child.required, ['value']);
  assert.equal(normalized.properties.child.additionalProperties, false);
});

test('codex schema normalization recurses into array items beneath an object root', () => {
  const normalized = normalizeSchemaForCodex({
    type: 'object',
    required: ['rows'],
    properties: {
      rows: {
        type: 'array',
        items: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      },
    },
  });
  assert.deepEqual(normalized.properties.rows.items.required, ['id']);
  assert.equal(normalized.properties.rows.items.additionalProperties, false);
});

test('codex schema normalization reaches deeply nested property and item schemas', () => {
  const normalized = normalizeSchemaForCodex({
    type: 'object',
    properties: {
      a: {
        type: 'object',
        properties: {
          b: {
            type: 'array',
            items: { type: 'object', properties: { c: { type: 'string' } } },
          },
        },
      },
    },
  });
  assert.deepEqual(normalized.required, ['a']);
  assert.deepEqual(normalized.properties.a.required, ['b']);
  assert.deepEqual(normalized.properties.a.properties.b.items.required, ['c']);
  assert.equal(normalized.properties.a.properties.b.items.additionalProperties, false);
});

test('codex schema normalization recurses into a definition used by an object contract', () => {
  const normalized = normalizeSchemaForCodex({
    type: 'object',
    required: ['item'],
    properties: { item: { $ref: '#/$defs/Item' } },
    $defs: {
      Item: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    },
  });
  assert.equal(normalized.additionalProperties, false);
  assert.equal(normalized.$defs.Item.additionalProperties, false);
  assert.deepEqual(normalized.$defs.Item.required, ['name']);
});

test('codex schema normalization preserves map schemas and normalizes their value schema', () => {
  const normalized = normalizeSchemaForCodex({
    type: 'object',
    required: ['labels'],
    properties: {
      labels: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          required: ['value'],
          properties: { value: { type: 'string' } },
        },
      },
    },
  });
  const valueSchema = normalized.properties.labels.additionalProperties;
  assert.notEqual(valueSchema, false, 'a map must not be silently narrowed to the empty object');
  assert.equal(valueSchema.additionalProperties, false);
  assert.deepEqual(valueSchema.required, ['value']);
});

test('codex schema normalization closes nullable objects', () => {
  const normalized = normalizeSchemaForCodex({
    type: 'object',
    required: ['child'],
    properties: {
      child: {
        type: ['object', 'null'],
        required: ['value'],
        properties: { value: { type: 'string' } },
      },
    },
  });
  assert.equal(normalized.properties.child.additionalProperties, false);
});

test('an already-strict codex schema is left byte-identical in meaning', () => {
  const strict = {
    type: 'object',
    properties: {
      nested: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        additionalProperties: false,
        required: ['ok'],
      },
    },
    additionalProperties: false,
    required: ['nested'],
  };
  assert.equal(JSON.stringify(normalizeSchemaForCodex(strict)), JSON.stringify(strict));
});

test('codex schema normalization never mutates the caller-owned input', () => {
  const input = {
    type: 'object',
    properties: { child: { type: 'object', properties: { ok: { type: 'boolean' } } } },
  };
  const deepFreeze = (value) => {
    if (value && typeof value === 'object') {
      Object.freeze(value);
      Object.values(value).forEach(deepFreeze);
    }
    return value;
  };
  const before = structuredClone(input);
  deepFreeze(input);
  const normalized = normalizeSchemaForCodex(input);
  assert.deepEqual(input, before);
  assert.notEqual(normalized, input);
  assert.notEqual(normalized.properties.child, input.properties.child);
});

test('an opaque object stays open rather than being narrowed to the empty object', () => {
  const normalized = normalizeSchemaForCodex({ type: 'object', title: 'opaque' });
  assert.deepEqual(normalized, { type: 'object', title: 'opaque' });
  assert.equal(Object.hasOwn(normalized, 'required'), false);

  const empty = normalizeSchemaForCodex({ type: 'object', properties: {} });
  assert.deepEqual(empty, { type: 'object', properties: {}, additionalProperties: false });
  assert.equal(Object.hasOwn(empty, 'required'), false);

  const explicitEmpty = normalizeSchemaForCodex({ type: 'object', properties: {}, required: [] });
  assert.deepEqual(explicitEmpty, { type: 'object', properties: {}, additionalProperties: false });
});

test('an untyped properties map is normalized as an object', () => {
  const normalized = normalizeSchemaForCodex({
    properties: { a: { type: 'string' }, b: { type: 'integer' } },
    required: ['a'],
  });
  assert.equal(normalized.additionalProperties, false);
  assert.deepEqual(normalized.required, ['a', 'b']);
  assert.deepEqual(normalized.properties.b.type, ['integer', 'null']);
});

test('composed object roots stay open so branch properties remain satisfiable', () => {
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    const normalized = normalizeSchemaForCodex({
      type: 'object',
      required: ['v'],
      properties: { v: { type: 'string' } },
      [keyword]: [{ type: 'object', properties: { x: { type: 'string' } } }],
    });
    assert.equal(Object.hasOwn(normalized, 'additionalProperties'), false, keyword);
    assert.equal(Object.hasOwn(normalized[keyword][0], 'additionalProperties'), false, keyword);
    assert.deepEqual(normalized.required, ['v'], keyword);
    assert.deepEqual(normalized[keyword][0].required, ['x'], keyword);
  }
});

// Named for what it actually asserts. The referring node is left open because a
// `$ref` contributes properties this node cannot see, so closing it against the
// local set alone would forbid them. That is the whole claim.
//
// It is deliberately NOT a claim that the result is satisfiable: `$defs.base`
// stays closed, which forbids the sibling `b` the root requires. Closing `$defs`
// is load bearing for the common case, and the endpoint rejects a `$ref` carrying
// sibling keywords before satisfiability is ever evaluated, so this shape fails
// over to claude either way. Naming it "remains satisfiable" would have blessed a
// property the code does not have.
test('an object with a ref stays open rather than forbidding the ref\'s properties', () => {
  const normalized = normalizeSchemaForCodex({
    type: 'object',
    $defs: {
      base: { type: 'object', properties: { a: { type: 'string' } } },
    },
    $ref: '#/$defs/base',
    properties: { b: { type: 'string' } },
  });
  assert.equal(Object.hasOwn(normalized, 'additionalProperties'), false);
  assert.equal(normalized.$defs.base.additionalProperties, false);
});

test('an object stays open when required names are absent from local properties', () => {
  const normalized = normalizeSchemaForCodex({
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['a', 'fromElsewhere'],
  });
  assert.equal(Object.hasOwn(normalized, 'additionalProperties'), false);
  assert.deepEqual(normalized.required, ['a', 'fromElsewhere']);
});

test('false property schemas stay forbidden while true schemas remain requireable', () => {
  const normalized = normalizeSchemaForCodex({
    type: 'object',
    properties: {
      banned: false,
      anything: true,
      ok: { type: 'string' },
    },
    required: ['ok'],
  });
  assert.equal(normalized.properties.banned, false);
  assert.equal(normalized.properties.anything, true);
  assert.deepEqual(normalized.required, ['ok', 'anything']);

  const forbiddenOnly = normalizeSchemaForCodex({
    type: 'object',
    properties: { banned: false },
  });
  assert.equal(Object.hasOwn(forbiddenOnly, 'required'), false,
    'forbidden properties must not synthesize an empty required list');
});

test('normalization preserves required names contributed outside local properties', () => {
  const normalized = normalizeSchemaForCodex({
    type: 'object',
    required: ['x', 'v'],
    properties: { v: { type: 'string' } },
    allOf: [{ type: 'object', properties: { x: { type: 'string' } } }],
  });
  assert.deepEqual(normalized.required, ['x', 'v']);
  assert.equal(Object.hasOwn(normalized, 'additionalProperties'), false);
});

test('optional enum and const properties gain a real null branch', () => {
  const normalized = normalizeSchemaForCodex({
    type: 'object',
    properties: {
      grade: { type: 'string', enum: ['a', 'b'] },
      fixed: { type: 'string', const: 'x' },
    },
  });
  assert.deepEqual(normalized.properties.grade, {
    anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'null' }],
  });
  assert.deepEqual(normalized.properties.fixed, {
    anyOf: [{ type: 'string', const: 'x' }, { type: 'null' }],
  });
});

test('normalization reaches schema-bearing conditional and map keywords', () => {
  const objectSchema = { properties: { x: { type: 'string' } } };
  const normalized = normalizeSchemaForCodex({
    not: objectSchema,
    if: objectSchema,
    then: objectSchema,
    else: objectSchema,
    patternProperties: { '^x': objectSchema },
    dependentSchemas: { x: objectSchema },
    contains: objectSchema,
    additionalItems: objectSchema,
  });
  for (const key of ['not', 'if', 'then', 'else']) {
    assert.equal(Object.hasOwn(normalized[key], 'additionalProperties'), false, key);
  }
  for (const key of ['contains', 'additionalItems']) {
    assert.equal(normalized[key].additionalProperties, false, key);
  }
  assert.equal(normalized.patternProperties['^x'].additionalProperties, false);
  assert.equal(Object.hasOwn(normalized.dependentSchemas.x, 'additionalProperties'), false);
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
  assert.equal(classifyFailure({
    code: 1,
    schemaRejected: true,
  }), 'schema-rejection');
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
  assert.equal(classifyFailure({
    code: 1,
    stdout: JSON.stringify({
      type: 'item.completed',
      item: { text: 'the config has an invalid schema, so I fixed it' },
    }),
    hasOutput: false,
  }), 'fatal', 'agent work product is not structured endpoint metadata');
  assert.equal(classifyFailure({
    code: 1,
    stderr: 'ECONNRESET while reading a response_format error',
    schemaRejected: true,
  }), 'transient', 'a structured schema signal must not shadow a transport failure');
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
    JSON.stringify({ type: 'error', message: 'invalid_json_schema in response_format' }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 18861, output_tokens: 19 } }),
  ].join('\n'));
  assert.equal(codex.usage.output_tokens, 19);
  assert.equal(codex.schemaRejected, true);

  const wrappedError = parseCodexStream(JSON.stringify({
    type: 'error',
    payload: { error: { message: 'invalid_json_schema in codex_output_schema' } },
  }));
  assert.equal(wrappedError.schemaRejected, true);
  assert.match(wrappedError.error, /codex_output_schema/);
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

test('the codex runner passes a normalized schema file without changing its prompt contract', async () => {
  const schema = {
    type: 'object',
    required: ['ok'],
    properties: { ok: { type: 'string' }, note: { type: 'string' } },
  };
  let writtenSchema;
  let capturedInvocation;
  const spawnImpl = async (invocation) => {
    capturedInvocation = invocation;
    const schemaIndex = invocation.args.indexOf('--output-schema');
    assert.notEqual(schemaIndex, -1, 'the codex argv must retain --output-schema');
    writtenSchema = JSON.parse(await readFile(invocation.args[schemaIndex + 1], 'utf8'));
    const messageIndex = invocation.args.indexOf('--output-last-message');
    await writeFile(invocation.args[messageIndex + 1], '{"ok":"yes","note":"done"}', 'utf8');
    return { code: 0, signal: null, timedOut: false, stdout: '', stderr: '' };
  };

  const out = await runAgent(
    { provider: 'codex', model: 'gpt-5.6-terra', tier: 'balanced', fallback: null },
    'return a result',
    { spawnImpl, sleep: async () => {}, schema },
  );

  assert.equal(out.ok, true);
  assert.deepEqual(writtenSchema, {
    ...schema,
    properties: { ok: { type: 'string' }, note: { type: ['string', 'null'] } },
    required: ['ok', 'note'],
    additionalProperties: false,
  });
  assert.ok(capturedInvocation.prompt.includes(JSON.stringify(schema, null, 2)));
  assert.deepEqual(schema.required, ['ok'], 'the caller schema must remain unchanged');
});

test('a codex JSONL error event reaches the attempt and returned error', async () => {
  const message = "invalid_json_schema: 'additionalProperties' is required to be supplied and to be false";
  const spawnImpl = fakeSpawn([{
    code: 1,
    stdout: JSON.stringify({ type: 'error', message }),
    stderr: '',
  }]);
  const out = await runAgent(
    { provider: 'codex', model: 'gpt-5.6-terra', tier: 'balanced', fallback: null },
    'return a result',
    { spawnImpl, sleep: async () => {}, maxAttempts: 3 },
  );

  assert.equal(out.ok, false);
  assert.equal(spawnImpl.calls.length, 1, 'a malformed request is deterministic and must not be retried');
  assert.equal(out.attempts[0].failure, 'schema-rejection');
  assert.match(out.attempts[0].stderr, /additionalProperties/);
  assert.match(out.error, /additionalProperties/);
});

test('a rejected codex schema fails over visibly to claude', async () => {
  const message = "invalid_json_schema: 'additionalProperties' is required to be supplied and to be false";
  const spawnImpl = fakeSpawn([
    {
      code: 1,
      stdout: JSON.stringify({ type: 'error', message }),
      stderr: '',
    },
    { code: 0, stdout: claudeOut('{"x":"y"}') },
  ]);
  const out = await runAgent({
    provider: 'codex',
    model: 'gpt-5.6-terra',
    tier: 'balanced',
    fallback: { provider: 'claude', model: 'sonnet', tier: 'balanced', effort: 'medium' },
  }, 'return a result', {
    spawnImpl,
    sleep: async () => {},
    schema: { type: 'object', properties: { x: { type: 'totally-not-a-type' } } },
  });

  assert.equal(out.ok, true);
  assert.equal(out.provider, 'claude');
  assert.equal(spawnImpl.calls.length, 2);
  assert.equal(out.failedOver, true);
  assert.equal(out.attempts[0].failure, 'schema-rejection');
  const receipt = (await readAudit()).find((row) => row.id === out.dispatchId);
  assert.equal(receipt?.provider, 'claude');
  assert.equal(receipt?.failedOver, true);
  assert.deepEqual(receipt?.failures, ['schema-rejection']);
});

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

// ── CLI handlers ─────────────────────────────────────────────────────────────

test('outcome rejects an unknown dispatch without writing an outcome', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'cmo-outcome-unknown-'));
  const output = captureOutput();
  const code = await outcomeCommand(
    ['outcome', 'd-missing', '--verdict', 'approved'],
    cacheDir,
    output.sink,
  );

  assert.equal(code, 1);
  assert.equal(output.text('stdout'), '');
  await assert.rejects(readFile(join(cacheDir, 'outcomes.jsonl'), 'utf8'), { code: 'ENOENT' });
});

test('outcome --force writes an orphan record', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'cmo-outcome-force-'));
  const output = captureOutput();
  const code = await outcomeCommand(
    ['outcome', 'd-orphan', '--verdict', 'fixed', '--force'],
    cacheDir,
    output.sink,
  );

  assert.equal(code, 0);
  const saved = JSON.parse((await readFile(join(cacheDir, 'outcomes.jsonl'), 'utf8')).trim());
  assert.deepEqual(
    { id: saved.id, verdict: saved.verdict, rounds: saved.rounds, orphan: saved.orphan },
    { id: 'd-orphan', verdict: 'fixed', rounds: 1, orphan: true },
  );
});

test('outcome records against an existing local receipt without marking an orphan', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'cmo-outcome-local-'));
  await writeFile(join(cacheDir, 'dispatches.jsonl'), `${JSON.stringify({
    at: Date.now(), id: 'd-local', provider: 'antigravity', role: 'review', model: 'gemini-4-carbon',
  })}\n`);
  const output = captureOutput();
  const code = await outcomeCommand(
    [
      'outcome', 'd-local',
      '--verdict', 'fixed',
      '--rounds', '2',
      '--note', 're-verified after patch',
      '--by', 'codex',
    ],
    cacheDir,
    output.sink,
  );

  assert.equal(code, 0);
  assert.equal(output.text('stderr'), '');
  const printed = JSON.parse(output.text('stdout').trim());
  const saved = JSON.parse((await readFile(join(cacheDir, 'outcomes.jsonl'), 'utf8')).trim());
  assert.deepEqual(printed, saved);
  assert.equal(saved.id, 'd-local');
  assert.equal(saved.verdict, 'fixed');
  assert.equal(saved.rounds, 2);
  assert.equal(saved.note, 're-verified after patch');
  assert.equal(saved.by, 'codex');
  assert.equal(Object.hasOwn(saved, 'orphan'), false);
});

test('outcome rejects invalid verdicts and round counts with usage status', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'cmo-outcome-invalid-'));
  const badVerdict = captureOutput();
  const badRounds = captureOutput();

  assert.equal(await outcomeCommand(
    ['outcome', 'd-any', '--verdict', 'maybe'], cacheDir, badVerdict.sink,
  ), 2);
  assert.equal(await outcomeCommand(
    ['outcome', 'd-any', '--verdict', 'approved', '--rounds', '1.5'], cacheDir, badRounds.sink,
  ), 2);
  await assert.rejects(readFile(join(cacheDir, 'outcomes.jsonl'), 'utf8'), { code: 'ENOENT' });
});

test('report --quality --json emits the stable quality envelope', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'cmo-report-quality-'));
  const now = Date.now();
  await writeFile(join(cacheDir, 'dispatches.jsonl'), `${JSON.stringify({
    at: now, id: 'd-quality', provider: 'codex', role: 'review', model: 'gpt-5.6-terra',
  })}\n`);
  await writeFile(join(cacheDir, 'outcomes.jsonl'), `${JSON.stringify({
    at: now, id: 'd-quality', verdict: 'confirmed', rounds: 1,
  })}\n`);
  const output = captureOutput();

  assert.equal(await cmoMain(
    ['report', '--quality', '--json'], { cacheDir, outputSink: output.sink },
  ), 0);
  assert.deepEqual(JSON.parse(output.text('stdout')), {
    window: '24h',
    quality: {
      total: 1,
      orphans: 0,
      groups: [{
        provider: 'codex', role: 'review', model: 'gpt-5.6-terra', n: 1,
        producerOutcomes: 0, firstRoundApprovals: 0, firstRoundApprovalRate: null,
        reviewAccuracy: 1, blocked: 0, confirmed: 1, falsePositive: 0, missed: 0,
        meanRounds: 1,
      }],
    },
  });
});

test('report --quality formats human output with first-round approval rate and counts', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'cmo-report-quality-human-'));
  const now = Date.now();
  await writeFile(join(cacheDir, 'dispatches.jsonl'), [
    JSON.stringify({ at: now, id: 'd-q1', provider: 'codex', role: 'review', model: 'gpt-5.6-terra' }),
    JSON.stringify({ at: now, id: 'd-q2', provider: 'codex', role: 'review', model: 'gpt-5.6-terra' }),
    '',
  ].join('\n'));
  await writeFile(join(cacheDir, 'outcomes.jsonl'), [
    JSON.stringify({ at: now, id: 'd-q1', verdict: 'confirmed', rounds: 1 }),
    JSON.stringify({ at: now, id: 'd-q2', verdict: 'missed', rounds: 3 }),
    JSON.stringify({ at: now, id: 'd-orphan', verdict: 'approved', rounds: 1, orphan: true }),
    '',
  ].join('\n'));
  const output = captureOutput();

  assert.equal(await cmoMain(
    ['report', '--quality'], { cacheDir, outputSink: output.sink },
  ), 0);
  assert.equal(output.text('stderr'), '');
  const text = output.text('stdout');
  assert.match(text, /quality outcomes — last 24h/);
  assert.match(text, /2 outcomes · 1 orphan\b/);
  assert.match(
    text,
    /codex \/ review \/ gpt-5\.6-terra: n=2 first-round approvals=0\/0 \(n\/a\) review accuracy=50% mean rounds=2 blocked=0 confirmed=1 false-positive=0 missed=1/,
  );
});

test('help names the active roster and keeps grok explicitly opt-in', () => {
  assert.match(USAGE, /^\s*outcome\s+/m);
  assert.match(USAGE, /--hosts\s+comma-separated subset: claude,codex,agents,kilo,opencode,antigravity/);
  assert.match(USAGE, /codex\|claude\|antigravity/);
  assert.match(USAGE, /config "providers"/);
  assert.doesNotMatch(USAGE, /grok first/i);
});

test('limits omit inactive grok and fail when every active vendor is exhausted', () => {
  const now = Date.parse('2026-11-22T00:00:00.000Z');
  const exhausted = (provider) => ({
    available: true,
    provider,
    worstPercent: 99,
    reportedPercent: 99,
    hardBlocked: true,
    windows: [{ key: 'weekly', label: 'Wkly', percentUsed: 99, resetsAt: '2026-11-23T00:00:00.000Z' }],
  });
  const limits = {
    codex: exhausted('codex'),
    claude: exhausted('claude'),
    antigravity: exhausted('antigravity'),
    grok: { ...healthy(), provider: 'grok' },
    inFlight: {},
  };
  const roster = ['codex', 'claude', 'antigravity'];

  assert.doesNotMatch(renderLimits(limits, now), /^grok\s/m);
  assert.equal(limitsExitStatus(limits, roster, now), 3);
});

test('renderLimits prints NOT ROUTABLE for an unverified subscription-gated vendor, including antigravity', () => {
  const now = Date.parse('2026-11-22T00:00:00.000Z');
  const limits = {
    codex: healthy(),
    claude: healthy(),
    antigravity: {
      available: false,
      provider: 'antigravity',
      error: 'an API-key login has no subscription quota; cmo never bills an API key',
      windows: [],
      auth: {
        ok: false,
        method: 'unknown',
        reason: 'an API-key login has no subscription quota; cmo never bills an API key',
      },
    },
    inFlight: {},
  };
  const rendered = renderLimits(limits, now);
  const agyLine = rendered.split('\n').find((line) => line.startsWith('antigravity '));
  assert.ok(agyLine, 'antigravity should appear in active limits output');
  assert.match(agyLine, /unauthenticated\s+NOT ROUTABLE: an API-key login has no subscription quota; cmo never bills an API key/);
  assert.doesNotMatch(agyLine, /unavailable:/);

  const unchecked = renderLimits({
    codex: healthy(),
    claude: healthy(),
    antigravity: { ...healthy(), provider: 'antigravity' },
    inFlight: {},
  }, now);
  const uncheckedLine = unchecked.split('\n').find((line) => line.startsWith('antigravity '));
  assert.match(uncheckedLine, /unauthenticated\s+NOT ROUTABLE: antigravity has not been checked for a subscription sign-in/);
});

test('human report share excludes inactive grok', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'cmo-report-share-'));
  await writeFile(join(cacheDir, 'dispatches.jsonl'), `${JSON.stringify({
    at: Date.now(), id: 'd-share', provider: 'codex', role: 'implement', model: 'gpt-5.6-terra',
  })}\n`);
  const output = captureOutput();
  const limits = {
    codex: healthy(),
    claude: healthy(),
    antigravity: { ...healthy(), provider: 'antigravity', auth: { ok: true, method: 'subscription' } },
  };
  const readLimits = async () => { throw new Error('report should not probe live meters'); };

  assert.equal(await cmoMain(['report'], { cacheDir, outputSink: output.sink, limits, readLimits }), 0);
  const shareLine = output.text('stdout').split('\n').find((line) => line.includes('· share '));
  assert.match(shareLine, /codex 100% \/ claude 0% \/ antigravity 0%/);
  assert.doesNotMatch(shareLine, /grok/);
});

test('test isolation keeps every test-time path out of the real home directory', () => {
  const home = homedir();
  const isInside = (target, root) => {
    const rel = relative(resolve(root), resolve(target));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  resetConfigCache();
  const cfg = loadConfig({ reload: true });
  const forbidden = [
    ['claudeCredentials', cfg.claudeCredentials, join(home, '.claude')],
    ['codexSessionsRoot', cfg.codexSessionsRoot, join(home, '.codex')],
    ['GROK_HOME', process.env.GROK_HOME ?? join(home, '.grok'), join(home, '.grok')],
    ['CACHE_DIR', CACHE_DIR, join(home, '.cache', 'cross-model-orchestrate')],
    ['CONFIG_DIR', CONFIG_DIR, join(home, '.config', 'cross-model-orchestrate')],
    ['configFile', cfg.configFile, join(home, '.config', 'cross-model-orchestrate')],
  ];
  for (const [label, target, root] of forbidden) {
    assert.equal(isInside(target, root), false, `${label} (${target}) must not resolve inside ${root}`);
  }
  assert.equal(cfg.claudeCliProbe, false);
  assert.equal(cfg.grokProbe, false);
  assert.equal(cfg.agyProbe, false);
});

test('cmoMain injects limits or readLimits for report and limits without probing live meters', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'cmo-inject-limits-'));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`unexpected network request during test: ${url}`); };

  try {
    const injected = {
      codex: { available: false, error: 'injected-codex-dark' },
      claude: healthy(),
      antigravity: { ...healthy(), provider: 'antigravity', auth: { ok: true, method: 'subscription' } },
      inFlight: {},
    };
    const reportOut = captureOutput();
    assert.equal(await cmoMain(['report'], {
      cacheDir,
      outputSink: reportOut.sink,
      limits: injected,
      readLimits: async () => { throw new Error('must not call readLimits when limits are injected'); },
    }), 0);
    assert.match(reportOut.text('stdout'), /the codex meter is dark: injected-codex-dark/);

    let reads = 0;
    const readerOut = captureOutput();
    assert.equal(await cmoMain(['report', '--json'], {
      cacheDir,
      outputSink: readerOut.sink,
      readLimits: async () => {
        reads += 1;
        return injected;
      },
    }), 0);
    assert.equal(reads, 1);
    const parsedReport = JSON.parse(readerOut.text('stdout'));
    assert.match(parsedReport.findings[0].finding, /injected-codex-dark/);

    const limitsOut = captureOutput();
    assert.equal(await cmoMain(['limits', '--human'], {
      outputSink: limitsOut.sink,
      limits: {
        codex: healthy(12),
        claude: healthy(24),
        antigravity: { ...healthy(36), provider: 'antigravity', auth: { ok: true, method: 'subscription' } },
        inFlight: {},
      },
      readLimits: async () => { throw new Error('must not call readLimits when limits are injected'); },
    }), 0);
    assert.match(limitsOut.text('stdout'), /^codex\s+ok/m);
    assert.match(limitsOut.text('stdout'), /^antigravity\s+ok/m);

    // Even an un-injected report stays strictly offline under test/isolate.mjs.
    const offlineOut = captureOutput();
    assert.equal(await cmoMain(['report'], { cacheDir, outputSink: offlineOut.sink }), 0);
    assert.doesNotMatch(offlineOut.text('stdout'), /antigravity meter is dark/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

async function withEmptyPath(fn) {
  const emptyBin = mkdtempSync(join(tmpdir(), 'cmo-empty-path-'));
  const prevPath = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    return await fn();
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  }
}

test('every dispatch saves envelope.json, stdout.log and stderr.log under dispatch/<dispatchId>', async () => withEmptyPath(async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'cmo-dispatch-artifacts-'));
  const rawOut = `${claudeOut('artifact body')}\n`;
  const rawErr = 'benign vendor warning on stderr\n';
  const spawnImpl = fakeSpawn([{ code: 0, stdout: rawOut, stderr: rawErr }]);
  const runOut = captureOutput();

  const code = await cmoMain(
    ['run', '--role', 'implement', '--complexity', '2', '--length', 's', '--prompt', 'build it'],
    {
      cacheDir,
      outputSink: runOut.sink,
      limits: { codex: spent(), claude: healthy(10) },
      spawnImpl,
    },
  );
  assert.equal(code, 0);
  const printed = JSON.parse(runOut.text('stdout'));
  assert.equal(printed.ok, true);
  assert.equal(Object.hasOwn(printed, 'replayed'), false);

  const dir = join(cacheDir, 'dispatch', printed.dispatchId);
  const savedEnvelope = JSON.parse(await readFile(join(dir, 'envelope.json'), 'utf8'));
  const savedStdout = await readFile(join(dir, 'stdout.log'), 'utf8');
  const savedStderr = await readFile(join(dir, 'stderr.log'), 'utf8');
  assert.deepEqual(savedEnvelope, printed);
  assert.equal(savedStdout, rawOut);
  assert.equal(savedStderr, rawErr);

  // Failed dispatches also persist their envelope and raw logs.
  const failSpawn = fakeSpawn([{ code: 2, stdout: 'bad flag stdout\n', stderr: 'fatal flag error\n' }]);
  const failOut = captureOutput();
  const failCode = await cmoMain(
    ['run', '--role', 'implement', '--prompt', 'broken'],
    {
      cacheDir,
      outputSink: failOut.sink,
      limits: { codex: spent(), claude: healthy(10) },
      spawnImpl: failSpawn,
    },
  );
  assert.equal(failCode, 1);
  const failedPrinted = JSON.parse(failOut.text('stdout'));
  const failDir = join(cacheDir, 'dispatch', failedPrinted.dispatchId);
  assert.deepEqual(JSON.parse(await readFile(join(failDir, 'envelope.json'), 'utf8')), failedPrinted);
  assert.equal(await readFile(join(failDir, 'stdout.log'), 'utf8'), 'bad flag stdout\n');
  assert.equal(await readFile(join(failDir, 'stderr.log'), 'utf8'), 'fatal flag error\n');
}));

test('cmo run --idempotency-key and dispatch file idempotency-key replay ok envelopes without running a vendor', async () => withEmptyPath(async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'cmo-idempotency-'));
  const workDir = mkdtempSync(join(tmpdir(), 'cmo-idempotency-files-'));
  const dispatchPath = join(workDir, 'task.md');
  writeFileSync(dispatchPath, [
    'DISPATCH',
    'role: implement',
    'complexity: 2',
    'length: s',
    'idempotency-key: unit-42',
    'TASK',
    'implement unit 42',
  ].join('\n'), 'utf8');

  const spawnImpl = fakeSpawn([{ code: 0, stdout: claudeOut('completed unit 42'), stderr: '' }]);
  const firstOut = captureOutput();
  const firstCode = await cmoMain(['run', '--dispatch', dispatchPath], {
    cacheDir,
    outputSink: firstOut.sink,
    limits: { codex: spent(), claude: healthy(10) },
    spawnImpl,
  });
  assert.equal(firstCode, 0);
  assert.equal(spawnImpl.calls.length, 1);
  const firstEnvelope = JSON.parse(firstOut.text('stdout'));
  assert.equal(firstEnvelope.ok, true);
  assert.equal(firstEnvelope.result, 'completed unit 42');
  assert.equal(Object.hasOwn(firstEnvelope, 'replayed'), false);

  const receiptsAfterFirst = await readAudit({ cacheDir });
  assert.equal(receiptsAfterFirst.length, 1);
  assert.equal(receiptsAfterFirst[0].idempotencyKey, 'unit-42');

  // Second run with the same key: even with exhausted limits and a throwing readLimits/spawn,
  // it prints the saved envelope with replayed: true and original dispatchId, exits 0, and runs nothing.
  const replayOut = captureOutput();
  const replayCode = await cmoMain(['run', '--dispatch', dispatchPath], {
    cacheDir,
    outputSink: replayOut.sink,
    readLimits: async () => { throw new Error('replay must not probe meters'); },
    spawnImpl: async () => { throw new Error('replay must not spawn a vendor'); },
  });
  assert.equal(replayCode, 0);
  const replayEnvelope = JSON.parse(replayOut.text('stdout'));
  assert.deepEqual(replayEnvelope, { ...firstEnvelope, replayed: true });
  assert.equal(replayEnvelope.dispatchId, firstEnvelope.dispatchId);
  assert.equal((await readAudit({ cacheDir })).length, 1, 'replay writes no duplicate receipt');

  // CLI --idempotency-key overrides dispatch file key, so a new key runs fresh.
  const overrideSpawn = fakeSpawn([{ code: 0, stdout: claudeOut('override result'), stderr: '' }]);
  const overrideOut = captureOutput();
  assert.equal(await cmoMain(['run', '--dispatch', dispatchPath, '--idempotency-key', 'unit-43'], {
    cacheDir,
    outputSink: overrideOut.sink,
    limits: { codex: spent(), claude: healthy(10) },
    spawnImpl: overrideSpawn,
  }), 0);
  assert.equal(overrideSpawn.calls.length, 1);
  const overrideEnvelope = JSON.parse(overrideOut.text('stdout'));
  assert.notEqual(overrideEnvelope.dispatchId, firstEnvelope.dispatchId);
  assert.equal(Object.hasOwn(overrideEnvelope, 'replayed'), false);

  // Replaying via CLI --idempotency-key also hits without a dispatch file.
  const cliReplayOut = captureOutput();
  assert.equal(await cmoMain(['run', '--idempotency-key', 'unit-43', '--prompt', 'anything'], {
    cacheDir,
    outputSink: cliReplayOut.sink,
    readLimits: async () => { throw new Error('replay must not probe meters'); },
    spawnImpl: async () => { throw new Error('replay must not spawn a vendor'); },
  }), 0);
  assert.deepEqual(JSON.parse(cliReplayOut.text('stdout')), { ...overrideEnvelope, replayed: true });

  // Empty --idempotency-key is a usage error (exit 2).
  const badKeyOut = captureOutput();
  assert.equal(await cmoMain(['run', '--idempotency-key', '--prompt', 'anything'], {
    cacheDir,
    outputSink: badKeyOut.sink,
  }), 2);
  assert.match(badKeyOut.text('stderr'), /idempotency-key/);
}));

test('failed receipts or missing saved envelopes do not replay and re-run cleanly', async () => withEmptyPath(async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'cmo-idempotency-retry-'));
  const limits = { codex: spent(), claude: healthy(10) };

  // 1. First run fails: records key on ok:false receipt, saves failed envelope, must NOT replay next time.
  const failSpawn = fakeSpawn([{ code: 2, stdout: '', stderr: 'fatal error' }]);
  const failOut = captureOutput();
  assert.equal(await cmoMain(['run', '--idempotency-key', 'retry-key', '--prompt', 'try 1'], {
    cacheDir, outputSink: failOut.sink, limits, spawnImpl: failSpawn,
  }), 1);
  const failReceipts = await readAudit({ cacheDir });
  assert.equal(failReceipts.length, 1);
  assert.equal(failReceipts[0].ok, false);
  assert.equal(failReceipts[0].idempotencyKey, 'retry-key');

  // 2. Second run with same key runs the vendor and succeeds.
  const okSpawn = fakeSpawn([{ code: 0, stdout: claudeOut('fixed on try 2'), stderr: '' }]);
  const okOut = captureOutput();
  assert.equal(await cmoMain(['run', '--idempotency-key', 'retry-key', '--prompt', 'try 2'], {
    cacheDir, outputSink: okOut.sink, limits, spawnImpl: okSpawn,
  }), 0);
  assert.equal(okSpawn.calls.length, 1);
  const okEnvelope = JSON.parse(okOut.text('stdout'));
  assert.equal(Object.hasOwn(okEnvelope, 'replayed'), false);

  // 3. Delete the saved envelope.json: with no saved envelope, cmo must run again rather than fail or replay nothing.
  const { rm } = await import('node:fs/promises');
  await rm(join(cacheDir, 'dispatch', okEnvelope.dispatchId, 'envelope.json'));
  const rerunSpawn = fakeSpawn([{ code: 0, stdout: claudeOut('rebuilt after cache eviction'), stderr: '' }]);
  const rerunOut = captureOutput();
  assert.equal(await cmoMain(['run', '--idempotency-key', 'retry-key', '--prompt', 'try 3'], {
    cacheDir, outputSink: rerunOut.sink, limits, spawnImpl: rerunSpawn,
  }), 0);
  assert.equal(rerunSpawn.calls.length, 1);
  const rerunEnvelope = JSON.parse(rerunOut.text('stdout'));
  assert.notEqual(rerunEnvelope.dispatchId, okEnvelope.dispatchId);
  assert.equal(rerunEnvelope.result, 'rebuilt after cache eviction');
}));

test('CLI subprocess cmo run replays idempotency-key with exit 0 and runs nothing on the second call', async () => {
  const { execFile } = await import('node:child_process');
  const { chmod } = await import('node:fs/promises');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const cmoBin = new URL('../bin/cmo.mjs', import.meta.url).pathname;

  const cacheDir = mkdtempSync(join(tmpdir(), 'cmo-subproc-idem-cache-'));
  const configDir = mkdtempSync(join(tmpdir(), 'cmo-subproc-idem-cfg-'));
  const fakeBinDir = mkdtempSync(join(tmpdir(), 'cmo-subproc-idem-bin-'));
  const emptyBinDir = mkdtempSync(join(tmpdir(), 'cmo-subproc-idem-empty-'));
  const callsFile = join(cacheDir, 'fake-claude-calls.txt');
  const fakeClaude = join(fakeBinDir, 'claude');

  writeFileSync(fakeClaude, [
    '#!/bin/sh',
    `echo 1 >> "${callsFile}"`,
    'cat >/dev/null',
    'echo "fake stderr line" >&2',
    'printf \'{"type":"result","result":"subproc-answer","usage":{"input_tokens":4,"output_tokens":2}}\\n\'',
  ].join('\n'), 'utf8');
  await chmod(fakeClaude, 0o755);

  const baseEnv = {
    ...process.env,
    CMO_CACHE_DIR: cacheDir,
    CMO_CONFIG_DIR: configDir,
    CMO_CLAUDE_CLI_PROBE: '0',
    CMO_AGY_PROBE: '0',
    CMO_GROK_PROBE: '0',
  };

  const first = await execFileAsync(
    process.execPath,
    [cmoBin, 'run', '--pin', 'claude', '--idempotency-key', 'subproc-k1', '--prompt', 'hello'],
    { env: { ...baseEnv, PATH: `${fakeBinDir}:/bin:/usr/bin` } },
  );
  const firstEnv = JSON.parse(first.stdout);
  assert.equal(firstEnv.ok, true);
  assert.equal(firstEnv.result, 'subproc-answer');
  assert.equal(Object.hasOwn(firstEnv, 'replayed'), false);
  assert.equal((await readFile(callsFile, 'utf8')).trim().split('\n').length, 1);
  assert.equal(await readFile(join(cacheDir, 'dispatch', firstEnv.dispatchId, 'stderr.log'), 'utf8'), 'fake stderr line\n');

  // Second subprocess has NO vendor CLI on PATH at all — proves zero vendor execution on replay.
  const second = await execFileAsync(
    process.execPath,
    [cmoBin, 'run', '--pin', 'claude', '--idempotency-key', 'subproc-k1', '--prompt', 'hello'],
    { env: { ...baseEnv, PATH: emptyBinDir } },
  );
  const secondEnv = JSON.parse(second.stdout);
  assert.deepEqual(secondEnv, { ...firstEnv, replayed: true });
  assert.equal(secondEnv.dispatchId, firstEnv.dispatchId);
  assert.equal((await readFile(callsFile, 'utf8')).trim().split('\n').length, 1);
});
