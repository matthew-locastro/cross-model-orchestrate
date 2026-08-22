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
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.CMO_CACHE_DIR || process.env.CMO_CACHE_DIR.includes('.cache/cross-model-orchestrate')) {
  process.env.CMO_CACHE_DIR = mkdtempSync(join(tmpdir(), 'cmo-test-state-'));
}

// The config dir too. Writing a real fleet config on this machine made four
// ledger tests start talking to a live coordinator instead of the local file —
// the suite passed everywhere except the one box that had actually been set up.
if (!process.env.CMO_CONFIG_DIR || process.env.CMO_CONFIG_DIR.includes('.config/cross-model-orchestrate')) {
  process.env.CMO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cmo-test-config-'));
}

// And any fleet settings inherited from the shell, for the same reason.
delete process.env.CMO_FLEET_URL;
delete process.env.CMO_FLEET_TOKEN;
