#!/usr/bin/env node
//
// cmo — cross-model orchestrate: pick a model, run a subagent, report headroom.
//
//   cmo install                                # wire the skill into every host
//   cmo doctor                                 # will this work on my machine?
//   cmo limits --human                         # what's left, both providers
//   cmo plan --role judge --complexity 4 --length s
//   cmo run  --role implement --complexity 3 --prompt-file p.md
//   echo "do the thing" | cmo run --role mechanical --length xs
//
// Workflow scripts and the codex-runner agent shell out to this exact surface,
// so treat the flags as an API. See README.md.

import { readFile } from 'node:fs/promises';

import { readLimits } from '../src/limits.mjs';
import { decide, providerState, pressure } from '../src/policy.mjs';
import { runAgent, DEFAULT_TIMEOUT_MS } from '../src/run.mjs';
import { doctor } from '../src/doctor.mjs';
import { install, uninstall } from '../src/install.mjs';

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
    independentOf: args['independent-of'] || null,
    pin: args.pin || null,
    pinModel: args.model || null,
  };
}

function bar(percent) {
  if (typeof percent !== 'number') return '  ?  ';
  const filled = Math.round(percent / 10);
  return `${'█'.repeat(filled)}${'·'.repeat(10 - filled)} ${String(percent).padStart(3)}%`;
}

function renderLimits(limits) {
  const lines = [];
  for (const provider of ['codex', 'claude']) {
    const p = limits[provider];
    const state = providerState(p).state;
    lines.push(`${provider.padEnd(7)} ${state.padEnd(9)} ${p.plan ? `plan=${p.plan} ` : ''}${p.available ? '' : `unavailable: ${p.error}`}`);
    for (const w of p.windows ?? []) {
      const reset = w.resetsAt ? ` resets ${w.resetsAt.replace('T', ' ').slice(0, 16)}Z` : '';
      lines.push(`        ${w.label.padEnd(6)} ${bar(w.percentUsed)}${reset}`);
    }
    // What the vendor reported vs what this machine has already committed.
    // Under several concurrent orchestrators the gap is the whole story.
    if (p.committedPoints > 0) {
      lines.push(`        ${'in-flight'.padEnd(6)} ${p.inFlightAgents} agent(s) on this machine`
        + ` · reported ${p.reportedPercent}% → effective ${p.worstPercent}%`);
    }
  }
  lines.push('');
  const bands = pressure();
  lines.push(`bands: tight ≥${bands.tight}%  critical ≥${bands.critical}%  exhausted ≥${bands.exhausted}%`);
  const flight = (limits.inFlight?.codex ?? 0) + (limits.inFlight?.claude ?? 0);
  lines.push(flight === 0
    ? 'no dispatches in flight from this machine'
    : `${flight} dispatch(es) in flight from this machine — effective figures include them`);
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

const USAGE = `cmo <command> [options]   —   cross-model orchestrate

setup
  install     install the skill into every agent host, and the Claude subagent
  uninstall   remove what install put there
  doctor      check CLIs, auth, model IDs, headroom and skill install

dispatch
  limits      report remaining subscription headroom for codex and claude
  plan        show which provider/model/effort a task would get, and why
  run         plan, then execute the subagent and print a JSON envelope
  selftest    offline checks of the decision table

install options
  --skill-name  install the skill under a different directory name
  --copy        copy instead of symlinking (automatic under npx)
  --hosts       comma-separated subset: claude,codex,agents,kilo,opencode

task options (plan, run)
  --role            mechanical|research|implement|review|judge|architecture|synthesis
  --complexity      1..5                       (default 3)
  --length          xs|s|m|l|xl                (default m)
  --context-tokens  rough input size the agent must read
  --write           the agent edits files in the working tree
  --independent-of  codex|claude — force the OTHER vendor (adversarial review)
  --pin             codex|claude — override provider selection
  --model           exact model id, bypassing the tier map

run options
  --prompt-file     read the prompt from a file (else stdin, else --prompt)
  --schema          JSON Schema file; the result is validated and returned parsed
  --cwd             working directory for the subagent  (default: cwd)
  --timeout         seconds before the agent is killed  (default: ${DEFAULT_TIMEOUT_MS / 1000})
  --attempts        max attempts per provider           (default: 3)
  --no-failover     do not try the other vendor
  --full-access     codex only: bypass the sandbox (use inside an isolated box)
  --sandbox         codex sandbox: read-only|workspace-write|danger-full-access

output
  --human           human-readable instead of JSON (limits, plan)
`;

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0];

  if (!command || args.help || command === 'help') {
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

  if (command === 'doctor') {
    return doctor(typeof args['skill-name'] === 'string' ? { skillName: args['skill-name'] } : {});
  }

  if (command === 'limits') {
    const limits = await readLimits({ refresh: Boolean(args.refresh) });
    if (args.human) {
      process.stdout.write(`${renderLimits(limits)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(limits, null, 2)}\n`);
    }
    // Non-zero when neither provider has room, so a shell caller can branch.
    const states = ['codex', 'claude'].map((p) => providerState(limits[p]).state);
    return states.every((s) => s === 'exhausted') ? 3 : 0;
  }

  if (command === 'plan') {
    const limits = await readLimits({ refresh: Boolean(args.refresh) });
    const decision = decide(taskFromArgs(args), limits);
    if (args.human) {
      if (!decision.ok) {
        process.stdout.write(`DEFER — ${decision.reason}\nresume after ${decision.resumeAfter ?? 'unknown'}\n`);
        return 3;
      }
      const eff = decision.effort ? ` effort=${decision.effort}` : '';
      const reasoning = decision.reasoning ? ` reasoning=${decision.reasoning}` : '';
      process.stdout.write(
        `${decision.provider} ${decision.model}${eff}${reasoning} (tier ${decision.tier}, weight ${decision.weight})\n`
        + `why: ${decision.reason}\n`
        + (decision.notes.length ? `notes:\n${decision.notes.map((n) => `  - ${n}`).join('\n')}\n` : '')
        + (decision.fallback ? `fallback: ${decision.fallback.provider} ${decision.fallback.model}\n` : ''),
      );
      return 0;
    }
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    return decision.ok ? 0 : 3;
  }

  if (command === 'run') {
    const prompt = (await readPrompt(args)).trim();
    if (!prompt) {
      process.stderr.write('cmo run: no prompt (use --prompt-file, --prompt, or stdin)\n');
      return 2;
    }
    const limits = await readLimits({ refresh: Boolean(args.refresh) });
    const decision = decide(taskFromArgs(args), limits);
    if (!decision.ok) {
      process.stdout.write(`${JSON.stringify({ ok: false, deferred: true, ...decision }, null, 2)}\n`);
      return 3;
    }

    let schema = null;
    if (typeof args.schema === 'string') {
      schema = JSON.parse(await readFile(args.schema, 'utf8'));
    }

    const envelope = await runAgent(decision, prompt, {
      cwd: args.cwd ? String(args.cwd) : process.cwd(),
      timeoutMs: args.timeout ? Number(args.timeout) * 1000 : DEFAULT_TIMEOUT_MS,
      maxAttempts: args.attempts ? Number(args.attempts) : 3,
      schema,
      failover: !args['no-failover'],
      fullAccess: Boolean(args['full-access']),
      sandbox: args.sandbox ? String(args.sandbox) : 'workspace-write',
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

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`cmo: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
