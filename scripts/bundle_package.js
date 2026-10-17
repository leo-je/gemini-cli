/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Stamps a bundle directory with a package.json so that the output of
// `npm run bundle` / `npm run bundle:single` is an installable package:
// `npm install -g <tarball>` exposes a `gemini-leo` command.
//
// The builds emit only JavaScript, so without this manifest npm has no name to
// register and no `bin` to link. See docs/single-file-bundle.md.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Named after the fork's own program so installing never replaces an existing
// global install of the upstream `@google/gemini-cli` package. Unscoped: this
// is the name the release workflow publishes to the public registry, and it is
// what `npm install -g` takes.
export const BUNDLE_PACKAGE_NAME = 'gemini-cli-leo';

// Named `gemini-leo` rather than `gemini` so it does not collide with an
// upstream `gemini` binary already on PATH.
export const BUNDLE_BIN_NAME = 'gemini-leo';

// The single-file build marks yoga-layout external, because its entry point
// awaits at top level and esbuild cannot inline that without code splitting
// (see esbuild.config.js). Both bundles need it at runtime; only the single
// file declares it, since the split build inlines a copy.
export const YOGA_LAYOUT_RANGE = '^3.2.1';

// Native modules cannot be inlined into JavaScript, so both bundles load PTY
// support at runtime. The `@lydell/node-pty-<platform>-<arch>` subpackages
// carry `os`/`cpu` fields, which is what makes npm install only the one that
// matches the machine that runs the install. Declaring the package as optional
// keeps a platform with no matching subpackage from failing the install
// instead of silently skipping it.
export const NODE_PTY_PACKAGE = '@lydell/node-pty';
const NODE_PTY_FALLBACK_RANGE = '1.1.0';

function readRootPackageJson(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
}

// Track the version the repository pins, so the bundle cannot drift from it.
function resolveNodePtyRange(rootPkg) {
  return (
    rootPkg?.optionalDependencies?.[NODE_PTY_PACKAGE] ??
    rootPkg?.dependencies?.[NODE_PTY_PACKAGE] ??
    NODE_PTY_FALLBACK_RANGE
  );
}

/**
 * Builds the bundle's package.json contents.
 *
 * @param {{ version?: string, dependencies?: object, optionalDependencies?: object }} rootPkg
 *   The repository's root package.json, used for the version and the pinned
 *   PTY version. The repository's own manifest cannot be reused verbatim: its
 *   `bin` points at `bundle/gemini.js`, which is only correct when the bundle
 *   is a subdirectory of the package, not when it *is* the package.
 * @param {{ version?: string, entry: string, needsYogaLayout?: boolean }} options
 *   `entry` is the built entry file relative to the bundle directory.
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
    // @github/keytar is deliberately absent. It ships prebuilds for every
    // platform in one package and declares no `os`/`cpu`, so npm would install
    // it everywhere and it would fail to load off-platform. The CLI falls back
    // to a file-backed keychain instead.
    optionalDependencies: { [NODE_PTY_PACKAGE]: resolveNodePtyRange(rootPkg) },
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
