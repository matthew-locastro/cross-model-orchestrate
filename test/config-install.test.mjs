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
import { nextSteps } from '../src/banner.mjs';
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
    assert.equal(config.preference.weightPoints, 25);
    assert.equal(config.routing.headroomWeight, 40);
    assert.equal(config.routing.powerGap, 20);
    assert.equal(config.routing.powerBonus, 25);
    assert.deepEqual(config.orchestrator, { vendor: 'claude', penalty: 30, reserveAt: 60 });
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

test('routing and orchestrator settings merge over the defaults', () => {
  withConfig((config) => {
    assert.equal(config.orchestrator.vendor, null);
    assert.equal(config.orchestrator.penalty, 10);
    assert.equal(config.orchestrator.reserveAt, 60);
    assert.equal(config.routing.powerGap, 15);
    assert.equal(config.routing.headroomWeight, 40);
    assert.equal(config.routing.powerBonus, 25);
    assert.equal(config.preference.first, 'codex');
    assert.equal(config.preference.weightPoints, 25);
  }, {
    orchestrator: { vendor: null, penalty: 10 },
    routing: { powerGap: 15 },
  });
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

async function withInstallHome(home, body) {
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const module = await import(`../src/install.mjs?home=${encodeURIComponent(home)}`);
    return await body(module);
  } finally {
    process.env.HOME = realHome;
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

function runDoctor(home, { config, stubs = [], agyProbe = false, agyResponse, agyExit = 0 } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'cmo-doctor-state-'));
  const configDir = mkdtempSync(join(tmpdir(), 'cmo-doctor-config-'));
  const binDir = mkdtempSync(join(tmpdir(), 'cmo-doctor-bin-'));
  try {
    if (config !== undefined) {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify(config), 'utf8');
    }
    for (const name of stubs) {
      const stub = join(binDir, name);
      const output = name === 'agy' && agyResponse !== undefined ? agyResponse : `${name} 0.0.0-stub\n`;
      const exit = name === 'agy' ? agyExit : 0;
      const body = name === 'agy'
        ? `if (process.argv.includes('/usage')) { process.stdout.write(${JSON.stringify(output)}); process.exit(${exit}); }\nprocess.stdout.write('agy 0.0.0-stub\\n');\n`
        : `process.stdout.write(${JSON.stringify(output)});\nprocess.exit(${exit});\n`;
      writeFileSync(stub, `#!${process.execPath}\n${body}`, { mode: 0o755 });
    }
    const env = { ...process.env };
    for (const key of [
      'CMO_AGY_BIN', 'CMO_GROK_BIN', 'CMO_FLEET_URL', 'CMO_FLEET_TOKEN',
      'CMO_CLAUDE_CREDENTIALS', 'CMO_CODEX_SESSIONS', 'XAI_API_KEY', 'GROK_CODE_XAI_API_KEY',
    ]) {
      delete env[key];
    }
    Object.assign(env, {
      HOME: home,
      PATH: binDir,
      CMO_CACHE_DIR: stateDir,
      CMO_CONFIG_DIR: configDir,
      CMO_CLAUDE_CLI_PROBE: '0',
      CMO_GROK_PROBE: '0',
      CMO_AGY_PROBE: agyProbe ? '1' : '0',
    });
    const stdout = execFileSync(
      process.execPath,
      [join(PACKAGE_ROOT, 'bin', 'cmo.mjs'), 'doctor'],
      { env, encoding: 'utf8' },
    );
    return { code: 0, stdout };
  } catch (err) {
    if (typeof err?.stdout === 'string') return { code: err.status ?? 1, stdout: err.stdout };
    throw err;
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
}

test('install wires the skill into every available host and the agent into Claude', () => {
  fakeHome((home) => {
    mkdirSync(join(home, '.gemini'), { recursive: true });
    const out = runInstall(home, ['install']);
    for (const dir of [
      join(home, '.claude/skills/cross-model-orchestrate'),
      join(home, '.codex/skills/cross-model-orchestrate'),
      join(home, '.agents/skills/cross-model-orchestrate'),
      join(home, '.kilo/skills/cross-model-orchestrate'),
      join(home, '.config/opencode/skills/cross-model-orchestrate'),
      join(home, '.gemini/config/skills/cross-model-orchestrate'),
    ]) {
      assert.ok(existsSync(join(dir, 'SKILL.md')), `${dir} should hold a readable skill`);
    }
    assert.ok(existsSync(join(home, '.claude/agents/codex-runner.md')));
    // Installing is step 1 of 3; the output has to say what the other two are,
    // because npm hides the postinstall banner by default.
    assert.match(out, /cmo install/);
    assert.match(out, /claude --model opus --effort high/);
    assert.match(out, /\/cross-model-orchestrate <what you want built>/);
    assert.match(out, /Any host with the skill can orchestrate with \`cmo run\` units/);
    assert.match(out, /Claude Code\s+adds Workflow fan-outs and steering/);
    assert.match(out, /Codex orchestrator needs network \(full access\)/);
  });
});

test('Antigravity links only after its home directory exists', async () => {
  const absentHome = mkdtempSync(join(tmpdir(), 'cmo-home-'));
  const presentHome = mkdtempSync(join(tmpdir(), 'cmo-home-'));
  try {
    const absentLog = [];
    await withInstallHome(absentHome, ({ install }) => install({ log: (line) => absentLog.push(line) }));
    assert.ok(!existsSync(join(absentHome, '.gemini')));
    assert.match(absentLog.join('\n'), /skip\s+.*\.gemini\/config\/skills\/cross-model-orchestrate.*\.gemini is absent/s);

    mkdirSync(join(presentHome, '.gemini'), { recursive: true });
    await withInstallHome(presentHome, async ({ install, uninstall }) => {
      await install({ log: () => {} });
      assert.ok(existsSync(join(presentHome, '.gemini/config/skills/cross-model-orchestrate/SKILL.md')));
      await uninstall({ log: () => {} });
    });
    assert.ok(!existsSync(join(presentHome, '.gemini/config/skills/cross-model-orchestrate')));
  } finally {
    rmSync(absentHome, { recursive: true, force: true });
    rmSync(presentHome, { recursive: true, force: true });
  }
});

test('banner describes orchestration from every host and says Antigravity links when ~/.gemini exists', () => {
  const text = nextSteps();
  assert.match(text, /links Antigravity when ~\/\.gemini exists/);
  assert.doesNotMatch(text, /OpenCode and Antigravity\./);
  assert.match(text, /Any host with the skill can orchestrate with \`cmo run\` units/);
  assert.match(text, /Claude Code\s+adds Workflow fan-outs and steering/);
  assert.match(text, /Codex orchestrator needs network \(full access\)/);
});

test('doctor reports an uninitialized optional skill host without a warning', () => {
  fakeHome((home) => {
    runInstall(home, ['install']);
    const sessionDir = join(home, '.codex/sessions/2026/11/22');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'rollout-1.jsonl'),
      `${JSON.stringify({ payload: { type: 'token_count', rate_limits: { primary: { used_percent: 5, window_minutes: 300 } } } })}\n`,
      'utf8',
    );

    const absent = runDoctor(home, { config: { providers: ['codex'] }, stubs: ['codex'] });
    assert.equal(absent.code, 0);
    assert.match(absent.stdout, /^\s+ok\s+antigravity\s+not initialized \(optional\)$/m);
    assert.match(absent.stdout, /^everything checks out\.$/m);

    mkdirSync(join(home, '.gemini'), { recursive: true });
    const unlinked = runDoctor(home, { config: { providers: ['codex'] }, stubs: ['codex'] });
    assert.match(unlinked.stdout, /^\s+warn\s+antigravity\s+not installed$/m);
  });
});

test('doctor adds an install hint and todo step when agy is missing', () => {
  fakeHome((home) => {
    const out = runDoctor(home, { stubs: ['codex', 'claude'] });
    assert.match(out.stdout, /^\s+warn\s+agy\s+not on PATH — curl -fsSL https:\/\/antigravity\.google\/cli\/install\.sh \| bash$/m);
    assert.match(out.stdout, /to finish setup[\s\S]*curl -fsSL https:\/\/antigravity\.google\/cli\/install\.sh \| bash\s+# an active vendor is unavailable/);
  });
});

test('doctor does not fail the antigravity sign-in or headroom rows when agy is absent', () => {
  fakeHome((home) => {
    const out = runDoctor(home, { stubs: ['codex', 'claude'], agyProbe: true });
    assert.equal(out.code, 0);
    assert.doesNotMatch(out.stdout, /^\s+FAIL\s+antigravity sign-in/m);
    assert.doesNotMatch(out.stdout, /^\s+FAIL\s+antigravity\s+not read/m);
  });
});

test('doctor verifies a fake installed agy subscription meter', () => {
  fakeHome((home) => {
    const usage = JSON.stringify({ command: { data: { groups: [{ name: 'Gemini Models', buckets: [
      { id: 'gemini-5h', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
      { id: 'gemini-weekly', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
    ] }] } } });
    const out = runDoctor(home, { stubs: ['codex', 'claude', 'agy'], agyProbe: true, agyResponse: usage });
    assert.equal(out.code, 0);
    assert.match(out.stdout, /^\s+ok\s+antigravity sign-in\s+subscription quota verified/m);
    assert.match(out.stdout, /^\s+ok\s+antigravity\s+5hr 0%  Wkly 0%/m);
  });
});

test('doctor gives an installed but unsigned agy a sign-in todo', () => {
  fakeHome((home) => {
    const out = runDoctor(home, { stubs: ['codex', 'claude', 'agy'], agyProbe: true, agyExit: 2 });
    assert.equal(out.code, 1);
    assert.match(out.stdout, /^\s+FAIL\s+antigravity sign-in\s+an API-key login has no subscription quota/m);
    assert.match(out.stdout, /agy\s+# sign in to a subscription account — antigravity dispatches are not routable/);
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
    mkdirSync(join(home, '.gemini'), { recursive: true });
    runInstall(home, ['install']);
    const foreign = join(home, '.kilo/skills/someone-elses');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'SKILL.md'), '# theirs\n');

    runInstall(home, ['uninstall']);

    assert.ok(!existsSync(join(home, '.claude/skills/cross-model-orchestrate')));
    assert.ok(!existsSync(join(home, '.gemini/config/skills/cross-model-orchestrate')));
    assert.ok(!existsSync(join(home, '.claude/agents/codex-runner.md')));
    assert.ok(existsSync(join(foreign, 'SKILL.md')), 'unrelated skills survive uninstall');
  });
});

test('an npx checkout is detected so we copy instead of dangling a symlink', () => {
  assert.equal(packageIsEphemeral('/home/x/.npm/_npx/abc123/node_modules/cross-model-orchestrate'), true);
  assert.equal(packageIsEphemeral('/usr/lib/node_modules/cross-model-orchestrate'), false);
});
