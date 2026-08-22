// update.mjs — upgrade the vendor CLIs, deliberately and never by accident.
//
// `doctor` refuses to do this, and should: a diagnostic that mutates the system
// breaks its own contract, and these are not our packages. But the fix it
// prints is tedious to run across a fleet, so here is an explicit command that
// runs it — with the guards that make mutation safe.
//
//   in flight   Refuses while this machine has dispatches running. Swapping the
//               codex binary mid-run can change the model ids underneath agents
//               that already resolved them.
//   confident   Only runs a command whose install method was actually detected.
//               Telling a Homebrew user to npm install leaves two copies and a
//               PATH puzzle, so an unknown install gets advice, not action.
//   explicit    Prints the plan and stops. Nothing runs without --yes.
//   honest      Reports the version before and after, so "updated" means
//               something changed rather than that a command exited 0.

import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';

import { snapshot } from './ledger.mjs';
import { identity } from './remote.mjs';

const execFileAsync = promisify(execFile);

/** Resolve where a binary really lives, portably. */
async function resolveBinary(binary) {
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [binary]);
    return await realpath(stdout.trim().split('\n')[0]);
  } catch {
    return null;
  }
}

async function version(binary) {
  try {
    const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 15_000 });
    return stdout.trim().split('\n')[0];
  } catch {
    return null;
  }
}

/**
 * What we would run for each target, or why we would not.
 * Exported for tests: the decision must be inspectable without executing it.
 */
export function commandFor(target, realPath) {
  if (!realPath) return { skip: 'not installed' };

  if (target === 'claude') {
    // Claude Code ships its own updater and knows its own install shape.
    return { cmd: 'claude', args: ['update'] };
  }

  if (/[/\\]node_modules[/\\]@openai[/\\]codex[/\\]/.test(realPath)) {
    return { cmd: 'npm', args: ['install', '-g', '@openai/codex@latest'] };
  }
  if (/[/\\]node_modules[/\\]cross-model-orchestrate[/\\]/.test(realPath)) {
    return { cmd: 'npm', args: ['install', '-g', 'cross-model-orchestrate@latest'] };
  }
  if (/[/\\](Cellar|homebrew|linuxbrew)[/\\]/i.test(realPath)) {
    return { cmd: 'brew', args: ['upgrade', target] };
  }
  return { skip: `installed somewhere this cannot upgrade safely (${realPath})` };
}

const TARGETS = [
  { name: 'codex', binary: 'codex' },
  { name: 'claude', binary: 'claude' },
  { name: 'cross-model-orchestrate', binary: 'cmo', self: true },
];

/** How many dispatches this machine currently has running. */
export async function localInFlight() {
  try {
    const state = await snapshot();
    const me = identity().node;
    return state.reservations.filter((r) => !r.node || r.node === me).length;
  } catch {
    return 0;
  }
}

export async function plan({ includeSelf = false } = {}) {
  const rows = [];
  for (const t of TARGETS) {
    if (t.self && !includeSelf) continue;
    const real = await resolveBinary(t.binary);
    rows.push({ ...t, real, before: await version(t.binary), ...commandFor(t.name, real) });
  }
  return rows;
}

export async function update({
  yes = false,
  includeSelf = false,
  force = false,
  log = (l) => process.stdout.write(`${l}\n`),
} = {}) {
  const busy = await localInFlight();
  if (busy > 0 && !force) {
    log(`${busy} dispatch(es) are running on this machine.`);
    log('Upgrading a vendor CLI now can change model ids underneath agents that');
    log('have already resolved them. Wait for them to finish, or pass --force if');
    log('you know what those agents are doing.');
    return 3;
  }

  const rows = await plan({ includeSelf });
  log(yes ? 'updating:' : 'would run:');
  for (const r of rows) {
    if (r.skip) log(`  skip   ${r.name.padEnd(24)} ${r.skip}`);
    else log(`  ${yes ? 'run ' : 'plan'}   ${r.name.padEnd(24)} ${r.cmd} ${r.args.join(' ')}`);
  }

  if (!yes) {
    log('');
    log('Nothing has changed. Re-run with --yes to execute.');
    return 0;
  }

  let failures = 0;
  for (const r of rows) {
    if (r.skip) continue;
    try {
      await execFileAsync(r.cmd, r.args, { timeout: 300_000 });
      const after = await version(r.binary);
      log(after === r.before
        ? `  ok     ${r.name.padEnd(24)} already current (${after ?? 'unknown'})`
        : `  ok     ${r.name.padEnd(24)} ${r.before ?? '?'} -> ${after ?? '?'}`);
    } catch (err) {
      failures += 1;
      log(`  FAIL   ${r.name.padEnd(24)} ${(err?.message ?? String(err)).split('\n')[0].slice(0, 90)}`);
    }
  }

  log('');
  log(failures ? `${failures} update(s) failed.` : 'run `cmo doctor` to confirm the model map still resolves.');
  return failures ? 1 : 0;
}
