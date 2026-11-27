// resets.mjs — redeemable weekly-reset inventory and opt-in burn mode.
//
// Some subscriptions grant redeemable "full resets" that expire on fixed dates.
// Any reset expiring before the provider's next natural weekly reset is lost
// unless the current weekly window is spent first and the user taps to redeem a
// reset in the vendor's app (cmo itself cannot redeem, and never plans around
// paid credits).

import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  CACHE_DIR, CONFIG_FILE, loadConfig, parseResetExpiry, parseResetsConfig, PROVIDERS,
} from './config.mjs';
import { parseSinceMinutes } from './durations.mjs';

/** While burning, tight/critical bands are ignored until the binding window reaches raw 95%+. */
export const BURN_BANDS = { tight: 95, critical: 95, exhausted: 95 };

const defaultCacheDir = () => process.env.CMO_CACHE_DIR || CACHE_DIR;

export function formatResetExpiry(iso) {
  if (typeof iso !== 'string' || !iso) return '?';
  return iso.endsWith('T00:00:00.000Z')
    ? iso.slice(0, 10)
    : `${iso.replace('T', ' ').slice(0, 16)}Z`;
}

/**
 * Find the provider's next natural weekly reset. Never mistakes a 5-hour or
 * daily window's `nextResetAt` for the weekly reset.
 */
export function naturalWeeklyResetAt(providerLimits, now = Date.now()) {
  if (!providerLimits || typeof providerLimits !== 'object') return null;
  const windows = Array.isArray(providerLimits.windows) ? providerLimits.windows : [];
  const weekly = windows.find((w) => w?.key === 'weekly');
  const candidate = weekly
    ? (weekly.resetsAt ?? null)
    : (windows.length === 0 ? (providerLimits.nextResetAt ?? null) : null);
  const ms = candidate ? Date.parse(candidate) : NaN;
  if (!Number.isFinite(ms) || ms <= now) return null;
  return new Date(ms).toISOString();
}

/**
 * Classify a provider's configured resets against `now` and its next natural
 * weekly reset. Already-expired entries are flagged `expired` and excluded from
 * `remaining` and `useOrLose`.
 */
export function classifyResets(provider, providerLimits, resetsList = [], now = Date.now()) {
  const normalized = (Array.isArray(resetsList) ? resetsList : [])
    .map(parseResetExpiry)
    .filter(Boolean)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const naturalResetAt = naturalWeeklyResetAt(providerLimits, now);
  const naturalResetMs = naturalResetAt ? Date.parse(naturalResetAt) : null;

  const entries = normalized.map((expiresAt) => {
    const ms = Date.parse(expiresAt);
    const expired = !(ms > now);
    const useOrLose = !expired && naturalResetMs != null && ms < naturalResetMs;
    return {
      expiresAt,
      display: formatResetExpiry(expiresAt),
      expired,
      useOrLose,
      status: expired ? 'expired' : (useOrLose ? 'use-or-lose' : 'ok'),
    };
  });

  return {
    provider,
    naturalResetAt,
    entries,
    remaining: entries.filter((e) => !e.expired),
    useOrLose: entries.filter((e) => e.useOrLose),
  };
}

export function useOrLoseSuggestion(provider, count) {
  if (!(count > 0)) return null;
  return `${count} ${provider} resets expire before the weekly reset; run \`cmo burn ${provider}\` to use them.`;
}

export function burnExhaustedNote(provider, remaining) {
  if (!Array.isArray(remaining) || remaining.length === 0) return null;
  return `${provider} exhausted; ${remaining.length} resets left (earliest expires ${remaining[0].display}): redeem one in the app to keep burning`;
}

// ── config.json reset mutations ───────────────────────────────────────────

async function readRawConfigObject(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${file}: root must be a JSON object`);
    }
    return parsed;
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export async function addReset(provider, expiry, { configFile = CONFIG_FILE } = {}) {
  if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider "${provider}"`);
  const iso = parseResetExpiry(expiry);
  if (!iso) throw new Error(`invalid ISO 8601 date or datetime "${expiry}"`);

  const raw = await readRawConfigObject(configFile);
  const existing = parseResetsConfig(raw.resets, configFile);
  const list = [...(existing[provider] ?? []), iso].sort((a, b) => Date.parse(a) - Date.parse(b));
  raw.resets = { ...existing, [provider]: list };
  await writeJsonAtomic(configFile, raw);
  loadConfig({ file: configFile, reload: true });
  return { added: iso, list };
}

export async function markResetUsed(provider, expiry = undefined, { configFile = CONFIG_FILE } = {}) {
  if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider "${provider}"`);
  let targetIso = null;
  if (expiry !== undefined) {
    targetIso = parseResetExpiry(expiry);
    if (!targetIso) throw new Error(`invalid ISO 8601 date or datetime "${expiry}"`);
  }

  const raw = await readRawConfigObject(configFile);
  const existing = parseResetsConfig(raw.resets, configFile);
  const list = [...(existing[provider] ?? [])];
  if (list.length === 0) {
    return { ok: false, error: `no resets configured for ${provider}` };
  }

  let removed;
  if (targetIso) {
    const idx = list.indexOf(targetIso);
    if (idx === -1) {
      return { ok: false, error: `no reset expiring ${formatResetExpiry(targetIso)} configured for ${provider}` };
    }
    [removed] = list.splice(idx, 1);
  } else {
    removed = list.shift();
  }

  const nextResets = { ...existing };
  if (list.length > 0) nextResets[provider] = list;
  else delete nextResets[provider];
  if (Object.keys(nextResets).length > 0) raw.resets = nextResets;
  else delete raw.resets;

  await writeJsonAtomic(configFile, raw);
  loadConfig({ file: configFile, reload: true });
  return { ok: true, removed, remaining: list };
}

// ── shared burn state in cacheDir ─────────────────────────────────────────

export function burnStateFile(cacheDir = defaultCacheDir()) {
  return join(cacheDir, 'burn.json');
}

/**
 * Parse `--until <ISO datetime/date or duration such as 36h>` into a UTC ISO timestamp.
 */
export function parseBurnUntil(spec, now = Date.now()) {
  if (typeof spec !== 'string' || !spec.trim()) return null;
  const trimmed = spec.trim();
  if (/^(?:\d+(?:\.\d+)?|\.\d+)\s*[smhdw]$/i.test(trimmed)) {
    const mins = parseSinceMinutes(trimmed, null);
    if (mins != null && mins > 0) {
      return new Date(now + Math.round(mins * 60_000)).toISOString();
    }
    return null;
  }
  return parseResetExpiry(trimmed);
}

export function readBurnState({ cacheDir = defaultCacheDir(), now = Date.now() } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(burnStateFile(cacheDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !PROVIDERS.includes(parsed.provider)) {
      return { active: false, expired: false, state: null };
    }
    const state = {
      provider: parsed.provider,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
      until: typeof parsed.until === 'string' ? parsed.until : null,
    };
    if (state.until != null) {
      const untilMs = Date.parse(state.until);
      if (!Number.isFinite(untilMs) || now >= untilMs) {
        return { active: false, expired: true, state };
      }
    }
    return { active: true, expired: false, state };
  } catch {
    return { active: false, expired: false, state: null };
  }
}

export function activeBurn(opts = {}) {
  const r = readBurnState(opts);
  return r.active ? r.state : null;
}

export async function setBurn(provider, { until = null, cacheDir = defaultCacheDir(), now = Date.now() } = {}) {
  if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider "${provider}"`);
  const state = {
    provider,
    startedAt: new Date(now).toISOString(),
    until: until ?? null,
  };
  await writeJsonAtomic(burnStateFile(cacheDir), state);
  return state;
}

export async function clearBurn({ cacheDir = defaultCacheDir() } = {}) {
  await rm(burnStateFile(cacheDir), { force: true });
}
