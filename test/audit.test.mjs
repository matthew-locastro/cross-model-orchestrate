import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summarise, newDispatchId } from '../src/audit.mjs';

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
