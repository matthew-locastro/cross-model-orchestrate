// npm test
//
// The contention behaviour: several orchestrators, on several projects,
// draining the same two subscriptions with no knowledge of each other. Every
// test here is about what one process can see of what the others just did.

import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function withCache(body) {
  const dir = mkdtempSync(join(tmpdir(), 'cmo-state-'));
  const prev = process.env.CMO_CACHE_DIR;
  process.env.CMO_CACHE_DIR = dir;
  try {
    return body(dir);
  } finally {
    if (prev === undefined) delete process.env.CMO_CACHE_DIR;
    else process.env.CMO_CACHE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

// The modules read CMO_CACHE_DIR at import time, so each scenario runs in a
// child process with the env already set. That is also a more honest test:
// contention between processes is the thing being modelled.
function run(dir, source) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, CMO_CACHE_DIR: dir },
    encoding: 'utf8',
    cwd: new URL('..', import.meta.url).pathname,
  }).trim();
}

const SRC = new URL('../src/', import.meta.url).pathname;

test('a probe is shared across processes, not repeated per process', () => {
  withCache((dir) => {
    // Two separate processes ask for headroom. The second must reuse the
    // first's answer rather than paying for its own probe.
    const src = (tag) => `
      import { freshProbe } from '${SRC}ledger.mjs';
      let probes = 0;
      const r = await freshProbe('codex', 60000, async () => { probes++; return { available: true, worstPercent: ${tag} }; });
      console.log(JSON.stringify({ probes, cached: r.cached, pct: r.value.worstPercent }));
    `;
    const first = JSON.parse(run(dir, src(10)));
    const second = JSON.parse(run(dir, src(99)));
    assert.deepEqual(first, { probes: 1, cached: false, pct: 10 });
    assert.deepEqual(second, { probes: 0, cached: true, pct: 10 }, 'second process must not re-probe');
  });
});

test('an expired probe is retaken', () => {
  withCache((dir) => {
    const src = `
      import { freshProbe } from '${SRC}ledger.mjs';
      await freshProbe('codex', 60000, async () => ({ available: true, worstPercent: 10 }));
      const r = await freshProbe('codex', 0, async () => ({ available: true, worstPercent: 44 }));
      console.log(JSON.stringify({ cached: r.cached, pct: r.value.worstPercent }));
    `;
    assert.deepEqual(JSON.parse(run(dir, src)), { cached: false, pct: 44 });
  });
});

test('one orchestrator sees another orchestrator\'s in-flight dispatches', () => {
  withCache((dir) => {
    // Process A reserves and stays alive; process B must see the commitment.
    const holder = `
      import { reserve } from '${SRC}ledger.mjs';
      for (let i = 0; i < 6; i++) await reserve('codex', { label: 'gen-' + i });
      console.log('reserved');
      await new Promise(r => setTimeout(r, 3000));
    `;
    const child = spawn(
      process.execPath, ['--input-type=module', '-e', holder],
      { env: { ...process.env, CMO_CACHE_DIR: dir }, stdio: 'pipe' },
    );
    try {
      // wait for the reservations to land
      const deadline = Date.now() + 5000;
      let state = { reservations: [] };
      while (Date.now() < deadline) {
        try {
          state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
          if (state.reservations.length >= 6) break;
        } catch { /* not written yet */ }
      }
      assert.equal(state.reservations.length, 6);

      const observer = `
        import { snapshot } from '${SRC}ledger.mjs';
        import { committed, inFlight } from '${SRC}ledger.mjs';
        const s = await snapshot();
        console.log(JSON.stringify({ n: inFlight(s, 'codex'), points: committed(s, 'codex') }));
      `;
      const seen = JSON.parse(run(dir, observer));
      assert.equal(seen.n, 6, 'a second process must see the first\'s in-flight work');
      assert.ok(seen.points > 0, 'and the headroom it has committed');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

test('a dead orchestrator does not hold headroom forever', () => {
  withCache((dir) => {
    // A reservation from a pid that no longer exists is garbage, and must not
    // make every other orchestrator on the box think the window is spent.
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      probes: {},
      samples: {},
      reservations: [
        { id: 'ghost', provider: 'codex', pid: 999999, startedAt: Date.now(), cost: 5, label: 'crashed' },
        { id: 'old', provider: 'codex', pid: process.pid, startedAt: Date.now() - 60 * 60_000, cost: 5, label: 'stale lease' },
      ],
    }), 'utf8');
    const src = `
      import { snapshot, inFlight } from '${SRC}ledger.mjs';
      const s = await snapshot();
      console.log(JSON.stringify({ n: inFlight(s, 'codex') }));
    `;
    assert.deepEqual(JSON.parse(run(dir, src)), { n: 0 });
  });
});

test('committed spend raises the effective percentage a decision sees', () => {
  withCache((dir) => {
    const src = `
      import { applyCommitted } from '${SRC}ledger.mjs';
      const state = { reservations: [
        { provider: 'codex', cost: 2 }, { provider: 'codex', cost: 2 }, { provider: 'claude', cost: 1 },
      ] };
      const reported = { available: true, worstPercent: 80, windows: [] };
      const eff = applyCommitted(reported, state, 'codex');
      console.log(JSON.stringify({ reported: eff.reportedPercent, effective: eff.worstPercent, agents: eff.inFlightAgents }));
    `;
    assert.deepEqual(JSON.parse(run(dir, src)), { reported: 80, effective: 84, agents: 2 });
  });
});

test('two orchestrators at 80% do not both dispatch into the wall', () => {
  withCache((dir) => {
    // The failure this whole mechanism exists for. Reported headroom says both
    // are fine; committed headroom says the second one must not pile on.
    const src = `
      import { applyCommitted } from '${SRC}ledger.mjs';
      import { decide } from '${SRC}policy.mjs';
      const reported = { available: true, worstPercent: 80, windows: [], hardBlocked: false };
      const clean = { reservations: [] };
      const busy = { reservations: Array.from({ length: 16 }, () => ({ provider: 'codex', cost: 1 })) };
      const before = decide({ role: 'implement', complexity: 3, length: 'm', pin: 'codex' },
        { codex: applyCommitted(reported, clean, 'codex'), claude: { available: false } });
      const after = decide({ role: 'implement', complexity: 3, length: 'm', pin: 'codex' },
        { codex: applyCommitted(reported, busy, 'codex'), claude: { available: false } });
      console.log(JSON.stringify({ before: before.ok, beforeTier: before.tier, after: after.ok, afterDefer: after.defer }));
    `;
    const r = JSON.parse(run(dir, src));
    assert.equal(r.before, true, 'with nothing in flight, 80% is dispatchable');
    assert.equal(r.after, false, 'with 16 agents already committed, it is not');
    assert.equal(r.afterDefer, true, 'and it defers rather than failing obscurely');
  });
});

test('the measured per-agent cost beats the configured guess once there is evidence', () => {
  withCache((dir) => {
    const src = `
      import { recordSample, perAgentCost } from '${SRC}ledger.mjs';
      const guess = await perAgentCost('codex');
      for (const d of [0.2, 0.3, 0.2, 0.25, 0.2, 0.3, 0.2, 0.3, 0.2, 0.25]) await recordSample('codex', d);
      const measured = await perAgentCost('codex');
      console.log(JSON.stringify({ guess, measured }));
    `;
    const r = JSON.parse(run(dir, src));
    assert.equal(r.guess, 1.0, 'the conservative default applies with no evidence');
    assert.ok(r.measured > 0.2 && r.measured < 0.3, `measured mean should replace it, got ${r.measured}`);
  });
});

test('a window reset or a nonsense delta is not recorded as a sample', () => {
  withCache((dir) => {
    const src = `
      import { recordSample, perAgentCost, snapshot } from '${SRC}ledger.mjs';
      for (const d of [-40, 99, NaN, 0.3, 0.3, 0.3, 0.3, 0.3]) await recordSample('codex', d);
      const s = await snapshot();
      console.log(JSON.stringify({ kept: s.samples.codex, cost: await perAgentCost('codex') }));
    `;
    const r = JSON.parse(run(dir, src));
    assert.deepEqual(r.kept, [0.3, 0.3, 0.3, 0.3, 0.3], 'a window reset or nonsense delta is dropped');
    assert.equal(r.cost, 1.0, 'five samples is not yet enough evidence — the default still stands');
  });
});

test('concurrent writers do not lose each other\'s reservations', async () => {
  // Twelve processes reserving at the same moment is the read-modify-write race
  // that an unlocked JSON cache loses silently. They have to stay ALIVE while
  // we look: a reservation from an exited process is garbage by design, so
  // spawning them sequentially would prove nothing.
  const dir = mkdtempSync(join(tmpdir(), 'cmo-state-'));
  const kids = [];
  try {
    const src = `
      import { reserve } from '${SRC}ledger.mjs';
      await reserve('codex', { label: 'w' + process.pid });
      console.log('reserved');
      await new Promise(r => setTimeout(r, 5000));
    `;
    for (let i = 0; i < 12; i++) {
      kids.push(spawn(process.execPath, ['--input-type=module', '-e', src], {
        env: { ...process.env, CMO_CACHE_DIR: dir }, stdio: 'pipe',
      }));
    }
    await Promise.all(kids.map((k) => new Promise((res) => {
      let out = '';
      k.stdout.on('data', (d) => { out += d; if (out.includes('reserved')) res(); });
      k.on('exit', res);
    })));

    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.equal(state.reservations.length, 12, 'every concurrent write must survive');
    assert.equal(new Set(state.reservations.map((r) => r.id)).size, 12, 'and stay distinct');
  } finally {
    kids.forEach((k) => k.kill('SIGKILL'));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agents too cheap to register on an integer meter still cost something', () => {
  withCache((dir) => {
    // Vendors report whole percents, so one small agent usually moves the meter
    // by zero. Treating that as free removes the protection entirely; the mean
    // over many samples recovers the real sub-resolution cost.
    const src = `
      import { recordSample, perAgentCost } from '${SRC}ledger.mjs';
      // twenty agents, two points of total movement
      for (let i = 0; i < 20; i++) await recordSample('codex', i % 10 === 0 ? 1 : 0);
      console.log(JSON.stringify({ cost: await perAgentCost('codex') }));
    `;
    const r = JSON.parse(run(dir, src));
    assert.ok(r.cost >= 0.05, 'never free');
    assert.ok(r.cost < 0.2, `should recover ~0.1/agent, got ${r.cost}`);
  });
});
