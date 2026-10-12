/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Stamps a bundle directory with a package.json so that the output of
// `npm run bundle` / `npm run bundle:single` is an installable package:
// `npm link` inside it exposes a `gemini-leo` command.
//
// The builds emit only JavaScript, so without this manifest npm has no name to
// register and no `bin` to link — `npm link` either fails with ENOENT (no
// package.json) or, if a manifest exists without `bin`, silently links nothing.
// See docs/single-file-bundle.md.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Scoped to this fork so `npm link` never shadows an existing global install of
// the upstream `@google/gemini-cli` package.
export const BUNDLE_PACKAGE_NAME = '@leo-je/gemini-cli';

// The command is named `gemini-leo` rather than `gemini` so it does not collide
// with an upstream `gemini` binary already on PATH.
export const BUNDLE_BIN_NAME = 'gemini-leo';

// The single-file build marks yoga-layout external, because its entry point
// awaits at top level and esbuild cannot inline that without code splitting
// (see esbuild.config.js). The single-file bundle therefore needs it from
// node_modules at runtime. It is already a transitive dependency of `ink`, so
// declaring it does not normally pull anything new into an existing install.
export const YOGA_LAYOUT_RANGE = '^3.2.1';

function readRootPackageJson(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
}

/**
 * Builds the bundle's package.json contents.
 *
 * @param {{ version?: string }} rootPkg - The repository's root package.json.
 * @param {{ version?: string, entry: string, needsYogaLayout?: boolean }} options
 *   `entry` is the built entry file relative to the bundle directory. The
 *   repository's own package.json cannot be reused verbatim: its `bin` points
 *   at `bundle/gemini.js`, which is only correct when the bundle is a
 *   subdirectory of the package, not when it *is* the package.
 * @returns {Record<string, unknown>}
 */
export function createBundlePackageJson(
  rootPkg,
  { version, entry, needsYogaLayout = false } = {},
) {
  const pkg = {
    name: BUNDLE_PACKAGE_NAME,
    version: version ?? rootPkg.version ?? '0.0.0',
    // Without this Node treats the entry's `.js` as CommonJS and has to warn
    // and reparse it as ESM. The single-file build uses `.mjs` to sidestep the
    // same problem, but the split build emits `.js`.
    type: 'module',
    bin: { [BUNDLE_BIN_NAME]: entry },
    engines: { node: '>=20.0.0' },
  };
  if (needsYogaLayout) {
    pkg.dependencies = { 'yoga-layout': YOGA_LAYOUT_RANGE };
  }
  return pkg;
}

/**
 * Writes package.json next to a bundle's JavaScript and returns its contents.
 *
 * @param {string} bundleDir - Directory holding the built entry.
 * @param {{ version?: string, entry: string, needsYogaLayout?: boolean }} options
 */
export function writeBundlePackageJson(bundleDir, options) {
  const rootPkg = readRootPackageJson(join(__dirname, '..'));
  const pkg = createBundlePackageJson(rootPkg, options);
  writeFileSync(
    join(bundleDir, 'package.json'),
    JSON.stringify(pkg, null, 2) + '\n',
  );
  return pkg;
}
