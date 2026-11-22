#!/usr/bin/env node
//
// cmo — cross-model orchestrate: pick a model, run a subagent, report headroom.
//
//   cmo install                                # wire the skill into every host
//   cmo doctor                                 # will this work on my machine?
//   cmo limits --human                         # what's left, every provider
//   cmo plan --role judge --complexity 4 --length s
//   cmo run  --role implement --complexity 3 --prompt-file p.md
//   echo "do the thing" | cmo run --role mechanical --length xs
//
// Workflow scripts and the codex-runner agent shell out to this exact surface,
// so treat the flags as an API. See README.md.

import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readLimits } from '../src/limits.mjs';
import {
  decide, isUsable, providerState, pressure, REQUIRES_SUBSCRIPTION_CHECK, routingLine,
} from '../src/policy.mjs';
import { formatDuration, providerPressure } from '../src/pace.mjs';
import { runAgent, DEFAULT_TIMEOUT_MS } from '../src/run.mjs';
import { doctor } from '../src/doctor.mjs';
import { install, uninstall } from '../src/install.mjs';
import { createCoordinator, DEFAULT_PORT } from '../src/server.mjs';
import { fleetConfig, health } from '../src/remote.mjs';
import { mergeDispatch, parseDispatchFile } from '../src/dispatch-file.mjs';
import { readAudit, summarise, findings, tierStats, failureTaxonomy, qualityReport } from '../src/audit.mjs';
import { readOutcomes, recordOutcome, VERDICTS } from '../src/outcomes.mjs';
import { durationProfile } from '../src/durations.mjs';
import { activeProviders, CACHE_DIR, loadConfig } from '../src/config.mjs';
import { MAX_LEASE_MS, perAgentCost } from '../src/ledger.mjs';
import { update } from '../src/update.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function taskFromArgs(args) {
  return {
    role: args.role,
    complexity: args.complexity,
    length: args.length,
    contextTokens: args['context-tokens'],
    needsSchema: Boolean(args.schema),
    needsRepoWrite: Boolean(args.write),
    needsWeb: Boolean(args.web),
    fullAccess: Boolean(args['full-access']),
    independentOf: args['independent-of'] || null,
    strictIndependence: Boolean(args['strict-independence']),
    pin: args.pin || null,
    pinModel: args.model || null,
  };
}

/**
 * A duration flag in seconds, as ms: null when absent, and a refusal when it is
 * not a positive number. `--timeout nope` once meant a NaN clock that never
 * fired, so a silent agent ran forever.
 */
function secondsFlag(args, key) {
  if (args[key] === undefined) return null;
  const n = Number(args[key]);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError(`--${key} must be a positive number of seconds, got "${args[key]}"`);
  }
  // Six hours: the longest a reservation can hold headroom, here and on a
  // fleet coordinator, so the longest any run can be allowed to last.
  if (n * 1000 > MAX_LEASE_MS) {
    throw new UsageError(`--${key} must be at most ${MAX_LEASE_MS / 1000} seconds (6 hours), got "${args[key]}"`);
  }
  return n * 1000;
}

class UsageError extends Error {}

/** The timeout a run will use, and the receipts that say who fits inside it. */
async function timing(args) {
  const timeoutMs = secondsFlag(args, 'timeout') ?? DEFAULT_TIMEOUT_MS;
  const fit = loadConfig().durationFit;
  if (!fit?.enabled) return { timeoutMs };
  const windowDays = Number(fit.windowDays) > 0 ? Number(fit.windowDays) : 14;
  // 4 MB is ~10,000 receipts — more than readAudit keeps — read from the end.
  const rows = await readAudit({ sinceMs: Date.now() - windowDays * 86_400_000, tailBytes: 4 << 20 }).catch(() => []);
  return { timeoutMs, durations: durationProfile(rows, { windowDays }) };
}

function bar(percent) {
  if (typeof percent !== 'number') return '  ?  ';
  const filled = Math.round(percent / 10);
  return `${'█'.repeat(filled)}${'·'.repeat(10 - filled)} ${String(percent).padStart(3)}%`;
}

export function renderLimits(limits, now = Date.now()) {
  const lines = [];
  const bandsNow = pressure();
  const providers = activeProviders();
  for (const provider of providers) {
    const p = limits[provider];
    if (!p) continue;
    const s = providerState(p, bandsNow, now, provider);
    const pp = providerPressure(p, { now, exhausted: bandsNow.exhausted });
    const paced = new Map(pp.windows.map((w) => [w.key, w]));
    const headline = pp.paceAware && typeof s.percent === 'number'
      ? `pressure ${s.percent}%${s.window ? ` (${s.window})` : ''} `
      : '';
    const via = p.available && typeof p.source === 'string' && p.source.startsWith('claude -p') ? 'via the claude CLI ' : '';
    // For vendors that must prove a subscription sign-in, an unverified meter
    // is the headline: the vendor is not routable however much allowance it has.
    const unverified = REQUIRES_SUBSCRIPTION_CHECK.has(provider) && p.auth?.ok !== true;
    const auth = unverified
      ? `NOT ROUTABLE: ${p.auth?.reason ?? s.reason} `
      : (provider === 'grok' && p.auth?.ok ? `auth=${p.auth.authMode ?? p.auth.method} ` : '');
    const why = p.available || unverified ? '' : `unavailable: ${p.error}`;
    const stale = p.stale
      ? `last good reading ${Math.max(1, Math.round((now - (Date.parse(p.stale.since) || now)) / 60_000))}m ago${p.stale.error ? ` (meter: ${p.stale.error})` : ''} `
      : '';
    lines.push(`${provider.padEnd(7)} ${s.state.padEnd(9)} ${headline}${p.plan ? `plan=${p.plan} ` : ''}${auth}${via}${stale}${why}`);
    for (const w of p.windows ?? []) {
      const reset = w.resetsAt ? ` resets ${w.resetsAt.replace('T', ' ').slice(0, 16)}Z` : '';
      lines.push(`        ${w.label.padEnd(6)} ${bar(w.percentUsed)}${reset}`);
      // The raw bar says how much is used; this says how long the rest must
      // last, which is the half of the picture that decides routing.
      const pw = paced.get(w.key);
      if (pw?.known) {
        const unit = pw.windowMinutes >= 2880 ? 'day' : 'hour';
        const per = unit === 'day' ? 1 : 24;
        const rate = (v) => Math.round((v / per) * 10) / 10;
        lines.push(`               pace: ${Math.round((100 - pw.percentUsed) * 10) / 10}% left for ${formatDuration(pw.minutesLeft)}`
          + ` = ${rate(pw.leftPerDay)}%/${unit} vs ${rate(pw.evenPerDay)}%/${unit} even → pressure ${pw.pressure}%`);
      } else if (pw?.stale) {
        lines.push('               pace: reset time has passed — this reading is stale');
      }
    }
    // What the vendor reported vs what this machine has already committed.
    // Under several concurrent orchestrators the gap is the whole story.
    if (p.committedPoints > 0) {
      lines.push(`        ${'in-flight'.padEnd(6)} ${p.inFlightAgents} agent(s) across `
        + `${limits.fleet ? 'the fleet' : 'this machine'}`
        + ` · reported ${p.reportedPercent}% → effective ${p.worstPercent}%`);
    }
  }
  lines.push('');
  const bands = pressure();
  lines.push(`bands (on pressure — usage weighed against time to reset): tight ≥${bands.tight}%  critical ≥${bands.critical}%  exhausted ≥${bands.exhausted}%`);
  const flight = providers.reduce((n, p) => n + (limits.inFlight?.[p] ?? 0), 0);
  const scope = limits.fleet ? 'the fleet' : 'this machine';
  lines.push(flight === 0
    ? `no dispatches in flight across ${scope}`
    : `${flight} dispatch(es) in flight across ${scope} — effective figures include them`);
  if (limits.fleet && limits.summary) {
    // Where the work actually is. "37 in flight" is not actionable;
    // "22 on vps-2, project checkout-flow" is.
    for (const [provider, info] of Object.entries(limits.summary)) {
      const where = Object.entries(info.nodes ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k}×${n}`)
        .join('  ');
      if (where) lines.push(`  ${provider}: ${where}`);
    }
  }
  if (!limits.fleet && fleetConfig()) {
    lines.push('WARNING: a fleet coordinator is configured but unreachable — '
      + 'this decision sees only the local machine.');
  }
  lines.push(routingLine(limits, now));
  return lines.join('\n');
}

async function readPrompt(args) {
  if (args['prompt-file']) return readFile(args['prompt-file'], 'utf8');
  if (typeof args.prompt === 'string') return args.prompt;
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export const USAGE = `cmo <command> [options]   —   cross-model orchestrate

setup
  install     install the skill into every agent host, and the Claude subagent
  uninstall   remove what install put there
  doctor      check CLIs, auth, model IDs, headroom, skill install and fleet
  update      upgrade the vendor CLIs, cmo and the skill — --yes to execute
  serve       run the fleet coordinator so several machines share one view

dispatch
  audit       what was ACTUALLY dispatched — the receipt for a fan-out
  report      read the soak log back: reliability, balance, quality, and what to change
  outcome     record a quality judgement for a dispatch receipt
  limits      report remaining subscription headroom for codex, claude and antigravity
  plan        show which provider/model/effort a task would get, and why
  run         plan, then execute the subagent and print a JSON envelope
  selftest    offline checks of the decision table

install options
  --skill-name  install the skill under a different directory name
  --copy        copy instead of symlinking (automatic under npx)
  --hosts       comma-separated subset: claude,codex,agents,kilo,opencode,antigravity

update options
  --yes         actually run it. Without this, update only prints the plan.
  --clis-only   upgrade only the vendor CLIs, leaving this package alone
                (by default update covers the CLIs, cmo itself, and the
                 installed skill when it is a copy rather than a symlink)
  --force       proceed even with dispatches in flight on this machine
                (they may resolve model ids that stop existing mid-run)

serve options
  --port        listen port (default ${DEFAULT_PORT})
  --host        bind address (default 127.0.0.1 — use 0.0.0.0 or a tailnet IP
                to accept other machines)
  --token       shared secret; or set CMO_FLEET_TOKEN. Required, min 16 chars.
  --state       where to persist fleet state

Clients join by setting CMO_FLEET_URL and CMO_FLEET_TOKEN, or the "fleet"
block in the config file. Without them, everything is single-box.

task options (plan, run)
  --role            mechanical|research|implement|review|judge|architecture|synthesis
  --complexity      1..5                       (default 3)
  --length          xs|s|m|l|xl                (default m)
  --context-tokens  rough input size the agent must read
  --write           the agent edits files in the working tree
  --web             the agent must open live URLs (research, link checks). Web
                    and research work goes to an active vendor with network
                    access; never codex without --full-access.
  --independent-of  codex|claude|antigravity — run on a vendor OTHER than this one
                    (adversarial review). If none of the others can run it
                    degrades to a fresh agent on the producer's own vendor and
                    LABELS the verdict same-vendor, because a flagged review
                    beats no review.
  --strict-independence
                    never degrade: defer instead of reviewing on the producer's
                    vendor. For verdicts that must be cross-vendor or absent.
  --pin             codex|claude|antigravity — override provider selection.
                    Additional vendors, including grok, are opt-in through the
                    config "providers" list.
  --model           exact model id, bypassing the tier map
  --timeout         the time budget in seconds  (default: ${DEFAULT_TIMEOUT_MS / 1000}). Within it
                    nothing is stopped. Past it, an agent still producing
                    output keeps going; one silent for --idle-timeout stops.
                    A vendor whose recent receipts for this role and tier
                    usually overrun it is tried after one that fits.
  --idle-timeout    seconds of silence, past the budget, before an agent is
                    stopped  (default: 900, never more than --timeout)
  --max-runtime     the absolute ceiling in seconds  (default: 14400, at most 21600)

run options
  --dispatch        a file holding a DISPATCH header and a TASK body. Preferred:
                    the parameters travel WITH the task, so nothing has to be
                    retyped as flags and nothing can be dropped in the retyping.
  --prompt-file     read the prompt from a file (else stdin, else --prompt)
  --schema          JSON Schema file; the result is validated and returned parsed
  --cwd             working directory for the subagent  (default: cwd)
  --attempts        max attempts per provider           (default: 3)
  --no-failover     do not try the other vendor
  --full-access     codex only: bypass the sandbox (use inside an isolated box)
  --sandbox         codex sandbox: read-only|workspace-write|danger-full-access

report options
  --since           how far back: 90 (minutes), 24h, or 7d (default 24h)
  --json            structured findings, for pasting to an agent to act on
  --quality         summarize recorded outcomes by provider, role, and model

outcome options
  --verdict         approved|fixed|rejected|blocked|confirmed|false-positive|missed
  --rounds          review rounds (default 1)
  --note            optional judgement note
  --by              optional reviewer identifier
  --force           record an unknown dispatch ID as an orphan

audit options
  --since           minutes to look back (default 60)
  --expected        how many subagents you dispatched. The gap between that and
                    the receipts is the number that never ran — a shim answering
                    by itself looks identical to a real dispatch without this.

output
  --human           human-readable instead of JSON (limits, plan)
`;

function processOutput(text, stream = 'stdout') {
  process[stream].write(text);
}

/** Shell status for `limits`, separated from rendering and I/O for callers. */
export function limitsExitStatus(limits, roster = activeProviders(), now = Date.now()) {
  const bands = pressure();
  const usable = roster.some((provider) => isUsable({
    state: providerState(limits?.[provider], bands, now, provider).state,
  }));
  return usable ? 0 : 3;
}

/** Record one outcome using an explicit cache and sink, so no subprocess is needed. */
export async function outcomeCommand(argv, cacheDir = CACHE_DIR, outputSink = processOutput) {
  const args = parseArgs(argv);
  const id = args._[args._[0] === 'outcome' ? 1 : 0];
  const verdict = args.verdict;
  if (!id || typeof verdict !== 'string' || !VERDICTS.has(verdict)) {
    outputSink('cmo outcome: provide a dispatch ID and a valid --verdict\n', 'stderr');
    return 2;
  }
  let rounds = 1;
  if (args.rounds !== undefined) {
    rounds = Number(args.rounds);
    if (!Number.isInteger(rounds) || rounds < 1) {
      outputSink('cmo outcome: --rounds must be a positive integer\n', 'stderr');
      return 2;
    }
  }
  const receipt = (await readAudit({ cacheDir })).some((row) => row.id === id);
  if (!receipt && !args.force) {
    outputSink(`cmo outcome: no local receipt for ${id}; use --force to record an orphan\n`, 'stderr');
    return 1;
  }
  const outcome = {
    at: Date.now(), id, verdict, rounds,
    ...(typeof args.note === 'string' ? { note: args.note } : {}),
    ...(typeof args.by === 'string' ? { by: args.by } : {}),
    ...(!receipt ? { orphan: true } : {}),
  };
  try {
    await recordOutcome(outcome, { cacheDir });
  } catch (err) {
    outputSink(`cmo outcome: ${err.message}\n`, 'stderr');
    return 1;
  }
  outputSink(`${JSON.stringify(outcome)}\n`, 'stdout');
  return 0;
}

export async function main(
  argv = process.argv.slice(2),
  {
    cacheDir = CACHE_DIR,
    outputSink = processOutput,
    limits: injectedLimits,
    readLimits: readLimitsFn = readLimits,
  } = {},
) {
  const args = parseArgs(argv);
  const command = args._[0];

  if (!command || args.help || command === 'help') {
    // Bare `cmo` is the first thing someone runs after installing, and npm
    // hides the postinstall banner by default, so lead with the three steps.
    if (!command && !args.help) {
      const { nextSteps } = await import('../src/banner.mjs');
      const { createRequire } = await import('node:module');
      let version = '';
      try {
        version = createRequire(import.meta.url)('../package.json').version;
      } catch { /* decoration */ }
      process.stdout.write(nextSteps({ version }));
      process.stdout.write('\n');
    }
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === 'install' || command === 'uninstall') {
    const opts = {
      ...(typeof args['skill-name'] === 'string' ? { skillName: args['skill-name'] } : {}),
      ...(args.copy ? { copy: true } : {}),
      ...(typeof args.hosts === 'string' ? { hosts: args.hosts.split(',').map((h) => h.trim()) } : {}),
    };
    await (command === 'install' ? install(opts) : uninstall(opts));
    return 0;
  }

  if (command === 'serve') {
    const token = args.token ?? process.env.CMO_FLEET_TOKEN;
    if (!token || String(token).length < 16) {
      process.stderr.write(
        'cmo serve: a shared token of at least 16 characters is required.\n'
        + 'An open coordinator lets anyone on the network stall every orchestrator\n'
        + 'you own by reserving 100% of your headroom.\n\n'
        + `  export CMO_FLEET_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '=+/')\n`
        + '  cmo serve --host 0.0.0.0\n',
      );
      return 2;
    }
    const port = Number(args.port ?? DEFAULT_PORT);
    const host = String(args.host ?? '127.0.0.1');
    const server = createCoordinator({ token: String(token), statePath: args.state ? String(args.state) : undefined });
    await new Promise((resolve) => server.listen(port, host, resolve));
    process.stdout.write(`cross-model-orchestrate coordinator on http://${host}:${port}\n`);
    process.stdout.write('clients: export CMO_FLEET_URL=http://<reachable-host>:' + port + ' CMO_FLEET_TOKEN=<token>\n');
    await new Promise(() => {}); // run until killed
    return 0;
  }

  if (command === 'update') {
    return update({
      yes: Boolean(args.yes),
      // Everything by default: the vendor CLIs, this package, and the installed
      // skill if it is a copy. `--self` is still accepted so older instructions
      // and scripts keep working; it is now the default rather than a flag.
      includeSelf: !args['clis-only'],
      force: Boolean(args.force),
    });
  }

  if (command === 'doctor') {
    return doctor(typeof args['skill-name'] === 'string' ? { skillName: args['skill-name'] } : {});
  }

  if (command === 'audit') {
    const mins = args.since ? Number(args.since) : 60;
    const rows = await readAudit({ sinceMs: Date.now() - mins * 60_000 });
    const sum = summarise(rows, args.expected ? { expected: Number(args.expected) } : {});
    if (!args.human) {
      process.stdout.write(`${JSON.stringify({ ...sum, rows }, null, 2)}\n`);
      return sum.undispatched ? 3 : 0;
    }
    process.stdout.write(`dispatches in the last ${mins} min: ${sum.total}`
      + (sum.failed ? `  (${sum.failed} failed)` : '') + '\n');
    for (const [prov, info] of Object.entries(sum.byProvider)) {
      const models = Object.entries(info.models).map(([m, n]) => `${m}x${n}`).join(' ');
      process.stdout.write(`  ${prov.padEnd(7)} ${String(info.count).padStart(3)}   ${models}\n`);
    }
    if (sum.codexShare != null) {
      process.stdout.write(`\nshare: ${activeProviders().map((p) => `${p} ${sum.shares?.[p] ?? 0}%`).join(' · ')}\n`);
    }
    if (sum.grokAuth) {
      process.stdout.write(`grok billing: ${sum.grokAuth.oauth} verified subscription (oauth)`
        + (sum.grokAuth.unverified ? `, ${sum.grokAuth.unverified} NOT verified — see cmo report` : '') + '\n');
    }
    if (sum.failedOver) process.stdout.write(`failovers: ${sum.failedOver}\n`);
    const ind = sum.independence;
    if (ind['cross-vendor'] || ind['same-vendor']) {
      process.stdout.write(`reviews: ${ind['cross-vendor']} cross-vendor, `
        + `${ind['same-vendor']} same-vendor\n`);
    }
    if (sum.undispatched != null) {
      process.stdout.write(sum.undispatched === 0
        ? `\nall ${sum.expected} expected dispatches are on record.\n`
        : `\nWARNING: ${sum.undispatched} of ${sum.expected} subagents left NO receipt —\n`
          + `they never called the dispatcher and answered by themselves.\n`);
    }
    return sum.undispatched ? 3 : 0;
  }

  if (command === 'outcome') {
    return outcomeCommand(argv, cacheDir, outputSink);
  }

  if (command === 'report') {
    const spec = String(args.since ?? '24h');
    const mins = /^\d+d$/.test(spec) ? parseInt(spec, 10) * 1440
      : /^\d+h$/.test(spec) ? parseInt(spec, 10) * 60
        : Number(spec) || 1440;
    const sinceMs = Date.now() - mins * 60_000;
    if (args.quality) {
      const [receipts, outcomes] = await Promise.all([
        readAudit({ cacheDir }),
        readOutcomes({ sinceMs, cacheDir }),
      ]);
      const quality = qualityReport(receipts, outcomes);
      if (args.json) {
        outputSink(`${JSON.stringify({ window: spec, quality }, null, 2)}\n`, 'stdout');
        return 0;
      }
      outputSink(`quality outcomes — last ${spec}\n`, 'stdout');
      outputSink(`${quality.total} outcomes · ${quality.orphans} orphan${quality.orphans === 1 ? '' : 's'}\n`, 'stdout');
      for (const group of quality.groups) {
        const approvalPct = Math.round(group.firstRoundApprovalRate * 100);
        outputSink(`  ${group.provider} / ${group.role} / ${group.model}: n=${group.n} first-round approvals=${group.firstRoundApprovals}/${group.n} (${approvalPct}%) mean rounds=${group.meanRounds} blocked=${group.blocked} confirmed=${group.confirmed} false-positive=${group.falsePositive} missed=${group.missed}\n`, 'stdout');
      }
      return 0;
    }
    const rows = await readAudit({ sinceMs, cacheDir });
    const cost = await perAgentCost('codex').catch(() => null);
    const lim = injectedLimits !== undefined
      ? injectedLimits
      : await readLimitsFn().catch(() => null);
    const sum = summarise(rows);
    const tiers = tierStats(rows);
    const fails = failureTaxonomy(rows);
    const found = findings(rows, { perAgentCost: cost, limits: lim });

    if (args.json) {
      outputSink(`${JSON.stringify({ window: spec, summary: sum, tiers, failures: fails, findings: found }, null, 2)}\n`, 'stdout');
      return 0;
    }

    const hrs = Math.round(mins / 60);
    outputSink(`\ncross-model-orchestrate — last ${hrs >= 24 ? `${Math.round(hrs / 24)}d` : `${hrs}h`}\n`, 'stdout');
    outputSink(`${'─'.repeat(60)}\n`, 'stdout');
    if (!rows.length) {
      outputSink('no dispatches recorded in this window.\n', 'stdout');
      for (const f of found) outputSink(`\n  [${f.severity}] ${f.finding}\n          → ${f.action}\n`, 'stdout');
      return 0;
    }

    outputSink(`${sum.total} dispatches · ${sum.failed} failed`
      + (sum.failedOver ? ` · ${sum.failedOver} failed over` : '')
      + ` · share ${activeProviders().map((p) => `${p} ${sum.shares?.[p] ?? 0}%`).join(' / ')}\n\n`, 'stdout');
    for (const [prov, info] of Object.entries(sum.byProvider)) {
      const models = Object.entries(info.models).map(([m, n]) => `${m}x${n}`).join('  ');
      outputSink(`  ${prov.padEnd(7)} ${String(info.count).padStart(4)}   ${models}\n`, 'stdout');
    }
    outputSink('\n  by role: '
      + Object.entries(sum.byRole).map(([r, n]) => `${r}x${n}`).join('  ') + '\n', 'stdout');
    const t = Object.entries(tiers).map(([k, v]) => `${k} p50 ${Math.round(v.p50 / 1000)}s/p95 ${Math.round(v.p95 / 1000)}s`);
    if (t.length) outputSink(`  timing:  ${t.join('   ')}\n`, 'stdout');
    if (Object.keys(fails).length) {
      outputSink(`  failures: ${Object.entries(fails).map(([k, n]) => `${k}x${n}`).join('  ')}\n`, 'stdout');
    }
    const ind = sum.independence;
    if (ind['cross-vendor'] || ind['same-vendor']) {
      outputSink(`  reviews: ${ind['cross-vendor']} cross-vendor, ${ind['same-vendor']} same-vendor\n`, 'stdout');
    }

    outputSink(`\n${'─'.repeat(60)}\n`, 'stdout');
    if (!found.length) {
      outputSink('nothing worth changing in this window.\n\n', 'stdout');
      return 0;
    }
    outputSink(`${found.length} finding(s)\n\n`, 'stdout');
    for (const f of found) {
      outputSink(`  [${f.severity}] ${f.finding}\n          → ${f.action}\n\n`, 'stdout');
    }
    return 0;
  }

  if (command === 'limits') {
    const limits = injectedLimits !== undefined
      ? injectedLimits
      : await readLimitsFn({ refresh: Boolean(args.refresh) });
    if (args.human) {
      outputSink(`${renderLimits(limits)}\n`, 'stdout');
    } else {
      outputSink(`${JSON.stringify(limits, null, 2)}\n`, 'stdout');
    }
    // Non-zero when no provider can take work, so a shell caller can branch.
    return limitsExitStatus(limits);
  }

  if (command === 'plan') {
    let planArgs = args;
    if (typeof args.dispatch === 'string') {
      planArgs = mergeDispatch(args, parseDispatchFile(await readFile(args.dispatch, 'utf8')).meta);
    }
    try {
      secondsFlag(planArgs, 'timeout');
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      process.stderr.write(`cmo plan: ${err.message}\n`);
      return 2;
    }
    const limits = injectedLimits !== undefined
      ? injectedLimits
      : await readLimitsFn({ refresh: Boolean(planArgs.refresh) });
    const decision = decide(taskFromArgs(planArgs), limits, await timing(planArgs));
    if (args.human) {
      if (!decision.ok) {
        process.stdout.write(`DEFER — ${decision.reason}\nresume after ${decision.resumeAfter ?? 'unknown'}\n`);
        return 3;
      }
      const eff = decision.effort ? ` effort=${decision.effort}` : '';
      const reasoning = decision.reasoning ? ` reasoning=${decision.reasoning}` : '';
      const indep = decision.independence
        ? `independence: ${decision.independence}${decision.degradedReview ? '  ← DEGRADED, verdict is not cross-vendor' : ''}\n`
        : '';
      process.stdout.write(
        `${decision.provider} ${decision.model}${eff}${reasoning} (tier ${decision.tier}, weight ${decision.weight})\n`
        + indep
        + `why: ${decision.reason}\n`
        + (decision.notes.length ? `notes:\n${decision.notes.map((n) => `  - ${n}`).join('\n')}\n` : '')
        + (decision.fallbacks?.length
          ? `fallback: ${decision.fallbacks.map((f) => `${f.provider} ${f.model}`).join(' → ')}\n`
          : ''),
      );
      return 0;
    }
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    return decision.ok ? 0 : 3;
  }

  if (command === 'run') {
    // A dispatch file carries its own parameters, so the caller never has to
    // transcribe them onto the command line — the failure mode that silently
    // turned a cross-vendor review into a same-vendor one.
    let runArgs = args;
    let prompt;
    if (typeof args.dispatch === 'string') {
      const parsed = parseDispatchFile(await readFile(args.dispatch, 'utf8'));
      runArgs = mergeDispatch(args, parsed.meta);
      prompt = parsed.task;
      if (parsed.unknown.length) {
        process.stderr.write(`cmo run: ignoring unknown dispatch keys: ${parsed.unknown.join(', ')}\n`);
      }
      if (!prompt) {
        process.stderr.write(`cmo run: ${args.dispatch} has no TASK section\n`);
        return 2;
      }
    } else {
      prompt = (await readPrompt(args)).trim();
    }
    if (!prompt) {
      process.stderr.write('cmo run: no prompt (use --prompt-file, --prompt, or stdin)\n');
      return 2;
    }
    // Bad durations are refused before anything is read or spent.
    let watchdogArgs;
    try {
      const watchdog = loadConfig().watchdog ?? {};
      secondsFlag(runArgs, 'timeout');
      watchdogArgs = {
        idleMs: secondsFlag(runArgs, 'idle-timeout') ?? (Number(watchdog.idleMinutes) || 15) * 60_000,
        maxMs: secondsFlag(runArgs, 'max-runtime') ?? (Number(watchdog.maxMinutes) || 240) * 60_000,
      };
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      process.stderr.write(`cmo run: ${err.message}\n`);
      return 2;
    }
    const limits = injectedLimits !== undefined
      ? injectedLimits
      : await readLimitsFn({ refresh: Boolean(runArgs.refresh) });
    const { timeoutMs, durations } = await timing(runArgs);
    const decision = decide(taskFromArgs(runArgs), limits, { timeoutMs, durations });
    if (!decision.ok) {
      process.stdout.write(`${JSON.stringify({ ok: false, deferred: true, ...decision }, null, 2)}\n`);
      return 3;
    }

    let schema = null;
    if (typeof runArgs.schema === 'string') {
      schema = JSON.parse(await readFile(runArgs.schema, 'utf8'));
    }

    const envelope = await runAgent(decision, prompt, {
      cwd: runArgs.cwd ? String(runArgs.cwd) : process.cwd(),
      timeoutMs,
      ...watchdogArgs,
      maxAttempts: runArgs.attempts ? Number(runArgs.attempts) : 3,
      schema,
      failover: !runArgs['no-failover'],
      fullAccess: Boolean(runArgs['full-access']),
      sandbox: runArgs.sandbox ? String(runArgs.sandbox) : 'workspace-write',
    });

    process.stdout.write(`${JSON.stringify({ ...envelope, decision: { weight: decision.weight, tier: decision.tier, reason: decision.reason, notes: decision.notes } }, null, 2)}\n`);
    return envelope.ok ? 0 : 1;
  }

  if (command === 'selftest') {
    const { selftest } = await import('../src/selftest.mjs');
    return selftest();
  }

  process.stderr.write(`cmo: unknown command "${command}"\n\n${USAGE}`);
  return 2;
}

async function executedDirectly(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const modulePath = fileURLToPath(metaUrl);
  try {
    const [realModule, realEntry] = await Promise.all([
      realpath(modulePath),
      realpath(resolve(argv1)),
    ]);
    return realModule === realEntry;
  } catch {
    return modulePath === resolve(argv1);
  }
}

if (await executedDirectly()) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`cmo: ${err?.stack ?? err}\n`);
      process.exit(1);
    });
}
