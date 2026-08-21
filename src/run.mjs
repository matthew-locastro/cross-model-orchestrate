// run.mjs — the hardened subagent runner.
//
// This is the generalisation of the image-generation CLI: one command that a
// workflow can shell out to hundreds of times and trust to either return a
// result or fail loudly, never to sit there waiting for a keystroke.
//
// Hardening, in order of how much each one has cost us:
//
//   watchdog     Hard wall-clock timeout, SIGTERM then SIGKILL. The 91-minute
//                stall in the image run was one agent holding a parallel()
//                barrier while it waited for a confirmation prompt nobody was
//                awake to answer. Every invocation here is non-interactive and
//                every invocation dies on the clock.
//   stdin prompt Prompts go down stdin, never argv. Long prompts blow argv
//                limits and shell-quoting bugs corrupt them silently.
//   retries      Bounded, classified, with exponential backoff and jitter.
//                A deterministic error is not retried; retrying it just burns
//                quota N times before failing anyway.
//   failover     An explicit rate-limit error switches vendor immediately
//                rather than sleeping — that is the whole point of running two
//                subscriptions.
//   harvest      Every `codex exec` writes a session rollout containing the
//                current rate-limit snapshot, so limits.mjs reads fresh codex
//                headroom off disk after every subagent — no extra probe, and
//                a run burning quota fast is visible within one agent rather
//                than one cache TTL.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { markExhausted, recordCodexRateLimits } from './limits.mjs';

export const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const KILL_GRACE_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

// ── failure classification ────────────────────────────────────────────────

const RATE_LIMIT_RE = /\b(rate[ _-]?limit|usage limit|quota exceeded|429|too many requests|out of (?:credits|usage)|limit reached)\b/i;
const TRANSIENT_RE = /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network error|stream (?:closed|error)|5\d\d\b|overloaded|temporarily unavailable|service unavailable)\b/i;
const AUTH_RE = /\b(unauthori[sz]ed|401|403|invalid[ _-]?api[ _-]?key|not logged in|please (?:run )?(?:codex )?login|token (?:has )?expired|re-?authenticate)\b/i;

/**
 * Decide what a failed attempt was. The classification drives everything: a
 * rate limit fails over, a transient error backs off, and anything else fails
 * fast so a broken prompt does not cost three runs of the same mistake.
 */
export function classifyFailure({ code, signal, timedOut, stderr = '', stdout = '' }) {
  if (timedOut) return 'timeout';
  const text = `${stderr}\n${stdout}`;
  if (RATE_LIMIT_RE.test(text)) return 'rate-limit';
  if (AUTH_RE.test(text)) return 'auth';
  if (TRANSIENT_RE.test(text)) return 'transient';
  if (signal) return 'transient';
  if (code === 0) return 'none';
  return 'fatal';
}

export function backoffMs(attempt, { base = 2_000, random = Math.random } = {}) {
  const raw = base * 2 ** attempt;
  const jitter = raw * 0.25 * random();
  return Math.min(MAX_BACKOFF_MS, Math.round(raw + jitter));
}

// ── command construction ──────────────────────────────────────────────────

/**
 * Build the argv for one provider. Exported so the tests can assert the exact
 * flags without spawning anything — the non-interactive flags in here are load
 * bearing and must not drift.
 */
export function buildCommand(decision, opts) {
  const {
    cwd,
    lastMessageFile,
    schemaFile = null,
    fullAccess = false,
    sandbox = 'workspace-write',
    allowedTools = null,
  } = opts;

  if (decision.provider === 'codex') {
    const args = [
      'exec',
      '--json', // JSONL events on stdout — also our rate-limit harvest
      '--color', 'never',
      '--skip-git-repo-check',
      '--cd', cwd,
      '--model', decision.model,
      '--output-last-message', lastMessageFile,
    ];
    if (decision.reasoning) {
      args.push('-c', `model_reasoning_effort=${decision.reasoning}`);
    }
    if (schemaFile) args.push('--output-schema', schemaFile);
    if (fullAccess) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('--sandbox', sandbox);
    }
    args.push('-'); // read the prompt from stdin
    return { binary: 'codex', args };
  }

  const args = [
    '-p',
    '--output-format', 'json',
    '--model', decision.model,
  ];
  if (decision.effort) args.push('--effort', decision.effort);
  if (allowedTools) args.push('--allowed-tools', allowedTools);
  // Headless: there is nobody to approve a tool call, so a permission prompt is
  // a guaranteed hang. Either the agent runs unattended or it must not run.
  args.push('--dangerously-skip-permissions');
  if (cwd) args.push('--add-dir', cwd);
  return { binary: 'claude', args };
}

/**
 * Child env. Stripping the API keys is deliberate: with a key present the CLI
 * bills the API account instead of consuming the subscription this whole
 * dispatcher exists to balance.
 */
export function childEnv(base = process.env) {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_API_KEY;
  delete env.OPENAI_API_KEY;
  env.CI = env.CI ?? '1'; // suppress spinners/TTY affordances
  return env;
}

// ── process execution ─────────────────────────────────────────────────────

function spawnWithTimeout({ binary, args, cwd, prompt, timeoutMs, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: null, signal: null, timedOut: false, stdout: '', stderr: String(err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, KILL_GRACE_MS).unref?.();
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ code: null, signal: null, timedOut, stdout, stderr: `${stderr}\n${err.message}` });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ code, signal, timedOut, stdout, stderr });
    });

    // Close stdin immediately after the prompt. An agent that then asks for
    // input gets EOF instead of blocking forever.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// ── output parsing ────────────────────────────────────────────────────────

/**
 * Pull token usage (and, where present, a rate-limit snapshot) out of a codex
 * JSONL stream.
 *
 * Two schemas are in play and they are NOT the same. `codex exec --json` emits
 * the thread/turn schema — `thread.started`, `item.completed`, and a final
 * `turn.completed` carrying `usage`. It does NOT carry rate limits. The session
 * ROLLOUT file uses the older `event_msg`/`token_count` schema and that is where
 * `rate_limits` lives; `codex exec` writes one of those per run, so limits.mjs
 * picks up fresh headroom from every codex subagent without us doing anything.
 * The rate-limit branch below stays for the builds that do inline it.
 */
export function parseCodexStream(stdout) {
  let rateLimits = null;
  let usage = null;
  for (const line of stdout.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = event.payload ?? event.msg ?? event;
    if (payload?.rate_limits) rateLimits = payload.rate_limits;
    if (event?.type === 'turn.completed' && event.usage) usage = event.usage;
    else if (payload?.info?.total_token_usage) usage = payload.info.total_token_usage;
    else if (payload?.type === 'token_count' && payload.info) usage = payload.info;
  }
  return { rateLimits, usage };
}

/** `claude -p --output-format json` returns one envelope; be liberal about it. */
export function parseClaudeStdout(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: '', usage: null };
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.result === 'string') {
      return { text: parsed.result, usage: parsed.usage ?? null, cost: parsed.total_cost_usd ?? null };
    }
    if (typeof parsed === 'string') return { text: parsed, usage: null };
  } catch {
    // Not JSON — some versions/flags stream plain text. Use it as-is.
  }
  return { text: trimmed, usage: null };
}

/**
 * Recover the JSON object from an agent's final message. Codex honours
 * --output-schema so this is usually already clean; Claude is held to the same
 * contract by prompt, and sometimes wraps it in a fence or a sentence.
 */
export function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const direct = tryParse(text.trim());
  if (direct !== undefined) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  // Last resort: the widest balanced {...} or [...] span in the message.
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) {
      const parsed = tryParse(text.slice(start, end + 1));
      if (parsed !== undefined) return parsed;
    }
  }
  return null;
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * When a schema is requested, Claude gets the contract in the prompt because it
 * has no --output-schema flag. Codex gets both: the flag enforces it and the
 * sentence stops it narrating around the object.
 */
export function schemaContract(schema) {
  return [
    '',
    '---',
    'RETURN FORMAT (hard requirement): your final message must be exactly one JSON',
    'object matching this schema, with no prose, no explanation and no code fence',
    'around it. Any commentary you want to make belongs inside the object.',
    '',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}

// ── the runner ────────────────────────────────────────────────────────────

/**
 * Run one subagent task, with retries and cross-vendor failover.
 *
 * @param {object} decision  from policy.decide()
 * @param {string} prompt
 * @param {object} opts
 *   cwd, timeoutMs, maxAttempts, schema, failover, fullAccess, sandbox,
 *   allowedTools, sleep (injectable for tests), spawnImpl (injectable)
 * @returns {Promise<object>} the result envelope
 */
export async function runAgent(decision, prompt, opts = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = 3,
    schema = null,
    failover = true,
    fullAccess = false,
    sandbox = 'workspace-write',
    allowedTools = null,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    spawnImpl = spawnWithTimeout,
    now = () => Date.now(),
  } = opts;

  const startedAt = now();
  const attempts = [];
  const workdir = await mkdtemp(join(tmpdir(), 'cmo-'));
  const lastMessageFile = join(workdir, 'last-message.txt');
  let schemaFile = null;
  if (schema) {
    schemaFile = join(workdir, 'schema.json');
    await writeFile(schemaFile, JSON.stringify(schema), 'utf8');
  }

  const fullPrompt = schema ? `${prompt}\n${schemaContract(schema)}` : prompt;

  // The dispatch ladder: primary first, then the other vendor if the policy
  // gave us one. This is "codex first, claude when codex is unavailable".
  const ladder = [decision, ...(failover && decision.fallback ? [decision.fallback] : [])];

  let lastError = null;

  try {
    for (let rung = 0; rung < ladder.length; rung += 1) {
      const target = ladder[rung];
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        // Never let a previous attempt's final message be read as this one's.
        await rm(lastMessageFile, { force: true }).catch(() => {});

        const { binary, args } = buildCommand(target, {
          cwd,
          lastMessageFile,
          schemaFile: target.provider === 'codex' ? schemaFile : null,
          fullAccess,
          sandbox,
          allowedTools,
        });

        const result = await spawnImpl({
          binary,
          args,
          cwd,
          prompt: fullPrompt,
          timeoutMs,
          env: childEnv(),
        });

        let text = '';
        let usage = null;

        if (target.provider === 'codex') {
          const stream = parseCodexStream(result.stdout);
          usage = stream.usage;
          if (stream.rateLimits) {
            // Free headroom refresh — every codex agent updates the cache.
            await recordCodexRateLimits(stream.rateLimits).catch(() => {});
          }
          try {
            text = (await readFile(lastMessageFile, 'utf8')).trim();
          } catch {
            text = '';
          }
        } else {
          const parsed = parseClaudeStdout(result.stdout);
          text = parsed.text;
          usage = parsed.usage;
        }

        const failure = classifyFailure(result);
        const succeeded = failure === 'none' && text.length > 0;

        attempts.push({
          provider: target.provider,
          model: target.model,
          attempt: attempt + 1,
          exitCode: result.code,
          timedOut: result.timedOut,
          failure: succeeded ? null : failure === 'none' ? 'empty-output' : failure,
          stderr: succeeded ? undefined : result.stderr.slice(-2_000),
        });

        if (succeeded) {
          const resultJson = schema ? extractJson(text) : null;
          if (schema && resultJson == null) {
            // A schema violation is a real failure: the script branches on this
            // object, and a run that mis-reads a "no" as a "yes" is worse than a
            // run that stops.
            attempts[attempts.length - 1].failure = 'schema-violation';
            lastError = 'agent returned no parseable JSON despite a schema contract';
            if (attempt + 1 < maxAttempts) {
              await sleep(backoffMs(attempt));
              continue;
            }
            break;
          }
          return {
            ok: true,
            provider: target.provider,
            model: target.model,
            tier: target.tier,
            ...(target.effort ? { effort: target.effort } : {}),
            ...(target.reasoning ? { reasoning: target.reasoning } : {}),
            failedOver: rung > 0,
            attempts,
            durationMs: now() - startedAt,
            usage,
            result: text,
            resultJson,
          };
        }

        lastError = result.stderr.slice(-2_000) || `exit ${result.code}`;

        if (failure === 'rate-limit') {
          // Do not sleep out a rate limit when the other vendor is idle.
          await markExhausted(target.provider).catch(() => {});
          break;
        }
        if (failure === 'auth' || failure === 'fatal') break;
        if (attempt + 1 < maxAttempts) await sleep(backoffMs(attempt));
      }
    }

    return {
      ok: false,
      provider: decision.provider,
      model: decision.model,
      attempts,
      durationMs: now() - startedAt,
      error: lastError ?? 'all providers failed',
    };
  } finally {
    // 253 agents leaving a temp dir each is how a box runs out of inodes.
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
