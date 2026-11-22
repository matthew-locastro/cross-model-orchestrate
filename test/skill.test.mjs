// The skill file is the orchestrator's whole contract, so the parts the user
// relies on are pinned here: the trigger phrases, the orchestrator-only rule,
// and that nothing project-specific leaks into a public package.

import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertNoPrivateWords,
  loadPrivateWordsGuard,
  resolvePrivateWordsPath,
} from './private-words.mjs';

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

test('nothing from one user\'s projects leaks into the public skill', (t) => {
  assertNoPrivateWords(t, { 'skill/SKILL.md': SKILL });
});

const REFS_DIR = fileURLToPath(new URL('../skill/references', import.meta.url));
const REF = (name) => readFileSync(new URL(`../skill/references/${name}`, import.meta.url), 'utf8');

function listReferenceFiles(dir = REFS_DIR, prefix = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listReferenceFiles(join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files.sort();
}

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

test('nothing from one user\'s projects leaks into the public references', (t) => {
  const names = listReferenceFiles();
  assert.ok(names.includes('dispatch-policy.md'));
  assert.ok(names.includes('plan-driven-development.md'));
  assert.ok(names.includes('plan-driven-templates.md'));
  assert.ok(names.includes('schemas/implementer-report.json'));
  assert.ok(names.includes('schemas/task-verdict.json'));
  assert.ok(names.includes('workflow-patterns.md'));
  assertNoPrivateWords(
    t,
    Object.fromEntries(names.map((name) => [name, REF(name)])),
  );
});

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('nothing from one user\'s projects leaks into the public README', (t) => {
  assertNoPrivateWords(t, { 'README.md': README });
});

test('package.json names antigravity instead of grok and keeps repository URLs', () => {
  assert.match(PKG.description, /Antigravity/);
  assert.doesNotMatch(PKG.description, /\bgrok\b/i);
  assert.ok(PKG.keywords.includes('antigravity'));
  assert.ok(!PKG.keywords.includes('grok'));
  assert.equal(PKG.repository?.url, 'git+https://github.com/matthew-locastro/cross-model-orchestrate.git');
  assert.equal(PKG.homepage, 'https://github.com/matthew-locastro/cross-model-orchestrate#readme');
  assert.equal(PKG.bugs?.url, 'https://github.com/matthew-locastro/cross-model-orchestrate/issues');
});

test('the skill replaces Grok guidance with Antigravity Gemini-only subscription rules', () => {
  assert.doesNotMatch(SKILL, /grok login/i);
  assert.doesNotMatch(SKILL, /When Grok is the right vendor/);
  assert.doesNotMatch(SKILL, /XAI_API_KEY/);
  assert.match(SKILL, /### When Antigravity is the right vendor/);
  assert.match(SKILL, /\^gemini-/);
  assert.match(SKILL, /GEMINI_API_KEY/);
  assert.match(SKILL, /agy -p \/usage --output-format json/);
  assert.match(SKILL, /--sandbox/);
  assert.match(SKILL, /HEADROOM: codex .* claude .* antigravity/);
});

test('who can run this covers Antigravity and Codex full-access requirements', () => {
  const who = SKILL.split('## Who can run this')[1]?.split('\n## ')[0] ?? '';
  assert.match(who, /Antigravity/);
  assert.match(who, /~\/\.gemini\/config\/skills/);
  assert.match(who, /Codex/);
  assert.match(who, /full access/i);
});

test('outcomes are recorded after gates and reviews and read back in quality reports', () => {
  assert.match(SKILL, /cmo outcome/);
  assert.match(SKILL, /cmo report --quality/);
  const afterRun = SKILL.split('### After a run')[1]?.split('\n### ')[0] ?? '';
  assert.match(afterRun, /cmo report --quality/);

  const pattern = REF('plan-driven-development.md');
  assert.match(pattern, /cmo outcome/);
  assert.match(pattern, /cmo report --quality/);
  assert.match(pattern, /test names/i);
  assert.match(pattern, /outside the sandbox/i);
  assert.match(pattern, /double-wrapped/);
});

test('README and references describe the three-vendor roster without project leaks', () => {
  assert.doesNotMatch(README, /Optional: Grok as a third vendor/);
  assert.doesNotMatch(README, /grok login/i);
  assert.match(README, /Antigravity/);
  assert.match(README, /GEMINI_API_KEY/);
  assert.match(README, /cmo outcome/);
  assert.match(README, /cmo report --quality/);

  const policy = REF('dispatch-policy.md');
  assert.doesNotMatch(policy, /grok login/i);
  assert.match(policy, /agy -p \/usage --output-format json/);

  const workflows = REF('workflow-patterns.md');
  assert.match(workflows, /antigravity/i);
});

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cmo-private-words-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const neverSkip = {
  skip(msg) {
    assert.fail(`expected guard to run, not skip: ${msg}`);
  },
};

test('private-words guard flags a temp text containing a synthetic word case-insensitively and whole-word only', () => {
  withTempDir((dir) => {
    const wordsFile = join(dir, 'words.txt');
    const textFile = join(dir, 'sample.md');
    writeFileSync(wordsFile, 'zzexampleword\n', 'utf8');
    writeFileSync(textFile, 'A line mentioning ZZExampleWord in a temp text.\n', 'utf8');
    const sample = readFileSync(textFile, 'utf8');

    const prev = process.env.CMO_PRIVATE_WORDS_FILE;
    process.env.CMO_PRIVATE_WORDS_FILE = wordsFile;
    try {
      assert.throws(
        () => assertNoPrivateWords(neverSkip, { 'sample.md': sample }),
        { name: 'AssertionError', message: /sample\.md/ },
      );
      assertNoPrivateWords(neverSkip, {
        'substrings.md': 'ozzexampleword and zzexamplewords are substrings, not whole words',
      });
      const refs = Object.fromEntries(listReferenceFiles().map((name) => [name, REF(name)]));
      assertNoPrivateWords(neverSkip, { 'skill/SKILL.md': SKILL, 'README.md': README, ...refs });
    } finally {
      if (prev === undefined) delete process.env.CMO_PRIVATE_WORDS_FILE;
      else process.env.CMO_PRIVATE_WORDS_FILE = prev;
    }
  });
});

test('private-words guard ignores comments and blanks and escapes regex metacharacters', () => {
  withTempDir((dir) => {
    const wordsFile = join(dir, 'words.txt');
    writeFileSync(
      wordsFile,
      [
        '# leading comment with zzcommentword',
        '  # indented comment with zzindentedcomment',
        '',
        '   ',
        'zz.meta+word?',
        'zz[box](1)*',
        'zzpipe|zzalt',
        '',
      ].join('\n'),
      'utf8',
    );
    const opts = { env: { CMO_PRIVATE_WORDS_FILE: wordsFile } };

    // Blank lines must not create an empty alternation, comments are ignored,
    // and unescaped regex meanings (wildcard '.', character class, pipe) do not fire.
    assertNoPrivateWords(
      neverSkip,
      {
        'clean.md': 'ordinary text with zzcommentword, zzindentedcomment, zzXmeta+word, zzbox1 and zzpipe alone',
      },
      opts,
    );

    for (const leaked of ['zz.meta+word?', 'ZZ[BOX](1)*', 'zzpipe|zzalt']) {
      assert.throws(
        () => assertNoPrivateWords(neverSkip, { 'leaked.md': `contains ${leaked} inline` }, opts),
        { name: 'AssertionError' },
        leaked,
      );
    }
  });
});

test('private-words guard skips with a clear message when the words file is missing or empty', () => {
  withTempDir((dir) => {
    const missing = join(dir, 'does-not-exist.txt');
    const skippedMissing = [];
    assertNoPrivateWords(
      { skip: (msg) => skippedMissing.push(msg) },
      { 'sample.md': 'zzexampleword' },
      { env: { CMO_PRIVATE_WORDS_FILE: missing } },
    );
    assert.equal(skippedMissing.length, 1);
    assert.match(skippedMissing[0], /not found/i);
    assert.ok(skippedMissing[0].includes(missing));

    const emptyFile = join(dir, 'empty.txt');
    writeFileSync(emptyFile, '\n  \n# comment only\n', 'utf8');
    const skippedEmpty = [];
    const guard = assertNoPrivateWords(
      { skip: (msg) => skippedEmpty.push(msg) },
      { 'sample.md': 'zzexampleword' },
      { env: { CMO_PRIVATE_WORDS_FILE: emptyFile } },
    );
    assert.equal(guard.regex, null);
    assert.equal(skippedEmpty.length, 1);
    assert.match(skippedEmpty[0], /empty/i);
  });
});

test('private-words guard resolves ~ with os.homedir() and ignores redirected CMO_CONFIG_DIR', () => {
  assert.equal(
    resolvePrivateWordsPath({ env: { CMO_CONFIG_DIR: '/tmp/redirected-cmo-config' } }),
    join(homedir(), '.config', 'cross-model-orchestrate-private-words.txt'),
  );

  withTempDir((fakeHome) => {
    assert.equal(
      resolvePrivateWordsPath({ env: { CMO_PRIVATE_WORDS_FILE: '~/my-words.txt' }, home: fakeHome }),
      join(fakeHome, 'my-words.txt'),
    );

    const defaultFile = join(fakeHome, '.config', 'cross-model-orchestrate-private-words.txt');
    mkdirSync(join(fakeHome, '.config'), { recursive: true });
    writeFileSync(defaultFile, 'zzdefaultword\n', 'utf8');

    const guard = loadPrivateWordsGuard({
      env: { CMO_CONFIG_DIR: '/tmp/redirected-cmo-config' },
      home: fakeHome,
    });
    assert.equal(guard.path, defaultFile);
    assert.ok(guard.regex instanceof RegExp);
    assert.throws(
      () => assertNoPrivateWords(
        neverSkip,
        { 'doc.md': 'leaked zzdefaultword here' },
        { env: { CMO_CONFIG_DIR: '/tmp/redirected-cmo-config' }, home: fakeHome },
      ),
      { name: 'AssertionError' },
    );
  });
});
