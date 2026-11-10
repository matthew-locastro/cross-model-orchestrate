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
// claude  Two sources, tried in order.
//
//         1. A live authenticated read of the OAuth usage endpoint, which costs
//            zero tokens (no inference). It needs the token Claude Code keeps in
//            `~/.claude/.credentials.json`, and that file only exists where
//            Claude Code stores its credentials on disk — Linux, mostly.
//
//         2. The CLI's own stream. On macOS Claude Code keeps its credentials in
//            the login Keychain, so there is no file, source 1 answers ENOENT
//            forever, and the meter is dark on every Mac. But the CLI reports
//            the windows itself: `claude -p --output-format stream-json` emits
//            one `rate_limit_event` per turn —
//
//              {"type":"rate_limit_event","rate_limit_info":{"status":"allowed",
//               "unifiedWindows":{
//                 "five_hour":{"utilization":0.01,"resetsAt":1791404400},
//                 "seven_day":{"utilization":0.65,"resetsAt":1791475200}}}}
//
//            — so when source 1 cannot answer, the meter asks the CLI, which
//            already knows how to authenticate wherever it is installed. This
//            tool never touches the Keychain. The price is one minimal haiku
//            turn (about a thousand input tokens with tools and MCP switched
//            off), which is why a reading from this source is reused for longer.
//
//         Claude Code does not persist the rolling-window snapshot anywhere
//         local — `~/.claude/stats-cache.json` is historical counts only — so
//         these are the only honest sources.
//
// grok    One agent-protocol round trip to a short-lived `grok agent stdio`:
//         `_x.ai/billing` (the account's weekly `creditUsagePercent` and when the
//         period ends — the TUI's /usage "Usage limit" tab) and
//         `_x.ai/auth/check_subscription` (is this a subscription sign-in at
//         all). No session, no model call. See grok.mjs: the auth half is not a
//         nicety, it is what keeps grok off pay-per-token API billing.
//
// All are cached on disk with a TTL so hundreds of dispatch decisions share one
// probe.

import { access, readFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';

import { CACHE_DIR, loadConfig } from './config.mjs';
import { GROK_METER_SOURCE, probeGrok } from './grok.mjs';
import {
  applyCommitted, freshProbe, inFlight, lastGoodReading, mutate, rememberGoodReading, snapshot,
} from './ledger.mjs';
import { providerPressure } from './pace.mjs';

export { CACHE_DIR };

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_TIMEOUT_MS = 5_000;

/** Stamped on a reading taken through the CLI, so its longer TTL can be told apart. */
export const CLAUDE_CLI_SOURCE = 'claude -p stream-json rate_limit_event';
const CLI_PROBE_TIMEOUT_MS = 60_000;
const PROBE_MODEL = 'claude-haiku-4-5-20251001';

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

async function readClaudeLimitsViaOAuth({ credentialsPath, fetchImpl, refresh = attemptTokenRefresh } = {}) {
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

// ── claude, second source: the CLI's own stream ───────────────────────────

/**
 * Pull the plan windows out of a `claude -p --output-format stream-json` run.
 *
 * Every turn carries one `rate_limit_event`. The last one on the stream is the
 * newest, so that is the one kept. `utilization` here is a FRACTION — 0.65 is
 * 65% — unlike the OAuth endpoint, which reports percentages. A value above 1
 * is therefore read as a percentage already, so a CLI that changes its mind
 * about the unit does not turn 65% into 6500% and get clamped to "exhausted".
 *
 * Only the two account-wide windows are read. The per-model weekly windows are
 * real, but they bind one model each, and folding them into `worstPercent`
 * would mark the whole provider spent because one model was.
 *
 * Returns null when the stream carries no usable event, which is what an older
 * CLI, an API-key login or a Bedrock/Vertex session produces: none of those
 * has plan windows to report.
 */
export function parseClaudeRateLimitEvents(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  let info = null;
  for (const line of stdout.split('\n')) {
    if (!line.includes('rate_limit_event')) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'rate_limit_event' && event.rate_limit_info && typeof event.rate_limit_info === 'object') {
        info = event.rate_limit_info;
      }
    } catch { /* a torn line is not a reading */ }
  }
  if (!info) return null;

  const toPercent = (utilization) => {
    const n = typeof utilization === 'number' ? utilization : Number(utilization);
    if (utilization == null || !Number.isFinite(n)) return null;
    return clampPercent(n <= 1 ? n * 100 : n);
  };
  const NAMES = { five_hour: ['5h', '5hr'], seven_day: ['weekly', 'Wkly'] };
  const windows = [];
  const unified = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {};
  for (const [field, [key, label]] of Object.entries(NAMES)) {
    const entry = unified[field];
    if (!entry || typeof entry !== 'object') continue;
    const percentUsed = toPercent(entry.utilization);
    if (percentUsed == null) continue;
    windows.push({ key, label, percentUsed, resetsAt: normalizeReset(entry.resetsAt) });
  }
  // Before `unifiedWindows` existed the event described a single window — the
  // one closest to its limit — at the top level. One window beats none.
  if (windows.length === 0 && NAMES[info.rateLimitType]) {
    const percentUsed = toPercent(info.utilization);
    if (percentUsed != null) {
      const [key, label] = NAMES[info.rateLimitType];
      windows.push({ key, label, percentUsed, resetsAt: normalizeReset(info.resetsAt) });
    }
  }
  if (windows.length === 0) return null;
  const hardBlocked = info.status === 'rejected' || windows.some((w) => w.percentUsed >= 100);
  return { windows, hardBlocked };
}

/** The words the claude CLI uses when its login has lapsed or never existed. */
export const CLAUDE_SIGNED_OUT_RE = /failed to authenticate|authentication[_ ]failed|not logged in|run \/login|(?:oauth )?(?:session|token) (?:has )?expired|invalid api key/i;

/**
 * Did a `claude -p` turn fail because the CLI is signed out?
 *
 * The CLI says so in its own output, not on stderr: a synthetic assistant
 * message carrying `"error": "authentication_failed"`, then a result with
 * `is_error: true` whose text is the reason —
 *
 *   {"type":"result","is_error":true,"total_cost_usd":0,
 *    "result":"Failed to authenticate: OAuth session expired and could not be refreshed"}
 *
 * — and it exits 1, having spent nothing. The terminal CLI keeps a login of
 * its own (the macOS Keychain), separate from the desktop app's, so it can
 * lapse while every app session keeps working. Before this was read, the meter
 * said only "the claude CLI reported no plan windows", which reads like an old
 * CLI rather than a lapsed login; headroom became "unknown", unknown routes
 * as usable, and every claude dispatch then failed on auth.
 *
 * Reads stream-json and json output alike. Returns the CLI's own words, or
 * null when the turn did not fail on auth.
 */
export function parseClaudeAuthFailure(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  let reason = null;
  for (const line of stdout.split('\n')) {
    if (!/authenticat|log ?in|expired|api key/i.test(line)) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === 'assistant' && event.error === 'authentication_failed') {
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      const text = content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join(' ').trim();
      reason = text || reason || 'authentication failed';
    } else if (event?.type === 'result' && event.is_error === true
      && CLAUDE_SIGNED_OUT_RE.test(String(event.result ?? ''))) {
      reason = String(event.result).trim();
    }
  }
  return reason;
}

/** A claude reading that says why it cannot run, and what fixes it. */
function claudeSignedOut(reason) {
  return {
    ...unavailable('claude', `the claude CLI is signed out (${reason}) — run \`claude\` in a terminal, then /login`),
    auth: { ok: false, method: 'none', reason: `the claude CLI is signed out: ${reason}` },
  };
}

/**
 * The smallest turn the CLI will run, and what it prints.
 *
 * Same shape as the token refresh above, plus the two flags that take the cost
 * from about 34,000 input tokens to about 1,000: `--tools ""` drops every tool
 * definition and `--strict-mcp-config` loads no MCP server. Stdin is closed
 * because the CLI otherwise waits three seconds for a pipe that never speaks.
 *
 * The exit code is ignored on purpose. A rate-limited account exits non-zero
 * and still prints the event — and that is the reading that matters most.
 */
async function runClaudeProbe({ lean = true } = {}) {
  const { spawn } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const args = [
    '-p', 'ok',
    '--model', PROBE_MODEL,
    '--system-prompt', 'Reply with the single word: ok',
    '--disable-slash-commands',
    '--no-session-persistence',
    ...(lean ? ['--tools', '', '--strict-mcp-config'] : []),
    '--output-format', 'stream-json',
    '--verbose',
  ];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('claude', args, { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, CLI_PROBE_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', () => { clearTimeout(timer); resolve(stdout); });
  });
}

/**
 * Read claude's windows by asking the CLI rather than the usage endpoint.
 *
 * Tries the lean turn first. An older CLI rejects the flags that make it lean,
 * prints nothing useful and exits; the plain turn costs more but runs anywhere
 * `claude -p` does, so it is the second attempt rather than the only one.
 */
export async function readClaudeLimitsViaCli({ probe = runClaudeProbe } = {}) {
  try {
    const lean = await probe({ lean: true });
    let parsed = parseClaudeRateLimitEvents(lean);
    if (!parsed) {
      // A lapsed login is not an old CLI: the plain turn would fail the same
      // way, so it is not run.
      const signedOut = parseClaudeAuthFailure(lean);
      if (signedOut) return claudeSignedOut(signedOut);
      const plain = await probe({ lean: false });
      parsed = parseClaudeRateLimitEvents(plain);
      if (!parsed) {
        const reason = parseClaudeAuthFailure(plain);
        if (reason) return claudeSignedOut(reason);
      }
    }
    if (!parsed) return unavailable('claude', 'the claude CLI reported no plan windows');
    return summarize('claude', parsed.windows, {
      hardBlocked: parsed.hardBlocked,
      source: CLAUDE_CLI_SOURCE,
    });
  } catch (err) {
    const message = err?.code === 'ENOENT' ? 'claude is not on PATH' : (err instanceof Error ? err.message : String(err));
    return unavailable('claude', message);
  }
}

/**
 * Claude's headroom, from whichever source can answer.
 *
 * The usage endpoint first, because it is free. The CLI second, because on a
 * Mac it is the only one that works. A caller that injects a credentials path
 * or a fetch is asking about the first source specifically — that is every
 * existing test — so the CLI is not consulted behind its back; pass `cli` to
 * exercise the fallback deliberately.
 *
 * When both fail the error names both, because "ENOENT …credentials.json" on
 * its own sends a Mac user looking for a file that will never exist.
 */
export async function readClaudeLimits({ credentialsPath, fetchImpl, refresh, cli } = {}) {
  const viaOAuth = await readClaudeLimitsViaOAuth({
    credentialsPath,
    fetchImpl,
    ...(refresh ? { refresh } : {}),
  });
  if (viaOAuth.available === true) return viaOAuth;

  const injected = credentialsPath !== undefined || fetchImpl !== undefined;
  const allowed = !injected && loadConfig().claudeCliProbe !== false;
  const readCli = cli ?? (allowed ? readClaudeLimitsViaCli : null);
  if (!readCli) return viaOAuth;

  const viaCli = await readCli();
  if (viaCli?.available === true) return viaCli;
  // A signed-out CLI is the answer that matters: claude cannot run at all, and
  // "ENOENT …credentials.json" in front of it would hide the remedy.
  if (viaCli?.auth?.ok === false) return viaCli;
  return unavailable('claude', `${viaOAuth.error}; and through the CLI: ${viaCli?.error ?? 'no reading'}`);
}

// ── grok ──────────────────────────────────────────────────────────────────

/**
 * Grok's headroom and, with it, whether grok may be used at all.
 *
 * Every reading carries `auth` — the verdict of grok.mjs on whether the CLI is
 * signed in to a subscription. Routing treats anything but `auth.ok` as a
 * provider that cannot run, which is what keeps a lapsed sign-in from quietly
 * falling through to API billing. The meter half fails soft like the others;
 * the auth half fails closed.
 */
export async function readGrokLimits({ probe } = {}) {
  const cfg = loadConfig();
  if (!probe && cfg.grokProbe === false) {
    return {
      ...unavailable('grok', 'grok probe disabled (CMO_GROK_PROBE=0)'),
      auth: { ok: false, method: 'unknown', reason: 'the grok probe is disabled, so its subscription sign-in is unverified' },
    };
  }
  const ask = probe ?? (() => probeGrok(cfg.grokBinary));
  try {
    const { auth, billing, errors = [] } = await ask();
    if (!billing) {
      return {
        ...unavailable('grok', errors.length ? `grok usage query failed: ${errors.join('; ')}` : 'grok reported no usage allowance'),
        auth,
        installed: true,
      };
    }
    return {
      ...summarize('grok', billing.windows, {
        hardBlocked: billing.windows.some((w) => w.percentUsed >= 100),
        plan: billing.plan,
        source: GROK_METER_SOURCE,
      }),
      auth,
      installed: true,
      unifiedBilling: billing.unifiedBilling ?? null,
      prepaidBalance: billing.prepaidBalance ?? null,
    };
  } catch (err) {
    const missing = err?.code === 'ENOENT';
    const message = missing ? 'grok is not on PATH' : (err instanceof Error ? err.message : String(err));
    return {
      ...unavailable('grok', message),
      auth: { ok: false, method: 'unknown', reason: missing ? 'the grok CLI is not installed' : `could not ask the grok CLI: ${message}` },
      ...(missing ? { installed: false } : {}),
    };
  }
}

/** Stand-in when a caller injected readers and did not mention grok: unverified, so unroutable. */
async function grokNotProbed() {
  return {
    ...unavailable('grok', 'not probed'),
    auth: { ok: false, method: 'unknown', reason: 'grok was not probed, so its subscription sign-in is unverified' },
  };
}

// ── shared state ──────────────────────────────────────────────────────────
//
// The cache lives in ledger.mjs because it is not this process's cache — it is
// the machine's. Several orchestrators read and write it, so it is locked,
// written atomically, and single-flighted: a hundred concurrent dispatches
// produce one probe, not a hundred.

function epochMs(t) {
  if (t == null || t === '') return null;
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * A meter that failed, without saying the vendor is signed out or missing,
 * stands on its last good reading for a while, marked `stale`. Otherwise one
 * flaky account query reads as "headroom unknown" and sends a vendor with most
 * of its week left to the back of the queue.
 *
 * Never across a reset (the old figure would then be wrong in the other
 * direction), never past `maxAgeMs`, and never over a sign-out or a missing
 * CLI: those are facts, not gaps. The fresh reading's `auth` always wins, so
 * grok's subscription check is never answered from the past.
 */
export async function holdLastGood(provider, value, { now = Date.now(), maxAgeMs = 30 * 60_000 } = {}) {
  if (value?.available === true) {
    if (!value.stale) await rememberGoodReading(provider, value, { now: () => now }).catch(() => {});
    return value;
  }
  if (!maxAgeMs || !value || value.auth?.ok === false || value.installed === false) return value;
  const last = await lastGoodReading(provider).catch(() => null);
  if (!last?.value || now - last.storedAt >= maxAgeMs || now < last.storedAt) return value;
  // A reading that carried a sign-in verdict (grok) stands in only on a fresh
  // verdict that affirms it: the past never vouches for today's sign-in.
  if (last.value.auth && value.auth?.ok !== true) return value;
  const resets = [last.value.nextResetAt, ...(last.value.windows ?? []).map((w) => w.resetsAt)]
    .map(epochMs).filter((t) => t != null);
  if (resets.some((t) => t <= now)) return value;
  return {
    ...last.value,
    ...(value.auth ? { auth: value.auth } : {}),
    stale: {
      since: new Date(last.storedAt).toISOString(),
      ageMs: now - last.storedAt,
      expiresAt: new Date(last.storedAt + maxAgeMs).toISOString(),
      error: value.error ?? null,
    },
  };
}

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
  // Injected readers are a test deciding what the probes say; one that does not
  // mention grok gets an unverified grok rather than a real CLI call.
  const readGrok = readers?.grok ?? (readers ? grokNotProbed : readGrokLimits);
  const holding = (provider, read) => async () => holdLastGood(provider, await read(), {
    now, maxAgeMs: cfg.freshness.lastGood ?? 0,
  });

  const [codexProbe, claudeProbe, grokProbe] = await Promise.all([
    freshProbe('codex', refresh ? -1 : cfg.freshness.codex, holding('codex', readCodex), { now: nowFn }),
    // A reading taken through the CLI cost a turn rather than a GET, so it is
    // reused for longer. Decided per entry: the same machine can hold either.
    freshProbe('claude', refresh ? -1 : (entry) => (
      entry?.value?.source === CLAUDE_CLI_SOURCE
        ? Math.max(cfg.freshness.claude, cfg.freshness.claudeCli ?? 0)
        : cfg.freshness.claude
    ), holding('claude', readClaude), { now: nowFn }),
    // A signed-out grok is re-asked sooner: `grok login` is the fix, and the
    // first dispatch after it should not wait out a minute of stale "no".
    freshProbe('grok', refresh ? -1 : (entry) => (
      entry?.value?.auth?.ok ? cfg.freshness.grok : (cfg.freshness.grokSignedOut ?? cfg.freshness.grok)
    ), holding('grok', readGrok), { now: nowFn }),
  ]);

  const state = await snapshot({ now: nowFn });
  const committed = (probe, provider) => (
    includeCommitted ? applyCommitted(probe.value, state, provider) : probe.value
  );
  const codex = committed(codexProbe, 'codex');
  const claude = committed(claudeProbe, 'claude');
  const grok = committed(grokProbe, 'grok');

  // Recorded on the reading itself so the routing decision can tell an absent
  // CLI from an unreadable meter. Injected readers (tests) are exempt: they are
  // deciding what the probe says, so PATH is not theirs to be judged by.
  if (!readers) {
    const grokBinary = cfg.grokBinary ?? 'grok';
    const [codexInstalled, claudeInstalled, grokInstalled] = await Promise.all([
      binaryOnPath('codex'), binaryOnPath('claude'),
      grokBinary.includes('/')
        ? access(grokBinary, constants.X_OK).then(() => true, () => false)
        : binaryOnPath(grokBinary),
    ]);
    if (codex && typeof codex === 'object') codex.installed = codexInstalled;
    if (claude && typeof claude === 'object') claude.installed = claudeInstalled;
    if (grok && typeof grok === 'object') grok.installed = grokInstalled;
  }

  // Pace-adjusted pressure, attached to the reading so a JSON consumer sees the
  // same figure routing uses. Computed here, at read time, and never persisted:
  // it depends on the clock, so a cached copy would be wrong a minute later.
  const withPressure = (reading) => {
    if (!reading || typeof reading !== 'object' || reading.available !== true) return reading;
    const pr = providerPressure(reading, { now, exhausted: cfg.pressure.exhausted });
    return {
      ...reading,
      pressurePercent: pr.percent,
      pressureWindow: pr.window,
      paceAware: pr.paceAware,
      pace: pr.windows,
    };
  };

  return {
    codex: withPressure(codex),
    claude: withPressure(claude),
    grok: withPressure(grok),
    cached: { codex: codexProbe.cached, claude: claudeProbe.cached, grok: grokProbe.cached },
    inFlight: {
      codex: inFlight(state, 'codex'),
      claude: inFlight(state, 'claude'),
      grok: inFlight(state, 'grok'),
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
 * endpoint — or, where there is no credentials file to read, one minimal turn
 * through the CLI — which is cheap enough to do after a dispatch and is the
 * only way claude can ever measure what one of its own agents costs.
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
 * The grok twin of `refreshClaudeLimits`: re-ask the agent protocol after a
 * dispatch, so grok can measure what one of its own agents costs. Throttled for
 * the same reason, since it starts the CLI.
 *
 * Stores a reading that answered, and also one whose sign-in has stopped being
 * a subscription — a lapse mid-run must stop the next grok dispatch, not the
 * one after the cache expires.
 */
export async function refreshGrokLimits({ now = Date.now(), minAgeMs = 0, read = readGrokLimits } = {}) {
  if (minAgeMs > 0) {
    const state = await snapshot({ now: () => now });
    const storedAt = state.probes?.grok?.storedAt;
    if (typeof storedAt === 'number' && now - storedAt < minAgeMs) return null;
  }
  const value = await read();
  if (value.available !== true && value.auth?.ok !== false) return null;
  if (value.available !== true && /probe disabled|not probed/.test(value.auth?.reason ?? '')) return null;
  await mutate((st) => {
    st.probes.grok = { storedAt: now, value };
  }, { now: () => now });
  return value;
}

/**
 * Record that grok must not be used: its session turned out not to be the
 * subscription. Shared, so every orchestrator on the machine stops at once.
 */
export async function markGrokUnverified(reason, { now = Date.now() } = {}) {
  await mutate((st) => {
    const previous = st.probes.grok?.value ?? unavailable('grok', reason);
    st.probes.grok = {
      storedAt: now,
      value: { ...previous, auth: { ok: false, method: 'api-key', reason } },
    };
  }, { now: () => now });
}

/**
 * Record that claude's CLI turned out to be signed out, as a dispatch just
 * found. Shared, so the next decision on this machine routes around claude
 * instead of finding out the same way. Not sticky: the next probe after the
 * claude TTL replaces it, so logging in fixes routing within a minute.
 */
export async function markClaudeSignedOut(reason, { now = Date.now() } = {}) {
  await mutate((st) => {
    st.probes.claude = { storedAt: now, value: claudeSignedOut(reason) };
  }, { now: () => now });
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
    // A stand-in's `stale` mark must not ride along: this is a fresh fact.
    const { stale: _stale, ...previous } = st.probes[provider]?.value ?? unavailable(provider, 'exhausted');
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
