// banner.mjs — the three steps, in one place.
//
// Shown from three points, because no single one is reliable:
//
//   postinstall   npm 7+ hides lifecycle script output unless you pass
//                 --foreground-scripts, so this is a bonus, not the plan.
//   bare `cmo`    guaranteed visible, and it is what someone types next.
//   `cmo install` the moment they have actually wired the skill in.

export function paint(stream = process.stdout) {
  const tty = stream.isTTY && !process.env.NO_COLOR;
  const w = (code) => (s) => (tty ? `[${code}m${s}[0m` : s);
  return { bold: w('1'), dim: w('2'), cyan: w('36'), green: w('32') };
}

/**
 * @param {object} opts
 *   version   printed after the name when known
 *   done      which step is already finished, so it can be struck from the list
 */
export function nextSteps({ version = '', done = null, stream = process.stdout } = {}) {
  const { bold, dim, cyan, green } = paint(stream);
  const step = (n, cmd, lines) => [
    `  ${done === n ? green('✓') : bold(`${n}.`)} ${done === n ? dim(cmd) : cyan(cmd)}`,
    ...lines.map((l) => `     ${dim(l)}`),
    '',
  ];

  return [
    '',
    `${green('✓')} ${bold('cross-model-orchestrate')}${version ? ` ${dim(`v${version}`)}` : ''}`
      + ` — the ${bold('cmo')} command is installed.`,
    '',
    ...step(1, 'cmo install', [
      'Wires the skill and the codex-runner subagent into Claude Code,',
      'Codex, Kilo and OpenCode. npm gave you the CLI and nothing else.',
    ]),
    ...step(2, 'claude --model opus --effort high', [
      'The orchestrator does the least typing and the most deciding, so',
      'give it the good model. Subagents get cheap tiers automatically.',
    ]),
    ...step(3, '/cross-model-orchestrate <what you want built>', [
      "Runs it on Claude Code's dynamic-workflow tooling, fanning out to",
      'subagents on Codex as well as Claude — and grading every artifact',
      'on the vendor that did not produce it.',
    ]),
    `  ${dim('The orchestration runs from Claude Code only. Codex does the work,')}`,
    `  ${dim('it does not do the deciding.')}`,
    '',
    `  ${cyan('cmo doctor')}   ${dim('check both CLIs, auth, model IDs, headroom, install')}`,
    `  ${cyan('cmo limits')}   ${dim("what's left on each subscription — costs nothing")}`,
    '',
  ].join('\n');
}
