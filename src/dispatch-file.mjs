// dispatch-file.mjs — let the shim hand over a file instead of retyping flags.
//
// The shim is a language model. Asking it to read eight parameters out of a
// prompt and re-emit them as command-line flags is asking it to transcribe, and
// transcription fails silently at a few percent per flag. On the first real
// fan-out one of four judges lost `--independent-of codex` on the way to the
// command line: cmo never learned independence was required, routed the review
// to the vendor that produced the work, and returned a verdict with no degraded
// label on it. Indistinguishable from a real cross-vendor verdict.
//
// Prompt discipline cannot fix that class of bug; removing the transcription
// can. The shim now writes the block it was given, verbatim, to a file and runs
// one fixed command. There are no flags left for it to drop.
//
//   DISPATCH
//   role: judge
//   complexity: 3
//   independent-of: codex
//   TASK
//   ...everything from here down is the prompt...

const FLAGS = new Set([
  'role', 'complexity', 'length', 'context-tokens', 'independent-of',
  'cwd', 'timeout', 'schema', 'pin', 'model', 'sandbox', 'attempts',
]);
const BOOLEANS = new Set(['write', 'strict-independence', 'no-failover', 'full-access', 'refresh']);

/**
 * Split a dispatch file into its parameters and its task text.
 *
 * Liberal about the envelope — a missing DISPATCH header just means the whole
 * file is the task — and strict about nothing, because a shim that cannot
 * produce a parseable file would otherwise fail the whole dispatch.
 */
export function parseDispatchFile(text) {
  const meta = {};
  const unknown = [];
  if (typeof text !== 'string') return { meta, task: '', unknown };

  const lines = text.split('\n');
  let start = lines.findIndex((l) => l.trim().toUpperCase() === 'DISPATCH');
  if (start === -1) return { meta, task: text.trim(), unknown };

  let taskAt = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().toUpperCase() === 'TASK') { taskAt = i; break; }
    if (!line.trim()) continue;

    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/);
    if (!m) continue; // not a parameter line; ignore rather than fail
    const key = m[1].toLowerCase();
    const value = m[2].trim();

    if (FLAGS.has(key)) meta[key] = value;
    else if (BOOLEANS.has(key)) meta[key] = !/^(false|no|0|off)$/i.test(value);
    else unknown.push(key);
  }

  // No TASK marker means the header ran to the end of the file and there is no
  // prompt — better to report an empty task than to dispatch the header itself.
  const task = taskAt === -1 ? '' : lines.slice(taskAt + 1).join('\n').trim();
  return { meta, task, unknown };
}

/**
 * Fold parsed parameters into parsed argv. Explicit flags win, so a caller can
 * still override one value without rewriting the file.
 */
export function mergeDispatch(args, meta) {
  const out = { ...args };
  for (const [key, value] of Object.entries(meta)) {
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}
