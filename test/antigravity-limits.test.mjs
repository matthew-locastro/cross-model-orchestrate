import './isolate.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAntigravityLimits, runAntigravityProbe } from '../src/limits.mjs';

const usage = ({ fiveHour = 0.8, weekly = 0.6 } = {}) => JSON.stringify({
  status: 'SUCCESS',
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-5h', remaining_fraction: fiveHour, reset_time: '2030-01-01T05:00:00Z' },
            { id: 'gemini-weekly', remaining_fraction: weekly, reset_time: '2030-01-08T00:00:00Z' },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            { id: '3p-5h', remaining_fraction: 0, reset_time: '1970-01-01T00:00:00Z' },
            { id: '3p-weekly', remaining_fraction: 0, reset_time: '1970-01-01T00:00:00Z' },
          ],
        },
      ],
    },
  },
});

test('the meter uses only Gemini Models buckets from the /usage envelope', async () => {
  const result = await readAntigravityLimits({ probe: async () => ({ code: 0, stdout: usage() }) });
  assert.equal(result.available, true);
  assert.equal(result.auth.ok, true);
  assert.equal(result.source, 'agy -p /usage --output-format json');
  assert.deepEqual(result.windows.map((w) => [w.key, w.percentUsed, w.resetsAt]), [
    ['5h', 20, '2030-01-01T05:00:00.000Z'],
    ['weekly', 40, '2030-01-08T00:00:00.000Z'],
  ]);
  assert.equal(result.worstPercent, 40);
});

test('a tight five-hour Gemini bucket is the binding window', async () => {
  const result = await readAntigravityLimits({ probe: async () => ({ code: 0, stdout: usage({ fiveHour: 0.05, weekly: 0.9 }) }) });
  assert.equal(result.worstWindow, '5h');
  assert.equal(result.worstPercent, 95);
});

test('an epoch reset that claims Gemini usage is ignored', async () => {
  const withEpochFiveHour = JSON.stringify({
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-5h', remaining_fraction: 0, reset_time: '1970-01-01T00:00:00Z' },
              { id: 'gemini-weekly', remaining_fraction: 0.6, reset_time: '2030-01-08T00:00:00Z' },
            ],
          },
        ],
      },
    },
  });
  const result = await readAntigravityLimits({ probe: async () => ({ code: 0, stdout: withEpochFiveHour }) });
  assert.equal(result.available, true);
  assert.equal(result.auth.ok, true);
  assert.deepEqual(result.windows.map((w) => [w.key, w.percentUsed, w.resetsAt]), [
    ['weekly', 40, '2030-01-08T00:00:00.000Z'],
  ]);
  assert.equal(result.worstWindow, 'weekly');
  assert.equal(result.worstPercent, 40);
});

test('unused Gemini buckets with epoch resets are routable at zero pressure', async () => {
  const result = await readAntigravityLimits({ probe: async () => ({ code: 0, stdout: usage({ fiveHour: 1, weekly: 1 }).replaceAll('2030-01-01T05:00:00Z', '1970-01-01T00:00:00Z').replaceAll('2030-01-08T00:00:00Z', '1970-01-01T00:00:00Z') }) });
  assert.equal(result.available, true);
  assert.equal(result.auth.ok, true);
  assert.deepEqual(result.windows.map((w) => [w.key, w.percentUsed, w.resetsAt]), [
    ['5h', 0, null],
    ['weekly', 0, null],
  ]);
  assert.equal(result.worstPercent, 0);
});

test('a null or non-numeric remaining fraction is not a meter reading', async () => {
  for (const remaining of [null, '', 'not-a-number']) {
    const fraction = JSON.stringify(remaining);
    const body = usage().replace('0.8', fraction).replace('0.6', fraction);
    const result = await readAntigravityLimits({ probe: async () => ({ code: 0, stdout: body }) });
    assert.equal(result.available, false, `remaining_fraction=${JSON.stringify(remaining)}`);
  }
});

test('the agy probe kills a hung child and fails soft', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmo-hung-agy-'));
  const binary = join(dir, 'agy');
  await writeFile(binary, `#!${process.execPath}\nsetInterval(() => {}, 1_000);\n`);
  await chmod(binary, 0o755);
  try {
    const started = Date.now();
    const result = await runAntigravityProbe(binary, { timeoutMs: 20 });
    assert.ok(Date.now() - started < 1_000);
    assert.notEqual(result.code, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('exit 2 means an API-key login has no subscription quota and is not routable', async () => {
  const result = await readAntigravityLimits({ probe: async () => ({ code: 2, stdout: '' }) });
  assert.equal(result.available, false);
  assert.equal(result.auth.ok, false);
  assert.match(result.auth.reason, /API-key login/i);
});

test('a malformed /usage envelope is not a meter reading', async () => {
  const result = await readAntigravityLimits({ probe: async () => ({ code: 0, stdout: '{not json' }) });
  assert.equal(result.available, false);
  assert.equal(result.auth.ok, false);
  assert.match(result.error, /usage/i);
});

test('a disabled meter is unverified and not routable', async () => {
  const result = await readAntigravityLimits();
  assert.equal(result.available, false);
  assert.equal(result.auth.ok, false);
  assert.match(result.auth.reason, /disabled/i);
});
