import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { summarise, newDispatchId } from '../src/audit.mjs';
import { main as cmoMain } from '../bin/cmo.mjs';

const execFileAsync = promisify(execFile);
const CMO = new URL('../bin/cmo.mjs', import.meta.url).pathname;

// The failure this exists for: a shim that answers by itself produces output
// indistinguishable from a dispatched one. Counting receipts is the only way to
// tell, because you cannot ask the shim whether it lied.

const row = (o) => ({ at: Date.now(), id: newDispatchId(), ok: true, ...o });

test('the gap between agents spawned and receipts written is the lie', () => {
  const rows = [
    row({ provider: 'codex', model: 'terra', role: 'implement' }),
    row({ provider: 'codex', model: 'terra', role: 'implement' }),
    row({ provider: 'claude', model: 'sonnet', role: 'judge', independence: 'cross-vendor' }),
  ];
  const s = summarise(rows, { expected: 12 });
  assert.equal(s.total, 3);
  assert.equal(s.undispatched, 9, 'nine subagents never called the dispatcher');
});

test('a clean run reports no gap', () => {
  const rows = [row({ provider: 'codex', model: 'terra' }), row({ provider: 'codex', model: 'terra' })];
  assert.equal(summarise(rows, { expected: 2 }).undispatched, 0);
});

test('codex share answers the balance question directly', () => {
  const rows = [
    row({ provider: 'codex', model: 'terra' }),
    row({ provider: 'codex', model: 'terra' }),
    row({ provider: 'codex', model: 'terra' }),
    row({ provider: 'claude', model: 'sonnet' }),
  ];
  assert.equal(summarise(rows).codexShare, 75);
});

test('provider failover is counted so planned-vendor drift is visible', () => {
  const rows = [
    row({ provider: 'claude', model: 'sonnet', failedOver: true }),
    row({ provider: 'codex', model: 'terra', failedOver: false }),
  ];
  assert.equal(summarise(rows).failedOver, 1);
});

test('review independence is counted, so a degraded verdict cannot hide in a pile', () => {
  const rows = [
    row({ provider: 'claude', model: 'sonnet', role: 'judge', independence: 'cross-vendor' }),
    row({ provider: 'codex', model: 'sol', role: 'judge', independence: 'same-vendor', degradedReview: true }),
    row({ provider: 'claude', model: 'sonnet', role: 'judge', independence: 'cross-vendor' }),
  ];
  const s = summarise(rows);
  assert.equal(s.independence['cross-vendor'], 2);
  assert.equal(s.independence['same-vendor'], 1);
});

test('failures are counted separately from absence', () => {
  // A dispatch that ran and failed left a receipt. One that never ran did not.
  // Confusing the two sends you debugging the wrong thing.
  const rows = [row({ provider: 'codex', model: 'terra', ok: false, error: 'timeout' }), row({ provider: 'codex', model: 'terra' })];
  const s = summarise(rows, { expected: 3 });
  assert.equal(s.failed, 1);
  assert.equal(s.undispatched, 1);
});

test('dispatch ids are unique', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newDispatchId()));
  assert.equal(ids.size, 200);
});

function captureOutput() {
  const writes = [];
  return {
    sink(text, stream = 'stdout') { writes.push({ stream, text }); },
    text(stream) { return writes.filter((w) => w.stream === stream).map((w) => w.text).join(''); },
  };
}

test('cmo audit --since accepts plain minutes and 30m/90m/2h/1d durations and counts receipts', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'cmo-audit-since-'));
  const now = Date.now();
  const min = 60_000;
  await writeFile(join(cacheDir, 'dispatches.jsonl'), [
    JSON.stringify({ at: now - 10 * min, id: 'd-10m', ok: true, provider: 'codex', model: 'gpt-5.6-terra', role: 'implement' }),
    JSON.stringify({ at: now - 25 * min, id: 'd-25m', ok: true, provider: 'antigravity', model: 'gemini-4-carbon', role: 'review', independence: 'cross-vendor' }),
    JSON.stringify({ at: now - 75 * min, id: 'd-75m', ok: true, provider: 'codex', model: 'gpt-5.6-terra', role: 'implement' }),
    JSON.stringify({ at: now - 100 * min, id: 'd-100m', ok: true, provider: 'claude', model: 'sonnet', role: 'review', independence: 'cross-vendor' }),
    JSON.stringify({ at: now - 12 * 60 * min, id: 'd-12h', ok: true, provider: 'codex', model: 'gpt-5.6-luna', role: 'mechanical' }),
    JSON.stringify({ at: now - 2 * 1440 * min, id: 'd-2d', ok: true, provider: 'codex', model: 'gpt-5.6-luna', role: 'mechanical' }),
    '',
  ].join('\n'));

  // Subprocess check for the exact reported CLI bug: --since 90m and --since 30 --expected 3
  const sub90m = await execFileAsync(
    process.execPath,
    [CMO, 'audit', '--since', '90m', '--expected', '3', '--human'],
    { env: { ...process.env, CMO_CACHE_DIR: cacheDir } },
  );
  assert.doesNotMatch(sub90m.stdout, /NaN/);
  assert.match(sub90m.stdout, /dispatches in the last 90 min: 3/);
  assert.match(sub90m.stdout, /all 3 expected dispatches are on record\./);

  const plain30 = captureOutput();
  const code30 = await cmoMain(['audit', '--since', '30', '--expected', '3', '--human'], {
    cacheDir,
    outputSink: plain30.sink,
  });
  assert.equal(code30, 3);
  assert.doesNotMatch(plain30.text('stdout'), /NaN/);
  assert.match(plain30.text('stdout'), /dispatches in the last 30 min: 2/);
  assert.match(plain30.text('stdout'), /WARNING: 1 of 3 subagents left NO receipt/);

  const dur30m = captureOutput();
  assert.equal(await cmoMain(['audit', '--since', '30m', '--expected', '2', '--human'], {
    cacheDir,
    outputSink: dur30m.sink,
  }), 0);
  assert.match(dur30m.text('stdout'), /dispatches in the last 30 min: 2/);

  const dur2h = captureOutput();
  assert.equal(await cmoMain(['audit', '--since', '2h', '--expected', '4'], {
    cacheDir,
    outputSink: dur2h.sink,
  }), 0);
  const parsed2h = JSON.parse(dur2h.text('stdout'));
  assert.equal(parsed2h.total, 4);
  assert.equal(parsed2h.undispatched, 0);

  const dur1d = captureOutput();
  assert.equal(await cmoMain(['audit', '--since', '1d', '--expected', '5', '--human'], {
    cacheDir,
    outputSink: dur1d.sink,
  }), 0);
  assert.match(dur1d.text('stdout'), /dispatches in the last 1440 min: 5/);

  // Report reuses the same parser (including m suffix)
  const rep30m = captureOutput();
  assert.equal(await cmoMain(['report', '--since', '30m', '--json'], {
    cacheDir,
    outputSink: rep30m.sink,
    limits: {},
  }), 0);
  assert.equal(JSON.parse(rep30m.text('stdout')).summary.total, 2);

  // Invalid --since fails loudly with usage exit code 2 rather than NaN
  const bad = captureOutput();
  assert.equal(await cmoMain(['audit', '--since', 'nope', '--human'], {
    cacheDir,
    outputSink: bad.sink,
  }), 2);
  assert.doesNotMatch(bad.text('stdout'), /NaN/);
  assert.match(bad.text('stderr'), /--since/);
});
