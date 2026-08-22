// doctor.mjs — "will this actually work on my machine?"
//
// Almost every failure report for a tool like this is one of five things: a CLI
// that is not installed, a CLI that is installed but not logged in, a model ID
// that does not exist on this account, a skill that never got installed, or a
// usage endpoint that will not answer. Check all five and say which.

import { execFile } from 'node:child_process';
import { readFile, lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { loadConfig, TIERS } from './config.mjs';
import { readLimits } from './limits.mjs';
import { AGENT_DIR, SKILL_HOSTS } from './install.mjs';
import { health } from './remote.mjs';

const execFileAsync = promisify(execFile);

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'FAIL';

async function binaryVersion(binary) {
  try {
    const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 15_000 });
    return stdout.trim().split('\n')[0];
  } catch {
    return null;
  }
}

/**
 * Codex caches the model list it was offered. If we can read it, we can catch a
 * stale model ID before it costs a failed agent halfway through a run.
 */
async function codexKnownModels() {
  for (const path of [
    join(process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex'), 'models_cache.json'),
  ]) {
    try {
      const raw = await readFile(path, 'utf8');
      const ids = new Set();
      for (const match of raw.matchAll(/"(gpt-[a-z0-9.\-]+)"/gi)) ids.add(match[1]);
      if (ids.size) return ids;
    } catch {
      /* no cache — not an error, just no cross-check */
    }
  }
  return null;
}

async function skillLocations(skillName) {
  const rows = [];
  for (const host of SKILL_HOSTS) {
    const target = join(host.dir, skillName);
    try {
      const stat = await lstat(target);
      const via = stat.isSymbolicLink() ? `→ ${await readlink(target)}` : '(copy)';
      let live = true;
      try {
        await lstat(join(target, 'SKILL.md'));
      } catch {
        live = false;
      }
      rows.push({ host: host.id, state: live ? OK : FAIL, detail: live ? via : `${via} (broken)` });
    } catch {
      rows.push({ host: host.id, state: WARN, detail: 'not installed' });
    }
  }
  return rows;
}

export async function doctor({ skillName = 'cross-model-orchestrate', log = (l) => process.stdout.write(`${l}\n`) } = {}) {
  const config = loadConfig({ reload: true });
  let failures = 0;
  let warnings = 0;
  const line = (state, label, detail = '') => {
    if (state === FAIL) failures += 1;
    if (state === WARN) warnings += 1;
    log(`  ${state.padEnd(4)} ${label.padEnd(30)} ${detail}`);
  };

  log('provider CLIs');
  const [codexVersion, claudeVersion] = await Promise.all([
    binaryVersion('codex'),
    binaryVersion('claude'),
  ]);
  line(codexVersion ? OK : WARN, 'codex', codexVersion ?? 'not on PATH — codex dispatch unavailable');
  line(claudeVersion ? OK : WARN, 'claude', claudeVersion ?? 'not on PATH — claude dispatch unavailable');
  if (!codexVersion && !claudeVersion) {
    line(FAIL, 'at least one provider', 'install codex or claude and log in');
  }

  log('\nauth');
  try {
    const raw = JSON.parse(await readFile(config.claudeCredentials, 'utf8'));
    const token = raw?.claudeAiOauth?.accessToken;
    const expiresAt = raw?.claudeAiOauth?.expiresAt;
    if (!token) line(WARN, 'claude oauth', 'no accessToken — run `claude` once');
    else if (typeof expiresAt === 'number' && expiresAt < Date.now()) {
      line(WARN, 'claude oauth', 'token expired — run `claude` once to refresh');
    } else line(OK, 'claude oauth', config.claudeCredentials);
  } catch {
    line(WARN, 'claude oauth', `unreadable: ${config.claudeCredentials}`);
  }

  log('\nfleet');
  const fleet = await health();
  if (!fleet.configured) {
    line(OK, 'coordination', 'single machine (set CMO_FLEET_URL + CMO_FLEET_TOKEN to share)');
  } else if (fleet.reachable) {
    line(OK, 'coordinator', fleet.url);
  } else {
    // Configured but down is worse than not configured: every box silently
    // reverts to seeing only itself, which is exactly when they overrun.
    line(FAIL, 'coordinator', `${fleet.url} unreachable — ${fleet.error ?? 'no response'}`);
  }

  log('\nheadroom');
  const limits = await readLimits({ refresh: true });
  for (const provider of ['codex', 'claude']) {
    const p = limits[provider];
    if (!p.available) {
      line(WARN, provider, p.error ?? 'unavailable');
      continue;
    }
    const windows = p.windows.map((w) => `${w.label} ${w.percentUsed}%`).join('  ');
    line(OK, provider, `${windows}${p.plan ? `  plan=${p.plan}` : ''}`);
  }

  const missingCodexModels = [];
  log('\nmodels');
  log(`  ${config.configFileFound ? 'from' : 'defaults; no config at'} ${config.configFile}`);
  const known = await codexKnownModels();
  for (const provider of ['codex', 'claude']) {
    for (const tier of TIERS) {
      const spec = config.models[provider][tier];
      const extra = spec.effort ? `effort=${spec.effort}` : spec.reasoning ? `reasoning=${spec.reasoning}` : '';
      let state = OK;
      let note = extra;
      if (provider === 'codex' && known && !known.has(spec.model)) {
        state = FAIL;
        note = `${extra} — this codex CLI does not offer it`.trim();
        missingCodexModels.push(spec.model);
      }
      line(state, `${provider} ${tier}`, `${spec.model} ${note}`.trim());
    }
  }
  if (!known) {
    log('  (no codex model cache found — model IDs were not cross-checked)');
  }

  // A failure that does not say what to do about it is a support question.
  // This one fires on almost every new machine, because an older codex CLI
  // exposes different model IDs.
  if (missingCodexModels.length) {
    // The cache holds display names as well as ids ("GPT-5.6-Luna" beside
    // "gpt-5.6-luna"). Only the lowercase ids are usable in config, and
    // printing the other kind sends people to paste a string that will not work.
    const offered = [...known].filter((m) => m === m.toLowerCase()).sort();
    log('');
    log(`  ${missingCodexModels.length} configured codex model(s) are unavailable here.`);
    log(`  This codex CLI (${codexVersion ?? 'unknown version'}) offers: ${offered.join(', ')}`);
    log('  Fix it either way:');
    log('    npm install -g @openai/codex@latest      # if the CLI is simply old');
    log(`    ${config.configFile}`);
    log('      {"models":{"codex":{"fast":"<id>","balanced":"<id>","frontier":"<id>"}}}');
    log('  Or set CMO_CODEX_FAST / CMO_CODEX_BALANCED / CMO_CODEX_FRONTIER.');
  }

  log('\nskill install');
  for (const row of await skillLocations(skillName)) {
    line(row.state, row.host, row.detail);
  }
  try {
    await lstat(join(AGENT_DIR, 'codex-runner.md'));
    line(OK, 'claude codex-runner agent', AGENT_DIR);
  } catch {
    line(WARN, 'claude codex-runner agent', 'not installed — workflows cannot dispatch to codex');
  }

  log('');
  if (failures) log(`${failures} failure(s), ${warnings} warning(s). Fix the failures before running a fan-out.`);
  else if (warnings) log(`no failures, ${warnings} warning(s). Anything marked "warn" degrades gracefully.`);
  else log('everything checks out.');
  return failures === 0 ? 0 : 1;
}
