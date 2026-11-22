// private-words.mjs — owner-local word list for leak-guard tests.
//
// The guarded words themselves are private to the package owner, so they live
// outside the repository in ~/.config/cross-model-orchestrate-private-words.txt
// (or at CMO_PRIVATE_WORDS_FILE). Note isolate.mjs redirects CMO_CONFIG_DIR to
// a temp directory, so ~ is resolved against os.homedir() directly.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PRIVATE_WORDS_FILE = '~/.config/cross-model-orchestrate-private-words.txt';

function expandHome(filePath, home = homedir()) {
  if (filePath === '~') return home;
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return join(home, filePath.slice(2));
  }
  return filePath;
}

function escapeRegex(word) {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function resolvePrivateWordsPath({ env = process.env, home = homedir() } = {}) {
  const configured = env.CMO_PRIVATE_WORDS_FILE?.trim();
  return expandHome(configured || DEFAULT_PRIVATE_WORDS_FILE, home);
}

export function loadPrivateWordsGuard({ file, env = process.env, home = homedir() } = {}) {
  const path = file !== undefined ? expandHome(file, home) : resolvePrivateWordsPath({ env, home });
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        regex: null,
        words: [],
        path,
        skipReason: `private words file not found at ${path} (set CMO_PRIVATE_WORDS_FILE or create ${DEFAULT_PRIVATE_WORDS_FILE})`,
      };
    }
    throw err;
  }

  const words = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  if (words.length === 0) {
    return {
      regex: null,
      words: [],
      path,
      skipReason: `private words file is empty at ${path}`,
    };
  }

  const regex = new RegExp(`(?<!\\w)(?:${words.map(escapeRegex).join('|')})(?!\\w)`, 'i');
  return { regex, words, path, skipReason: null };
}

export function assertNoPrivateWords(t, targets, options) {
  const guard = loadPrivateWordsGuard(options);
  if (!guard.regex) {
    t.skip(guard.skipReason);
    return guard;
  }
  const entries = typeof targets === 'string'
    ? [['text', targets]]
    : Array.isArray(targets)
      ? targets
      : Object.entries(targets);
  for (const [label, text] of entries) {
    assert.doesNotMatch(text, guard.regex, label);
  }
  return guard;
}
