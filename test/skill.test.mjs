// The skill file is the orchestrator's whole contract, so the parts the user
// relies on are pinned here: the trigger phrases, the orchestrator-only rule,
// and that nothing project-specific leaks into a public package.

import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SKILL = readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf8');
const frontmatter = SKILL.split('---')[1];

test('the skill loads on the feedback-batch phrases as well as the orchestration ones', () => {
  assert.match(frontmatter, /^name: cross-model-orchestrate$/m);
  assert.match(frontmatter, /when_to_use: >/);
  assert.match(frontmatter, /Start Feedback Batch/);
  assert.match(frontmatter, /End Feedback Batch/);
});

test('the chat stays the orchestrator and every unit runs in the background', () => {
  assert.match(SKILL, /## This chat is the orchestrator: it never does the work/);
  assert.match(SKILL, /Every user message gets an answer in the same turn/);
  assert.match(SKILL, /- This chat does no product work\./);
  // The old escape hatches are gone: no shape of work is done inline.
  assert.doesNotMatch(SKILL, /just do it — no orchestration/);
  assert.doesNotMatch(SKILL, /do it inline/);
});

test('a feedback batch collects until End, then packages by file and checks every item', () => {
  assert.match(SKILL, /## Feedback batches/);
  assert.match(SKILL, /While the batch is open, collect; do not act/);
  assert.match(SKILL, /two packages never edit the same file/);
  assert.match(SKILL, /- Never act on a feedback-batch item before End Feedback Batch\./);
});

test('nothing from one user\'s projects leaks into the public skill', () => {
  assert.doesNotMatch(SKILL, /\b(SYH|syhclub|yacht|superyacht)\b/i);
});
