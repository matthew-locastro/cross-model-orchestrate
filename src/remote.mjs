// remote.mjs — talk to the fleet coordinator.
//
// Every call here fails soft. If the coordinator is unreachable the caller
// falls back to this machine's local ledger and carries on: a coordination
// outage must degrade to single-box behaviour, never to a stalled dispatch.
// That is the whole reliability posture — being slightly wrong about other
// boxes beats refusing to run.

import { hostname } from 'node:os';
import { basename, resolve } from 'node:path';

import { loadConfig } from './config.mjs';

const TIMEOUT_MS = 4_000;

/** Who is dispatching, for the fleet view. Cheap and stable. */
export function identity(cwd = process.cwd()) {
  const cfg = loadConfig();
  return {
    node: cfg.fleet?.nodeId || process.env.CMO_NODE_ID || hostname(),
    // Projects come and go constantly, so this is derived per dispatch, never
    // registered. Resolve first: a relative --cwd would otherwise name every
    // project ".".
    project: basename(resolve(cwd)) || null,
  };
}

export function fleetConfig() {
  const cfg = loadConfig();
  const url = cfg.fleet?.url;
  const token = cfg.fleet?.token;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

let degradedSince = 0;
/** True when the last attempt failed recently — used to explain, not to gate. */
export function isDegraded(now = Date.now()) {
  return degradedSince > 0 && now - degradedSince < 60_000;
}

async function call(method, path, body) {
  const fleet = fleetConfig();
  if (!fleet) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${fleet.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${fleet.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    if (res.status === 401) {
      degradedSince = Date.now();
      throw new Error('fleet coordinator rejected the token');
    }
    if (!res.ok) throw new Error(`fleet coordinator HTTP ${res.status}`);
    degradedSince = 0;
    return await res.json();
  } catch (err) {
    degradedSince = Date.now();
    return { __error: err?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function ok(result) {
  return result && !result.__error ? result : null;
}

export async function health() {
  const fleet = fleetConfig();
  if (!fleet) return { configured: false };
  const res = await call('GET', '/v1/health');
  if (!res || res.__error) return { configured: true, url: fleet.url, reachable: false, error: res?.__error };
  return { configured: true, url: fleet.url, reachable: true };
}

export async function remoteState() {
  return ok(await call('GET', '/v1/state'));
}

export async function remoteReserve(entry) {
  return ok(await call('POST', '/v1/reserve', entry));
}

export async function remoteRelease(id) {
  return ok(await call('POST', '/v1/release', { id }));
}

export async function remoteProbe(provider, value, storedAt) {
  const { node } = identity();
  return ok(await call('POST', '/v1/probe', { provider, value, storedAt, node }));
}

export async function remoteSample(provider, delta) {
  return ok(await call('POST', '/v1/sample', { provider, delta }));
}
