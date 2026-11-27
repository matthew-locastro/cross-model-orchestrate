// isolate.mjs — keep the test suite out of the machine's real shared state.
//
// This must be the FIRST import in every test file. Sibling imports evaluate in
// source order, so setting the env here happens before config.mjs reads it.
//
// It is not hygiene, it is a bug fix. The runner tests deliberately simulate a
// rate-limit response, which calls markExhausted() — and before this existed
// that wrote "codex: exhausted" into the real ledger, where every orchestrator
// on the machine reads it. Running `npm test` would stop unrelated production
// runs from dispatching to Codex until the next probe expired.
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

const home = homedir();

function inside(target, root) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

if (
  !process.env.CMO_CACHE_DIR
  || process.env.CMO_CACHE_DIR.includes('.cache/cross-model-orchestrate')
  || inside(process.env.CMO_CACHE_DIR, join(home, '.cache', 'cross-model-orchestrate'))
) {
  process.env.CMO_CACHE_DIR = mkdtempSync(join(tmpdir(), 'cmo-test-state-'));
}

// The config dir too. Writing a real fleet config on this machine made four
// ledger tests start talking to a live coordinator instead of the local file —
// the suite passed everywhere except the one box that had actually been set up.
if (
  !process.env.CMO_CONFIG_DIR
  || process.env.CMO_CONFIG_DIR.includes('.config/cross-model-orchestrate')
  || inside(process.env.CMO_CONFIG_DIR, join(home, '.config', 'cross-model-orchestrate'))
) {
  process.env.CMO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cmo-test-config-'));
}

// Keep credential and session readers out of the user's real ~/.claude,
// ~/.codex and ~/.grok trees so no test can ever read real OAuth tokens,
// trigger a token refresh, or hit a live vendor endpoint.
if (!process.env.CMO_CLAUDE_CREDENTIALS || inside(process.env.CMO_CLAUDE_CREDENTIALS, join(home, '.claude'))) {
  process.env.CMO_CLAUDE_CREDENTIALS = join(process.env.CMO_CONFIG_DIR, 'no-claude-credentials.json');
}
if (!process.env.CMO_CODEX_SESSIONS || inside(process.env.CMO_CODEX_SESSIONS, join(home, '.codex'))) {
  process.env.CMO_CODEX_SESSIONS = join(process.env.CMO_CACHE_DIR, 'no-codex-sessions');
}
if (!process.env.GROK_HOME || inside(process.env.GROK_HOME, join(home, '.grok'))) {
  process.env.GROK_HOME = join(process.env.CMO_CONFIG_DIR, 'no-grok-home');
}

// And the meter's CLI fallback. On a Mac there is no credentials file, so an
// un-injected claude read would otherwise spawn the real CLI and spend a real
// turn — slow, billed, and a different answer on every machine.
process.env.CMO_CLAUDE_CLI_PROBE = '0';

// And grok's. Its meter starts the real CLI, and its answer decides whether grok
// is routable at all — a suite whose routing depends on whether this machine is
// signed in to SuperGrok tests the machine, not the code. Disabled, grok reads
// as unverified and unroutable unless a test injects a reading.
process.env.CMO_GROK_PROBE = '0';

// Antigravity's meter also starts its CLI. Tests use only injected readings
// and fake binaries, so no test may reach the real account.
process.env.CMO_AGY_PROBE = '0';

// And any fleet or machine-level Codex sandbox overrides inherited from the shell.
delete process.env.CMO_FLEET_URL;
delete process.env.CMO_FLEET_TOKEN;
delete process.env.CMO_CODEX_FULL_ACCESS;
