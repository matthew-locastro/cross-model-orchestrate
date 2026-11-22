import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { readAudit } from '../src/audit.mjs';
import { resetConfigCache } from '../src/config.mjs';
import { snapshot } from '../src/ledger.mjs';
import { buildCommand, childEnv, runAgent } from '../src/run.mjs';

const AGY = {
  provider: 'antigravity',
  model: 'gemini-4-carbon',
  tier: 'balanced',
  effort: 'high',
  factors: { role: 'implement', needsRepoWrite: true },
  fallbacks: [],
};

const FAKE_AGY = `#!/bin/bash
set -eu
mkdir -p "$CMO_AGY_CAPTURE"
printf '%s' "$0" > "$CMO_AGY_CAPTURE/invoked"
printf '%s\\0' "$@" > "$CMO_AGY_CAPTURE/args"
tee "$CMO_AGY_CAPTURE/stdin" >/dev/null
for key in GEMINI_API_KEY GOOGLE_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY XAI_API_KEY; do
  if [[ -v $key ]]; then printf '%s=1\\n' "$key"; else printf '%s=0\\n' "$key"; fi
done > "$CMO_AGY_CAPTURE/keys"
previous=''
for value in "$@"; do
  if [[ "$previous" == '--json-schema' ]]; then cp "$value" "$CMO_AGY_CAPTURE/schema"; fi
  previous="$value"
done
success='{"conversation_id":"c1","status":"SUCCESS","response":"ok","duration_seconds":1,"num_turns":1,"usage":{"input_tokens":11,"output_tokens":7,"thinking_tokens":3,"cache_read_tokens":2,"total_tokens":23}}'
case "$CMO_AGY_SCENARIO" in
  schema)
    printf '%s' '{"conversation_id":"c1","status":"SUCCESS","response":"","structured_output":{"verdict":"approved"},"usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18}}'
    ;;
  schema-fallback)
    printf '%s' '{"status":"SUCCESS","response":"result: {\\"verdict\\":\\"fallback\\"}","structured_output":"not an object"}'
    ;;
  schema-invalid)
    printf '%s' '{"status":"SUCCESS","response":"[]","structured_output":[]}'
    ;;
  timeout)
    printf '%s' '{"status":"ERROR","response":"","error":"print timeout","finished_reason":"print_timeout"}'
    printf '%s\\n' 'AGY_ERROR: {"status":"DEADLINE_EXCEEDED","reason":"print_timeout"}' >&2
    exit 3
    ;;
  quota)
    printf '%s' '{"status":"ERROR","response":"","error":"RESOURCE_EXHAUSTED: quota exhausted"}'
    printf '%s\\n' 'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","reason":"quota"}' >&2
    exit 1
    ;;
  auth)
    printf '%s' '{"status":"ERROR","response":"","error":"authentication failed; run login"}'
    printf '%s\\n' 'OAuth login required' >&2
    exit 1
    ;;
  structured-auth-conflict)
    printf '%s' '{"status":"ERROR","response":"","error":"agent stopped"}'
    printf '%s\\n' 'quota rate-limit' >&2
    printf '%s\\n' 'AGY_ERROR: {"status":"ERROR","reason":"login_required"}' >&2
    exit 1
    ;;
  success-noisy)
    printf '%s' "$success"
    printf '%s\\n' 'docs: npm run login; auth, quota, rate-limit, and print_timeout are examples' >&2
    ;;
  status-error)
    printf '%s' '{"status":"ERROR","response":"partial answer","error":"agent stopped"}'
    ;;
  soft-deny)
    printf '%s' "$success"
    printf '%s\\n' 'Tool call soft-denied: approval unavailable in headless mode' >&2
    ;;
  long)
    printf '%s\\n' '{"event":"init","init":{"model":"gemini-4-carbon"}}'
    printf '%s\\n' '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"ok","duration_seconds":1,"num_turns":1,"usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18}}}'
    ;;
  *) printf '%s' "$success" ;;
esac
`;

async function withFakeAgy(scenario, body) {
  const dir = await mkdtemp(join(tmpdir(), 'cmo-fake-agy-'));
  const agy = join(dir, 'agy');
  const claude = join(dir, 'claude');
  const capture = join(dir, 'capture');
  await writeFile(agy, FAKE_AGY, 'utf8');
  await writeFile(claude, FAKE_AGY, 'utf8'); // red-run guard: never launch the real fallback branch
  await Promise.all([chmod(agy, 0o755), chmod(claude, 0o755)]);
  const saved = Object.fromEntries([
    'CMO_AGY_BIN', 'CMO_AGY_CAPTURE', 'CMO_AGY_SCENARIO', 'PATH',
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY',
  ].map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    CMO_AGY_BIN: agy,
    CMO_AGY_CAPTURE: capture,
    CMO_AGY_SCENARIO: scenario,
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    GEMINI_API_KEY: 'secret',
    GOOGLE_API_KEY: 'secret',
    OPENAI_API_KEY: 'secret',
    ANTHROPIC_API_KEY: 'secret',
    XAI_API_KEY: 'secret',
  });
  resetConfigCache();
  try {
    const value = await body();
    const keyText = await readFile(join(capture, 'keys'), 'utf8');
    const captured = {
      invokedAs: await readFile(join(capture, 'invoked'), 'utf8'),
      args: (await readFile(join(capture, 'args'), 'utf8')).split('\0').filter(Boolean),
      stdin: await readFile(join(capture, 'stdin'), 'utf8'),
      schema: await readFile(join(capture, 'schema'), 'utf8').catch(() => null),
      keys: Object.fromEntries(keyText.trim().split('\n').map((line) => {
        const [key, present] = line.split('=');
        return [key, present === '1'];
      })),
    };
    return { value, captured };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigCache();
    await rm(dir, { recursive: true, force: true });
  }
}

test('short antigravity runs use agy -p with explicit Gemini, effort, hard ceiling and write permission', async () => {
  const { value: out, captured } = await withFakeAgy('success', () => runAgent(AGY, 'do the task', {
    timeoutMs: 30_000, maxMs: 120_000, maxAttempts: 1, failover: false,
  }));
  assert.equal(out.ok, true, JSON.stringify({ out, captured }));
  assert.equal(out.provider, 'antigravity');
  assert.equal(out.result, 'ok');
  assert.equal(basename(captured.invokedAs), 'agy');
  assert.deepEqual(captured.args, [
    '-p', 'do the task',
    '--output-format', 'json',
    '--model', 'gemini-4-carbon',
    '--effort', 'high',
    '--disable-slash-commands',
    '--print-timeout', '120s',
    '--dangerously-skip-permissions',
  ]);
  assert.equal(captured.stdin, '');
  assert.deepEqual(captured.keys, {
    GEMINI_API_KEY: false,
    GOOGLE_API_KEY: false,
    OPENAI_API_KEY: false,
    ANTHROPIC_API_KEY: false,
    XAI_API_KEY: false,
  });
  const receipt = (await readAudit()).find((row) => row.id === out.dispatchId);
  assert.equal(receipt.provider, 'antigravity');
  assert.deepEqual(receipt.tokens, { in: 11, out: 7 });
});

test('read-only roles never bypass permissions, while mechanical write work does', () => {
  for (const role of ['review', 'judge', 'research', 'synthesis', 'architecture']) {
    const { args } = buildCommand(
      { ...AGY, factors: { role, needsRepoWrite: true } },
      { cwd: '/repo', prompt: 'inspect', timeoutMs: 15_000 },
    );
    assert.ok(!args.includes('--dangerously-skip-permissions'), role);
  }
  const { args } = buildCommand(
    { ...AGY, factors: { role: 'mechanical', needsRepoWrite: true } },
    { cwd: '/repo', prompt: 'rename', timeoutMs: 15_000 },
  );
  assert.ok(args.includes('--dangerously-skip-permissions'));
});

test('schemas use the original schema file and structured_output object', async () => {
  const schema = { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string' } } };
  const { value: out, captured } = await withFakeAgy('schema', () => runAgent(AGY, 'judge it', {
    timeoutMs: 30_000, maxAttempts: 1, failover: false, schema,
  }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.resultJson, { verdict: 'approved' });
  assert.ok(captured.args.includes('--json-schema'));
  assert.deepEqual(JSON.parse(captured.schema), schema);
  assert.equal(captured.args[captured.args.indexOf('-p') + 1], 'judge it');
  assert.ok(!captured.args.join(' ').includes('RETURN FORMAT'));
});

test('schemas fall back to response JSON but still require an object', async () => {
  const schema = { type: 'object' };
  const fallback = await withFakeAgy('schema-fallback', () => runAgent(AGY, 'judge it', {
    timeoutMs: 30_000, maxAttempts: 1, failover: false, schema,
  }));
  assert.equal(fallback.value.ok, true);
  assert.deepEqual(fallback.value.resultJson, { verdict: 'fallback' });

  const invalid = await withFakeAgy('schema-invalid', () => runAgent(AGY, 'judge it', {
    timeoutMs: 30_000, maxAttempts: 1, failover: false, schema,
  }));
  assert.equal(invalid.value.ok, false);
  assert.equal(invalid.value.attempts[0].failure, 'schema-violation');
});

test('print_timeout is a timeout and RESOURCE_EXHAUSTED marks antigravity exhausted', async () => {
  const timed = await withFakeAgy('timeout', () => runAgent(AGY, 'wait', {
    timeoutMs: 30_000, maxAttempts: 1, failover: false,
  }));
  assert.equal(timed.value.ok, false);
  assert.equal(timed.value.attempts[0].failure, 'timeout');

  const quota = await withFakeAgy('quota', () => runAgent(AGY, 'spend', {
    timeoutMs: 30_000, maxAttempts: 1, failover: false,
  }));
  assert.equal(quota.value.ok, false);
  assert.equal(quota.value.attempts[0].failure, 'rate-limit');
  assert.equal((await snapshot()).probes.antigravity.value.hardBlocked, true);
});

test('auth failures are signed-out and exit zero with non-SUCCESS status still fails', async () => {
  const auth = await withFakeAgy('auth', () => runAgent(AGY, 'sign in', {
    timeoutMs: 30_000, maxAttempts: 1, failover: false,
  }));
  assert.equal(auth.value.ok, false);
  assert.equal(auth.value.attempts[0].failure, 'signed-out');

  const badStatus = await withFakeAgy('status-error', () => runAgent(AGY, 'stop', {
    timeoutMs: 30_000, maxAttempts: 1, failover: false,
  }));
  assert.equal(badStatus.value.ok, false);
  assert.equal(badStatus.value.attempts[0].failure, 'fatal');
});

test('structured AGY_ERROR classification wins over conflicting stderr text', async () => {
  const auth = await withFakeAgy('structured-auth-conflict', () => runAgent(AGY, 'sign in', {
    timeoutMs: 30_000, maxAttempts: 1, failover: false,
  }));
  assert.equal(auth.value.ok, false);
  assert.equal(auth.value.attempts[0].failure, 'signed-out');
});

test('SUCCESS envelopes ignore failure words in stderr', async () => {
  const { value: out } = await withFakeAgy('success-noisy', () => runAgent(AGY, 'inspect', {
    timeoutMs: 30_000, maxAttempts: 1, failover: false,
  }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.result, 'ok');
});

test('soft-deny stderr is retained as a receipt warning without discarding success', async () => {
  const { value: out } = await withFakeAgy('soft-deny', () => runAgent(AGY, 'inspect', {
    timeoutMs: 30_000, maxAttempts: 1, failover: false,
  }));
  assert.equal(out.ok, true, JSON.stringify(out));
  const receipt = (await readAudit()).find((row) => row.id === out.dispatchId);
  assert.match(receipt.warnings[0], /soft-denied/);
});

test('prompts over 100,000 bytes use one stream-json user line and the final result event', async () => {
  const prompt = 'x'.repeat(100_001);
  const { value: out, captured } = await withFakeAgy('long', () => runAgent(AGY, prompt, {
    timeoutMs: 30_000, maxAttempts: 1, failover: false,
  }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.result, 'ok');
  assert.ok(!captured.args.includes('-p'));
  assert.deepEqual(captured.args.slice(0, 4), ['--input-format', 'stream-json', '--output-format', 'stream-json']);
  assert.ok(captured.stdin.endsWith('\n'));
  assert.equal(captured.stdin.split('\n').length, 2, 'exactly one NDJSON line, then EOF');
  assert.deepEqual(JSON.parse(captured.stdin.trim()), { event: 'user', message: { content: prompt } });
});

test('non-Gemini Antigravity models are refused before spawn', async () => {
  let spawned = false;
  const out = await runAgent({ ...AGY, model: 'claude-sonnet-5-5' }, 'never send', {
    timeoutMs: 30_000,
    maxAttempts: 1,
    failover: false,
    spawnImpl: async () => { spawned = true; throw new Error('must not spawn'); },
  });
  assert.equal(spawned, false);
  assert.equal(out.ok, false);
  assert.equal(out.attempts[0].failure, 'invalid-model');
  assert.match(out.error, /Gemini model/);
});

test('childEnv scrubs every vendor API key used by agy', () => {
  const env = childEnv({
    GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'g', OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', XAI_API_KEY: 'x',
  });
  for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY']) {
    assert.ok(!Object.hasOwn(env, key), key);
  }
});
