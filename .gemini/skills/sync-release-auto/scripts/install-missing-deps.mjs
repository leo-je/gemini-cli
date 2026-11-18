#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Install dependencies that an upstream merge added but the shared node_modules
// does not have yet.
//
// The release pipeline reuses the main checkout's node_modules across worktrees
// to avoid a full install per run. That is only valid while upstream does not
// change dependencies; when it does, the build fails with "Cannot find module
// 're2js'" and looks like merge damage. This script installs exactly the names
// it is given, without touching any tracked file.
//
// The manifests must NOT change: the version stamp assertion in the pipeline
// rejects a release commit that modifies anything but version fields, and the
// merged manifests already carry upstream's dependency changes. So this runs
// with --no-save and verifies at the end that git sees no manifest drift.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const names = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
if (names.length === 0) {
  console.log('nothing to install');
  process.exit(0);
}

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

/** The version each workspace manifest declares, so the install is pinned. */
function declaredVersion(name) {
  for (const dir of [
    'packages/core',
    'packages/cli',
    'packages/a2a-server',
    'packages/sdk',
    'packages/devtools',
    'packages/test-utils',
  ]) {
    const manifestPath = join(root, dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const version = manifest[field]?.[name];
      if (typeof version === 'string') return version;
    }
  }
  return null;
}

const specs = names.map((name) => {
  const version = declaredVersion(name);
  // A caret/range spec is passed through; a bare name would install `latest`,
  // which can disagree with what the merged manifest asked for.
  return version ? `${name}@${version}` : name;
});

console.log(`installing: ${specs.join(' ')}`);

/**
 * Install, falling back to the public registry.
 *
 * This host is configured for registry.npmmirror.com, which intermittently
 * resets (ECONNRESET) exactly like the GitHub proxy does. A regional mirror
 * outage must not be reported as "the merge added an uninstallable dependency".
 */
function attempt(registry) {
  const args = ['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund'];
  // This host's ~/.npm carries root-owned cache entries, so npm dies with EPERM
  // unless the cache is redirected; the pipeline's cleanEnv() does the same, but
  // this script can also be run on its own.
  const env = { ...process.env };
  if (registry) args.push(`--registry=${registry}`);
  args.push(...specs);
  if (!env.npm_config_cache) {
    env.npm_config_cache = join(tmpdir(), 'dsh-sync-release-npm-cache');
    mkdirSync(env.npm_config_cache, { recursive: true });
  }
  execFileSync('npm', args, { cwd: root, stdio: 'inherit', env });
}

try {
  attempt(null);
} catch {
  console.warn('install failed against the configured registry; retrying on npmjs.org');
  try {
    attempt('https://registry.npmjs.org');
  } catch (error) {
    console.error(`install failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

// `--no-save` should leave the manifests alone; prove it rather than trust it.
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'package.json', 'packages'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
if (dirty) {
  console.error(`the install modified tracked files, which the release must not do:\n${dirty}`);
  process.exit(1);
}

const stillMissing = specs
  .map((spec) => spec.replace(/@[^@]*$/, ''))
  .filter((name) => !existsSync(join(root, 'node_modules', name)));
if (stillMissing.length > 0) {
  console.error(`still missing after install: ${stillMissing.join(', ')}`);
  process.exit(1);
}

console.log('installed');
