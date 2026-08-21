// server.mjs — the fleet coordinator.
//
// One process, anywhere your boxes can reach it, holding the same ledger the
// local file holds: probes, reservations, cost samples. Every orchestrator on
// every machine reads and writes it, so a run on box A can see that box B just
// launched forty agents against the same subscription.
//
// Zero dependencies, node:http. Run it on whichever machine is always up and
// point the others at it.
//
// Two things differ from the single-box ledger, and both come from the same
// fact: you cannot ask another machine whether a process is still alive.
//
//   leases   A reservation carries its own expiry, set by the client from the
//            dispatch's timeout. If a box dies mid-run its reservations expire
//            on their own rather than holding headroom hostage forever. There
//            is no heartbeat to get wrong.
//
//   identity Entries record which node and which project made them, because
//            "37 agents in flight" is not actionable and "22 on vps-2, project
//            checkout-flow" is.
//
// Auth is a bearer token and is NOT optional. An open endpoint here lets anyone
// on the network stall every orchestrator you own by reserving 100% headroom.

import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import { CACHE_DIR } from './config.mjs';

export const DEFAULT_PORT = 7867;
const MAX_BODY_BYTES = 256 * 1024;

/** A reservation with no explicit lease expires this long after it started. */
const DEFAULT_LEASE_MS = 30 * 60_000;
/** Probes older than this are dropped rather than served as fleet truth. */
const PROBE_MAX_AGE_MS = 10 * 60_000;
const MAX_SAMPLES = 200;

function emptyState() {
  return { probes: {}, reservations: [], samples: {} };
}

/** Constant-time compare so the token cannot be recovered by timing the 401s. */
function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function expire(state, now) {
  const reservations = state.reservations.filter((r) => r && (r.expiresAt ?? 0) > now);
  const probes = {};
  for (const [provider, entry] of Object.entries(state.probes ?? {})) {
    if (entry && now - entry.storedAt < PROBE_MAX_AGE_MS) probes[provider] = entry;
  }
  return { ...state, reservations, probes };
}

export function summary(state) {
  const byProvider = {};
  for (const r of state.reservations) {
    const p = (byProvider[r.provider] ??= { agents: 0, points: 0, nodes: {} });
    p.agents += 1;
    p.points = Math.round((p.points + (Number(r.cost) || 0)) * 10) / 10;
    const key = r.project ? `${r.node}:${r.project}` : r.node ?? 'unknown';
    p.nodes[key] = (p.nodes[key] ?? 0) + 1;
  }
  return byProvider;
}

/**
 * Create the coordinator. Exported separately from the CLI so tests can start
 * it on an ephemeral port without spawning a process.
 */
export function createCoordinator({ token, statePath, now = Date.now } = {}) {
  if (!token || String(token).length < 16) {
    throw new Error('a fleet token of at least 16 characters is required');
  }
  const file = statePath ?? join(CACHE_DIR, 'fleet-state.json');
  let state = emptyState();
  let loaded = false;
  let writing = null;

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      state = {
        probes: parsed.probes ?? {},
        reservations: Array.isArray(parsed.reservations) ? parsed.reservations : [],
        samples: parsed.samples ?? {},
      };
    } catch {
      state = emptyState();
    }
  }

  /**
   * Persist so a coordinator restart does not forget what is in flight.
   * Serialised through one promise: this is a single process, so there is no
   * lock to take, but overlapping writes would still interleave.
   */
  function persist() {
    writing = (writing ?? Promise.resolve()).then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await rename(tmp, file);
      } catch {
        // Losing durability is survivable; refusing to coordinate is not.
      }
    });
    return writing;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  const server = createServer(async (req, res) => {
    const send = (code, body) => {
      const payload = JSON.stringify(body ?? {});
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(payload);
    };

    try {
      const url = new URL(req.url, 'http://localhost');

      // Unauthenticated liveness only — it reveals nothing.
      if (url.pathname === '/v1/health') return send(200, { ok: true, service: 'cross-model-orchestrate' });

      const auth = req.headers.authorization ?? '';
      if (!tokenMatches(auth.replace(/^Bearer\s+/i, ''), token)) {
        return send(401, { error: 'unauthorized' });
      }

      await load();
      state = expire(state, now());

      if (req.method === 'GET' && url.pathname === '/v1/state') {
        return send(200, { ...state, summary: summary(state), serverTime: now() });
      }

      if (req.method === 'POST' && url.pathname === '/v1/reserve') {
        const b = await readBody(req);
        if (!b.id || !b.provider) return send(400, { error: 'id and provider are required' });
        const startedAt = now();
        const entry = {
          id: String(b.id),
          provider: String(b.provider),
          cost: Number(b.cost) || 0,
          label: b.label ?? null,
          node: b.node ?? 'unknown',
          project: b.project ?? null,
          startedAt,
          expiresAt: startedAt + Math.min(Number(b.leaseMs) || DEFAULT_LEASE_MS, 6 * 60 * 60_000),
        };
        state.reservations = state.reservations.filter((r) => r.id !== entry.id).concat(entry);
        await persist();
        return send(200, { ok: true, reservation: entry });
      }

      if (req.method === 'POST' && url.pathname === '/v1/release') {
        const b = await readBody(req);
        const before = state.reservations.length;
        state.reservations = state.reservations.filter((r) => r.id !== String(b.id));
        await persist();
        return send(200, { ok: true, removed: before - state.reservations.length });
      }

      if (req.method === 'POST' && url.pathname === '/v1/probe') {
        const b = await readBody(req);
        if (!b.provider || !b.value) return send(400, { error: 'provider and value are required' });
        const current = state.probes[b.provider];
        const storedAt = Number(b.storedAt) || now();
        // Keep the newest reading; a slow box must not overwrite a fresh one.
        if (!current || current.storedAt <= storedAt) {
          state.probes[b.provider] = { storedAt, value: b.value, node: b.node ?? null };
          await persist();
        }
        return send(200, { ok: true, probe: state.probes[b.provider] });
      }

      if (req.method === 'POST' && url.pathname === '/v1/sample') {
        const b = await readBody(req);
        const d = Number(b.delta);
        if (!b.provider || !Number.isFinite(d) || d < 0 || d > 25) {
          return send(400, { error: 'provider and a plausible delta are required' });
        }
        const list = state.samples[b.provider] ?? [];
        list.push(Math.round(d * 100) / 100);
        state.samples[b.provider] = list.slice(-MAX_SAMPLES);
        await persist();
        return send(200, { ok: true, samples: state.samples[b.provider].length });
      }

      return send(404, { error: 'not found' });
    } catch (err) {
      send(400, { error: err?.message ?? 'bad request' });
    }
  });

  return server;
}
