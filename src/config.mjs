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

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_DIR = process.env.CMO_CONFIG_DIR
  ?? join(homedir(), '.config', 'cross-model-orchestrate');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
export const CACHE_DIR = process.env.CMO_CACHE_DIR
  ?? join(homedir(), '.cache', 'cross-model-orchestrate');

export const TIERS = ['fast', 'balanced', 'frontier'];

/**
 * Defaults as of codex-cli 0.149 and Claude Code 2.1.
 *
 * Claude Fable is deliberately absent from the tier map: Anthropic documents it
 * as substantially more consumption-intensive than Sonnet, so it is reachable
 * only through an explicit `--model fable`.
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
export const DEFAULT_FRESHNESS = {
  codex: 10_000, // a local file read — effectively free, so keep it tight
  claude: 45_000, // a network call, shared across every process on this machine
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
export const DEFAULT_RESERVATION = { default: 1.0, codex: 1.0, claude: 1.0 };

/** Headroom bands, in percent of a rolling window consumed. */
export const DEFAULT_PRESSURE = {
  tight: 65, // deprioritise this provider when the other is healthier
  critical: 85, // downgrade one tier to stretch what is left
  exhausted: 95, // not a candidate at all
};

export const DEFAULT_PREFERENCE = {
  // Which vendor wins a tie. The default is codex because the orchestrator is
  // itself usually a Claude session, so Claude's window is already being spent
  // by the run doing the dispatching. Set to "claude" if that is not true for
  // you — for example if you drive this from a shell script or cron.
  first: 'codex',
  // How much the preference is worth, in percentage points of headroom. At 100
  // the preferred vendor only loses once it is fully consumed relative to the
  // other; at 0 the emptier subscription always wins.
  weightPoints: 100,
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
  const out = { codex: {}, claude: {} };
  for (const provider of ['codex', 'claude']) {
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
    for (const provider of ['codex', 'claude']) {
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

let cached = null;

/** Resolved configuration: defaults, then the config file, then the env. */
export function loadConfig({ file = CONFIG_FILE, reload = false } = {}) {
  if (cached && !reload) return cached;
  const fromFile = readConfigFile(file);
  cached = {
    models: mergeModels(DEFAULT_MODELS, fromFile.models, envModelOverrides()),
    pressure: { ...DEFAULT_PRESSURE, ...(fromFile.pressure ?? {}) },
    freshness: { ...DEFAULT_FRESHNESS, ...(fromFile.freshness ?? {}) },
    reservation: { ...DEFAULT_RESERVATION, ...(fromFile.reservation ?? {}) },
    preference: {
      ...DEFAULT_PREFERENCE,
      ...(fromFile.preference ?? {}),
      ...(process.env.CMO_PREFER ? { first: process.env.CMO_PREFER } : {}),
    },
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
    configFile: file,
    configFileFound: Object.keys(fromFile).length > 0,
  };
  return cached;
}

export function resetConfigCache() {
  cached = null;
}
