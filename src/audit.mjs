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

// ── soak analysis ─────────────────────────────────────────────────────────
//
// A multi-day soak that ends with "it felt fine" taught nothing. These turn the
// log into findings, and findings into specific changes: a tier that is always
// over-provisioned, a role that keeps retrying, a review that keeps degrading,
// a reservation cost that is nowhere near what agents actually consume.
//
// Nothing here changes configuration. It says what it saw and what it would
// change, and a person decides — the same posture as doctor.

function pct(n, total) {
  return total ? Math.round((n / total) * 100) : 0;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[i];
}

/** Duration spread per tier, which is where over- and under-provisioning shows. */
export function tierStats(rows) {
  const byTier = {};
  for (const r of rows) {
    if (!r.tier || typeof r.durationMs !== 'number') continue;
    (byTier[r.tier] ??= []).push(r.durationMs);
  }
  const out = {};
  for (const [tier, list] of Object.entries(byTier)) {
    const sorted = [...list].sort((a, b) => a - b);
    out[tier] = {
      count: sorted.length,
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
    };
  }
  return out;
}

/** Every distinct way dispatches went wrong, most common first. */
export function failureTaxonomy(rows) {
  const kinds = {};
  for (const r of rows) {
    for (const f of r.failures ?? []) kinds[f] = (kinds[f] ?? 0) + 1;
    if (r.ok === false && !(r.failures ?? []).length) kinds.unknown = (kinds.unknown ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(kinds).sort((a, b) => b[1] - a[1]));
}

/**
 * The recommendations. Each one names what was measured, so it can be argued
 * with rather than merely obeyed.
 */
export function findings(rows, { perAgentCost = null, limits = null } = {}) {
  const out = [];

  // A dark meter first, before anything else — every other number here is
  // computed against headroom the tool may no longer be able to see. Found on
  // the first day of a soak: an expired Claude OAuth token silently blinded the
  // Claude side, and the tool carried on dispatching as if the window were
  // unknown-and-usable.
  for (const provider of ['codex', 'claude']) {
    const p = limits?.[provider];
    if (p && p.available === false) {
      out.push({
        severity: 'high',
        finding: `the ${provider} meter is dark: ${p.error ?? 'unavailable'}`,
        action: provider === 'claude' && /expired/i.test(p.error ?? '')
          ? 'Run any claude command once to refresh the OAuth token. Until then headroom reads as '
            + 'unknown, which the policy treats as usable — so it will keep dispatching into a window it cannot see.'
          : 'Fix the probe before trusting anything else here. Unknown headroom is treated as usable by design, '
            + 'so a blind meter fails toward over-dispatching.',
      });
    }
  }

  const total = rows.length;
  if (!total) return out;

  const ok = rows.filter((r) => r.ok !== false).length;
  const failed = total - ok;
  if (failed) {
    const kinds = failureTaxonomy(rows);
    const top = Object.entries(kinds)[0];
    out.push({
      severity: failed / total > 0.05 ? 'high' : 'low',
      finding: `${failed} of ${total} dispatches failed (${pct(failed, total)}%), most often "${top[0]}" x${top[1]}`,
      action: top[0] === 'timeout'
        ? 'Raise --timeout for the roles that hit it, or split the task; a timeout is work paid for and thrown away.'
        : top[0] === 'rate-limit'
          ? 'Expected when a window fills. If it happens with headroom showing, the meter is lying — check cmo limits --refresh.'
          : 'Read the error field on those rows; a deterministic failure repeated is a prompt or flag bug, not bad luck.',
    });
  }

  const retried = rows.filter((r) => r.retried).length;
  if (retried / total > 0.1) {
    out.push({
      severity: 'medium',
      finding: `${retried} dispatches (${pct(retried, total)}%) needed more than one attempt`,
      action: 'Retries are wasted spend. Check whether one provider is flaky, or a tier is too small for its role.',
    });
  }

  const codex = rows.filter((r) => r.provider === 'codex').length;
  const share = pct(codex, total);
  if (share < 50) {
    out.push({
      severity: 'high',
      finding: `only ${share}% of dispatches went to codex`,
      action: 'The orchestrator is a Claude session and cannot move. Route more fan-out through codex-runner, '
        + 'or the run competes with the thing driving it.',
    });
  }

  const reviews = rows.filter((r) => r.independence);
  const degraded = reviews.filter((r) => r.independence === 'same-vendor').length;
  if (degraded) {
    out.push({
      severity: degraded / reviews.length > 0.25 ? 'high' : 'medium',
      finding: `${degraded} of ${reviews.length} reviews ran same-vendor (${pct(degraded, reviews.length)}%)`,
      action: 'Those verdicts are provisional — the grader shared the producer\'s blind spots. Re-grade them '
        + 'when the other window reopens, and start fan-outs earlier in the window.',
    });
  }

  const stats = tierStats(rows);
  for (const [tier, s] of Object.entries(stats)) {
    if (tier !== 'fast' && s.count >= 10 && s.p95 != null && s.p95 < 12_000) {
      out.push({
        severity: 'low',
        finding: `${tier} tier: ${s.count} dispatches, p95 only ${Math.round(s.p95 / 1000)}s`,
        action: `Work finishing that fast rarely needed ${tier}. Try lowering complexity or length for those roles `
          + 'and watch whether quality moves.',
      });
    }
  }

  if (perAgentCost != null) {
    const configured = 1.0;
    if (perAgentCost <= configured / 4) {
      out.push({
        severity: 'low',
        finding: `measured cost is ${perAgentCost} points per agent against a ${configured} default`,
        action: 'The default is being carried by the floor. Reservations are over-reserving, which makes '
          + 'concurrent fan-outs defer earlier than they need to.',
      });
    }
  }

  return out;
}
