// The watchdog stops a stalled agent and never a working one. Past its time
// budget an agent that is still producing output keeps going; silence, or the
// hard ceiling, is what stops it. Real child processes, small clocks.

import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grokSessionActivity } from '../src/grok.mjs';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { snapshot } from '../src/ledger.mjs';
import { parseClaudeStdout, runAgent, spawnWithTimeout, watchdogVerdict } from '../src/run.mjs';

const node = (code, opts) => spawnWithTimeout({
  binary: process.execPath, args: ['-e', code], cwd: process.cwd(), prompt: '', env: process.env, ...opts,
});
const timed = async (fn) => { const t = Date.now(); const r = await fn(); return { ...r, took: Date.now() - t }; };

test('within the budget nothing is stopped; past it, only silence or the ceiling', () => {
  const base = { timeoutMs: 1000, idleMs: 300, maxMs: 5000 };
  assert.ok(watchdogVerdict({ ...base, elapsed: 900, quiet: 900, everSpoke: false }).wait > 0);
  assert.match(watchdogVerdict({ ...base, elapsed: 1000, quiet: 1000, everSpoke: false }).stop, /no output at all/);
  assert.ok(watchdogVerdict({ ...base, elapsed: 3000, quiet: 100, everSpoke: true }).wait > 0, 'talking past the budget keeps going');
  assert.match(watchdogVerdict({ ...base, elapsed: 3000, quiet: 300, everSpoke: true }).stop, /no output for/);
  assert.match(watchdogVerdict({ ...base, elapsed: 5000, quiet: 0, everSpoke: true }).stop, /ceiling/);
  // Silence is never allowed longer than the budget itself.
  assert.match(watchdogVerdict({ timeoutMs: 1000, idleMs: 60_000, maxMs: 5000, elapsed: 1000, quiet: 1000, everSpoke: false }).stop, /no output at all/);
  // A ceiling below the budget is the budget.
  assert.ok(watchdogVerdict({ timeoutMs: 1000, idleMs: 300, maxMs: 10, elapsed: 500, quiet: 0, everSpoke: true }).wait > 0);
});

test('a silent child stops at its budget, as a wall clock would', async () => {
  const r = await timed(() => node('setTimeout(() => {}, 10000)', { timeoutMs: 300, idleMs: 60_000, maxMs: 60_000 }));
  assert.equal(r.timedOut, true);
  assert.match(r.stopReason, /no output at all/);
  assert.ok(r.took < 3000, `took ${r.took}ms`);
});

test('a child still talking past its budget is not cut off', async () => {
  const code = "const i = setInterval(() => process.stdout.write('.'), 40); setTimeout(() => { clearInterval(i); console.log('done'); }, 900);";
  const r = await node(code, { timeoutMs: 300, idleMs: 200, maxMs: 10_000 });
  assert.equal(r.timedOut, false);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /done/);
});

test('a child that goes quiet past its budget is stopped for the silence', async () => {
  const code = "const i = setInterval(() => process.stdout.write('.'), 30); setTimeout(() => clearInterval(i), 150); setTimeout(() => {}, 10000);";
  const r = await timed(() => node(code, { timeoutMs: 300, idleMs: 250, maxMs: 60_000 }));
  assert.equal(r.timedOut, true);
  assert.match(r.stopReason, /no output for/);
  assert.ok(r.took >= 300 && r.took < 3000, `took ${r.took}ms`);
});

test('a child that talks forever stops at the ceiling', async () => {
  const code = "setInterval(() => process.stdout.write('.'), 30);";
  const r = await timed(() => node(code, { timeoutMs: 200, idleMs: 200, maxMs: 700 }));
  assert.equal(r.timedOut, true);
  assert.match(r.stopReason, /ceiling/);
  assert.ok(r.took >= 700 && r.took < 4000, `took ${r.took}ms`);
});

// ── claude streams now, so its progress is visible ────────────────────────

const INIT = JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none' });
const TOOL = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'HTTP 429 Too Many Requests in the fixture file' }] } });
const ASSISTANT = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });

test('a claude stream yields the result line\'s answer, and only the envelope is classified', () => {
  const ok = [INIT, ASSISTANT, TOOL, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'all done', usage: { output_tokens: 5 } })].join('\n');
  const p = parseClaudeStdout(ok);
  assert.equal(p.text, 'all done');
  assert.deepEqual(p.usage, { output_tokens: 5 });
  assert.doesNotMatch(p.raw, /429/, 'tool output never reaches the failure classifier');

  const failed = [INIT, JSON.stringify({ type: 'result', is_error: true, result: 'Failed to authenticate: OAuth session expired' })].join('\n');
  assert.equal(parseClaudeStdout(failed).text, '');
  assert.match(parseClaudeStdout(failed).error, /Failed to authenticate/);
});

test('a claude stream cut off before its result is no answer, not plain text', () => {
  assert.deepEqual(parseClaudeStdout([INIT, ASSISTANT, TOOL].join('\n')), { text: '', usage: null, raw: '' });
  assert.deepEqual(parseClaudeStdout(INIT), { text: '', usage: null, raw: '' });
});

test('the json envelope and plain text still parse as before', () => {
  assert.equal(parseClaudeStdout(JSON.stringify({ type: 'result', result: 'one envelope' })).text, 'one envelope');
  assert.equal(parseClaudeStdout('just words').text, 'just words');
});

// ── grok reasons silently; its session log does not ───────────────────────


test('a silent stdout with fresh activity elsewhere is not a stall', async () => {
  const code = "process.stdout.write('{}\\n'); const i = setInterval(() => {}, 1000); setTimeout(() => { clearInterval(i); console.log('done'); }, 900);";
  const r = await node(code, { timeoutMs: 200, idleMs: 200, maxMs: 10_000, activity: () => Date.now() });
  assert.equal(r.timedOut, false);
  assert.match(r.stdout, /done/);
});

test('activity that stops updating no longer keeps a stall alive', async () => {
  const frozen = Date.now();
  const r = await node('process.stdout.write("{}\\n"); setTimeout(() => {}, 10000)', {
    timeoutMs: 200, idleMs: 200, maxMs: 10_000, activity: () => frozen,
  });
  assert.equal(r.timedOut, true);
  assert.match(r.stopReason, /no output for/);
});

test('grok\'s activity is read from its own session log, found by the init line', () => {
  const home = mkdtempSync(join(tmpdir(), 'cmo-grok-home-'));
  try {
    const dir = join(home, 'sessions', encodeURIComponent('/some/repo'), 'abc-123');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), '{}\n');
    const when = new Date('2026-11-10T05:00:00Z');
    utimesSync(join(dir, 'events.jsonl'), when, when);
    const init = '{"type":"system","subtype":"init","session_id":"abc-123","apiKeySource":"oauth"}\n';
    assert.equal(grokSessionActivity(init, { grokHome: home }), when.getTime());
    assert.equal(grokSessionActivity('', { grokHome: home }), null, 'no init line yet');
    assert.equal(grokSessionActivity('{"session_id":"other"}\n', { grokHome: home }), null, 'another session');
    assert.equal(grokSessionActivity('{"session_id":"../../etc"}\n', { grokHome: home }), null, 'never a path');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── found in cross-vendor review ──────────────────────────────────────────


const execFileAsync = promisify(execFile);
const CMO = new URL('../bin/cmo.mjs', import.meta.url).pathname;

test('a clock that is not a positive number falls back to the default, never hangs', () => {
  assert.ok(watchdogVerdict({ timeoutMs: NaN, elapsed: 0, quiet: 0, everSpoke: false }).wait > 0);
  assert.ok(watchdogVerdict({ timeoutMs: NaN, elapsed: 31 * 60_000, quiet: 31 * 60_000, everSpoke: false }).stop);
});

test('a bad duration flag is refused before anything runs', async () => {
  for (const [cmd, flag] of [['run', '--timeout'], ['run', '--idle-timeout'], ['run', '--max-runtime'], ['plan', '--timeout']]) {
    const err = await execFileAsync(process.execPath, [CMO, cmd, flag, 'nope', '--prompt', 'x'], { env: process.env })
      .then(() => null, (e) => e);
    assert.ok(err, `${cmd} ${flag} nope should fail`);
    assert.equal(err.code, 2);
    assert.match(err.stderr, new RegExp(`${flag} must be a positive number of seconds`));
  }
});

test('a run that may outlive its budget holds its headroom to the ceiling', async () => {
  let leaseLeft = null;
  const spawnImpl = async () => {
    const st = await snapshot({ local: true });
    const mine = st.reservations.at(-1);
    leaseLeft = mine.startedAt + mine.leaseMs - Date.now();
    return { code: 0, signal: null, timedOut: false, aborted: null, stdout: '{"type":"result","result":"ok"}', stderr: '' };
  };
  const out = await runAgent(
    { provider: 'claude', model: 'sonnet', tier: 'balanced', fallbacks: [] },
    'task',
    { spawnImpl, sleep: async () => {}, timeoutMs: 60_000, maxMs: 3 * 60 * 60_000 },
  );
  assert.equal(out.ok, true);
  assert.ok(leaseLeft > 3 * 60 * 60_000 - 5_000, `lease left ${leaseLeft}ms`);
});

test('a long run\'s reservation is not collected at the old 30-minute lease', async () => {
  const { gcReservations } = await import('../src/ledger.mjs');
  const now = Date.now();
  const long = { id: 'a', provider: 'grok', pid: process.pid, startedAt: now - 2 * 60 * 60_000, leaseMs: 4 * 60 * 60_000 };
  const legacy = { id: 'b', provider: 'grok', pid: process.pid, startedAt: now - 2 * 60 * 60_000 };
  assert.deepEqual(gcReservations([long, legacy], now).map((r) => r.id), ['a']);
});

test('no run may outlast the longest lease a reservation can hold', async () => {
  const err = await execFileAsync(process.execPath, [CMO, 'run', '--max-runtime', '1e306', '--prompt', 'x'], { env: process.env })
    .then(() => null, (e) => e);
  assert.equal(err?.code, 2);
  assert.match(err.stderr, /--max-runtime must be at most 21600 seconds/);

  let lease = null;
  const spawnImpl = async () => {
    const st = await snapshot({ local: true });
    lease = st.reservations.at(-1).leaseMs;
    return { code: 0, signal: null, timedOut: false, aborted: null, stdout: '{"type":"result","result":"ok"}', stderr: '' };
  };
  await runAgent({ provider: 'claude', model: 'sonnet', tier: 'balanced', fallbacks: [] }, 'task',
    { spawnImpl, sleep: async () => {}, timeoutMs: 60_000, maxMs: Infinity });
  assert.ok(lease <= 6 * 60 * 60_000, `lease ${lease}`);

  const { gcReservations } = await import('../src/ledger.mjs');
  const now = Date.now();
  const forever = { id: 'x', provider: 'grok', pid: process.pid, startedAt: now - 40 * 60_000, leaseMs: Infinity };
  assert.deepEqual(gcReservations([forever], now), [], 'a non-finite lease is the default 30 minutes');
});

test('grok\'s activity never follows a symlink out of its sessions folder', async () => {
  const { symlinkSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'cmo-grok-home-'));
  const outside = mkdtempSync(join(tmpdir(), 'cmo-outside-'));
  try {
    mkdirSync(join(outside, 'sym-1'), { recursive: true });
    writeFileSync(join(outside, 'sym-1', 'events.jsonl'), '{}\n');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    symlinkSync(outside, join(home, 'sessions', 'linked'));
    assert.equal(grokSessionActivity('{"session_id":"sym-1"}\n', { grokHome: home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
