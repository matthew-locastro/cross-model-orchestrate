import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCoordinator, expire, summary } from '../src/server.mjs';

const SRC = new URL('../src/', import.meta.url).pathname;
const TOKEN = 'test-token-at-least-16-chars';

/** Start a coordinator on an ephemeral port with its own state file. */
async function withCoordinator(body) {
  const dir = mkdtempSync(join(tmpdir(), 'cmo-fleet-'));
  const server = createCoordinator({ token: TOKEN, statePath: join(dir, 'fleet.json') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await body(url, dir);
  } finally {
    // undici keeps connections alive, so close() alone waits forever on them.
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run source as a separate "box": its own local cache dir and node id, but
 * pointed at the shared coordinator. Two of these is the whole scenario.
 *
 * MUST be async. The coordinator runs in this process, and execFileSync blocks
 * the event loop — the child's requests would time out against a server that
 * cannot answer while it waits.
 */
async function box(url, name, source, extraEnv = {}) {
  const cache = mkdtempSync(join(tmpdir(), `cmo-box-${name}-`));
  try {
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', source], {
      env: {
        ...process.env,
        CMO_CACHE_DIR: cache,
        CMO_FLEET_URL: url,
        CMO_FLEET_TOKEN: TOKEN,
        CMO_NODE_ID: name,
        ...extraEnv,
      },
      encoding: 'utf8',
    });
    return stdout.trim();
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

test('the coordinator refuses to start without a real token', () => {
  // An open coordinator lets anyone on the network reserve 100% of your
  // headroom and stall every orchestrator you own.
  assert.throws(() => createCoordinator({ token: '' }), /token/);
  assert.throws(() => createCoordinator({ token: 'short' }), /16 characters/);
});

test('the coordinator rejects a wrong token', async () => {
  await withCoordinator(async (url) => {
    const res = await fetch(`${url}/v1/state`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(res.status, 401);
    const health = await fetch(`${url}/v1/health`); // liveness needs no auth
    assert.equal(health.status, 200);
  });
});

test('one box sees another box\'s in-flight dispatches', async () => {
  await withCoordinator(async (url) => {
    // Box A reserves against codex, then exits. Its process is gone — which on
    // a single machine would reclaim the entry — but the fleet holds it under
    // a lease, because box B cannot test a pid on box A.
    await box(url, 'vps-a', `
      import { reserve } from '${SRC}ledger.mjs';
      for (let i = 0; i < 5; i++) await reserve('codex', { label: 'gen', leaseMs: 60000 });
      console.log('ok');
    `);

    const seen = JSON.parse(await box(url, 'vps-b', `
      import { snapshot, inFlight, committed } from '${SRC}ledger.mjs';
      const s = await snapshot();
      console.log(JSON.stringify({
        fleet: s.fleet, n: inFlight(s, 'codex'), points: committed(s, 'codex'),
        nodes: Object.keys(s.summary?.codex?.nodes ?? {}),
      }));
    `));

    assert.equal(seen.fleet, true, 'the reading must be the fleet\'s, not the box\'s');
    assert.equal(seen.n, 5);
    assert.ok(seen.points > 0);
    assert.deepEqual(seen.nodes.map((n) => n.split(':')[0]), Array(5).fill('vps-a').slice(0, seen.nodes.length));
  });
});

test('a box that dies mid-run releases its headroom on the lease', () => {
  const now = 1_000_000;
  const state = {
    probes: {},
    samples: {},
    reservations: [
      { id: 'live', provider: 'codex', cost: 1, expiresAt: now + 60_000, node: 'a' },
      { id: 'dead', provider: 'codex', cost: 1, expiresAt: now - 1, node: 'b' },
    ],
  };
  const after = expire(state, now);
  assert.deepEqual(after.reservations.map((r) => r.id), ['live']);
});

test('the fleet view says where the work is, not just how much', () => {
  const s = summary({
    reservations: [
      { provider: 'codex', cost: 1, node: 'vps-a', project: 'checkout-flow' },
      { provider: 'codex', cost: 1, node: 'vps-a', project: 'checkout-flow' },
      { provider: 'codex', cost: 1, node: 'vps-b', project: 'termroam' },
      { provider: 'claude', cost: 1, node: 'vps-b', project: 'termroam' },
    ],
  });
  assert.equal(s.codex.agents, 3);
  assert.equal(s.codex.nodes['vps-a:checkout-flow'], 2);
  assert.equal(s.codex.nodes['vps-b:termroam'], 1);
  assert.equal(s.claude.agents, 1);
});

test('one probe serves the whole fleet', async () => {
  await withCoordinator(async (url) => {
    // Windows are per-subscription, not per-machine, so a reading taken on box
    // A is a valid reading for box B. Box B must not pay for its own.
    const probe = `
      import { freshProbe } from '${SRC}ledger.mjs';
      let taken = 0;
      const r = await freshProbe('codex', 60000, async () => { taken++; return { available: true, worstPercent: 42, windows: [] }; });
      console.log(JSON.stringify({ taken, cached: r.cached, pct: r.value.worstPercent, from: r.from ?? null }));
    `;
    const a = JSON.parse(await box(url, 'vps-a', probe));
    const b = JSON.parse(await box(url, 'vps-b', probe));
    assert.deepEqual({ taken: a.taken, cached: a.cached, pct: a.pct }, { taken: 1, cached: false, pct: 42 });
    assert.equal(b.taken, 0, 'the second box must not re-probe');
    assert.equal(b.cached, true);
    assert.equal(b.pct, 42);
    assert.equal(b.from, 'vps-a', 'and it should say whose reading it is using');
  });
});

test('a sign-out is one machine\'s: it outranks the fleet there and is never published', async () => {
  await withCoordinator(async (url) => {
    const healthy = `{ available: true, worstPercent: 30, windows: [] }`;
    const signedOut = `{ available: false, windows: [], auth: { ok: false, method: 'none', reason: 'the claude CLI is signed out' } }`;
    // Box A is signed in and publishes a healthy claude reading.
    await box(url, 'mac-a', `
      import { freshProbe } from '${SRC}ledger.mjs';
      await freshProbe('claude', 60000, async () => (${healthy}));
      console.log('ok');
    `);
    // Box B's own CLI is signed out: a dispatch found it, or its probe did.
    const b = JSON.parse(await box(url, 'mac-b', `
      import { freshProbe } from '${SRC}ledger.mjs';
      import { markClaudeSignedOut } from '${SRC}limits.mjs';
      await markClaudeSignedOut('OAuth session expired');
      const marked = await freshProbe('claude', 60000, async () => (${healthy}));
      const probed = await freshProbe('grok', 60000, async () => (${signedOut}));
      console.log(JSON.stringify({ marked: marked.value.auth?.ok ?? null, from: marked.from ?? null, probed: probed.value.auth?.ok ?? null }));
    `));
    assert.equal(b.marked, false, 'box B must not route to a claude it cannot run');
    assert.equal(b.from, null, 'its own reading, not the fleet\'s');
    // Box C is signed in: box B's sign-outs must not reach it.
    const c = JSON.parse(await box(url, 'mac-c', `
      import { freshProbe } from '${SRC}ledger.mjs';
      let grokProbed = 0;
      const claude = await freshProbe('claude', 60000, async () => { throw new Error('should be cached'); });
      const grok = await freshProbe('grok', 60000, async () => { grokProbed++; return { available: true, worstPercent: 1, windows: [], auth: { ok: true } }; });
      console.log(JSON.stringify({ claude: claude.value.available, from: claude.from ?? null, grokProbed, grok: grok.value.auth?.ok }));
    `));
    assert.equal(c.claude, true, 'box A\'s healthy reading still serves the fleet');
    assert.equal(c.from, 'mac-a');
    assert.equal(c.grokProbed, 1, 'box B\'s signed-out grok was never published, so C reads its own');
    assert.equal(c.grok, true);
  });
});

test('a stand-in reading stays on its box: never published over the fleet', async () => {
  await withCoordinator(async (url) => {
    const auth = `{ ok: true, method: 'oauth', authMode: 'Oidc' }`;
    // Box A knew grok at 6%, then its meter errored: it stands on the 6%.
    const a = JSON.parse(await box(url, 'mac-a', `
      import { freshProbe } from '${SRC}ledger.mjs';
      import { holdLastGood } from '${SRC}limits.mjs';
      const now = Date.now();
      await holdLastGood('grok', { available: true, worstPercent: 6, windows: [], auth: ${auth} }, { now: now - 60000 });
      const r = await freshProbe('grok', 60000, async () => holdLastGood('grok',
        { available: false, windows: [], error: 'Internal error', auth: ${auth} }, { now }));
      console.log(JSON.stringify({ stale: Boolean(r.value.stale), pct: r.value.worstPercent }));
    `));
    assert.deepEqual(a, { stale: true, pct: 6 });
    // Box B must take its own reading, not inherit A's guess as a fresh one.
    const b = JSON.parse(await box(url, 'mac-b', `
      import { freshProbe } from '${SRC}ledger.mjs';
      let probed = 0;
      const r = await freshProbe('grok', 60000, async () => { probed++; return { available: true, worstPercent: 80, windows: [] }; });
      console.log(JSON.stringify({ probed, pct: r.value.worstPercent }));
    `));
    assert.deepEqual(b, { probed: 1, pct: 80 });
  });
});

test('a genuine fleet reading also becomes this box\'s last good one', async () => {
  await withCoordinator(async (url) => {
    await box(url, 'mac-a', `
      import { freshProbe } from '${SRC}ledger.mjs';
      await freshProbe('grok', 60000, async () => ({ available: true, worstPercent: 80, windows: [] }));
      console.log('ok');
    `);
    const b = JSON.parse(await box(url, 'mac-b', `
      import { freshProbe, lastGoodReading } from '${SRC}ledger.mjs';
      import { holdLastGood } from '${SRC}limits.mjs';
      await holdLastGood('grok', { available: true, worstPercent: 6, windows: [] }, { now: Date.now() - 120000 });
      const r = await freshProbe('grok', 60000, async () => { throw new Error('should use the fleet'); });
      const last = await lastGoodReading('grok');
      console.log(JSON.stringify({ from: r.from ?? null, last: last.value.worstPercent }));
    `));
    assert.deepEqual(b, { from: 'mac-a', last: 80 });
  });
});

test('cost samples are pooled — the fleet learns from every box', async () => {
  await withCoordinator(async (url) => {
    await box(url, 'vps-a', `
      import { recordSample } from '${SRC}ledger.mjs';
      for (let i = 0; i < 6; i++) await recordSample('codex', 0.2);
      console.log('ok');
    `);
    const seen = JSON.parse(await box(url, 'vps-b', `
      import { recordSample, snapshot, perAgentCost } from '${SRC}ledger.mjs';
      for (let i = 0; i < 6; i++) await recordSample('codex', 0.2);
      const s = await snapshot();
      console.log(JSON.stringify({ samples: s.samples.codex.length, cost: await perAgentCost('codex') }));
    `));
    assert.equal(seen.samples, 12, 'box B sees box A\'s measurements too');
    assert.ok(seen.cost > 0.15 && seen.cost < 0.25, `pooled estimate, got ${seen.cost}`);
  });
});

test('an unreachable coordinator degrades to single-box, it does not stall', async () => {
  // The reliability posture: being slightly wrong about other boxes beats
  // refusing to dispatch. A coordination outage must never stop work.
  const out = JSON.parse(await box('http://127.0.0.1:9', 'lonely', `
    import { snapshot, reserve, inFlight } from '${SRC}ledger.mjs';
    const id = await reserve('codex', { label: 'x' });
    const s = await snapshot();
    console.log(JSON.stringify({ reserved: Boolean(id), fleet: s.fleet, n: inFlight(s, 'codex') }));
  `));
  assert.equal(out.reserved, true, 'the dispatch still gets its reservation');
  assert.equal(out.fleet, false, 'but it knows the view is local only');
  assert.equal(out.n, 1, 'and the local ledger still works');
});

test('a slow box cannot overwrite a fresher reading', async () => {
  await withCoordinator(async (url) => {
    const res = await fetch(`${url}/v1/probe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'codex', value: { worstPercent: 50 }, storedAt: Date.now() }),
    });
    assert.equal(res.status, 200);
    // An older reading arriving late must lose.
    await fetch(`${url}/v1/probe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'codex', value: { worstPercent: 10 }, storedAt: Date.now() - 60_000 }),
    });
    const state = await (await fetch(`${url}/v1/state`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    assert.equal(state.probes.codex.value.worstPercent, 50);
  });
});

test('nonsense samples are rejected at the boundary, not just by the client', async () => {
  await withCoordinator(async (url) => {
    const post = (delta) => fetch(`${url}/v1/sample`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'codex', delta }),
    });
    assert.equal((await post(-5)).status, 400);
    assert.equal((await post(999)).status, 400);
    assert.equal((await post(0.3)).status, 200);
  });
});
