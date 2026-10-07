import './isolate.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLAUDE_CLI_SOURCE, parseClaudeRateLimitEvents, readClaudeLimits, readClaudeLimitsViaCli, readLimits,
} from '../src/limits.mjs';

// The Claude OAuth token lives for hours, not days. When it lapses the usage
// endpoint stops answering, headroom reads as unknown, and unknown is treated
// as usable — so a blind meter fails toward over-dispatching. That happened on
// the first morning of the soak. These pin the repair path.

async function credentials({ expiresAt }) {
  const dir = await mkdtemp(join(tmpdir(), 'cmo-creds-'));
  const path = join(dir, '.credentials.json');
  await writeFile(path, JSON.stringify({
    claudeAiOauth: { accessToken: 'tok-live', expiresAt },
  }));
  return path;
}

const usageBody = {
  limits: [{ group: 'session', percent: 20, resets_at: '2030-01-01T00:00:00Z' }],
};

const okFetch = async () => ({ ok: true, json: async () => usageBody });

test('an expired token triggers exactly one refresh attempt, then re-reads', async () => {
  const path = await credentials({ expiresAt: Date.now() - 1000 });
  let attempts = 0;

  const refresh = async () => {
    attempts += 1;
    // What `claude auth status` does when it works: rewrites the file.
    await writeFile(path, JSON.stringify({
      claudeAiOauth: { accessToken: 'tok-fresh', expiresAt: Date.now() + 3_600_000 },
    }));
    return true;
  };

  const result = await readClaudeLimits({ credentialsPath: path, fetchImpl: okFetch, refresh });
  assert.equal(attempts, 1);
  assert.equal(result.available, true, 'the probe should succeed once the token is refreshed');
});

test('a live token never spawns a refresh', async () => {
  const path = await credentials({ expiresAt: Date.now() + 3_600_000 });
  let attempts = 0;
  const refresh = async () => { attempts += 1; return true; };

  const result = await readClaudeLimits({ credentialsPath: path, fetchImpl: okFetch, refresh });
  assert.equal(attempts, 0, 'refreshing a valid token would spawn a CLI on every probe');
  assert.equal(result.available, true);
});

test('a refresh that cannot run reports honestly rather than silently', async () => {
  const path = await credentials({ expiresAt: Date.now() - 1000 });
  const result = await readClaudeLimits({
    credentialsPath: path,
    fetchImpl: okFetch,
    refresh: async () => false, // no claude on PATH
  });
  assert.equal(result.available, false);
  assert.match(result.error, /auto-refresh could not run/);
});

test('a refresh that runs but does not take is distinguished from one that cannot run', async () => {
  const path = await credentials({ expiresAt: Date.now() - 1000 });
  const result = await readClaudeLimits({
    credentialsPath: path,
    fetchImpl: okFetch,
    refresh: async () => true, // claimed success, left the file expired
  });
  assert.equal(result.available, false);
  assert.match(result.error, /did not take/);
});

test('a missing credentials file is not treated as an expiry', async () => {
  let attempts = 0;
  const result = await readClaudeLimits({
    credentialsPath: join(tmpdir(), 'cmo-does-not-exist', 'creds.json'),
    fetchImpl: okFetch,
    refresh: async () => { attempts += 1; return true; },
  });
  assert.equal(attempts, 0, 'only an expiry is repairable in place');
  assert.equal(result.available, false);
});

// On macOS Claude Code keeps its credentials in the login Keychain, so the file
// the usage endpoint needs never exists and the meter was dark on every Mac —
// found when a run was planned against "claude: unknown" while the weekly window
// sat at 66%. The CLI reports the windows itself, so the meter asks the CLI.
// These pin that second source.

const event = (info) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info });
const stream = (...lines) => [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  ...lines,
  JSON.stringify({ type: 'result', subtype: 'success' }),
].join('\n');

const macEvent = event({
  status: 'allowed',
  resetsAt: 1791404400,
  rateLimitType: 'five_hour',
  unifiedWindows: {
    five_hour: { utilization: 0.01, resetsAt: 1791404400 },
    seven_day: { utilization: 0.65, resetsAt: 1791475200 },
  },
});

test('the CLI stream yields both windows, with utilization read as a fraction', () => {
  const parsed = parseClaudeRateLimitEvents(stream(macEvent));
  assert.deepEqual(parsed.windows.map((w) => [w.key, w.percentUsed]), [['5h', 1], ['weekly', 65]]);
  assert.equal(parsed.windows[1].resetsAt, new Date(1791475200 * 1000).toISOString());
  assert.equal(parsed.hardBlocked, false);
});

test('a utilization above 1 is already a percentage, not 6500%', () => {
  const parsed = parseClaudeRateLimitEvents(stream(event({
    status: 'allowed',
    unifiedWindows: { seven_day: { utilization: 65, resetsAt: 1791475200 } },
  })));
  assert.equal(parsed.windows[0].percentUsed, 65);
  assert.equal(parsed.hardBlocked, false);
});

test('the newest event on the stream wins, and a torn line is ignored', () => {
  const older = event({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1 } } });
  const parsed = parseClaudeRateLimitEvents(stream(older, '{"type":"rate_limit_event","rate_limit_info":{', macEvent));
  assert.equal(parsed.windows.find((w) => w.key === '5h').percentUsed, 1);
});

test('a rejected status is a hard block even below 100%', () => {
  const parsed = parseClaudeRateLimitEvents(stream(event({
    status: 'rejected',
    unifiedWindows: { five_hour: { utilization: 0.97, resetsAt: 1791404400 } },
  })));
  assert.equal(parsed.hardBlocked, true);
});

test('an event from before unifiedWindows still gives the one window it describes', () => {
  const parsed = parseClaudeRateLimitEvents(stream(event({
    status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8, resetsAt: 1791475200,
  })));
  assert.deepEqual(parsed.windows.map((w) => [w.key, w.percentUsed]), [['weekly', 80]]);
});

test('per-model weekly windows do not mark the whole provider spent', () => {
  const parsed = parseClaudeRateLimitEvents(stream(event({
    status: 'allowed',
    unifiedWindows: {
      seven_day: { utilization: 0.2, resetsAt: 1791475200 },
      seven_day_opus: { utilization: 0.99, resetsAt: 1791475200 },
    },
  })));
  assert.deepEqual(parsed.windows.map((w) => w.key), ['weekly']);
});

test('a stream with no event is not a reading', () => {
  assert.equal(parseClaudeRateLimitEvents(stream()), null);
  assert.equal(parseClaudeRateLimitEvents(''), null);
  assert.equal(parseClaudeRateLimitEvents(undefined), null);
});

test('the CLI reader falls back to the plain turn when the lean one prints nothing', async () => {
  const calls = [];
  const result = await readClaudeLimitsViaCli({
    probe: async ({ lean }) => { calls.push(lean); return lean ? 'error: unknown option --tools' : stream(macEvent); },
  });
  assert.deepEqual(calls, [true, false]);
  assert.equal(result.available, true);
  assert.equal(result.worstPercent, 65);
  assert.equal(result.source, CLAUDE_CLI_SOURCE);
});

test('a missing claude binary is reported as that, not as a stack trace', async () => {
  const result = await readClaudeLimitsViaCli({
    probe: async () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }); },
  });
  assert.equal(result.available, false);
  assert.equal(result.error, 'claude is not on PATH');
});

test('with no credentials file the meter asks the CLI, and is no longer dark', async () => {
  let asked = 0;
  const result = await readClaudeLimits({
    credentialsPath: join(tmpdir(), 'cmo-does-not-exist', 'creds.json'), // macOS: Keychain, no file
    cli: async () => { asked += 1; return readClaudeLimitsViaCli({ probe: async () => stream(macEvent) }); },
  });
  assert.equal(asked, 1);
  assert.equal(result.available, true);
  assert.equal(result.worstWindow, 'weekly');
  assert.equal(result.worstPercent, 65);
});

test('a working usage endpoint never spends a turn on the CLI', async () => {
  const path = await credentials({ expiresAt: Date.now() + 3_600_000 });
  let asked = 0;
  const result = await readClaudeLimits({
    credentialsPath: path,
    fetchImpl: okFetch,
    cli: async () => { asked += 1; return null; },
  });
  assert.equal(asked, 0);
  assert.equal(result.available, true);
});

test('when both sources fail the error names both', async () => {
  const result = await readClaudeLimits({
    credentialsPath: join(tmpdir(), 'cmo-does-not-exist', 'creds.json'),
    cli: async () => readClaudeLimitsViaCli({ probe: async () => stream() }),
  });
  assert.equal(result.available, false);
  assert.match(result.error, /ENOENT/);
  assert.match(result.error, /through the CLI: the claude CLI reported no plan windows/);
});

test('a reading taken through the CLI is reused for longer than one from the endpoint', async () => {
  const t0 = 1_800_000_000_000;
  let probes = 0;
  const viaCli = async () => {
    probes += 1;
    return { provider: 'claude', available: true, windows: [], worstPercent: 65, source: CLAUDE_CLI_SOURCE };
  };
  const codex = async () => ({ provider: 'codex', available: true, windows: [], worstPercent: 5 });
  await readLimits({ now: t0, readers: { codex, claude: viaCli }, refresh: true });
  await readLimits({ now: t0 + 60_000, readers: { codex, claude: viaCli } }); // past 45s, inside 120s
  assert.equal(probes, 1, 'a CLI reading one minute old is still good');
  await readLimits({ now: t0 + 121_000, readers: { codex, claude: viaCli } });
  assert.equal(probes, 2, 'and is retaken once it is older than the CLI window');
});

