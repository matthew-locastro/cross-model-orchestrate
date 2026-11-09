// selftest.mjs — offline proof that the decision table still says what the
// orchestrator's instructions claim it says.
//
// `npm test` is the real suite. This is the operator-facing version: no
// network, no spawn, prints the matrix so a human can see the policy rather
// than read it. The model names in the output come from your config, so this
// doubles as a check that an override landed.

import { decide } from './policy.mjs';
import { buildCommand, childEnv, classifyFailure, extractJson, parseClaudeStdout } from './run.mjs';
import { parseClaudeAuthFailure } from './limits.mjs';
import { grokAuthFrom, offSubscriptionReason, parseGrokModels } from './grok.mjs';

const HEALTHY = { available: true, worstPercent: 5, nextResetAt: null, hardBlocked: false, windows: [{ key: '5h', percentUsed: 5 }] };
const atPercent = (percent) => ({
  available: true, worstPercent: percent, nextResetAt: null, hardBlocked: false,
  windows: [{ key: '5h', percentUsed: percent }],
});
const TIGHT = { available: true, worstPercent: 72, nextResetAt: null, hardBlocked: false, windows: [{ key: '5h', percentUsed: 72 }] };
const SPENT = { available: true, worstPercent: 99, nextResetAt: '2026-08-22T00:00:00.000Z', hardBlocked: true, windows: [{ key: '5h', percentUsed: 99 }] };

// Pace cases need reset times relative to the clock the decision will read.
const from = (ms) => new Date(Date.now() + ms).toISOString();
const HOUR = 3_600_000;
const weekly = (used, leftMs) => ({ key: 'weekly', label: 'Wkly', percentUsed: used, resetsAt: from(leftMs) });
const fiveHour = (used, leftMs) => ({ key: '5h', label: '5hr', percentUsed: used, resetsAt: from(leftMs) });
const paced = (windows) => {
  const worst = windows.reduce((a, w) => (w.percentUsed > a.percentUsed ? w : a));
  return { available: true, worstPercent: worst.percentUsed, worstWindow: worst.key, nextResetAt: worst.resetsAt, hardBlocked: false, windows };
};
// Grok is routable only with a verified subscription sign-in on the reading.
const SUBSCRIBED = { ok: true, method: 'oauth', authMode: 'Oidc', tier: 'SuperGrok Plus' };
const grokAt = (percent) => ({ ...atPercent(percent), provider: 'grok', auth: SUBSCRIBED });
const GROK_OK = { ...paced([weekly(9, 108 * HOUR)]), provider: 'grok', auth: SUBSCRIBED };
const GROK_SIGNED_OUT = { available: false, provider: 'grok', windows: [], auth: { ok: false, method: 'none', reason: 'not signed in' } };
const GROK_ON_KEY = { ...GROK_OK, auth: { ok: false, method: 'api-key', reason: 'XAI_API_KEY' } };
const CLAUDE_SIGNED_OUT = { available: false, provider: 'claude', windows: [], auth: { ok: false, method: 'none', reason: 'the claude CLI is signed out' } };
const CLAUDE_AUTH_RESULT = JSON.stringify({
  type: 'result', subtype: 'success', is_error: true, total_cost_usd: 0,
  result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
});
const WEEK_SQUEEZED = paced([weekly(80, 120 * HOUR)]); // 20% must last five days
const WEEK_EXPIRING = paced([weekly(80, 12 * HOUR)]); // 20% for twelve hours
const BLIP = paced([fiveHour(70, HOUR / 3), weekly(10, 144 * HOUR)]); // clears in twenty minutes

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
    name: 'a weekly squeeze with days to go loses to a 5-hour blip about to clear',
    task: { role: 'implement', complexity: 3, length: 'm' },
    limits: { codex: WEEK_SQUEEZED, claude: BLIP },
    expect: (d) => d.provider === 'claude' && d.states.codex.state === 'critical' && d.states.claude.state === 'ok',
  },
  {
    name: 'expiring weekly budget stays usable, and a far emptier side is power-used',
    task: { role: 'implement', complexity: 3, length: 'm' },
    limits: { codex: WEEK_EXPIRING, claude: HEALTHY },
    expect: (d) => d.states.codex.state === 'ok' && d.provider === 'claude' && /power-use:/.test(d.reason),
  },
  {
    name: 'a pace-critical provider still serves the cross-vendor review only it can do',
    task: { role: 'review', complexity: 3, length: 's', independentOf: 'claude' },
    limits: { codex: WEEK_SQUEEZED, claude: HEALTHY },
    expect: (d) => d.provider === 'codex' && d.independence === 'cross-vendor',
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
    name: 'grok never runs unless signed in to a subscription',
    task: { role: 'research', complexity: 2, length: 's', needsWeb: true },
    limits: { codex: SPENT, claude: SPENT, grok: GROK_SIGNED_OUT },
    expect: (d) => d.ok === false && d.defer === true,
  },
  {
    name: 'grok on an API key is refused even when pinned',
    task: { role: 'research', complexity: 2, length: 's', pin: 'grok' },
    limits: { codex: HEALTHY, claude: HEALTHY, grok: GROK_ON_KEY },
    expect: (d) => d.ok === false,
  },
  {
    name: 'research goes to grok when it is signed in',
    task: { role: 'research', complexity: 2, length: 's' },
    limits: { codex: HEALTHY, claude: HEALTHY, grok: GROK_OK },
    expect: (d) => d.provider === 'grok',
  },
  {
    name: 'web work never goes to codex',
    task: { role: 'implement', complexity: 3, length: 'm', needsWeb: true },
    limits: { codex: HEALTHY, claude: HEALTHY, grok: GROK_SIGNED_OUT },
    expect: (d) => d.provider === 'claude' && !d.fallbacks.some((f) => f.provider === 'codex'),
  },
  {
    name: 'even headroom tie-breaks to codex and keeps claude in reserve',
    task: { role: 'implement', complexity: 3, length: 'm' },
    limits: { codex: HEALTHY, claude: HEALTHY, grok: GROK_OK },
    expect: (d) => d.provider === 'codex' && d.fallbacks.length === 2,
  },
  {
    name: 'review of grok output never runs on grok',
    task: { role: 'review', complexity: 3, length: 's', independentOf: 'grok' },
    limits: { codex: SPENT, claude: HEALTHY, grok: GROK_OK },
    expect: (d) => d.provider === 'claude' && d.independence === 'cross-vendor'
      && !d.fallbacks.some((f) => f.provider === 'grok'),
  },
  {
    name: 'grok is the cross-vendor reviewer when claude is spent',
    task: { role: 'review', complexity: 3, length: 's', independentOf: 'codex' },
    limits: { codex: HEALTHY, claude: SPENT, grok: GROK_OK },
    expect: (d) => d.provider === 'grok' && d.independence === 'cross-vendor',
  },
  {
    name: 'a signed-out claude CLI is never routed to',
    task: { role: 'review', complexity: 3, length: 's', independentOf: 'codex' },
    limits: { codex: HEALTHY, claude: CLAUDE_SIGNED_OUT, grok: GROK_OK },
    expect: (d) => d.provider === 'grok' && !d.fallbacks.some((f) => f.provider === 'claude'),
  },
  {
    name: 'bulk reading does not get a frontier model',
    task: { role: 'synthesis', complexity: 3, length: 'xl', contextTokens: 250_000 },
    limits: { codex: HEALTHY, claude: HEALTHY },
    expect: (d) => d.tier === 'balanced',
  },
  {
    name: 'power-use: grok at 6% beats codex at 67%, claude at 60% stays reserved',
    task: { role: 'implement', complexity: 4, length: 'l' },
    limits: { codex: atPercent(67), claude: atPercent(60), grok: grokAt(6) },
    expect: (d) => d.provider === 'grok'
      && /power-use: grok is 61 points less used than codex/.test(d.reason)
      && d.notes.some((n) => n === 'claude reserved for the orchestrator (pressure 60% ≥ 60%)'),
  },
  {
    name: 'power-use: codex at 10% beats grok at 50% and claude at 30%',
    task: { role: 'implement', complexity: 3, length: 'm' },
    limits: { codex: atPercent(10), claude: atPercent(30), grok: grokAt(50) },
    expect: (d) => d.provider === 'codex'
      && /power-use: codex is 20 points less used than claude/.test(d.reason),
  },
  {
    name: 'claude wins when its differential beats the orchestrator penalty',
    task: { role: 'implement', complexity: 3, length: 'm' },
    limits: { codex: atPercent(40), claude: atPercent(5), grok: grokAt(45) },
    expect: (d) => d.provider === 'claude'
      && /power-use: claude is 35 points less used than codex/.test(d.reason)
      && /claude loses 30 to keep orchestrator headroom/.test(d.reason),
  },
  {
    name: 'claude above reserveAt is never chosen while anyone else can run',
    task: { role: 'implement', complexity: 3, length: 'm' },
    limits: { codex: atPercent(40), claude: atPercent(70), grok: grokAt(45) },
    expect: (d) => d.provider === 'codex'
      && d.notes.some((n) => /claude reserved for the orchestrator \(pressure 70% ≥ 60%\)/.test(n)),
  },
  {
    name: 'claude above reserveAt still runs when every other vendor is exhausted',
    task: { role: 'implement', complexity: 3, length: 'm' },
    limits: { codex: SPENT, claude: atPercent(72), grok: { ...grokAt(99), hardBlocked: true } },
    expect: (d) => d.provider === 'claude'
      && /used because nothing else can run/.test(d.reason),
  },
  {
    name: 'a review independent of codex goes to grok, not a reserved claude',
    task: { role: 'review', complexity: 3, length: 's', independentOf: 'codex' },
    limits: { codex: atPercent(20), claude: atPercent(75), grok: grokAt(12) },
    expect: (d) => d.provider === 'grok' && d.independence === 'cross-vendor'
      && !d.fallbacks.some((f) => f.provider === 'codex'),
  },
  {
    name: 'research still goes to a healthy grok on affinity',
    task: { role: 'research', complexity: 2, length: 's' },
    limits: { codex: atPercent(15), claude: atPercent(20), grok: grokAt(25) },
    expect: (d) => d.provider === 'grok' && /preferred for research/.test(d.reason),
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
    name: 'grok command takes its prompt from a file and cannot prompt for permission',
    run: () => {
      const { args } = buildCommand(
        { provider: 'grok', model: 'grok-4.7', effort: 'medium' },
        { cwd: '/repo', promptFile: '/tmp/prompt.md', grokBinary: '/x/grok' },
      );
      const at = (flag) => args[args.indexOf(flag) + 1];
      return at('--prompt-file') === '/tmp/prompt.md'
        && at('--output-format') === 'streaming-messages-json'
        && at('--permission-mode') === 'bypassPermissions'
        && at('--reasoning-effort') === 'medium';
    },
  },
  {
    name: 'every child loses its xAI keys and gets the API-key lock',
    run: () => {
      const env = childEnv({ XAI_API_KEY: 'k', GROK_CODE_XAI_API_KEY: 'k', PATH: '/bin' });
      return !('XAI_API_KEY' in env) && !('GROK_CODE_XAI_API_KEY' in env)
        && env.GROK_DISABLE_API_KEY_AUTH === '1';
    },
  },
  {
    name: 'only an OAuth subscription sign-in passes the grok check',
    run: () => grokAuthFrom({ authenticated: true, meta: { auth_mode: 'Oidc', subscription_tier: 'SuperGrok', backend_billed: false } }).ok
      && !grokAuthFrom({ authenticated: true, meta: { auth_mode: 'ApiKey', subscription_tier: 'SuperGrok' } }).ok
      && !grokAuthFrom({ authenticated: false }).ok
      && !grokAuthFrom(null).ok,
  },
  {
    name: 'a grok session started on an API key is killed on its first line',
    run: () => Boolean(offSubscriptionReason('{"type":"system","subtype":"init","apiKeySource":"user","model":"grok-4.7"}\n'))
      && !offSubscriptionReason('{"type":"system","subtype":"init","apiKeySource":"oauth","model":"grok-4.7"}\n'),
  },
  {
    name: '`grok models` sign-in lines are classified',
    run: () => parseGrokModels('You are logged in with grok.com.\n').method === 'oauth'
      && parseGrokModels('You are using XAI_API_KEY.\n').method === 'api-key'
      && parseGrokModels('You are not authenticated.\n').method === 'none',
  },
  {
    name: 'grok usage errors are rate limits, not fatal',
    run: () => classifyFailure({ code: 1, stderr: 'usage_limit_reached' }) === 'rate-limit'
      && classifyFailure({ code: 1, stderr: 'usage_pool_exhausted' }) === 'rate-limit',
  },
  {
    name: 'a usage-limit message is classified as rate-limit, not fatal',
    run: () => classifyFailure({ code: 1, stderr: 'You have hit your usage limit' }) === 'rate-limit',
  },
  {
    name: 'a signed-out claude run is an auth failure, never an answer',
    run: () => {
      const parsed = parseClaudeStdout(CLAUDE_AUTH_RESULT);
      return parsed.text === ''
        && classifyFailure({ code: 1, stderr: parsed.error }) === 'auth'
        && /OAuth session expired/.test(parseClaudeAuthFailure(CLAUDE_AUTH_RESULT) ?? '');
    },
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
    process.stdout.write(`  ${pass ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(60)} ${got}\n`);
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
