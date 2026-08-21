// selftest.mjs — offline proof that the decision table still says what the
// orchestrator's instructions claim it says.
//
// `npm test` is the real suite. This is the operator-facing version: no
// network, no spawn, prints the matrix so a human can see the policy rather
// than read it. The model names in the output come from your config, so this
// doubles as a check that an override landed.

import { decide } from './policy.mjs';
import { buildCommand, classifyFailure, extractJson } from './run.mjs';

const HEALTHY = { available: true, worstPercent: 5, nextResetAt: null, hardBlocked: false, windows: [{ key: '5h', percentUsed: 5 }] };
const TIGHT = { available: true, worstPercent: 72, nextResetAt: null, hardBlocked: false, windows: [{ key: '5h', percentUsed: 72 }] };
const SPENT = { available: true, worstPercent: 99, nextResetAt: '2026-08-22T00:00:00.000Z', hardBlocked: true, windows: [{ key: '5h', percentUsed: 99 }] };

const CASES = [
  {
    name: 'mechanical work goes to the cheapest preferred-vendor model',
    task: { role: 'mechanical', complexity: 1, length: 'xs' },
    limits: { codex: HEALTHY, claude: HEALTHY },
    expect: (d) => d.provider === 'codex' && d.tier === 'fast',
  },
  {
    name: 'architecture goes frontier',
    task: { role: 'architecture', complexity: 5, length: 'l' },
    limits: { codex: HEALTHY, claude: HEALTHY },
    expect: (d) => d.tier === 'frontier',
  },
  {
    name: 'codex exhausted falls back to claude',
    task: { role: 'implement', complexity: 3, length: 'm' },
    limits: { codex: SPENT, claude: HEALTHY },
    expect: (d) => d.provider === 'claude',
  },
  {
    name: 'review of codex output is forced onto claude',
    task: { role: 'review', complexity: 3, length: 's', independentOf: 'codex' },
    limits: { codex: HEALTHY, claude: HEALTHY },
    expect: (d) => d.provider === 'claude',
  },
  {
    name: 'review of claude output is forced onto codex',
    task: { role: 'review', complexity: 3, length: 's', independentOf: 'claude' },
    limits: { codex: TIGHT, claude: HEALTHY },
    expect: (d) => d.provider === 'codex',
  },
  {
    name: 'both spent defers instead of burning the run',
    task: { role: 'implement', complexity: 3, length: 'm' },
    limits: { codex: SPENT, claude: SPENT },
    expect: (d) => d.ok === false && d.defer === true,
  },
  {
    name: 'a judge is never dispatched to the fast tier',
    task: { role: 'judge', complexity: 1, length: 'xs' },
    limits: { codex: HEALTHY, claude: HEALTHY },
    expect: (d) => d.tier !== 'fast',
  },
  {
    name: 'bulk reading does not get a frontier model',
    task: { role: 'synthesis', complexity: 3, length: 'xl', contextTokens: 250_000 },
    limits: { codex: HEALTHY, claude: HEALTHY },
    expect: (d) => d.tier === 'balanced',
  },
];

const UNIT = [
  {
    name: 'codex command is non-interactive and reads the prompt from stdin',
    run: () => {
      const { binary, args } = buildCommand(
        { provider: 'codex', model: 'gpt-5.6-terra', reasoning: 'medium' },
        { cwd: '/repo', lastMessageFile: '/tmp/last.txt' },
      );
      return binary === 'codex'
        && args.at(-1) === '-'
        && args.includes('--skip-git-repo-check')
        && args.includes('--json');
    },
  },
  {
    name: 'claude command skips permission prompts',
    run: () => {
      const { args } = buildCommand(
        { provider: 'claude', model: 'sonnet', effort: 'medium' },
        { cwd: '/repo', lastMessageFile: '/tmp/last.txt' },
      );
      return args.includes('--dangerously-skip-permissions') && args.includes('--effort');
    },
  },
  {
    name: 'a usage-limit message is classified as rate-limit, not fatal',
    run: () => classifyFailure({ code: 1, stderr: 'You have hit your usage limit' }) === 'rate-limit',
  },
  {
    name: 'a fenced JSON verdict is recovered',
    run: () => extractJson('sure:\n```json\n{"score":22}\n```')?.score === 22,
  },
];

export function selftest() {
  let failures = 0;
  process.stdout.write('decision table\n');
  for (const c of CASES) {
    const d = decide(c.task, c.limits);
    const pass = c.expect(d);
    if (!pass) failures += 1;
    const got = d.ok ? `${d.provider} ${d.model} (${d.tier})` : `defer → ${d.resumeAfter ?? 'unknown'}`;
    process.stdout.write(`  ${pass ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(52)} ${got}\n`);
  }
  process.stdout.write('\nunit checks\n');
  for (const u of UNIT) {
    let pass = false;
    try {
      pass = Boolean(u.run());
    } catch {
      pass = false;
    }
    if (!pass) failures += 1;
    process.stdout.write(`  ${pass ? 'ok  ' : 'FAIL'}  ${u.name}\n`);
  }
  process.stdout.write(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}\n`);
  return failures === 0 ? 0 : 1;
}
