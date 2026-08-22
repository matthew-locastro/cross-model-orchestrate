import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDispatchFile, mergeDispatch } from '../src/dispatch-file.mjs';

// The bug this file exists for: a shim retyped eight parameters as flags and
// dropped `--independent-of codex` on one dispatch in four. cmo never learned
// the review had to be independent, sent it back to the producing vendor, and
// returned an unlabelled verdict. Parameters now travel WITH the task.

const BLOCK = `DISPATCH
role: judge
complexity: 3
length: s
independent-of: codex
write: true
cwd: /repo
timeout: 600
schema: /repo/verdict.json
TASK
Score these two definitions.

Second paragraph stays intact.`;

test('parameters and task come out of one block', () => {
  const { meta, task } = parseDispatchFile(BLOCK);
  assert.equal(meta.role, 'judge');
  assert.equal(meta['independent-of'], 'codex', 'the flag that got dropped');
  assert.equal(meta.complexity, '3');
  assert.equal(meta.schema, '/repo/verdict.json');
  assert.equal(meta.write, true, 'booleans are flags, not strings');
  assert.match(task, /^Score these two definitions\./);
  assert.match(task, /Second paragraph stays intact\.$/, 'the whole body survives');
});

test('the header never leaks into the task', () => {
  const { task } = parseDispatchFile(BLOCK);
  assert.doesNotMatch(task, /DISPATCH|independent-of|^TASK/m);
});

test('a file with no header is all task', () => {
  const { meta, task } = parseDispatchFile('just do the thing');
  assert.deepEqual(meta, {});
  assert.equal(task, 'just do the thing');
});

test('a header with no TASK marker yields no task rather than dispatching itself', () => {
  // Better to fail loudly than to send the routing header to a model as work.
  const { task } = parseDispatchFile('DISPATCH\nrole: judge\n');
  assert.equal(task, '');
});

test('unknown keys are reported, not silently swallowed', () => {
  const { unknown, meta } = parseDispatchFile('DISPATCH\nrole: judge\nvibe: high\nTASK\nx');
  assert.deepEqual(unknown, ['vibe']);
  assert.equal(meta.role, 'judge');
});

test('explicit flags beat the file, so one value can be overridden', () => {
  const { meta } = parseDispatchFile(BLOCK);
  const merged = mergeDispatch({ role: 'implement' }, meta);
  assert.equal(merged.role, 'implement');
  assert.equal(merged['independent-of'], 'codex', 'everything else still arrives');
});

test('a boolean can be turned off in the file', () => {
  const { meta } = parseDispatchFile('DISPATCH\nrole: judge\nwrite: false\nTASK\nx');
  assert.equal(meta.write, false);
});

test('malformed lines are skipped rather than failing the dispatch', () => {
  const { meta, task } = parseDispatchFile('DISPATCH\nrole: judge\n===\n\nlength: s\nTASK\nx');
  assert.equal(meta.role, 'judge');
  assert.equal(meta.length, 's');
  assert.equal(task, 'x');
});
