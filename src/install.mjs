// install.mjs — put the skill and the dispatch shim where each agent host reads.
//
// Five hosts read skills from five different directories and none of them agree
// on a location, so installation is a fan-out. Everything is idempotent, and
// nothing that already exists and is not ours is ever replaced.

import { cp, mkdir, lstat, readlink, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(HERE, '..');

/**
 * Where each host looks for skills. Claude also has a separate agents dir for
 * subagent definitions; the others have no equivalent, which is exactly why the
 * orchestration half of this tool is Claude-only today.
 */
export const SKILL_HOSTS = [
  { id: 'claude', dir: join(homedir(), '.claude', 'skills') },
  { id: 'codex', dir: join(homedir(), '.codex', 'skills') },
  { id: 'agents', dir: join(homedir(), '.agents', 'skills') },
  { id: 'kilo', dir: join(homedir(), '.kilo', 'skills') },
  { id: 'opencode', dir: join(homedir(), '.config', 'opencode', 'skills') },
];

export const AGENT_DIR = join(homedir(), '.claude', 'agents');

const MARKER = '.cross-model-orchestrate';

async function pathKind(path) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      const target = await readlink(path);
      let live = true;
      try {
        await lstat(resolve(dirname(path), target));
      } catch {
        live = false;
      }
      return { kind: 'symlink', target, live };
    }
    return { kind: stat.isDirectory() ? 'dir' : 'file' };
  } catch {
    return { kind: 'missing' };
  }
}

/**
 * True when this path is one we previously installed, so replacing it is safe.
 * Three ways to qualify: it points into this package, it is a dangling symlink
 * (nobody's working install is broken), or it carries our marker file.
 */
async function isOurs(path, info) {
  if (info.kind === 'symlink') {
    if (!info.live) return true;
    const target = resolve(dirname(path), info.target);
    if (target.startsWith(PACKAGE_ROOT)) return true;
    // A link into ANOTHER copy of this same package — a source checkout when
    // you later install from npm, or a package root that moved between
    // versions. Still ours, and still safe to relink. Without this, switching
    // install methods leaves you with "not ours to replace" and no way
    // forward but deleting the links by hand.
    return /[/\\]cross-model-orchestrate[/\\](skill|agents)([/\\]|$)/.test(target);
  }
  if (info.kind === 'dir') {
    try {
      await lstat(join(path, MARKER));
      return true;
    } catch {
      return false;
    }
  }
  if (info.kind === 'file') {
    try {
      return (await readFile(path, 'utf8')).includes('cross-model-orchestrate');
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * npx unpacks into a temp directory that disappears, so a symlink into it would
 * dangle the moment the command exits. Detect that and copy instead.
 */
export function packageIsEphemeral(root = PACKAGE_ROOT) {
  return /[/\\](_npx|\.npm[/\\]_cacache)[/\\]/.test(root);
}

async function place(source, target, { copy, log }) {
  const info = await pathKind(target);

  if (info.kind !== 'missing' && !(await isOurs(target, info))) {
    log(`  skip   ${target}\n         something else is already there — not ours to replace`);
    return 'skipped';
  }

  if (info.kind === 'symlink' && info.live && !copy && resolve(dirname(target), info.target) === source) {
    log(`  ok     ${target}`);
    return 'unchanged';
  }

  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });

  if (copy) {
    await cp(source, target, { recursive: true });
    const stat = await lstat(target);
    if (stat.isDirectory()) {
      await writeFile(join(target, MARKER), `${PACKAGE_ROOT}\n`, 'utf8');
    }
    log(`  copied ${target}`);
    return 'copied';
  }

  await symlink(source, target);
  log(`  linked ${target} → ${source}`);
  return 'linked';
}

/**
 * @param {object} opts
 *   skillName  directory name the skill is installed under (default from the
 *              package name; rename it if it collides with something you have)
 *   copy       copy instead of symlink (forced when running from npx)
 *   hosts      subset of SKILL_HOSTS ids
 *   log        sink for progress lines
 */
export async function install(opts = {}) {
  const {
    skillName = 'cross-model-orchestrate',
    hosts = SKILL_HOSTS.map((h) => h.id),
    log = (line) => process.stdout.write(`${line}\n`),
  } = opts;

  const ephemeral = packageIsEphemeral();
  const copy = opts.copy ?? ephemeral;

  if (ephemeral && opts.copy !== false) {
    log('running from a temporary npx checkout — copying instead of linking.');
    log('install globally (npm i -g cross-model-orchestrate) so `cmo` is on PATH');
    log('for subagents, and so updates reach the installed skill.\n');
  }

  const results = [];
  log(`skill "${skillName}":`);
  for (const host of SKILL_HOSTS) {
    if (!hosts.includes(host.id)) continue;
    await mkdir(host.dir, { recursive: true });
    results.push({
      host: host.id,
      action: await place(join(PACKAGE_ROOT, 'skill'), join(host.dir, skillName), { copy, log }),
    });
  }

  log('\nsubagent definition (Claude Code only):');
  await mkdir(AGENT_DIR, { recursive: true });
  results.push({
    host: 'claude-agent',
    action: await place(
      join(PACKAGE_ROOT, 'agents', 'codex-runner.md'),
      join(AGENT_DIR, 'codex-runner.md'),
      { copy, log },
    ),
  });

  const skipped = results.filter((r) => r.action === 'skipped');
  log('');
  if (skipped.length) {
    log(`${skipped.length} location(s) skipped — remove them by hand, or pass --skill-name`);
    log('to install under a different name.');
  }
  const { nextSteps } = await import('./banner.mjs');
  log(nextSteps({ done: 1 }).trimEnd());
  return results;
}

export async function uninstall(opts = {}) {
  const {
    skillName = 'cross-model-orchestrate',
    log = (line) => process.stdout.write(`${line}\n`),
  } = opts;

  for (const host of SKILL_HOSTS) {
    const target = join(host.dir, skillName);
    const info = await pathKind(target);
    if (info.kind === 'missing') continue;
    if (!(await isOurs(target, info))) {
      log(`  skip   ${target} — not ours`);
      continue;
    }
    await rm(target, { recursive: true, force: true });
    log(`  removed ${target}`);
  }

  const agent = join(AGENT_DIR, 'codex-runner.md');
  const info = await pathKind(agent);
  if (info.kind !== 'missing' && (await isOurs(agent, info))) {
    await rm(agent, { force: true });
    log(`  removed ${agent}`);
  }
  log('\nthe npm package itself is still installed: npm rm -g cross-model-orchestrate');
}
