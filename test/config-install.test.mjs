// npm test
//
// The two modules that behave differently on someone else's machine: config
// resolution (their model IDs, their preferred vendor) and install (their
// existing skill directories, which must never be clobbered).

import './isolate.mjs'; // MUST be first — see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_MODELS, loadConfig, resetConfigCache } from '../src/config.mjs';
import { decide } from '../src/policy.mjs';
import { install, uninstall, packageIsEphemeral, PACKAGE_ROOT } from '../src/install.mjs';

const healthy = (percent = 5) => ({
  available: true,
  worstPercent: percent,
  nextResetAt: null,
  hardBlocked: false,
  windows: [{ key: '5h', label: '5hr', percentUsed: percent, resetsAt: null }],
});

function withConfig(body, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'cmo-config-'));
  const file = join(dir, 'config.json');
  if (contents !== undefined) writeFileSync(file, JSON.stringify(contents), 'utf8');
  try {
    resetConfigCache();
    return body(loadConfig({ file, reload: true }));
  } finally {
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── config ────────────────────────────────────────────────────────────────

test('a missing config file is not an error — the defaults are usable', () => {
  withConfig((config) => {
    assert.deepEqual(config.models, DEFAULT_MODELS);
    assert.equal(config.configFileFound, false);
    assert.equal(config.preference.first, 'codex');
  });
});

test('a config file overrides individual tiers without erasing the rest', () => {
  withConfig((config) => {
    assert.equal(config.models.codex.frontier.model, 'gpt-6-titan');
    // The reasoning level from the default survives a model-only override.
    assert.equal(config.models.codex.frontier.reasoning, DEFAULT_MODELS.codex.frontier.reasoning);
    // Untouched tiers are untouched.
    assert.equal(config.models.claude.fast.model, DEFAULT_MODELS.claude.fast.model);
  }, { models: { codex: { frontier: 'gpt-6-titan' } } });
});

test('a malformed config file is loud, not silently ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmo-config-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, '{ not json', 'utf8');
  try {
    resetConfigCache();
    // Falling back to defaults here would route work to models the user thought
    // they had changed — the worst possible failure mode for this file.
    assert.throws(() => loadConfig({ file, reload: true }), /config\.json/);
  } finally {
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('custom bands and a flipped vendor preference actually change dispatch', () => {
  withConfig(() => {
    // claude preferred, and codex at 30% now counts as exhausted.
    const d = decide({ role: 'implement', complexity: 3, length: 'm' }, { codex: healthy(35), claude: healthy(20) });
    assert.equal(d.provider, 'claude');
    assert.equal(d.fallback, null, 'codex is past the custom exhausted band, so there is nowhere to fail over');
  }, { preference: { first: 'claude' }, pressure: { tight: 10, critical: 20, exhausted: 30 } });
});

test('env vars beat the config file', () => {
  process.env.CMO_CLAUDE_BALANCED = 'sonnet-next';
  try {
    withConfig((config) => {
      assert.equal(config.models.claude.balanced.model, 'sonnet-next');
      assert.equal(config.models.claude.balanced.effort, DEFAULT_MODELS.claude.balanced.effort);
    }, { models: { claude: { balanced: 'from-file' } } });
  } finally {
    delete process.env.CMO_CLAUDE_BALANCED;
  }
});

// ── install ───────────────────────────────────────────────────────────────

function fakeHome(body) {
  const home = mkdtempSync(join(tmpdir(), 'cmo-home-'));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return body(home);
  } finally {
    process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  }
}

// install.mjs reads HOME at import time, so exercise it through a subprocess
// that gets a fresh module graph with the fake HOME already set.
function runInstall(home, args = []) {
  return execFileSync(
    process.execPath,
    [join(PACKAGE_ROOT, 'bin', 'cmo.mjs'), ...args],
    { env: { ...process.env, HOME: home }, encoding: 'utf8' },
  );
}

test('install wires the skill into every host and the agent into Claude', () => {
  fakeHome((home) => {
    const out = runInstall(home, ['install']);
    for (const dir of [
      join(home, '.claude/skills/cross-model-orchestrate'),
      join(home, '.codex/skills/cross-model-orchestrate'),
      join(home, '.agents/skills/cross-model-orchestrate'),
      join(home, '.kilo/skills/cross-model-orchestrate'),
      join(home, '.config/opencode/skills/cross-model-orchestrate'),
    ]) {
      assert.ok(existsSync(join(dir, 'SKILL.md')), `${dir} should hold a readable skill`);
    }
    assert.ok(existsSync(join(home, '.claude/agents/codex-runner.md')));
    // Installing is step 1 of 3; the output has to say what the other two are,
    // because npm hides the postinstall banner by default.
    assert.match(out, /cmo install/);
    assert.match(out, /claude --model opus --effort high/);
    assert.match(out, /\/cross-model-orchestrate <what you want built>/);
    assert.match(out, /runs from Claude Code only/);
  });
});

test('install is idempotent', () => {
  fakeHome((home) => {
    runInstall(home, ['install']);
    const second = runInstall(home, ['install']);
    assert.match(second, /ok\s+.*\.claude\/skills\/cross-model-orchestrate/);
    assert.ok(existsSync(join(home, '.claude/skills/cross-model-orchestrate/SKILL.md')));
  });
});

test('install never replaces somebody else\'s skill of the same name', () => {
  fakeHome((home) => {
    const target = join(home, '.claude/skills/cross-model-orchestrate');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), '# not ours\n');

    const out = runInstall(home, ['install']);

    assert.equal(
      readFileSync(join(target, 'SKILL.md'), 'utf8'),
      '# not ours\n',
      'a foreign skill directory must survive untouched',
    );
    assert.match(out, /skip/);
    assert.match(out, /not ours to replace/);
    // The other hosts still got it.
    assert.ok(existsSync(join(home, '.codex/skills/cross-model-orchestrate/SKILL.md')));
  });
});

test('a dangling link from an earlier install is reclaimed', () => {
  fakeHome((home) => {
    const dir = join(home, '.claude/skills');
    mkdirSync(dir, { recursive: true });
    symlinkSync('/nowhere/that/exists/cross-model-orchestrate', join(dir, 'cross-model-orchestrate'));

    runInstall(home, ['install']);

    // A broken symlink cannot be anyone's working install, so replacing it is
    // safe — and it is how a moved or reinstalled package repairs itself.
    assert.ok(existsSync(join(dir, 'cross-model-orchestrate/SKILL.md')));
  });
});

test('switching install methods relinks instead of refusing', () => {
  // A link into another copy of THIS package — a source checkout after you
  // install from npm, or a package root that moved between versions. Treating
  // it as foreign leaves the user with "not ours to replace" and no way
  // forward except deleting links by hand.
  fakeHome((home) => {
    const dir = join(home, '.claude/skills');
    mkdirSync(dir, { recursive: true });
    const other = mkdtempSync(join(tmpdir(), 'cmo-othercopy-'));
    const otherPkg = join(other, 'cross-model-orchestrate');
    mkdirSync(join(otherPkg, 'skill'), { recursive: true });
    writeFileSync(join(otherPkg, 'skill', 'SKILL.md'), '# an older copy\n');
    symlinkSync(join(otherPkg, 'skill'), join(dir, 'cross-model-orchestrate'));

    const out = runInstall(home, ['install']);

    assert.doesNotMatch(out, /not ours to replace/);
    assert.equal(
      readFileSync(join(dir, 'cross-model-orchestrate/SKILL.md'), 'utf8').includes('an older copy'),
      false,
      'the link should now resolve to this package, not the old copy',
    );
    rmSync(other, { recursive: true, force: true });
  });
});

test('--skill-name installs under a different directory, so collisions have a fix', () => {
  fakeHome((home) => {
    runInstall(home, ['install', '--skill-name', 'orchestrate']);
    assert.ok(existsSync(join(home, '.claude/skills/orchestrate/SKILL.md')));
    assert.ok(!existsSync(join(home, '.claude/skills/cross-model-orchestrate')));
  });
});

test('--hosts limits the fan-out', () => {
  fakeHome((home) => {
    runInstall(home, ['install', '--hosts', 'claude']);
    assert.ok(existsSync(join(home, '.claude/skills/cross-model-orchestrate/SKILL.md')));
    assert.ok(!existsSync(join(home, '.codex/skills/cross-model-orchestrate')));
  });
});

test('uninstall removes what install made and nothing else', () => {
  fakeHome((home) => {
    runInstall(home, ['install']);
    const foreign = join(home, '.kilo/skills/someone-elses');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'SKILL.md'), '# theirs\n');

    runInstall(home, ['uninstall']);

    assert.ok(!existsSync(join(home, '.claude/skills/cross-model-orchestrate')));
    assert.ok(!existsSync(join(home, '.claude/agents/codex-runner.md')));
    assert.ok(existsSync(join(foreign, 'SKILL.md')), 'unrelated skills survive uninstall');
  });
});

test('an npx checkout is detected so we copy instead of dangling a symlink', () => {
  assert.equal(packageIsEphemeral('/home/x/.npm/_npx/abc123/node_modules/cross-model-orchestrate'), true);
  assert.equal(packageIsEphemeral('/usr/lib/node_modules/cross-model-orchestrate'), false);
});
