// ledger.mjs — shared state for every orchestrator on this machine.
//
// The problem this exists for: subscriptions are contended. Several
// orchestrators, on several projects, drain the same two windows at the same
// time, and none of them knows what the others just dispatched. Three things
// follow, and all three are handled here.
//
//   1. A reading goes stale immediately. Whatever another orchestrator spent
//      two seconds ago is not in your number yet. So the probe cache is short,
//      and it is SHARED — one probe serves every process on the box instead of
//      each one asking separately.
//
//   2. Concurrent writers clobber each other. read → mutate → write with a
//      plain writeFile means two processes finishing at once can lose one
//      another's entry, and a torn write leaves JSON that parses as nothing,
//      which silently reads back as "headroom unknown" — the most dangerous
//      possible default. Every mutation here takes a lock and lands via
//      atomic rename.
//
//   3. THE METER IS A LAGGING INDICATOR. This is the one that actually bites.
//      Even a perfectly fresh reading only reflects consumption the vendor has
//      already accounted for. It says nothing about the forty agents currently
//      in flight across four other orchestrators. Two of them read 80%, both
//      see room, both dispatch a batch, and both sail through the limit.
//
//      So every dispatch RESERVES against the provider before it runs and
//      releases afterwards. Effective headroom is what the vendor reported
//      plus what this machine has already committed but not yet been billed
//      for. A crashed run cannot hold a reservation forever: entries carry a
//      pid and a timestamp, and are collected when the process is gone or the
//      entry is older than the lease.

import { open, mkdir, readFile, rename, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { CACHE_DIR, loadConfig } from './config.mjs';

export const STATE_FILE = join(CACHE_DIR, 'state.json');
const LOCK_FILE = join(CACHE_DIR, 'state.lock');

/** A lock older than this belonged to a process that died holding it. */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

/** A reservation older than this is assumed abandoned, even if the pid lives. */
export const RESERVATION_LEASE_MS = 30 * 60_000;

const EMPTY = { probes: {}, reservations: [], samples: {} };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function acquire(now) {
  const deadline = now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fh = await open(LOCK_FILE, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') return false; // unwritable dir — proceed unlocked
      let age = Infinity;
      try {
        age = now() - (await stat(LOCK_FILE)).mtimeMs;
      } catch {
        continue; // it vanished; try again
      }
      if (age > LOCK_STALE_MS) {
        // Whoever held this is gone. Breaking it is safer than deadlocking
        // every orchestrator on the machine behind a corpse.
        await rm(LOCK_FILE, { force: true }).catch(() => {});
        continue;
      }
      if (now() > deadline) return false; // proceed unlocked rather than block a dispatch
      await sleep(25);
    }
  }
}

async function release() {
  await rm(LOCK_FILE, { force: true }).catch(() => {});
}

async function readState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    return {
      probes: parsed.probes ?? {},
      reservations: Array.isArray(parsed.reservations) ? parsed.reservations : [],
      samples: parsed.samples ?? {},
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

/** Write via temp + rename so a reader never sees a half-written file. */
async function writeState(state) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, STATE_FILE);
  } catch {
    // A full or read-only disk must never fail a dispatch decision.
  }
}

function processAlive(pid) {
  if (typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0); // signal 0 tests existence without touching it
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // exists, owned by someone else
  }
}

/** Drop reservations whose process is gone or whose lease expired. */
export function gcReservations(reservations, now) {
  return reservations.filter(
    (r) => r && now - r.startedAt < RESERVATION_LEASE_MS && processAlive(r.pid),
  );
}

/**
 * Run `fn(state)` under the lock and persist whatever it returns.
 * If the lock cannot be taken we still proceed — a contended lock must degrade
 * to a possible lost update, never to a stalled dispatch.
 */
export async function mutate(fn, { now = Date.now } = {}) {
  const locked = await acquire(now);
  try {
    const state = await readState();
    state.reservations = gcReservations(state.reservations, now());
    const result = await fn(state);
    await writeState(state);
    return result;
  } finally {
    if (locked) await release();
  }
}

export async function snapshot({ now = Date.now } = {}) {
  const state = await readState();
  state.reservations = gcReservations(state.reservations, now());
  return state;
}

// ── probe cache ───────────────────────────────────────────────────────────

/**
 * Return a cached probe if it is younger than maxAgeMs, otherwise take one.
 *
 * Single-flight across processes: the lock means a hundred concurrent
 * dispatches produce one probe, not a hundred. Whoever gets the lock probes;
 * everyone else finds the fresh answer already there.
 */
export async function freshProbe(provider, maxAgeMs, read, { now = Date.now } = {}) {
  const state = await readState();
  const entry = state.probes?.[provider];
  if (entry && now() - entry.storedAt < maxAgeMs) return { value: entry.value, cached: true };

  const value = await read();
  await mutate((s) => {
    const current = s.probes[provider];
    // Someone else may have probed while we were waiting; keep the newer one.
    if (!current || current.storedAt < now()) {
      s.probes[provider] = { storedAt: now(), value };
    }
  }, { now });
  return { value, cached: false };
}

// ── reservations ──────────────────────────────────────────────────────────

let counter = 0;

/**
 * Claim headroom before dispatching. Returns the reservation id.
 *
 * `cost` is in percentage points of the provider's worst window — an estimate,
 * and openly so. It is refined per provider from observed deltas (see
 * `recordSample`), and falls back to the configured default until there is
 * enough evidence. Being directionally right about committed spend beats being
 * precisely right about spend that already landed.
 */
export async function reserve(provider, { label = null, cost = null, now = Date.now } = {}) {
  counter += 1;
  const id = `${process.pid}-${now()}-${counter}`;
  const points = cost ?? (await perAgentCost(provider, { now }));
  await mutate((s) => {
    s.reservations.push({
      id,
      provider,
      pid: process.pid,
      startedAt: now(),
      cost: points,
      label,
    });
  }, { now });
  return id;
}

export async function releaseReservation(id, { now = Date.now } = {}) {
  await mutate((s) => {
    s.reservations = s.reservations.filter((r) => r.id !== id);
  }, { now });
}

/** Percentage points already committed on a provider but not yet reported. */
export function committed(state, provider) {
  return state.reservations
    .filter((r) => r.provider === provider)
    .reduce((sum, r) => sum + (Number(r.cost) || 0), 0);
}

export function inFlight(state, provider) {
  return state.reservations.filter((r) => r.provider === provider).length;
}

// ── learning what an agent actually costs ─────────────────────────────────

const MAX_SAMPLES = 40;

/**
 * Record an observed movement in a provider's reported percentage across one
 * dispatch. Codex gives these away for free — every run rewrites its session
 * rollout — so the estimate gets better the more the tool is used.
 */
export async function recordSample(provider, deltaPoints, { now = Date.now } = {}) {
  const d = Number(deltaPoints);
  if (!Number.isFinite(d) || d < 0 || d > 25) return; // nonsense or a window reset
  await mutate((s) => {
    const list = s.samples[provider] ?? [];
    list.push(Math.round(d * 100) / 100);
    s.samples[provider] = list.slice(-MAX_SAMPLES);
  }, { now });
}

/**
 * Mean, not median, and zeros count.
 *
 * Vendors report utilisation as an integer percent, so one small agent usually
 * costs less than the meter can resolve and shows up as a delta of zero. A
 * median of those zeros says "agents are free", which is wrong and removes the
 * protection entirely. The mean over many samples recovers the sub-resolution
 * cost correctly: twenty agents that together moved the window two points cost
 * about 0.1 points each.
 *
 * Floored, because "too small to measure" is not "free".
 */
export const MIN_SAMPLES = 10;
export const COST_FLOOR = 0.05;

export function estimateFromSamples(samples) {
  const usable = (samples ?? []).filter((n) => Number.isFinite(n) && n >= 0);
  if (usable.length < MIN_SAMPLES) return null; // not enough evidence to beat the default
  const mean = usable.reduce((a, b) => a + b, 0) / usable.length;
  return Math.max(COST_FLOOR, Math.round(mean * 100) / 100);
}

export async function perAgentCost(provider, { now = Date.now, state = null } = {}) {
  const s = state ?? (await snapshot({ now }));
  const measured = estimateFromSamples(s.samples?.[provider]);
  if (measured != null) return measured;
  const cfg = loadConfig();
  return cfg.reservation?.[provider] ?? cfg.reservation?.default ?? 1.0;
}

/**
 * Fold committed-but-unreported spend into a provider's reading.
 *
 * The returned object is shaped exactly like a probe result so the policy does
 * not need to know this happened — but it carries the extra fields so `cmo
 * limits` can show the difference between what the vendor said and what this
 * machine has already promised to spend.
 */
export function applyCommitted(limits, state, provider) {
  if (!limits || limits.available !== true) return limits;
  const points = committed(state, provider);
  const agents = inFlight(state, provider);
  if (points <= 0) return { ...limits, inFlightAgents: 0, committedPoints: 0 };
  const reported = typeof limits.worstPercent === 'number' ? limits.worstPercent : 0;
  return {
    ...limits,
    reportedPercent: reported,
    worstPercent: Math.min(100, Math.round((reported + points) * 10) / 10),
    inFlightAgents: agents,
    committedPoints: Math.round(points * 10) / 10,
  };
}
