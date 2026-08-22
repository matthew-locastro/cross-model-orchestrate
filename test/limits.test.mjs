import './isolate.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readClaudeLimits } from '../src/limits.mjs';

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
