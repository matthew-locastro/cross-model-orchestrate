#!/usr/bin/env node
//
// postinstall — print the three steps, and nothing else.
//
// Two rules, because postinstall scripts have a deservedly bad name:
//
//   It only PRINTS. It does not touch your home directory, wire anything into
//   your agent tools, or phone anywhere. `cmo install` does that, deliberately,
//   as a thing you type.
//
//   It cannot fail the install. Everything is wrapped and the exit code is
//   always 0. Nobody's CI should break because a banner threw.
//
// Note that npm 7+ hides lifecycle output unless you pass --foreground-scripts,
// so this is a bonus. The reliable copy is printed by a bare `cmo`.
// It also stays quiet when this package is somebody's dependency.

function isGlobalInstall() {
  if (process.env.npm_config_global === 'true') return true;
  if (process.env.npm_config_global === 'false') return false;
  const dir = process.cwd();
  return /[/\\](lib[/\\])?node_modules[/\\]cross-model-orchestrate$/.test(dir)
    && !/[/\\]\.pnpm[/\\]/.test(dir)
    && /[/\\](usr|opt|\.npm-global|\.nvm|npm|node|Cellar)[/\\]/i.test(dir);
}

try {
  if (isGlobalInstall()) {
    const { nextSteps } = await import('../src/banner.mjs');
    let version = '';
    try {
      const { createRequire } = await import('node:module');
      version = createRequire(import.meta.url)('../package.json').version;
    } catch { /* version is decoration */ }
    process.stdout.write(nextSteps({ version }));
  }
} catch {
  // A banner is never worth failing an install over.
}

process.exit(0);
