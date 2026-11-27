// Reset inventory (`resets.<provider>`, `cmo resets`) and burn mode (`cmo burn`).
import './isolate.mjs'; // MUST be first — see isolate.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, resetConfigCache } from '../src/config.mjs';
import { decide } from '../src/policy.mjs';
import { runAgent } from '../src/run.mjs';
import { main as cmoMain, renderLimits } from '../bin/cmo.mjs';

const NOW = Date.parse('2026-11-27T20:00:00.000Z');
const HOUR = 3_600_000;

function captureOutput() {
  const writes = [];
  return {
    sink(text, stream = 'stdout') { writes.push({ stream, text }); },
    text(stream = 'stdout') { return writes.filter((w) => w.stream === stream).map((w) => w.text).join(''); },
  };
}

function withSandbox(fn, initialConfig = undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'cmo-resets-burn-'));
  const cacheDir = join(dir, 'cache');
  const configFile = join(dir, 'config.json');
  if (initialConfig !== undefined) {
    writeFileSync(configFile, JSON.stringify(initialConfig, null, 2), 'utf8');
  }
  return Promise.resolve()
    .then(() => {
      resetConfigCache();
      loadConfig({ file: configFile, reload: true });
      return fn({ cacheDir, configFile });
    })
    .finally(() => {
      resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    });
}

const VERIFIED_SUB = { ok: true, method: 'subscription' };

const codexWeekly = (percent, resetsAt = '2026-12-03T08:00:00.000Z', extraWindows = []) => ({
  provider: 'codex',
  available: true,
  worstPercent: percent,
  worstWindow: 'weekly',
  nextResetAt: resetsAt,
  hardBlocked: percent >= 100,
  plan: 'pro',
  windows: [
    ...extraWindows,
    { key: 'weekly', label: 'Wkly', percentUsed: percent, resetsAt },
  ],
});

const claudeAt = (percent, resetsAt = '2026-12-04T16:00:00.000Z') => ({
  provider: 'claude',
  available: true,
  worstPercent: percent,
  worstWindow: 'weekly',
  nextResetAt: resetsAt,
  hardBlocked: percent >= 100,
  windows: [{ key: 'weekly', label: 'Wkly', percentUsed: percent, resetsAt }],
});

const agyAt = (percent, resetsAt = '2026-12-04T00:00:00.000Z') => ({
  provider: 'antigravity',
  available: true,
  auth: VERIFIED_SUB,
  worstPercent: percent,
  worstWindow: 'weekly',
  nextResetAt: resetsAt,
  hardBlocked: percent >= 100,
  windows: [{ key: 'weekly', label: 'Wkly', percentUsed: percent, resetsAt }],
});

const claudeJsonOut = (text) => JSON.stringify({
  type: 'result',
  result: text,
  usage: { input_tokens: 10, output_tokens: 5 },
});

function fakeSpawn(responses) {
  let idx = 0;
  const calls = [];
  const fn = async (invocation) => {
    calls.push(invocation);
    const r = responses[Math.min(idx, responses.length - 1)];
    idx += 1;
    if (typeof r === 'function') return r(invocation);
    return { code: 0, signal: null, timedOut: false, stdout: '', stderr: '', ...r };
  };
  fn.calls = calls;
  return fn;
}

test('reset inventory parses ISO dates (00:00 UTC) and datetimes, rejects bad entries, and supports list/add/used', async () => {
  await withSandbox(async ({ cacheDir, configFile }) => {
    // Empty by default
    assert.deepEqual(loadConfig({ file: configFile, reload: true }).resets, {});
    const emptyList = captureOutput();
    assert.equal(await cmoMain(['resets', 'list'], { cacheDir, configFile, now: NOW, outputSink: emptyList.sink }), 0);
    assert.match(emptyList.text(), /no .*resets/i);

    // Add out of order + duplicate bare date + offset datetime
    for (const expiry of ['2026-12-10', '2026-11-30', '2026-11-30', '2026-12-02T14:30:00+02:00']) {
      const out = captureOutput();
      assert.equal(
        await cmoMain(['resets', 'add', 'codex', expiry], { cacheDir, configFile, now: NOW, outputSink: out.sink }),
        0,
      );
    }

    const cfg = loadConfig({ file: configFile, reload: true });
    assert.deepEqual(cfg.resets.codex, [
      '2026-11-30T00:00:00.000Z',
      '2026-11-30T00:00:00.000Z',
      '2026-12-02T12:30:00.000Z',
      '2026-12-10T00:00:00.000Z',
    ]);

    const listed = captureOutput();
    assert.equal(await cmoMain(['resets', 'list'], { cacheDir, configFile, now: NOW, outputSink: listed.sink }), 0);
    assert.match(listed.text(), /codex.*2026-11-30.*2026-12-02 12:30Z.*2026-12-10/);

    // `cmo resets used codex` removes ONLY ONE of the earliest (2026-11-30), keeping the duplicate
    const usedEarliest = captureOutput();
    assert.equal(await cmoMain(['resets', 'used', 'codex'], { cacheDir, configFile, now: NOW, outputSink: usedEarliest.sink }), 0);
    assert.deepEqual(loadConfig({ file: configFile, reload: true }).resets.codex, [
      '2026-11-30T00:00:00.000Z',
      '2026-12-02T12:30:00.000Z',
      '2026-12-10T00:00:00.000Z',
    ]);

    // `cmo resets used codex <expiry>` removes that specific entry
    const usedSpecific = captureOutput();
    assert.equal(
      await cmoMain(['resets', 'used', 'codex', '2026-12-02T12:30:00Z'], { cacheDir, configFile, now: NOW, outputSink: usedSpecific.sink }),
      0,
    );
    assert.deepEqual(loadConfig({ file: configFile, reload: true }).resets.codex, [
      '2026-11-30T00:00:00.000Z',
      '2026-12-10T00:00:00.000Z',
    ]);

    // Unmatched expiry exits 1; malformed date or unknown provider exits 2
    const unmatched = captureOutput();
    assert.equal(
      await cmoMain(['resets', 'used', 'codex', '2026-12-25'], { cacheDir, configFile, now: NOW, outputSink: unmatched.sink }),
      1,
    );
    const badDate = captureOutput();
    assert.equal(
      await cmoMain(['resets', 'add', 'codex', '2026-02-30'], { cacheDir, configFile, now: NOW, outputSink: badDate.sink }),
      2,
    );
    const badProvider = captureOutput();
    assert.equal(
      await cmoMain(['resets', 'add', 'unknown-vendor', '2026-12-01'], { cacheDir, configFile, now: NOW, outputSink: badProvider.sink }),
      2,
    );
  });

  // Malformed config.json resets throws loudly rather than silently dropping entries
  await assert.rejects(
    () => withSandbox(() => {}, { resets: { codex: ['not-an-iso-date'] } }),
    /resets/,
  );
});

test('limits --human classifies resets against the weekly natural reset and prints the use-or-lose suggestion', async () => {
  await withSandbox(async ({ cacheDir }) => {
    // Weekly resets 2026-12-03 08:00Z; 5h resets in 2h (must NOT be mistaken for the weekly reset).
    // - 2026-11-20: already expired before NOW -> not counted as use-or-lose
    // - 2026-11-30: before weekly reset -> use or lose
    // - 2026-12-03: bare date = 2026-12-03T00:00Z < 2026-12-03T08:00Z -> use or lose
    // - 2026-12-09: after weekly reset -> safe, not marked use or lose
    const limits = {
      codex: {
        ...codexWeekly(35, '2026-12-03T08:00:00.000Z', [
          { key: '5h', label: '5hr', percentUsed: 50, resetsAt: '2026-11-27T22:00:00.000Z' },
        ]),
        worstPercent: 50,
        worstWindow: '5h',
        nextResetAt: '2026-11-27T22:00:00.000Z',
      },
      claude: claudeAt(15),
      antigravity: agyAt(10),
    };

    const rendered = renderLimits(limits, NOW, { cacheDir });
    assert.match(rendered, /2026-11-30 \(use or lose\)/);
    assert.match(rendered, /2026-12-03 \(use or lose\)/);
    assert.match(rendered, /2026-12-09(?! \(use or lose\))/);
    assert.doesNotMatch(rendered, /2026-11-20 \(use or lose\)/);
    assert.ok(
      rendered.includes('2 codex resets expire before the weekly reset; run `cmo burn codex` to use them.'),
      `expected exact suggestion line in:\n${rendered}`,
    );
  }, {
    resets: {
      codex: ['2026-11-20', '2026-11-30', '2026-12-03', '2026-12-09'],
    },
  });
});

test('burn mode strongly prefers the burn provider across pressure bands while respecting capabilities and Claude reserve', async () => {
  await withSandbox(async ({ cacheDir, configFile }) => {
    // Codex at 85% raw with 5 days left has 94% pace pressure (critical) while Antigravity is at 6%.
    // Without burn mode, Antigravity wins via power-use and Codex critical would downgrade frontier->balanced.
    const limits = {
      codex: codexWeekly(85, new Date(NOW + 5 * 24 * HOUR).toISOString()),
      claude: claudeAt(65),
      antigravity: agyAt(6),
    };

    const normal = decide({ role: 'architecture', complexity: 5, length: 'l' }, limits, { now: NOW, cacheDir });
    assert.equal(normal.provider, 'antigravity');

    // Start burn mode via CLI; state lives in cacheDir so subsequent decisions see it.
    const statusBefore = captureOutput();
    assert.equal(await cmoMain(['burn'], { cacheDir, configFile, now: NOW, outputSink: statusBefore.sink }), 0);
    assert.match(statusBefore.text(), /off/i);

    const startOut = captureOutput();
    assert.equal(
      await cmoMain(['burn', 'codex', '--until', '36h'], { cacheDir, configFile, now: NOW, outputSink: startOut.sink }),
      0,
    );
    assert.match(startOut.text(), /codex.*active/i);

    // Architecture task: strongly prefers codex AND does not downgrade frontier->balanced on critical pressure!
    const burning = decide({ role: 'architecture', complexity: 5, length: 'l' }, limits, { now: NOW, cacheDir });
    assert.equal(burning.provider, 'codex');
    assert.equal(burning.tier, 'frontier');
    // Claude's orchestrator reserve (65% >= 60%) still holds Claude behind Antigravity on the fallback ladder.
    assert.deepEqual(burning.fallbacks.map((f) => f.provider), ['antigravity', 'claude']);
    assert.ok(burning.notes.some((n) => /claude reserved for the orchestrator/.test(n)));

    // Capability rule: sandboxed Codex still cannot take research or --web work.
    const webTask = decide({ role: 'research', complexity: 2, length: 's', needsWeb: true }, limits, { now: NOW, cacheDir });
    assert.equal(webTask.provider, 'antigravity');
    assert.ok(!webTask.fallbacks.some((f) => f.provider === 'codex'));

    // With fullAccess enabled on the dispatch, Codex CAN reach the network, so burn prefers Codex.
    const webFullAccess = decide(
      { role: 'research', complexity: 2, length: 's', needsWeb: true, fullAccess: true },
      limits,
      { now: NOW, cacheDir },
    );
    assert.equal(webFullAccess.provider, 'codex');
  });
});

test('cross-vendor independence rule holds under burn mode', async () => {
  await withSandbox(async ({ cacheDir, configFile }) => {
    await cmoMain(['burn', 'codex', '--until', '24h'], { cacheDir, configFile, now: NOW, outputSink: () => {} });
    const limits = {
      codex: codexWeekly(40),
      claude: claudeAt(65),
      antigravity: agyAt(12),
    };

    // Work independent of codex MUST NOT go to codex even while burning codex; Claude stays reserved behind Antigravity.
    const reviewCodex = decide(
      { role: 'review', complexity: 3, length: 's', independentOf: 'codex' },
      limits,
      { now: NOW, cacheDir },
    );
    assert.equal(reviewCodex.provider, 'antigravity');
    assert.equal(reviewCodex.independence, 'cross-vendor');
    assert.ok(!reviewCodex.fallbacks.some((f) => f.provider === 'codex'));

    // Work independent of antigravity DOES use the burn provider (codex).
    const reviewAgy = decide(
      { role: 'review', complexity: 3, length: 's', independentOf: 'antigravity' },
      limits,
      { now: NOW, cacheDir },
    );
    assert.equal(reviewAgy.provider, 'codex');
    assert.equal(reviewAgy.independence, 'cross-vendor');
  });
});

test('burn exhaustion (raw >=95%) falls back, prompts to redeem in limits --human and cmo run notes, and auto-resumes when usage drops', async () => {
  await withSandbox(async ({ cacheDir, configFile }) => {
    await cmoMain(['burn', 'codex', '--until', '48h'], { cacheDir, configFile, now: NOW, outputSink: () => {} });

    const expectedMsg = 'codex exhausted; 2 resets left (earliest expires 2026-11-30): redeem one in the app to keep burning';

    // Raw 94% is NOT exhausted yet -> still burns codex.
    const at94 = {
      codex: codexWeekly(94),
      claude: claudeAt(20),
      antigravity: agyAt(10),
    };
    assert.equal(decide({ role: 'implement' }, at94, { now: NOW, cacheDir }).provider, 'codex');

    // Raw 95% IS exhausted -> falls back to antigravity, and both limits --human and cmo run notes emit expectedMsg.
    const at95 = {
      codex: codexWeekly(95),
      claude: claudeAt(20),
      antigravity: agyAt(10),
    };
    const limitsOut = captureOutput();
    assert.equal(
      await cmoMain(['limits', '--human'], { cacheDir, configFile, now: NOW, limits: at95, outputSink: limitsOut.sink }),
      0,
    );
    assert.ok(limitsOut.text().includes(expectedMsg), `limits --human missing message:\n${limitsOut.text()}`);

    const spawn = fakeSpawn([{
      code: 0,
      stdout: JSON.stringify({ status: 'SUCCESS', response: 'done by fallback', stats: { models: {} } }),
    }]);
    const runOut = captureOutput();
    assert.equal(
      await cmoMain(['run', '--role', 'implement', '--prompt', 'build x'], {
        cacheDir,
        configFile,
        now: NOW,
        limits: at95,
        spawnImpl: spawn,
        outputSink: runOut.sink,
      }),
      0,
    );
    const envelope = JSON.parse(runOut.text());
    assert.equal(envelope.provider, 'antigravity');
    assert.ok(Array.isArray(envelope.notes) && envelope.notes.includes(expectedMsg));
    assert.ok(Array.isArray(envelope.decision?.notes) && envelope.decision.notes.includes(expectedMsg));

    // Mid-run rate limit when codex started below 95%: envelope notes come from decide(), not a post-run rewrite.
    const midRunSpawn = fakeSpawn([
      { code: 1, stdout: '', stderr: 'You have hit your usage limit' },
      { code: 0, stdout: claudeJsonOut('recovered on claude'), stderr: '' },
    ]);
    const midRunOut = captureOutput();
    assert.equal(
      await cmoMain(['run', '--role', 'implement', '--prompt', 'finish batch'], {
        cacheDir,
        configFile,
        now: NOW,
        limits: { codex: codexWeekly(93), claude: claudeAt(15) },
        spawnImpl: midRunSpawn,
        outputSink: midRunOut.sink,
      }),
      0,
    );
    const midEnv = JSON.parse(midRunOut.text());
    assert.equal(midEnv.provider, 'claude');
    assert.equal(midEnv.failedOver, true);
    assert.ok(!midEnv.notes.includes(expectedMsg));
    assert.deepEqual(midEnv.notes, midEnv.decision?.notes);

    // Once user redeems a reset in the vendor's app and usage drops (e.g. 2%), burning resumes automatically
    // and healthy cmo run envelopes no longer emit the exhausted redemption warning!
    const afterRedeem = {
      codex: codexWeekly(2, '2026-12-04T20:00:00.000Z'),
      claude: claudeAt(20),
      antigravity: agyAt(5),
    };
    const resumed = decide({ role: 'implement' }, afterRedeem, { now: NOW + HOUR, cacheDir });
    assert.equal(resumed.provider, 'codex');

    const codexOkSpawn = fakeSpawn([async (inv) => {
      const idx = inv.args.indexOf('--output-last-message');
      if (idx !== -1) writeFileSync(inv.args[idx + 1], 'burned on codex', 'utf8');
      return {
        code: 0,
        stdout: `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 8, output_tokens: 4 } })}\n`,
        stderr: '',
      };
    }]);
    const resumedRunOut = captureOutput();
    assert.equal(
      await cmoMain(['run', '--role', 'implement', '--prompt', 'next unit'], {
        cacheDir,
        configFile,
        now: NOW + HOUR,
        limits: afterRedeem,
        spawnImpl: codexOkSpawn,
        outputSink: resumedRunOut.sink,
      }),
      0,
    );
    const resumedEnv = JSON.parse(resumedRunOut.text());
    assert.equal(resumedEnv.provider, 'codex');
    assert.ok(!resumedEnv.notes.includes(expectedMsg));

    // Even when every provider is exhausted (deferred exit 3), cmo run envelope notes still include expectedMsg.
    const deferredOut = captureOutput();
    assert.equal(
      await cmoMain(['run', '--role', 'implement', '--prompt', 'all spent'], {
        cacheDir,
        configFile,
        now: NOW,
        limits: { codex: codexWeekly(99), claude: claudeAt(99), antigravity: agyAt(99) },
        outputSink: deferredOut.sink,
      }),
      3,
    );
    assert.ok(JSON.parse(deferredOut.text()).notes.includes(expectedMsg));
  }, {
    resets: {
      codex: ['2026-11-20', '2026-11-30', '2026-12-10'],
    },
  });
});

test('burn state in cache directory is shared across separate cmo CLI processes', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const cmoBin = new URL('../bin/cmo.mjs', import.meta.url).pathname;

  const dir = mkdtempSync(join(tmpdir(), 'cmo-subproc-burn-'));
  const cacheDir = join(dir, 'cache');
  const configDir = join(dir, 'config');
  const env = {
    ...process.env,
    CMO_CACHE_DIR: cacheDir,
    CMO_CONFIG_DIR: configDir,
    CMO_CLAUDE_CLI_PROBE: '0',
    CMO_AGY_PROBE: '0',
    CMO_GROK_PROBE: '0',
  };
  try {
    await execFileAsync(process.execPath, [cmoBin, 'resets', 'add', 'codex', '2026-12-01'], { env });
    const listed = await execFileAsync(process.execPath, [cmoBin, 'resets', 'list'], { env });
    assert.match(listed.stdout, /codex: 2026-12-01/);

    await execFileAsync(process.execPath, [cmoBin, 'burn', 'codex', '--until', '36h'], { env });
    const status = await execFileAsync(process.execPath, [cmoBin, 'burn'], { env });
    assert.match(status.stdout, /^burn: codex active until /);

    await execFileAsync(process.execPath, [cmoBin, 'burn', '--off'], { env });
    const offStatus = await execFileAsync(process.execPath, [cmoBin, 'burn'], { env });
    assert.equal(offStatus.stdout.trim(), 'burn: off');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('burn state expires at --until (duration or ISO datetime) and stops immediately on --off', async () => {
  await withSandbox(async ({ cacheDir, configFile }) => {
    const limits = {
      codex: codexWeekly(80, new Date(NOW + 5 * 24 * HOUR).toISOString()),
      claude: claudeAt(30),
      antigravity: agyAt(5),
    };

    // 1. Duration --until 36h
    assert.equal(
      await cmoMain(['burn', 'codex', '--until', '36h'], { cacheDir, configFile, now: NOW, outputSink: () => {} }),
      0,
    );
    assert.equal(decide({ role: 'implement' }, limits, { now: NOW + 35 * HOUR, cacheDir }).provider, 'codex');
    assert.equal(decide({ role: 'implement' }, limits, { now: NOW + 36 * HOUR, cacheDir }).provider, 'antigravity');

    const expiredStatus = captureOutput();
    assert.equal(
      await cmoMain(['burn'], { cacheDir, configFile, now: NOW + 36 * HOUR, outputSink: expiredStatus.sink }),
      0,
    );
    assert.match(expiredStatus.text(), /off/i);

    // 2. ISO datetime --until, then explicit --off before expiry
    assert.equal(
      await cmoMain(
        ['burn', 'codex', '--until', '2026-11-29T12:00:00Z'],
        { cacheDir, configFile, now: NOW, outputSink: () => {} },
      ),
      0,
    );
    assert.equal(
      decide({ role: 'implement' }, limits, { now: Date.parse('2026-11-29T11:59:59Z'), cacheDir }).provider,
      'codex',
    );
    assert.equal(
      decide({ role: 'implement' }, limits, { now: Date.parse('2026-11-29T12:00:00Z'), cacheDir }).provider,
      'antigravity',
    );

    // Explicit --off ends burn immediately even when started with no --until
    assert.equal(
      await cmoMain(['burn', 'codex'], { cacheDir, configFile, now: NOW, outputSink: () => {} }),
      0,
    );
    assert.equal(decide({ role: 'implement' }, limits, { now: NOW, cacheDir }).provider, 'codex');
    assert.equal(
      await cmoMain(['burn', '--off'], { cacheDir, configFile, now: NOW, outputSink: () => {} }),
      0,
    );
    assert.equal(decide({ role: 'implement' }, limits, { now: NOW, cacheDir }).provider, 'antigravity');
  });
});

test('cmo run idempotency replay returns the saved envelope unchanged and runAgent does not synthesize post-run burn notes', async () => {
  await withSandbox(async ({ cacheDir, configFile }) => {
    const codexOkSpawn = fakeSpawn([async (inv) => {
      const idx = inv.args.indexOf('--output-last-message');
      if (idx !== -1) writeFileSync(inv.args[idx + 1], 'first run answer', 'utf8');
      return {
        code: 0,
        stdout: `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 8, output_tokens: 4 } })}\n`,
        stderr: '',
      };
    }]);

    const firstOut = captureOutput();
    assert.equal(
      await cmoMain(['run', '--role', 'implement', '--prompt', 'cached work', '--idempotency-key', 'burn-replay-key'], {
        cacheDir,
        configFile,
        now: NOW,
        limits: { codex: codexWeekly(10), claude: claudeAt(30), antigravity: agyAt(30) },
        spawnImpl: codexOkSpawn,
        outputSink: firstOut.sink,
      }),
      0,
    );
    const originalEnv = JSON.parse(firstOut.text());
    assert.equal(codexOkSpawn.calls.length, 1);

    // Enable burn mode and exhaust codex afterwards: replay must still return the stored envelope untouched.
    await cmoMain(['burn', 'codex', '--until', '24h'], { cacheDir, configFile, now: NOW, outputSink: () => {} });
    const replayOut = captureOutput();
    assert.equal(
      await cmoMain(['run', '--role', 'implement', '--prompt', 'cached work', '--idempotency-key', 'burn-replay-key'], {
        cacheDir,
        configFile,
        now: NOW,
        limits: { codex: codexWeekly(98), claude: claudeAt(20), antigravity: agyAt(10) },
        spawnImpl: codexOkSpawn,
        outputSink: replayOut.sink,
      }),
      0,
    );
    const replayedEnv = JSON.parse(replayOut.text());
    assert.equal(codexOkSpawn.calls.length, 1);
    assert.deepEqual(replayedEnv, { ...originalEnv, replayed: true });

    // Bare decision without notes stays clean even when burn is active and the primary hits a rate limit.
    const bareSpawn = fakeSpawn([
      { code: 1, stdout: '', stderr: '429 Too Many Requests' },
      { code: 0, stdout: claudeJsonOut('fallback ok'), stderr: '' },
    ]);
    const bareEnv = await runAgent(
      {
        provider: 'codex',
        model: 'gpt-5.4',
        tier: 'balanced',
        fallbacks: [{ provider: 'claude', model: 'claude-sonnet-4-6', tier: 'balanced' }],
      },
      'bare prompt',
      { cacheDir, now: () => NOW, spawnImpl: bareSpawn, sleep: async () => {} },
    );
    assert.equal(bareEnv.ok, true);
    assert.equal(bareEnv.notes, undefined);
    assert.equal(bareEnv.decision, undefined);
  }, {
    resets: {
      codex: ['2026-11-30', '2026-12-10'],
    },
  });
});
