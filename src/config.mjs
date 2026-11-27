// config.mjs — everything that differs between machines and accounts.
//
// Model IDs are the part of this tool most likely to be wrong on someone else's
// box: a Codex plan exposes a different model list, a Claude account may not
// have Opus, and both vendors rename things. So the tier→model map is data, and
// there are three ways to change it without editing code:
//
//   1. ~/.config/cross-model-orchestrate/config.json
//   2. CMO_CODEX_FRONTIER / CMO_CLAUDE_BALANCED / … environment variables
//   3. --model on a single call
//
// `cmo doctor` prints the resolved map and checks it against what the installed
// CLIs actually offer.

import { accessSync, constants, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import { DEFAULT_DURATION_FIT } from './durations.mjs';

export const CONFIG_DIR = process.env.CMO_CONFIG_DIR
  ?? join(homedir(), '.config', 'cross-model-orchestrate');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
export const CACHE_DIR = process.env.CMO_CACHE_DIR
  ?? join(homedir(), '.cache', 'cross-model-orchestrate');

export const TIERS = ['fast', 'balanced', 'frontier'];

/**
 * Every vendor cmo knows how to dispatch to, in tie-break order. This static
 * list is also used for parsing and reports. Routing uses activeProviders(), so
 * a known vendor can remain available without joining the default roster.
 */
export const PROVIDERS = ['codex', 'claude', 'antigravity', 'grok'];
const DEFAULT_ACTIVE_PROVIDERS = ['codex', 'claude', 'antigravity'];

/** Antigravity is pinned to Gemini so it remains an independent vendor. */
export const ANTIGRAVITY_MODEL_RE = /^gemini-[a-z0-9.-]+$/;

/**
 * Defaults as of codex-cli 0.149, Claude Code 2.1 and Grok Build 1.0.50.
 *
 * Claude Fable is deliberately absent from the tier map: Anthropic documents it
 * as substantially more consumption-intensive than Sonnet, so it is reachable
 * only through an explicit `--model fable`.
 *
 * Grok runs grok-4.7 on every tier and varies only the reasoning effort.
 * `grok-4.7-build-fast` is NOT the cheap tier: the CLI's own model list calls it
 * "Fast variant. 2x the price." — faster wall clock for double the allowance.
 */
export const DEFAULT_MODELS = {
  codex: {
    frontier: { model: 'gpt-5.6-sol', reasoning: 'high' },
    balanced: { model: 'gpt-5.6-terra', reasoning: 'medium' },
    fast: { model: 'gpt-5.6-luna', reasoning: 'low' },
  },
  claude: {
    frontier: { model: 'opus', effort: 'high' },
    balanced: { model: 'sonnet', effort: 'medium' },
    fast: { model: 'haiku', effort: 'low' },
  },
  // Provisional until outcome data confirms the tier ordering in practice.
  antigravity: {
    frontier: { model: 'gemini-4-neon', effort: 'xhigh' },
    balanced: { model: 'gemini-4-carbon', effort: 'high' },
    fast: { model: 'gemini-4-hydrogen', effort: 'low' },
  },
  grok: {
    frontier: { model: 'grok-4.7', effort: 'high' },
    balanced: { model: 'grok-4.7', effort: 'medium' },
    fast: { model: 'grok-4.7', effort: 'low' },
  },
};

/**
 * How stale a reading may be before a dispatch decision re-probes it.
 *
 * These are short on purpose. Subscriptions are contended: several
 * orchestrators on several projects drain the same two windows, so a reading
 * from five minutes ago describes a machine that no longer exists. The cache is
 * shared and single-flighted (see ledger.mjs), so a short TTL costs one probe
 * for the whole box, not one per dispatch.
 */
/**
 * When a running agent is stopped. Past its time budget (`--timeout`) an agent
 * that is still producing output keeps going: a long run that is making
 * progress is worth more than the clock. It is stopped only once it has been
 * silent for `idleMinutes` (never longer than the budget itself), or at the
 * `maxMinutes` ceiling. Within the budget nothing is stopped for silence.
 */
export const DEFAULT_WATCHDOG = {
  idleMinutes: 15,
  maxMinutes: 240,
};

export const DEFAULT_FRESHNESS = {
  codex: 10_000, // a local file read — effectively free, so keep it tight
  claude: 45_000, // a network call, shared across every process on this machine
  claudeCli: 120_000, // read through the CLI instead (macOS): a small turn, not a GET
  antigravity: 60_000, // a no-inference /usage request to the subscription backend
  grok: 60_000, // two RPCs to a short-lived `grok agent stdio` — no inference, ~3s
  grokSignedOut: 15_000, // a signed-out reading is re-checked soon: logging in fixes it
  // A meter that errors (xAI's usage query answers "Internal error" now and
  // then) falls back to the last good reading for this long, as long as no
  // window has reset since. Usage only grows within a window, so the stand-in
  // can only understate it, by what was spent in that time. 0 turns it off.
  lastGood: 30 * 60_000,
};

/**
 * Assumed cost of one in-flight agent, in percentage points of the provider's
 * worst window. Used to account for dispatches that have been committed but not
 * yet billed — the gap the vendor's own number cannot see.
 *
 * Deliberately conservative: overestimating makes a run stop early with its
 * work cached, underestimating makes it discover the limit by being killed.
 * Replaced by a measured median once there is enough evidence.
 */
export const DEFAULT_RESERVATION = {
  default: 1.0,
  codex: 1.0,
  claude: 1.0,
  antigravity: 1.0,
  grok: 1.0,
};

/** Headroom bands, in percent of a rolling window consumed. */
export const DEFAULT_PRESSURE = {
  tight: 65, // deprioritise this provider when the other is healthier
  critical: 85, // downgrade one tier to stretch what is left
  exhausted: 95, // not a candidate at all
};

export const DEFAULT_PREFERENCE = {
  // Tie-break only. Least-used headroom decides a dispatch; this picks a
  // winner when two usable providers are within a few points of each other.
  // Worth `weightPoints / 10` score points (default 2.5) — enough to settle a
  // near-tie, not enough to outweigh a real difference in pressure. The
  // default vendor is codex. Set `first`, or `CMO_PREFER`, to take the other
  // side of a tie. Claude's window is protected by `orchestrator`, not by this.
  first: 'codex',
  weightPoints: 25,
};

/**
 * How subscription pressure turns into score.
 *
 * Headroom is the dominant term: `headroomWeight` points at 0% pressure,
 * scaled linearly down to 0 at 100%. A power-use bonus lands on the one
 * usable provider whose pressure sits at least `powerGap` points below every
 * other provider that is actually competing for the dispatch. It is withheld
 * when any usable competitor's pressure is unknown.
 */
export const DEFAULT_ROUTING = {
  headroomWeight: 40,
  powerGap: 20,
  powerBonus: 25,
};

/**
 * The vendor driving the run. Spare it: every dispatch costs it `penalty`
 * points, and once its pressure reaches `reserveAt` it is a candidate only
 * when nothing else can run.
 *
 * `vendor: null` turns the reserve off — the right setting when a shell
 * script or cron drives cmo and no Claude session is spending the window.
 */
export const DEFAULT_ORCHESTRATOR = {
  vendor: 'claude',
  penalty: 30,
  reserveAt: 60,
};

/**
 * Per-machine Codex defaults. `fullAccess: false` keeps Codex in its default
 * `workspace-write` sandbox unless a machine opts in via `codex.fullAccess` or
 * `CMO_CODEX_FULL_ACCESS=1`, or a single dispatch passes `--full-access`.
 */
export const DEFAULT_CODEX = {
  fullAccess: false,
};

function envBoolean(value) {
  if (value === undefined) return undefined;
  const trimmed = String(value).trim();
  if (/^(1|true|yes|on)$/i.test(trimmed)) return true;
  if (/^(0|false|no|off)$/i.test(trimmed)) return false;
  return undefined;
}

const ISO_DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

function validCalendarDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * Parse an ISO 8601 expiry date or datetime into a canonical UTC ISO string.
 * A bare YYYY-MM-DD date means 00:00 UTC of that date (deliberately conservative).
 */
export function parseResetExpiry(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const dateOnly = trimmed.match(ISO_DATE_ONLY_RE);
  if (dateOnly) {
    const [, y, m, d] = dateOnly.map(Number);
    if (!validCalendarDate(y, m, d)) return null;
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0)).toISOString();
  }
  const dt = trimmed.match(ISO_DATETIME_RE);
  if (!dt) return null;
  const year = Number(dt[1]);
  const month = Number(dt[2]);
  const day = Number(dt[3]);
  const hour = Number(dt[4]);
  const minute = Number(dt[5]);
  const second = dt[6] !== undefined ? Number(dt[6]) : 0;
  if (!validCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  const tz = dt[7];
  const normalizedStr = /^[+-]\d{4}$/.test(tz)
    ? `${trimmed.slice(0, -5)}${tz.slice(0, 3)}:${tz.slice(3)}`
    : trimmed;
  const ms = Date.parse(normalizedStr);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Validate and normalize `config.resets.<provider>` lists, sorted earliest first. */
export function parseResetsConfig(raw, sourceLabel = 'config.json') {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${sourceLabel}: "resets" must be an object mapping provider names to expiry arrays`);
  }
  const out = {};
  for (const [provider, entries] of Object.entries(raw)) {
    if (!PROVIDERS.includes(provider)) {
      throw new Error(`${sourceLabel}: unknown provider "${provider}" in resets`);
    }
    if (!Array.isArray(entries)) {
      throw new Error(`${sourceLabel}: resets.${provider} must be an array of ISO 8601 dates or datetimes`);
    }
    const parsed = entries.map((entry) => {
      const iso = parseResetExpiry(entry);
      if (!iso) {
        throw new Error(`${sourceLabel}: invalid ISO 8601 reset expiry "${entry}" in resets.${provider}`);
      }
      return iso;
    });
    parsed.sort((a, b) => Date.parse(a) - Date.parse(b));
    if (parsed.length > 0) out[provider] = parsed;
  }
  return out;
}

/**
 * What a vendor is better placed to do than the others, in points of score.
 *
 * Web-capable vendors can open a URL and see what is there. Codex's sandbox has
 * no network, so research and link verification lean to Antigravity or Grok.
 * A tight window or a power-use gap on someone else still takes the work away.
 */
export const DEFAULT_AFFINITY = {
  grok: { roles: ['research'], web: true, points: 25 },
};

function readConfigFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    // A malformed config is worth shouting about — silently falling back to
    // defaults would route work to models the user thought they had changed.
    throw new Error(`${path}: ${err.message}`);
  }
}

function envModelOverrides() {
  const out = Object.fromEntries(PROVIDERS.map((p) => [p, {}]));
  for (const provider of PROVIDERS) {
    for (const tier of TIERS) {
      const value = process.env[`CMO_${provider.toUpperCase()}_${tier.toUpperCase()}`];
      if (value) out[provider][tier] = { model: value };
    }
  }
  return out;
}

function mergeModels(base, ...layers) {
  const out = structuredClone(base);
  for (const layer of layers) {
    for (const provider of PROVIDERS) {
      for (const tier of TIERS) {
        const patch = layer?.[provider]?.[tier];
        if (!patch) continue;
        out[provider][tier] = {
          ...out[provider][tier],
          ...(typeof patch === 'string' ? { model: patch } : patch),
        };
      }
    }
  }
  return out;
}

/** True when `path` is an executable file. */
function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where to find the grok CLI. Its installer puts it in `~/.grok/bin` and adds
 * that to PATH from `.zshrc` — an interactive-shell file, which an agent's or a
 * scheduled job's PATH often never reads. So PATH first, then the installer's
 * own location, then the bare name (which fails loudly as "not installed").
 */
export function resolveGrokBinary(env = process.env, home = homedir()) {
  if (env.CMO_GROK_BIN) return env.CMO_GROK_BIN;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && executable(join(dir, 'grok'))) return join(dir, 'grok');
  }
  const installed = join(env.GROK_HOME ?? join(home, '.grok'), 'bin', 'grok');
  return executable(installed) ? installed : 'grok';
}

/** Find Antigravity on PATH first, then in its user-local install location. */
export function resolveAgyBinary(env = process.env, home = homedir()) {
  if (env.CMO_AGY_BIN) return env.CMO_AGY_BIN;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && executable(join(dir, 'agy'))) return 'agy';
  }
  const installed = join(home, '.local', 'bin', 'agy');
  return executable(installed) ? installed : 'agy';
}

let cached = null;

/** Resolved configuration: defaults, then the config file, then the env. */
export function loadConfig({ file = CONFIG_FILE, reload = false } = {}) {
  if (cached && !reload) return cached;
  const fromFile = readConfigFile(file);
  cached = {
    providers: Array.isArray(fromFile.providers)
      ? fromFile.providers
      : [...DEFAULT_ACTIVE_PROVIDERS],
    models: mergeModels(DEFAULT_MODELS, fromFile.models, envModelOverrides()),
    pressure: { ...DEFAULT_PRESSURE, ...(fromFile.pressure ?? {}) },
    freshness: { ...DEFAULT_FRESHNESS, ...(fromFile.freshness ?? {}) },
    reservation: { ...DEFAULT_RESERVATION, ...(fromFile.reservation ?? {}) },
    affinity: { ...DEFAULT_AFFINITY, ...(fromFile.affinity ?? {}) },
    preference: {
      ...DEFAULT_PREFERENCE,
      ...(fromFile.preference ?? {}),
      ...(process.env.CMO_PREFER ? { first: process.env.CMO_PREFER } : {}),
    },
    routing: { ...DEFAULT_ROUTING, ...(fromFile.routing ?? {}) },
    // Move a vendor whose own receipts say it will not finish inside the
    // dispatch's timeout behind one that will (durations.mjs).
    durationFit: { ...DEFAULT_DURATION_FIT, ...(fromFile.durationFit ?? {}) },
    watchdog: { ...DEFAULT_WATCHDOG, ...(fromFile.watchdog ?? {}) },
    orchestrator: {
      ...DEFAULT_ORCHESTRATOR,
      ...(fromFile.orchestrator ?? {}),
    },
    codex: {
      ...DEFAULT_CODEX,
      ...(fromFile.codex && typeof fromFile.codex === 'object' ? fromFile.codex : {}),
      fullAccess: envBoolean(process.env.CMO_CODEX_FULL_ACCESS)
        ?? (fromFile.codex?.fullAccess === true),
    },
    resets: parseResetsConfig(fromFile.resets, file),
    /**
     * Fleet coordination. Set `url` + `token` and every box points at one
     * coordinator, so a run here can see the forty agents box B just launched.
     * Unset means single-box behaviour, which is also the fallback whenever the
     * coordinator cannot be reached.
     */
    fleet: {
      url: process.env.CMO_FLEET_URL ?? fromFile.fleet?.url ?? null,
      token: process.env.CMO_FLEET_TOKEN ?? fromFile.fleet?.token ?? null,
      nodeId: process.env.CMO_NODE_ID ?? fromFile.fleet?.nodeId ?? null,
    },
    // Where the two providers keep their state. Overridable mostly for tests.
    codexSessionsRoot: process.env.CMO_CODEX_SESSIONS
      ?? fromFile.codexSessionsRoot
      ?? join(homedir(), '.codex', 'sessions'),
    claudeCredentials: process.env.CMO_CLAUDE_CREDENTIALS
      ?? fromFile.claudeCredentials
      ?? join(homedir(), '.claude', '.credentials.json'),
    // Whether the claude meter may fall back to asking the CLI when there is no
    // credentials file to read (see limits.mjs). On by default, because on macOS
    // it is the only source there is. `CMO_CLAUDE_CLI_PROBE=0` turns it off:
    // the test suite does, so `npm test` never spends a real turn.
    claudeCliProbe: process.env.CMO_CLAUDE_CLI_PROBE !== undefined
      ? !/^(0|false|no|off)$/i.test(process.env.CMO_CLAUDE_CLI_PROBE)
      : fromFile.claudeCliProbe !== false,
    // The grok CLI, and whether its meter may be asked at all. The meter costs
    // no inference, but it does start the CLI; `CMO_GROK_PROBE=0` turns it off
    // (the test suite does), which leaves grok unverified and so unroutable.
    grokBinary: process.env.CMO_GROK_BIN ?? fromFile.grokBinary ?? resolveGrokBinary(),
    grokProbe: process.env.CMO_GROK_PROBE !== undefined
      ? !/^(0|false|no|off)$/i.test(process.env.CMO_GROK_PROBE)
      : fromFile.grokProbe !== false,
    // Antigravity's meter is free of inference but still starts the real CLI.
    agyBinary: process.env.CMO_AGY_BIN ?? fromFile.agyBinary ?? resolveAgyBinary(),
    agyProbe: process.env.CMO_AGY_PROBE !== undefined
      ? !/^(0|false|no|off)$/i.test(process.env.CMO_AGY_PROBE)
      : fromFile.agyProbe !== false,
    configFile: file,
    configFileFound: Object.keys(fromFile).length > 0,
  };
  return cached;
}

/** The known providers configured to participate in routing, in config order. */
export function activeProviders(config = loadConfig()) {
  const configured = Array.isArray(config?.providers)
    ? config.providers
    : DEFAULT_ACTIVE_PROVIDERS;
  return [...new Set(configured.filter((provider) => PROVIDERS.includes(provider)))];
}

/** Effective Codex full access: per-dispatch flag/header, else the machine setting. */
export function codexFullAccess(explicit = false, config = loadConfig()) {
  return explicit === true || config?.codex?.fullAccess === true;
}

export function resetConfigCache() {
  cached = null;
}
