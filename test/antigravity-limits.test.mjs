import './isolate.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';

import { readAntigravityLimits } from '../src/limits.mjs';

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
