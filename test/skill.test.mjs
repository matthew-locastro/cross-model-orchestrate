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

const REF = (name) => readFileSync(new URL(`../skill/references/${name}`, import.meta.url), 'utf8');

test('plan-driven development is reachable from the skill and keeps every review cross-vendor', () => {
  assert.match(SKILL, /### Plan-driven development/);
  assert.match(SKILL, /references\/plan-driven-development\.md/);
  assert.match(SKILL, /a feature or fix against an agreed spec \| plan-driven development/);
  assert.match(SKILL, /- No evidence, no "done"\./);
  const pattern = REF('plan-driven-development.md');
  assert.match(pattern, /independent-of: <the implementer's provider, from its envelope>/);
  assert.match(pattern, /each review file is written \*\*after\*\* its implement or fix dispatch returns/);
  assert.match(pattern, /After \*\*three\*\* rounds the task is parked/);
  assert.match(pattern, /A red baseline\s+stops the run/);
  assert.match(pattern, /the orchestrator commits/);
  // Credit where the method came from.
  assert.match(pattern, /obra\/superpowers/);
  assert.match(pattern, /MIT, © 2025 Jesse\s+Vincent/);
});

test('every review template names the vendor to avoid and none spends a write tier', () => {
  const templates = REF('plan-driven-templates.md');
  const reviews = templates.split('```text').filter((block) => /role: review/.test(block));
  assert.equal(reviews.length, 2);
  for (const block of reviews) {
    assert.match(block, /independent-of: </);
    assert.doesNotMatch(block, /write: true/);
    assert.match(block, /task-verdict\.json/);
  }
});

test('implement and review templates leave repository housekeeping to the orchestrator', () => {
  const templates = REF('plan-driven-templates.md');
  const dispatched = templates.split('```text').filter((block) => /role: implement|role: review/.test(block));
  for (const block of dispatched) assert.match(block, /housekeeping/);
});

test('the report and verdict schemas are strict objects the script can branch on', () => {
  const strict = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'))) {
      assert.equal(node.additionalProperties, false, `${path} is closed`);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${path} requires every property`);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) strict(child, `${path}.${key}`);
    if (node.items) strict(node.items, `${path}[]`);
  };
  for (const name of ['implementer-report.json', 'task-verdict.json']) {
    const schema = JSON.parse(REF(`schemas/${name}`));
    strict(schema, name);
  }
  const verdict = JSON.parse(REF('schemas/task-verdict.json'));
  assert.deepEqual(verdict.properties.quality.properties.findings.items.properties.severity.enum, ['critical', 'important', 'minor']);
  assert.ok(verdict.properties.evidence.properties.tree_clean_after_review);
});

test('nothing from one user\'s projects leaks into the public references', () => {
  for (const name of ['plan-driven-development.md', 'plan-driven-templates.md', 'schemas/implementer-report.json', 'schemas/task-verdict.json']) {
    assert.doesNotMatch(REF(name), /\b(SYH|syhclub|yacht|superyacht)\b/i, name);
  }
});
