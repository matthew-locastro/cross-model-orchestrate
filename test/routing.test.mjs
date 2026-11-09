// Least-used routing: headroom dominates, a differentially idle subscription
// gets a power-use bonus, and the orchestrator's vendor is held in reserve.
import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, resetConfigCache } from '../src/config.mjs';
import { providerPressure } from '../src/pace.mjs';
import { decide, providerState, routingLine } from '../src/policy.mjs';

const reading = (percent, extra = {}) => ({
  available: true,
  worstPercent: percent,
  nextResetAt: null,
  hardBlocked: false,
  windows: [{ key: '5h', label: '5hr', percentUsed: percent, resetsAt: null }],
  ...extra,
});
const SUB = { ok: true, method: 'oauth', authMode: 'Oidc', tier: 'SuperGrok Plus' };
const grok = (percent, extra = {}) => reading(percent, { provider: 'grok', auth: SUB, ...extra });
const spent = () => reading(99, { hardBlocked: true });

const limits = (codex, claude, grokPercentOrReading) => ({
  codex: reading(codex),
  claude: reading(claude),
  grok: typeof grokPercentOrReading === 'number' ? grok(grokPercentOrReading) : grokPercentOrReading,
});

function withConfig(contents, body) {
  const dir = mkdtempSync(join(tmpdir(), 'cmo-route-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(contents), 'utf8');
  try {
    resetConfigCache();
    loadConfig({ file, reload: true });
    return body();
  } finally {
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('grok 6, codex 67, claude 60: implement power-uses grok and reserves claude', () => {
  const d = decide({ role: 'implement', complexity: 4, length: 'l' }, limits(67, 60, 6));
  assert.equal(d.provider, 'grok');
  assert.match(d.reason, /power-use: grok is 61 points less used than codex/);
  assert.ok(d.notes.some((n) => n === 'claude reserved for the orchestrator (pressure 60% ≥ 60%)'));
  assert.equal(d.fallbacks[0].provider, 'codex');
  assert.equal(d.fallbacks.at(-1).provider, 'claude');
  assert.equal(
    routingLine(limits(67, 60, 6)),
    'routing: power-use grok (6%) · codex 67% · claude reserved for orchestrator',
  );
});

test('codex 10, grok 50, claude 30: implement power-uses codex', () => {
  const d = decide({ role: 'implement', complexity: 3, length: 'm' }, limits(10, 30, 50));
  assert.equal(d.provider, 'codex');
  assert.match(d.reason, /power-use: codex is 20 points less used than claude/);
  assert.equal(d.notes.some((n) => /reserved for the orchestrator/.test(n)), false);
});

test('codex 40, grok 45, claude 5: claude wins and the why shows the bonus and the penalty', () => {
  const d = decide({ role: 'implement', complexity: 3, length: 'm' }, limits(40, 5, 45));
  assert.equal(d.provider, 'claude');
  assert.match(d.reason, /power-use: claude is 35 points less used than codex/);
  assert.match(d.reason, /claude loses 30 to keep orchestrator headroom/);
});

test('codex 40, grok 45, claude 70: claude is reserved and never chosen', () => {
  const d = decide({ role: 'implement', complexity: 3, length: 'm' }, limits(40, 70, 45));
  assert.equal(d.provider, 'codex');
  assert.notEqual(d.provider, 'claude');
  assert.ok(d.fallbacks[0].provider !== 'claude');
  assert.ok(d.notes.some((n) => n === 'claude reserved for the orchestrator (pressure 70% ≥ 60%)'));
});

test('claude above reserveAt is still allowed when every other vendor is exhausted', () => {
  const d = decide(
    { role: 'implement', complexity: 3, length: 'm' },
    { codex: spent(), claude: reading(72), grok: grok(99, { hardBlocked: true }) },
  );
  assert.equal(d.ok, true);
  assert.equal(d.provider, 'claude');
  assert.match(d.reason, /claude reserved for the orchestrator \(pressure 72% ≥ 60%\), used because nothing else can run/);
  assert.equal(d.fallback, null);
});

test('a review independent of codex goes to a healthy grok, never a reserved claude', () => {
  const d = decide(
    { role: 'review', complexity: 3, length: 's', independentOf: 'codex' },
    limits(20, 75, 12),
  );
  assert.equal(d.provider, 'grok');
  assert.notEqual(d.provider, 'claude');
  assert.equal(d.independence, 'cross-vendor');
  assert.ok(!d.fallbacks.some((f) => f.provider === 'codex'));
  assert.ok(d.notes.some((n) => /claude reserved for the orchestrator \(pressure 75% ≥ 60%\)/.test(n)));
});

test('research still goes to grok when it is healthy', () => {
  const d = decide({ role: 'research', complexity: 2, length: 's' }, limits(15, 20, 25));
  assert.equal(d.provider, 'grok');
  assert.match(d.reason, /grok preferred for research/);
  assert.equal(/power-use:/.test(d.reason), false);
});

test('a pin still forces the orchestrator vendor while it is reserved', () => {
  const d = decide({ role: 'implement', pin: 'claude' }, limits(40, 70, 45));
  assert.equal(d.provider, 'claude');
  assert.ok(d.notes.some((n) => /provider pinned to claude/.test(n)));
});

test('orchestrator.vendor null turns the reserve off', () => {
  const readingSet = { codex: reading(90), claude: reading(70), grok: spent() };
  const held = decide({ role: 'implement' }, readingSet);
  assert.equal(held.provider, 'codex', 'a critical codex still outranks a reserved claude');
  withConfig({ orchestrator: { vendor: null } }, () => {
    const open = decide({ role: 'implement' }, readingSet);
    assert.equal(open.provider, 'claude');
    assert.equal(open.notes.some((n) => /reserved for the orchestrator/.test(n)), false);
  });
});

test('a usable provider with unknown pressure blocks the power-use bonus', () => {
  // Codex 50%, Claude 5%, Grok signed in but unreadable. Claude's 45-point gap
  // over Codex is not a comparison against every competitor: Grok can still run.
  const unread = { provider: 'grok', available: false, auth: SUB, error: 'meter unreadable' };
  const d = decide({ role: 'implement', complexity: 3, length: 'm' }, limits(50, 5, unread));
  assert.equal(d.states.grok.state, 'unknown');
  assert.equal(d.states.grok.percent, null);
  assert.equal(/power-use:/.test(d.reason), false);
  assert.equal(d.provider, 'codex');
  assert.notEqual(d.provider, 'claude');
});

test('an available reading with no pressure stays null and does not win as least-used', () => {
  const blank = { available: true, worstPercent: null, windows: [], hardBlocked: false };
  assert.equal(providerPressure(blank).percent, null);
  const state = providerState(blank);
  assert.equal(state.state, 'unknown');
  assert.equal(state.percent, null);

  // A coerced 0% would outrank a provider genuinely at 5%.
  const d = decide(
    { role: 'implement', complexity: 3, length: 'm' },
    { codex: blank, claude: reading(5), grok: grok(99, { hardBlocked: true }) },
  );
  assert.equal(d.states.codex.state, 'unknown');
  assert.equal(d.states.codex.percent, null);
  assert.equal(d.provider, 'claude');
});

test('limits --human says headroom unknown when the lead has no numeric pressure', () => {
  const dark = { available: false, error: 'no reading' };
  const line = routingLine({
    codex: dark,
    claude: dark,
    grok: { provider: 'grok', available: false, auth: SUB, error: 'meter unreadable' },
  });
  assert.equal(
    line,
    'routing: headroom unknown (codex) · grok unknown · claude unknown',
  );
  assert.equal(/least-used/.test(line), false);
});

test('a configured powerGap is what the bonus actually uses', () => {
  withConfig({ routing: { powerGap: 100 } }, () => {
    const d = decide({ role: 'implement' }, limits(10, 30, 50));
    assert.equal(d.provider, 'codex');
    assert.equal(/power-use:/.test(d.reason), false);
  });
});
