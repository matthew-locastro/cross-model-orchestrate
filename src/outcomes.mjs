// outcomes.mjs — append-only quality judgements for dispatch receipts.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CACHE_DIR } from './config.mjs';

export const OUTCOMES_FILE = join(CACHE_DIR, 'outcomes.jsonl');
export const VERDICTS = new Set(['approved', 'fixed', 'rejected', 'blocked', 'confirmed', 'false-positive', 'missed']);

/** Record a judgement without altering the receipt that it evaluates. */
export async function recordOutcome(entry) {
  await mkdir(CACHE_DIR, { recursive: true });
  await appendFile(OUTCOMES_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Read valid outcome lines. A torn final line never breaks a report. */
export async function readOutcomes({ sinceMs = null } = {}) {
  let text;
  try {
    text = await readFile(OUTCOMES_FILE, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (sinceMs == null || (row.at ?? 0) >= sinceMs) rows.push(row);
    } catch {
      /* ignore a partial or manually damaged line */
    }
  }
  return rows;
}
