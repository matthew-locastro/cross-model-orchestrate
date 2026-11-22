import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';

import { AUDIT_FILE } from '../src/audit.mjs';
import { qualityReport } from '../src/audit.mjs';
import { OUTCOMES_FILE, readOutcomes, recordOutcome } from '../src/outcomes.mjs';

test('outcomes are append-only beside dispatch receipts in the configured cache', async () => {
  const id = 'd-outcomes-test';
  await appendFile(AUDIT_FILE, `${JSON.stringify({ at: Date.now(), id, provider: 'codex', role: 'review', model: 'gpt-5.6-terra' })}\n`);
  await recordOutcome({ id, verdict: 'approved', rounds: 1, note: 'checked', by: 'reviewer' });

  const rows = await readOutcomes();
  const saved = rows.find((row) => row.id === id);
  assert.equal(saved.verdict, 'approved');
  assert.equal(saved.rounds, 1);
  assert.equal(saved.note, 'checked');
  assert.equal(saved.by, 'reviewer');
  assert.match(OUTCOMES_FILE, /outcomes\.jsonl$/);
});

test('quality report groups outcomes by provider, role and model with exact metrics', () => {
  const receipts = [
    { id: 'd-1', provider: 'codex', role: 'review', model: 'gpt-5.6-terra' },
    { id: 'd-2', provider: 'codex', role: 'review', model: 'gpt-5.6-terra' },
    { id: 'd-3', provider: 'claude', role: 'implement', model: 'sonnet' },
    { id: 'd-4', provider: 'claude', role: 'implement', model: 'sonnet' },
    { id: 'd-5', provider: 'claude', role: 'implement', model: 'sonnet' },
  ];
  const outcomes = [
    { id: 'd-1', verdict: 'approved', rounds: 1 },
    { id: 'd-2', verdict: 'blocked', rounds: 3 },
    { id: 'd-3', verdict: 'confirmed', rounds: 2 },
    { id: 'd-4', verdict: 'false-positive', rounds: 2 },
    { id: 'd-5', verdict: 'missed', rounds: 4 },
    { id: 'd-orphan', verdict: 'approved', rounds: 1, orphan: true },
  ];
  assert.deepEqual(qualityReport(receipts, outcomes), {
    total: 5,
    orphans: 1,
    groups: [
      {
        provider: 'claude', role: 'implement', model: 'sonnet', n: 3,
        firstRoundApprovals: 0, firstRoundApprovalRate: 0, meanRounds: 2.67,
        blocked: 0, confirmed: 1, falsePositive: 1, missed: 1,
      },
      {
        provider: 'codex', role: 'review', model: 'gpt-5.6-terra', n: 2,
        firstRoundApprovals: 1, firstRoundApprovalRate: 0.5, meanRounds: 2,
        blocked: 1, confirmed: 0, falsePositive: 0, missed: 0,
      },
    ],
  });
});

test('quality report rounds fractional first-round approval rates to a 0..1 ratio', () => {
  const receipts = [
    { id: 'd-a1', provider: 'antigravity', role: 'implement', model: 'gemini-4-carbon' },
    { id: 'd-a2', provider: 'antigravity', role: 'implement', model: 'gemini-4-carbon' },
    { id: 'd-a3', provider: 'antigravity', role: 'implement', model: 'gemini-4-carbon' },
  ];
  const outcomes = [
    { id: 'd-a1', verdict: 'approved', rounds: 1 },
    { id: 'd-a2', verdict: 'approved', rounds: 1 },
    { id: 'd-a3', verdict: 'fixed', rounds: 2 },
  ];
  const report = qualityReport(receipts, outcomes);
  assert.equal(report.groups[0].firstRoundApprovals, 2);
  assert.equal(report.groups[0].firstRoundApprovalRate, 0.67);
});
