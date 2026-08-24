// limits.mjs — subscription headroom for the two subagent providers.
//
// The orchestrator asks this before every fan-out and periodically during long
// runs, so a 250-agent workflow does not walk into a usage wall at agent 180.
// Both readers FAIL SOFT: any error returns `{ available: false, error }` so a
// dead probe degrades dispatch to "assume healthy", never blocks a run.
//
// Sources
// -------
// codex   Local only, zero cost. `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
//         carries an `event_msg` per turn whose `payload.rate_limits` holds the
//         current rolling-window snapshot:
//
//           {"primary":{"used_percent":1.0,"window_minutes":10080,
//                       "resets_at":1787902559},
//            "secondary":null,"credits":{...},"plan_type":"pro",
//            "rate_limit_reached_type":null,"spend_control_reached":null}
//
//         NOTE: do not assume primary==5h. codex-cli 0.149 emits the weekly
//         window as `primary` with `secondary: null`; older builds put the
//         5-hour window in `primary`. Classify by `window_minutes`, never by
//         field name.
//
// claude  Live authenticated read of the OAuth usage endpoint, which costs zero
//         tokens (no inference). Claude Code does not persist the rolling-window
//         snapshot anywhere local — `~/.claude/stats-cache.json` is historical
//         counts only — so this is the only honest source.
//
// Both are cached on disk with a TTL so hundreds of dispatch decisions share one
// probe.

import { access, readFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';

import { CACHE_DIR, loadConfig } from './config.mjs';
import { applyCommitted, freshProbe, inFlight, mutate, snapshot } from './ledger.mjs';

export { CACHE_DIR };

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Is the vendor CLI even on PATH?
 *
 * This is a different question from "can we read its meter", and conflating
 * them cost a real dispatch. On a machine with no codex installed, the probe
 * reported "headroom unknown", the router read unknown as usable, preferred
 * codex anyway, and every dispatch paid a doomed spawn and an ENOENT before
 * failing over. Across a 250-agent fan-out that is 250 wasted spawns and a
 * `fatal` in every receipt.
 *
 * The distinction has to be kept, though — it must NOT collapse into "demote
 * anything unreadable". A freshly installed codex has no session file, so its
 * meter is legitimately unknown, and the first dispatch is what creates the
 * file that fixes it. Demote on unknown and codex never gets that first
 * dispatch, so the meter never becomes readable: a trap that never reopens.
 *
 * Absent binary, never dispatch. Present binary, unreadable meter, dispatch.
 *
 * Scans PATH directly rather than spawning `which`, because this runs on the
 * read path of every routing decision.
 */
const onPathCache = new Map();
export async function binaryOnPath(name, { env = process.env, cache = onPathCache } = {}) {
  if (cache.has(name)) return cache.get(name);
  const exts = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  let found = false;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        await access(join(dir, `${name}${ext}`), constants.X_OK);
        found = true;
        break;
      } catch { /* keep looking */ }
    }
    if (found) break;
  }
  cache.set(name, found);
  return found;
}

// ── shared shaping ────────────────────────────────────────────────────────

/** Coerce epoch-seconds, epoch-ms, or an ISO string into an ISO string. */
export function normalizeReset(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value; // <1e12 ⇒ seconds
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  return null;
}

function clampPercent(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Name a rolling window by its length, not by which JSON field carried it.
 * 300 minutes is the 5-hour session window; 10080 is the 7-day window.
 */
export function windowKeyForMinutes(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return { key: 'window', label: 'Window' };
  if (n <= 360) return { key: '5h', label: '5hr' };
  if (n <= 2880) return { key: 'daily', label: 'Daily' };
  return { key: 'weekly', label: 'Wkly' };
}

/**
 * Reduce a provider's windows to the single number dispatch cares about: the
 * most-consumed window, plus when relief arrives.
 */
export function summarize(provider, windows, extra = {}) {
  const usable = windows.filter((w) => typeof w.percentUsed === 'number');
  const worst = usable.reduce(
    (acc, w) => (acc == null || w.percentUsed > acc.percentUsed ? w : acc),
    null,
  );
  return {
    provider,
    available: usable.length > 0,
    windows: usable,
    worstPercent: worst ? worst.percentUsed : null,
    worstWindow: worst ? worst.key : null,
    nextResetAt: worst ? worst.resetsAt : null,
    hardBlocked: Boolean(extra.hardBlocked),
    plan: extra.plan ?? null,
    source: extra.source ?? null,
    checkedAt: new Date().toISOString(),
    ...(extra.error ? { error: extra.error } : {}),
  };
}

function unavailable(provider, error) {
  return {
    provider,
    available: false,
    error,
    windows: [],
    worstPercent: null,
    worstWindow: null,
    nextResetAt: null,
    hardBlocked: false,
    plan: null,
    source: null,
    checkedAt: new Date().toISOString(),
  };
}

// ── codex ─────────────────────────────────────────────────────────────────

/** Map one `payload.rate_limits` snapshot onto windows + hard-block flags. */
export function parseCodexRateLimits(rl) {
  if (!rl || typeof rl !== 'object') return null;
  const windows = [];
  for (const field of ['primary', 'secondary']) {
    const w = rl[field];
    if (!w || typeof w !== 'object') continue;
    const percentUsed = clampPercent(w.used_percent);
    if (percentUsed == null) continue;
    const { key, label } = windowKeyForMinutes(w.window_minutes);
    // Two fields can name the same window across CLI versions; keep the worse.
    const existing = windows.find((x) => x.key === key);
    if (existing) {
      if (percentUsed > existing.percentUsed) {
        existing.percentUsed = percentUsed;
        existing.resetsAt = normalizeReset(w.resets_at ?? w.reset_at);
      }
      continue;
    }
    windows.push({ key, label, percentUsed, resetsAt: normalizeReset(w.resets_at ?? w.reset_at) });
  }
  if (windows.length === 0) return null;
  return {
    windows,
    hardBlocked: Boolean(rl.rate_limit_reached_type) || rl.spend_control_reached === true,
    plan: typeof rl.plan_type === 'string' ? rl.plan_type : null,
  };
}

/** Scan a JSONL rollout backwards for the newest rate-limit snapshot. */
export function extractLatestRateLimits(content) {
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !line.includes('"rate_limits"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    // The field has moved between CLI versions; accept either nesting.
    const rl = parsed?.payload?.rate_limits ?? parsed?.rate_limits ?? parsed?.msg?.rate_limits;
    if (rl && (rl.primary || rl.secondary)) return rl;
  }
  return null;
}

async function listNumericDesc(dir) {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => /^\d+$/.test(e)).sort().reverse();
  } catch {
    return [];
  }
}

/**
 * Newest-first walk of YYYY/MM/DD. Dated-dir lexical order is chronological, so
 * descending the greatest subdir at each level reaches today's logs first. We
 * return several candidates because the newest file is not guaranteed to
 * contain a snapshot (a session can end before its first token_count).
 */
async function recentRolloutFiles(root, limit = 8) {
  const found = [];
  for (const y of await listNumericDesc(root)) {
    for (const m of await listNumericDesc(join(root, y))) {
      for (const d of await listNumericDesc(join(root, y, m))) {
        const dir = join(root, y, m, d);
        let entries;
        try {
          entries = await readdir(dir);
        } catch {
          continue;
        }
        const rollouts = entries.filter((e) => e.startsWith('rollout-') && e.endsWith('.jsonl'));
        const stamped = [];
        for (const name of rollouts) {
          const path = join(dir, name);
          try {
            stamped.push({ path, mtime: (await stat(path)).mtimeMs });
          } catch {
            /* raced with cleanup — skip */
          }
        }
        stamped.sort((a, b) => b.mtime - a.mtime);
        for (const s of stamped) {
          found.push(s.path);
          if (found.length >= limit) return found;
        }
      }
      if (found.length > 0) return found; // a whole month scanned; good enough
    }
    if (found.length > 0) return found;
  }
  return found;
}

export async function readCodexLimits({ sessionsRoot } = {}) {
  const root = sessionsRoot ?? loadConfig().codexSessionsRoot;
  try {
    const files = await recentRolloutFiles(root);
    if (files.length === 0) return unavailable('codex', 'no codex session rollouts found');
    for (const file of files) {
      let content;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const rl = extractLatestRateLimits(content);
      const parsed = rl && parseCodexRateLimits(rl);
      if (parsed) {
        return summarize('codex', parsed.windows, {
          hardBlocked: parsed.hardBlocked,
          plan: parsed.plan,
          source: file,
        });
      }
    }
    return unavailable('codex', 'no rate_limits snapshot in recent rollouts');
  } catch (err) {
    return unavailable('codex', err instanceof Error ? err.message : String(err));
  }
}

// ── claude ────────────────────────────────────────────────────────────────

/**
 * Prefer the `limits[]` array — it is the forward-compatible shape and carries
 * a `severity` the named fields do not. Fall back to `five_hour`/`seven_day`.
 */
export function parseOAuthUsage(body) {
  if (!body || typeof body !== 'object') return null;
  const windows = [];
  let hardBlocked = false;

  if (Array.isArray(body.limits)) {
    for (const entry of body.limits) {
      if (!entry || typeof entry !== 'object') continue;
      const percentUsed = clampPercent(entry.percent);
      if (percentUsed == null) continue;
      const group = String(entry.group ?? entry.kind ?? 'window');
      const key = group === 'session' ? '5h' : group === 'weekly' ? 'weekly' : group;
      const label = key === '5h' ? '5hr' : key === 'weekly' ? 'Wkly' : group;
      if (windows.some((w) => w.key === key)) continue;
      windows.push({ key, label, percentUsed, resetsAt: normalizeReset(entry.resets_at) });
      if (percentUsed >= 100) hardBlocked = true;
      if (typeof entry.severity === 'string' && /exhaust|block|reached/i.test(entry.severity)) {
        hardBlocked = true;
      }
    }
  }

  if (windows.length === 0) {
    for (const [field, key, label] of [
      ['five_hour', '5h', '5hr'],
      ['seven_day', 'weekly', 'Wkly'],
    ]) {
      const entry = body[field];
      if (!entry || typeof entry !== 'object') continue;
      const percentUsed = clampPercent(entry.utilization);
      if (percentUsed == null) continue;
      windows.push({ key, label, percentUsed, resetsAt: normalizeReset(entry.resets_at) });
      if (percentUsed >= 100) hardBlocked = true;
    }
  }

  if (windows.length === 0) return null;
  if (body?.extra_usage?.spend_limit_reached === true) hardBlocked = true;
  return { windows, hardBlocked };
}

/**
 * Claude's OAuth token is short-lived — hours, not days — and when it lapses the
 * usage endpoint stops answering. The meter goes dark, headroom reads as
 * unknown, and unknown is deliberately treated as usable: the tool keeps
 * dispatching into a window it can no longer see. Over a multi-day soak that is
 * the difference between a report and a fiction. It happened on the first
 * morning of one.
 *
 * Finding the cheapest repair took measuring rather than guessing. Against a
 * deliberately expired token, `claude auth status`, `claude doctor`,
 * `claude agents list` and `claude mcp list` all leave it expired — they read
 * the credentials file without authenticating. Only a real inference call
 * refreshes it. So that is what this does, made as small as a turn can be:
 *
 *   haiku            the cheapest model on the account
 *   empty cwd        no project CLAUDE.md, no git status, no directory context
 *   --system-prompt  replaces the full agent preamble with one line
 *   no skills        --disable-slash-commands skips plugin and skill loading
 *
 * That is a few hundred tokens against a five-hour window measured in millions,
 * and it is spent only when the token has already lapsed. `--bare` would be
 * cheaper still and is the obvious thing to reach for — but it deliberately
 * never reads OAuth, so it refreshes nothing.
 *
 * Rate-limited to one attempt a minute per process: a fan-out of two hundred
 * agents must not each spawn a CLI on a bad morning.
 */
let lastRefreshAttempt = 0;

async function attemptTokenRefresh({ now = Date.now } = {}) {
  if (now() - lastRefreshAttempt < 60_000) return false;
  lastRefreshAttempt = now();
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { tmpdir } = await import('node:os');
    await promisify(execFile)('claude', [
      '-p', 'ok',
      '--model', 'claude-haiku-4-5-20251001',
      '--system-prompt', 'Reply with the single word: ok',
      '--disable-slash-commands',
      '--no-session-persistence',
    ], { timeout: 90_000, cwd: tmpdir() });
    return true;
  } catch {
    return false; // no claude on PATH, or it failed — the caller reports honestly
  }
}

async function readOAuthToken(credentialsPath) {
  const path = credentialsPath ?? loadConfig().claudeCredentials;
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw);
  const token = parsed?.claudeAiOauth?.accessToken;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('no claudeAiOauth.accessToken in credentials');
  }
  const expiresAt = parsed?.claudeAiOauth?.expiresAt;
  if (typeof expiresAt === 'number' && expiresAt < Date.now()) {
    throw new Error('claude oauth token expired — run `claude` once to refresh');
  }
  return token;
}

export async function readClaudeLimits({ credentialsPath, fetchImpl, refresh = attemptTokenRefresh } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  try {
    let token;
    try {
      token = await readOAuthToken(credentialsPath);
    } catch (err) {
      // An expired token is the one failure worth trying to repair in place,
      // because the alternative is a meter that stays dark for days.
      if (!/expired/i.test(err?.message ?? '')) throw err;
      const refreshed = await refresh();
      if (!refreshed) throw new Error('claude oauth token expired and auto-refresh could not run — run `claude` once');
      try {
        token = await readOAuthToken(credentialsPath);
      } catch {
        throw new Error('claude oauth token expired and auto-refresh did not take — run `claude` once');
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await doFetch(OAUTH_USAGE_URL, {
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return unavailable('claude', `oauth usage HTTP ${response.status}`);
    const parsed = parseOAuthUsage(await response.json());
    if (!parsed) return unavailable('claude', 'unexpected oauth usage shape');
    return summarize('claude', parsed.windows, {
      hardBlocked: parsed.hardBlocked,
      source: OAUTH_USAGE_URL,
    });
  } catch (err) {
    return unavailable('claude', err instanceof Error ? err.message : String(err));
  }
}

// ── shared state ──────────────────────────────────────────────────────────
//
// The cache lives in ledger.mjs because it is not this process's cache — it is
// the machine's. Several orchestrators read and write it, so it is locked,
// written atomically, and single-flighted: a hundred concurrent dispatches
// produce one probe, not a hundred.

/**
 * Read both providers, honouring a SHORT shared freshness window, and fold in
 * headroom this machine has already committed but not yet been billed for.
 *
 * `refresh: true` forces a probe regardless of age.
 *
 * The committed-spend adjustment is the important part under concurrency: the
 * vendor's number describes work that has already landed, and says nothing
 * about the agents other orchestrators launched thirty seconds ago.
 */
export async function readLimits({ refresh = false, now = Date.now(), readers, includeCommitted = true } = {}) {
  const cfg = loadConfig();
  const nowFn = () => now;
  const readCodex = readers?.codex ?? readCodexLimits;
  const readClaude = readers?.claude ?? readClaudeLimits;

  const [codexProbe, claudeProbe] = await Promise.all([
    freshProbe('codex', refresh ? -1 : cfg.freshness.codex, readCodex, { now: nowFn }),
    freshProbe('claude', refresh ? -1 : cfg.freshness.claude, readClaude, { now: nowFn }),
  ]);

  const state = await snapshot({ now: nowFn });
  const codex = includeCommitted ? applyCommitted(codexProbe.value, state, 'codex') : codexProbe.value;
  const claude = includeCommitted ? applyCommitted(claudeProbe.value, state, 'claude') : claudeProbe.value;

  // Recorded on the reading itself so the routing decision can tell an absent
  // CLI from an unreadable meter. Injected readers (tests) are exempt: they are
  // deciding what the probe says, so PATH is not theirs to be judged by.
  if (!readers) {
    const [codexInstalled, claudeInstalled] = await Promise.all([
      binaryOnPath('codex'), binaryOnPath('claude'),
    ]);
    if (codex && typeof codex === 'object') codex.installed = codexInstalled;
    if (claude && typeof claude === 'object') claude.installed = claudeInstalled;
  }

  return {
    codex,
    claude,
    cached: { codex: codexProbe.cached, claude: claudeProbe.cached },
    inFlight: {
      codex: inFlight(state, 'codex'),
      claude: inFlight(state, 'claude'),
    },
    // Whether these figures cover the whole fleet or only this machine, and
    // where the in-flight work actually is. The caller needs to know which,
    // because a single-box view during a coordinator outage is a weaker claim.
    fleet: Boolean(state.fleet),
    summary: state.summary ?? null,
  };
}

/**
 * Re-read Codex headroom from disk and store it, returning the value.
 *
 * `codex exec --json` does NOT carry rate limits in its event stream — that
 * lives in the session rollout, which the run has just finished writing. So
 * after a dispatch we read the rollout rather than the stream.
 */
export async function refreshCodexLimits({ now = Date.now() } = {}) {
  const value = await readCodexLimits();
  if (value.available !== true) return null;
  await mutate((st) => {
    st.probes.codex = { storedAt: now, value };
  }, { now: () => now });
  return value;
}

/**
 * The claude twin of `refreshCodexLimits`. Codex gets its reading for free out
 * of the exec stream; claude's costs one HTTP GET against the OAuth usage
 * endpoint, which is cheap enough to do after a dispatch and is the only way
 * claude can ever measure what one of its own agents costs.
 */
export async function refreshClaudeLimits({ now = Date.now(), minAgeMs = 0 } = {}) {
  // Throttle, because unlike codex's this reading is a network call.
  //
  // Codex harvests its meter out of a file the dispatch just wrote, so doing it
  // after every agent is free. Claude's costs an HTTP GET against the OAuth
  // usage endpoint, and "after every agent" on a sixteen-wide claude fan-out is
  // sixteen requests in a burst against an endpoint that rate-limits. Earning a
  // 429 to measure cost would trade the meter for a statistic — and a dark
  // meter is the single worst state this tool can be in, because every routing
  // decision below it is computed against a reading that no longer exists.
  //
  // A sample from some dispatches is plenty; the estimate is a mean over many.
  if (minAgeMs > 0) {
    const state = await snapshot({ now: () => now });
    const storedAt = state.probes?.claude?.storedAt;
    if (typeof storedAt === 'number' && now - storedAt < minAgeMs) return null;
  }
  const value = await readClaudeLimits();
  // Never store a failed read: a 429 must not overwrite a good reading with a
  // dark one. The previous value stays, ages out on its own TTL, and the next
  // caller retries.
  if (value.available !== true) return null;
  await mutate((st) => {
    st.probes.claude = { storedAt: now, value };
  }, { now: () => now });
  return value;
}

/**
 * Fold a rate-limit snapshot harvested from a live `codex exec --json` stream
 * back into the cache. Every codex subagent therefore refreshes the codex
 * reading for free, and a run that is burning quota fast notices inside one
 * agent instead of one TTL.
 */
export async function recordCodexRateLimits(rl, { now = Date.now() } = {}) {
  const parsed = parseCodexRateLimits(rl);
  if (!parsed) return null;
  const value = summarize('codex', parsed.windows, {
    hardBlocked: parsed.hardBlocked,
    plan: parsed.plan,
    source: 'codex exec --json token_count',
  });
  await mutate((st) => {
    st.probes.codex = { storedAt: now, value };
  }, { now: () => now });
  return value;
}

/** Mark a provider spent after it returned an explicit rate-limit error. */
export async function markExhausted(provider, { now = Date.now(), resetsAt = null } = {}) {
  let value = null;
  await mutate((st) => {
    const previous = st.probes[provider]?.value ?? unavailable(provider, 'exhausted');
    value = {
      ...previous,
      available: true,
      hardBlocked: true,
      worstPercent: 100,
      nextResetAt: resetsAt ?? previous.nextResetAt,
      source: 'provider rate-limit error',
      checkedAt: new Date(now).toISOString(),
    };
    st.probes[provider] = { storedAt: now, value };
  }, { now: () => now });
  return value;
}
