// grok.mjs — xAI's Grok Build CLI as a provider, on the subscription and nothing else.
//
// Grok is the third vendor. It is worth having for two reasons the other two
// cannot cover: it is a separate weekly allowance (SuperGrok), and it runs
// unsandboxed on this machine with live web search and fetch, so it can open a
// URL and look — which Codex's network-less sandbox cannot, and quietly guesses
// at instead.
//
// The hard constraint is billing. The CLI authenticates three ways, in this
// order (docs/user-guide/02-authentication.md, "Auth Precedence"):
//
//   1. a per-model `api_key` / `env_key` in ~/.grok/config.toml
//   2. the session token from `grok login` (OAuth via auth.x.ai — the subscription)
//   3. XAI_API_KEY (or the legacy GROK_CODE_XAI_API_KEY) — pay-per-token API spend
//
// and falls through to 3 whenever 2 is missing. A dispatcher that simply ran
// `grok -p` would therefore bill the API the first time the sign-in lapsed, and
// nothing in its output would say so. cmo closes that path four times over:
//
//   env      every child is started with both key variables removed and
//            GROK_DISABLE_API_KEY_AUTH=1, which makes the CLI refuse key auth
//            outright. Verified: with a key in the env and the lock set, a
//            headless run fails "Not signed in" instead of using the key.
//   preflight before routing, cmo asks the CLI's own agent protocol whether the
//            session is a subscription sign-in (`_x.ai/auth/check_subscription`:
//            authenticated, auth_mode Oidc, a subscription tier). No inference.
//            Anything else — signed out, a key, an unknown mode — makes grok
//            unroutable, with the reason, until `grok login` fixes it.
//   in-flight the dispatch's own stream opens with an init line naming how the
//            session authenticated (`apiKeySource`: "oauth" or "user" for a
//            key). A session that started on anything but oauth is killed on
//            that line, before its first response is billed in full.
//   receipt  every grok receipt records the source it saw, so `cmo audit` can
//            show that each grok dispatch was verified as subscription-billed.
//
// cmo never reads, stores or sets a key. It reads ~/.grok/auth.json not at all:
// everything comes from the CLI, which already knows how to authenticate.
//
// The meter is the same agent-protocol call the TUI's /usage "Usage limit" tab
// makes: `_x.ai/billing` returns the account's weekly `creditUsagePercent` and
// the period it resets at. `isUnifiedBillingUser: true` means that allowance is
// shared with the Grok apps — the CLI and the app draw on one weekly pool.

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

/** Environment variables the grok CLI will bill an API key from. Never passed on. */
export const GROK_KEY_VARS = ['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY'];

/** Stamped on a reading taken through the agent protocol. */
export const GROK_METER_SOURCE = 'grok agent stdio _x.ai/billing';

// Measured at 6–18s for the pair on a busy machine: the agent loads skills and
// project context before it answers. Generous, so a slow answer is not misread
// as an unverified sign-in.
const PROBE_TIMEOUT_MS = 45_000;
const RPC = {
  billing: '_x.ai/billing',
  subscription: '_x.ai/auth/check_subscription',
};

/**
 * The environment any grok process gets from cmo: no key to fall back to, and
 * the CLI told to refuse key auth even if one were found some other way.
 * Returns a copy; the caller's env is never modified.
 */
export function lockGrokEnv(base = process.env) {
  const env = { ...base };
  for (const name of GROK_KEY_VARS) delete env[name];
  env.GROK_DISABLE_API_KEY_AUTH = '1';
  // A self-update mid-fan-out would swap the binary under running dispatches.
  env.GROK_DISABLE_AUTOUPDATER = '1';
  return env;
}

// ── auth ──────────────────────────────────────────────────────────────────

/**
 * Judge a `_x.ai/auth/check_subscription` result. Fails closed: only a signed-in
 * OIDC/OAuth session with a subscription tier and no backend billing passes.
 *
 * The account's email comes back in `meta` and is deliberately not copied: it
 * would end up in the shared ledger and in every `cmo limits` JSON dump.
 */
export function grokAuthFrom(check) {
  if (!check || typeof check !== 'object') {
    return { ok: false, method: 'unknown', reason: 'the grok CLI did not answer the subscription check' };
  }
  if (check.authenticated !== true) {
    return { ok: false, method: 'none', reason: 'grok is not signed in — run `grok login` (browser OAuth)' };
  }
  const meta = check.meta && typeof check.meta === 'object' ? check.meta : {};
  const authMode = typeof meta.auth_mode === 'string' ? meta.auth_mode : null;
  const tier = typeof meta.subscription_tier === 'string' && meta.subscription_tier ? meta.subscription_tier : null;
  const facts = {
    authMode,
    tier,
    backendBilled: typeof meta.backend_billed === 'boolean' ? meta.backend_billed : null,
  };
  if (authMode && /key|deploy/i.test(authMode)) {
    return { ok: false, method: 'api-key', ...facts, reason: `grok is authenticated with ${authMode}, which bills the API — run \`grok login\`` };
  }
  if (!authMode || !/^(oidc|oauth2?)$/i.test(authMode)) {
    return { ok: false, method: 'unknown', ...facts, reason: `grok auth mode "${authMode ?? 'none'}" is not a recognised subscription sign-in` };
  }
  // Only an explicit `false` passes: an absent field is not evidence.
  if (meta.backend_billed !== false) {
    return { ok: false, method: 'oauth', ...facts, reason: 'the grok session did not confirm subscription billing (backend_billed is not false)' };
  }
  if (!tier) {
    return { ok: false, method: 'oauth', ...facts, reason: 'grok is signed in but the account reports no subscription tier' };
  }
  return { ok: true, method: 'oauth', ...facts };
}

/**
 * The status line `grok models` prints first. A fallback for when the agent
 * protocol cannot answer, and the doctor's cross-check of model ids.
 *
 *   You are logged in with grok.com.                 → oauth
 *   You are using XAI_API_KEY.                       → api-key
 *   You are authenticated via XAI_API_KEY (…)        → api-key
 *   Model 'x' is using its own API key.              → a per-model key (config.toml)
 *   You are authenticated via deployment key.        → api-key
 *   You are using a deprecated authentication method → web-login
 *   You are not authenticated.                       → none
 */
export function parseGrokModels(text) {
  const out = { method: 'unknown', status: null, modelKeys: [], models: [], defaultModel: null };
  if (typeof text !== 'string') return out;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const own = line.match(/^Model '(.*)' is using its own API key/);
    if (own) {
      out.modelKeys.push(own[1]);
      continue;
    }
    if (/^You are /.test(line) && !out.status) {
      out.status = line;
      if (/logged in with/i.test(line)) out.method = 'oauth';
      else if (/not authenticated/i.test(line)) out.method = 'none';
      else if (/XAI_API_KEY|deployment key|api key/i.test(line)) out.method = 'api-key';
      else if (/deprecated authentication/i.test(line)) out.method = 'web-login';
      continue;
    }
    const def = line.match(/^Default model:\s*(\S+)/);
    if (def) {
      out.defaultModel = def[1];
      continue;
    }
    const model = line.match(/^[*-]\s+(\S+)/);
    if (model) out.models.push(model[1]);
  }
  return out;
}

// ── the meter ─────────────────────────────────────────────────────────────

function clampPercent(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (value == null || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Turn a `_x.ai/billing` result into windows. The account has one allowance
 * with one period; its type names it, and when the type is missing the length
 * of the period does.
 */
export function grokWindowsFrom(billing) {
  const cfg = billing?.config;
  if (!cfg || typeof cfg !== 'object') return null;
  const percentUsed = clampPercent(cfg.creditUsagePercent);
  if (percentUsed == null) return null;
  const period = cfg.currentPeriod && typeof cfg.currentPeriod === 'object' ? cfg.currentPeriod : {};
  const start = Date.parse(period.start ?? cfg.billingPeriodStart ?? '');
  const end = Date.parse(period.end ?? cfg.billingPeriodEnd ?? '');
  const type = String(period.type ?? '');
  let key = 'window';
  let label = 'Window';
  if (/WEEK/i.test(type)) [key, label] = ['weekly', 'Wkly'];
  else if (/DAY|DAILY/i.test(type)) [key, label] = ['daily', 'Daily'];
  else if (/MONTH/i.test(type)) [key, label] = ['monthly', 'Mthly'];
  else if (Number.isFinite(start) && Number.isFinite(end)) {
    const minutes = (end - start) / 60_000;
    if (minutes <= 360) [key, label] = ['5h', '5hr'];
    else if (minutes <= 2880) [key, label] = ['daily', 'Daily'];
    else if (minutes <= 10_080 * 1.5) [key, label] = ['weekly', 'Wkly'];
    else [key, label] = ['monthly', 'Mthly'];
  }
  const prepaid = Number(cfg.prepaidBalance?.val);
  return {
    windows: [{
      key,
      label,
      percentUsed,
      resetsAt: Number.isFinite(end) ? new Date(end).toISOString() : null,
    }],
    plan: typeof billing.subscription_tier === 'string' ? billing.subscription_tier : null,
    unifiedBilling: cfg.isUnifiedBillingUser === true,
    prepaidBalance: Number.isFinite(prepaid) ? prepaid : null,
  };
}

/**
 * Ask a short-lived `grok agent stdio` a few questions over its JSON-RPC
 * protocol, then stop it. No session is created and no model is called: these
 * are the account queries the TUI makes to draw its own usage panel.
 *
 * Resolves `{ [method]: { result } | { error } }`. Rejects only when the CLI
 * cannot be started or never answers `initialize`.
 */
export function grokRpc(binary, methods, { timeoutMs = PROBE_TIMEOUT_MS, spawnImpl = spawn, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(binary, ['agent', '--no-leader', 'stdio'], {
        cwd: tmpdir(),
        env: lockGrokEnv(env),
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    const answers = {};
    const ids = new Map(methods.map((m, i) => [i + 2, m]));
    let buffer = '';
    let initialised = false;
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      if (err) reject(err);
      else resolve(answers);
    };
    const timer = setTimeout(() => {
      finish(initialised ? null : new Error(`grok agent did not answer within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const send = (id, method, params = {}) => {
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch { /* the close handler reports it */ }
    };

    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && !initialised) {
          initialised = true;
          if (msg.error) {
            finish(new Error(`grok agent refused initialize: ${msg.error.message ?? 'error'}`));
            return;
          }
          for (const [id, method] of ids) send(id, method);
          if (ids.size === 0) finish();
          continue;
        }
        const method = ids.get(msg.id);
        if (!method) continue;
        answers[method] = msg.error ? { error: msg.error.message ?? 'error' } : { result: msg.result };
        if (Object.keys(answers).length === ids.size) finish();
      }
    });
    child.stdin.on?.('error', () => {});
    child.on('error', (err) => finish(err));
    child.on('close', () => finish(initialised ? null : new Error('grok agent exited before answering')));

    send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  });
}

/**
 * One probe, both answers: is this a subscription sign-in, and how much of the
 * allowance is used. Returns `{ auth, billing }` — billing null when the
 * account query failed — or throws when the CLI is not there to ask.
 */
export async function probeGrok(binary, opts = {}) {
  const answers = await grokRpc(binary, [RPC.subscription, RPC.billing], opts);
  const sub = answers[RPC.subscription];
  const bill = answers[RPC.billing];
  return {
    auth: grokAuthFrom(sub?.result ?? null),
    billing: bill?.result ? grokWindowsFrom(bill.result) : null,
    errors: [sub?.error, bill?.error].filter(Boolean),
  };
}

// ── the dispatch stream ───────────────────────────────────────────────────

/**
 * Read a `grok --output-format streaming-messages-json` run.
 *
 * The init line says how the session authenticated; the terminal `result` line
 * carries the final answer, the usage, and any errors. The result line is the
 * contract: a run that never wrote one did not finish, whatever text streamed.
 */
export function parseGrokStream(stdout) {
  let init = null;
  let result = null;
  let errorEvent = null;
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line || line[0] !== '{') continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'system' && event.subtype === 'init' && !init) init = event;
    else if (event?.type === 'result') result = event;
    else if (event?.type === 'error') errorEvent = event;
  }
  const isError = Boolean(result && (result.is_error === true
    || (typeof result.subtype === 'string' && result.subtype !== 'success')));
  const errors = Array.isArray(result?.errors) ? result.errors.filter((e) => typeof e === 'string') : [];
  const error = errors.join('\n') || (typeof errorEvent?.message === 'string' ? errorEvent.message : '') || null;
  const text = !isError && typeof result?.result === 'string' ? result.result.trim() : '';
  return {
    text,
    usage: result?.usage ?? null,
    apiKeySource: typeof init?.apiKeySource === 'string' ? init.apiKeySource : null,
    model: typeof init?.model === 'string' ? init.model : null,
    isError,
    error,
    stopReason: result?.stop_reason ?? null,
    finished: Boolean(result),
  };
}

/**
 * Did this session start on anything but the subscription?
 *
 * Only a session that really started is judged: a failed start (signed out,
 * bad flag) still prints an init line, with model "unknown" and a placeholder
 * source, and that must read as the auth failure it is, not as API billing.
 */
export function startedOffSubscription({ apiKeySource, model }) {
  if (!apiKeySource || !model || model === 'unknown') return false;
  return apiKeySource !== 'oauth';
}

/**
 * The same judgement on a stream still arriving, so the dispatcher can kill a
 * key-billed session on its first line instead of after its last.
 */
export function offSubscriptionReason(partialStdout) {
  const s = String(partialStdout ?? '');
  const nl = s.indexOf('\n');
  if (nl === -1) return null; // the init line has not finished arriving
  for (const line of s.split('\n')) {
    if (!line.includes('"init"')) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'system' && event.subtype === 'init') {
        return startedOffSubscription(event)
          ? `grok session authenticated with "${event.apiKeySource}", not the subscription — killed`
          : null;
      }
    } catch { /* torn line: wait for more */ }
  }
  return null;
}
