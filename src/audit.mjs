// audit.mjs — a receipt for every dispatch.
//
// The shim is a language model asked not to do something it is perfectly
// capable of doing. On a 12-agent fan-out it answered 4 tasks itself instead of
// dispatching them: three generators and one judge. The workflow could not tell,
// because a self-written answer looks exactly like a dispatched one.
//
// No wording fixes that reliably. What fixes it is a receipt: every real
// dispatch writes a line here with a random id, and the id is returned in the
// envelope. An orchestrator that spawned twelve shims and finds eight receipts
// knows four of them lied, without having to trust any of them.
//
// This doubles as the observability that was missing: which provider actually
// ran the work, at which tier, and whether a review was genuinely cross-vendor.
// Before this, answering "did the fan-out balance?" meant grepping session
// rollout files on both vendors and guessing.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { CACHE_DIR } from './config.mjs';

export const AUDIT_FILE = join(CACHE_DIR, 'dispatches.jsonl');

/** Keep the file bounded; nobody needs last month's dispatches. */
const MAX_LINES = 5_000;

export function newDispatchId() {
  return `d-${randomUUID().slice(0, 12)}`;
}

/**
 * Append one receipt. Never throws: a dispatch must not fail because the audit
 * log is unwritable.
 */
export async function record(entry) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await appendFile(AUDIT_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    /* observability is not worth failing a run over */
  }
}

export async function readAudit({ sinceMs = null } = {}) {
  let text = '';
  try {
    text = await readFile(AUDIT_FILE, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  const lines = text.split('\n').slice(-MAX_LINES);
  for (const line of lines) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (sinceMs == null || (row.at ?? 0) >= sinceMs) rows.push(row);
    } catch {
      /* a torn line is not worth failing the report over */
    }
  }
  return rows;
}

/**
 * Summarise a window of dispatches.
 *
 * `expected` is the number of subagents the caller believes it dispatched. The
 * gap between that and what is on record is the number that never happened —
 * the shim answering by itself, which is otherwise invisible.
 */
export function summarise(rows, { expected = null } = {}) {
  const byProvider = {};
  const byRole = {};
  const independence = { 'cross-vendor': 0, 'same-vendor': 0 };
  let failed = 0;

  for (const r of rows) {
    const p = (byProvider[r.provider] ??= { count: 0, models: {} });
    p.count += 1;
    p.models[r.model] = (p.models[r.model] ?? 0) + 1;
    byRole[r.role ?? 'unknown'] = (byRole[r.role ?? 'unknown'] ?? 0) + 1;
    if (r.independence && independence[r.independence] !== undefined) independence[r.independence] += 1;
    if (r.ok === false) failed += 1;
  }

  const total = rows.length;
  const codex = byProvider.codex?.count ?? 0;
  return {
    total,
    failed,
    byProvider,
    byRole,
    independence,
    codexShare: total ? Math.round((codex / total) * 100) : null,
    ...(expected != null
      ? { expected, undispatched: Math.max(0, expected - total) }
      : {}),
  };
}
