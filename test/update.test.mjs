import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { commandFor } from '../src/update.mjs';

// The guard that matters most is not running the wrong upgrade command.
// Telling a Homebrew user to npm install leaves them with two copies of the
// binary and a PATH puzzle they will spend an hour on.

test('an npm global install is upgraded through npm', () => {
  const c = commandFor('codex', '/home/x/.npm-global/lib/node_modules/@openai/codex/bin/codex.js');
  assert.deepEqual(c, { cmd: 'npm', args: ['install', '-g', '@openai/codex@latest'] });
});

test('a homebrew install is upgraded through brew', () => {
  const c = commandFor('codex', '/opt/homebrew/Cellar/codex/0.149.0/bin/codex');
  assert.deepEqual(c, { cmd: 'brew', args: ['upgrade', 'codex'] });
});

test('claude uses its own updater regardless of where it lives', () => {
  // It ships a native installer and knows its own shape better than we do.
  assert.deepEqual(
    commandFor('claude', '/home/x/.local/share/claude/versions/2.1.239'),
    { cmd: 'claude', args: ['update'] },
  );
});

test('an install we do not recognise is skipped, not guessed at', () => {
  const c = commandFor('codex', '/opt/weird/vendor/bin/codex');
  assert.ok(c.skip, 'must refuse rather than guess');
  assert.match(c.skip, /cannot upgrade safely/);
  assert.equal(c.cmd, undefined);
});

test('a missing binary is skipped', () => {
  assert.match(commandFor('codex', null).skip, /not installed/);
});

test('the tool can upgrade itself through npm', () => {
  const c = commandFor('cross-model-orchestrate', '/usr/lib/node_modules/cross-model-orchestrate/bin/cmo.mjs');
  assert.deepEqual(c, { cmd: 'npm', args: ['install', '-g', 'cross-model-orchestrate@latest'] });
});
