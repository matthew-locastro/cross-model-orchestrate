import './isolate.mjs'; // MUST be first — see the file
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeProviders, ANTIGRAVITY_MODEL_RE, DEFAULT_FRESHNESS, DEFAULT_MODELS,
  DEFAULT_RESERVATION, loadConfig, resetConfigCache, resolveAgyBinary,
} from '../src/config.mjs';
import {
  CAPABILITIES, decide, providerState, rankProviders, REQUIRES_SUBSCRIPTION_CHECK,
} from '../src/policy.mjs';

const HEALTHY = {
  available: true,
  worstPercent: 5,
  nextResetAt: null,
  hardBlocked: false,
  windows: [{ key: '5h', percentUsed: 5 }],
};

const VERIFIED = { ok: true, method: 'subscription' };
const antigravity = (percent = 5) => ({
  ...HEALTHY,
  provider: 'antigravity',
  worstPercent: percent,
  windows: [{ key: '5h', percentUsed: percent }],
  auth: VERIFIED,
});
const grok = (percent = 5) => ({
  ...HEALTHY,
  provider: 'grok',
  worstPercent: percent,
  windows: [{ key: '5h', percentUsed: percent }],
  auth: VERIFIED,
});

function withConfig(contents, body) {
  const dir = mkdtempSync(join(tmpdir(), 'cmo-roster-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(contents), 'utf8');
  try {
    resetConfigCache();
    const config = loadConfig({ file, reload: true });
    return body(config);
  } finally {
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the default active roster is codex, claude and antigravity', () => {
  withConfig({}, (config) => {
    assert.deepEqual(activeProviders(config), ['codex', 'claude', 'antigravity']);
  });
});

test('an explicit providers config can opt grok into the active roster', () => {
  withConfig({ providers: ['grok', 'claude', 'unknown', 'grok'] }, (config) => {
    assert.deepEqual(activeProviders(config), ['grok', 'claude']);
  });
});

test('inactive grok is never ranked even when its verified meter is healthiest', () => {
  withConfig({}, () => {
    const states = {
      codex: providerState(HEALTHY, undefined, Date.now(), 'codex'),
      claude: providerState(HEALTHY, undefined, Date.now(), 'claude'),
      antigravity: providerState(antigravity(20), undefined, Date.now(), 'antigravity'),
      grok: providerState(grok(0), undefined, Date.now(), 'grok'),
    };
    assert.ok(!rankProviders({ role: 'research' }, states).some((candidate) => candidate.provider === 'grok'));
    const decision = decide(
      { role: 'research', complexity: 2, length: 's' },
      { codex: HEALTHY, claude: HEALTHY, antigravity: antigravity(20), grok: grok(0) },
    );
    assert.notEqual(decision.provider, 'grok');
    assert.ok(!decision.fallbacks.some((fallback) => fallback.provider === 'grok'));
  });
});

test('antigravity has a provisional allowlisted Gemini model on every tier', () => {
  assert.deepEqual(DEFAULT_MODELS.antigravity, {
    frontier: { model: 'gemini-4-neon', effort: 'xhigh' },
    balanced: { model: 'gemini-4-carbon', effort: 'high' },
    fast: { model: 'gemini-4-hydrogen', effort: 'low' },
  });
  for (const tier of ['frontier', 'balanced', 'fast']) {
    assert.match(DEFAULT_MODELS.antigravity[tier].model, ANTIGRAVITY_MODEL_RE);
  }
  assert.doesNotMatch('claude-opus-5-5', ANTIGRAVITY_MODEL_RE);
  assert.doesNotMatch('gpt-oss-120b', ANTIGRAVITY_MODEL_RE);
  assert.equal(DEFAULT_FRESHNESS.antigravity, 60_000);
  assert.equal(DEFAULT_RESERVATION.antigravity, 1.0);
  assert.equal(CAPABILITIES.antigravity.web, true);
  assert.equal(REQUIRES_SUBSCRIPTION_CHECK.has('antigravity'), true);
  assert.equal(providerState(undefined, undefined, Date.now(), 'antigravity').state, 'unauthenticated');
});

test('antigravity binary and probe config are explicit and overridable', () => {
  assert.equal(resolveAgyBinary({ CMO_AGY_BIN: '/opt/agy', PATH: '' }, '/unused'), '/opt/agy');
  const previousProbe = process.env.CMO_AGY_PROBE;
  const previousBinary = process.env.CMO_AGY_BIN;
  delete process.env.CMO_AGY_PROBE;
  delete process.env.CMO_AGY_BIN;
  try {
    withConfig({ agyBinary: '/configured/agy' }, (config) => {
      assert.equal(config.agyBinary, '/configured/agy');
      assert.equal(config.agyProbe, true);
    });
  } finally {
    if (previousProbe === undefined) delete process.env.CMO_AGY_PROBE;
    else process.env.CMO_AGY_PROBE = previousProbe;
    if (previousBinary === undefined) delete process.env.CMO_AGY_BIN;
    else process.env.CMO_AGY_BIN = previousBinary;
    resetConfigCache();
  }
});

test('research and web work never route to sandboxed codex', () => {
  withConfig({}, () => {
    const limits = { codex: HEALTHY, claude: HEALTHY, antigravity: antigravity() };
    const research = decide({ role: 'research', complexity: 2, length: 's' }, limits);
    assert.notEqual(research.provider, 'codex');
    assert.ok(!research.fallbacks.some((fallback) => fallback.provider === 'codex'));

    const fullAccess = decide({ role: 'research', pin: 'codex', fullAccess: true }, limits);
    assert.equal(fullAccess.provider, 'codex');

    const web = decide({ role: 'implement', complexity: 3, length: 'm', needsWeb: true }, limits);
    assert.notEqual(web.provider, 'codex');
    assert.ok(!web.fallbacks.some((fallback) => fallback.provider === 'codex'));
  });
});
