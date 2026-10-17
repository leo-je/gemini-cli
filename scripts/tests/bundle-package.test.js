/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  createBundlePackageJson,
  BUNDLE_PACKAGE_NAME,
  BUNDLE_BIN_NAME,
  YOGA_LAYOUT_RANGE,
  NODE_PTY_PACKAGE,
} from '../bundle_package.js';

describe('createBundlePackageJson', () => {
  const rootPkg = {
    version: '0.1.13',
    optionalDependencies: { '@lydell/node-pty': '1.1.0' },
  };

  it('names the package so it cannot shadow the upstream global install', () => {
    const pkg = createBundlePackageJson(rootPkg, { entry: 'gemini.js' });
    expect(pkg.name).toBe(BUNDLE_PACKAGE_NAME);
    // Pinned literally: this is the name the release workflow publishes, so a
    // change here would quietly publish under a different package.
    expect(pkg.name).toBe('gemini-cli-leo');
  });

  it('uses the repository version', () => {
    const pkg = createBundlePackageJson(rootPkg, { entry: 'gemini.js' });
    expect(pkg.version).toBe('0.1.13');
  });

  it('falls back when the repository has no version', () => {
    const pkg = createBundlePackageJson({}, { entry: 'gemini.js' });
    expect(pkg.version).toBe('0.0.0');
  });

  it('declares module type so the entry is not reparsed as CommonJS', () => {
    const pkg = createBundlePackageJson(rootPkg, { entry: 'gemini.js' });
    expect(pkg.type).toBe('module');
  });

  it('exposes the entry through a gemini-leo bin, not gemini', () => {
    const bin = createBundlePackageJson(rootPkg, { entry: 'gemini.js' }).bin;
    expect(bin).toEqual({ 'gemini-leo': 'gemini.js' });
    expect(bin).not.toHaveProperty('gemini');
    expect(BUNDLE_BIN_NAME).toBe('gemini-leo');
  });

  it('points the bin at whichever entry the build produced', () => {
    expect(
      createBundlePackageJson(rootPkg, { entry: 'gemini.mjs' }).bin,
    ).toEqual({ 'gemini-leo': 'gemini.mjs' });
  });

  it('omits the yoga-layout dependency for the self-contained split bundle', () => {
    const pkg = createBundlePackageJson(rootPkg, {
      entry: 'gemini.js',
      needsYogaLayout: false,
    });
    expect(pkg.dependencies).toBeUndefined();
  });

  it('declares yoga-layout for the single-file bundle, which keeps it external', () => {
    const pkg = createBundlePackageJson(rootPkg, {
      entry: 'gemini.mjs',
      needsYogaLayout: true,
    });
    expect(pkg.dependencies).toEqual({ 'yoga-layout': YOGA_LAYOUT_RANGE });
  });

  describe('native modules', () => {
    it('declares node-pty as optional so unmatched platforms skip it', () => {
      const pkg = createBundlePackageJson(rootPkg, { entry: 'gemini.mjs' });
      expect(pkg.optionalDependencies).toEqual({ '@lydell/node-pty': '1.1.0' });
      expect(NODE_PTY_PACKAGE).toBe('@lydell/node-pty');
    });

    it('tracks the version the repository pins', () => {
      const pkg = createBundlePackageJson(
        {
          version: '0.1.13',
          optionalDependencies: { '@lydell/node-pty': '2.0.0' },
        },
        { entry: 'gemini.mjs' },
      );
      expect(pkg.optionalDependencies[NODE_PTY_PACKAGE]).toBe('2.0.0');
    });

    it('falls back to a known version when the repository does not pin one', () => {
      const pkg = createBundlePackageJson(
        { version: '0.1.13' },
        {
          entry: 'gemini.mjs',
        },
      );
      expect(pkg.optionalDependencies[NODE_PTY_PACKAGE]).toBe('1.1.0');
    });

    // keytar cannot be gated: it ships every platform's prebuild in one package
    // and declares no os/cpu, so npm would install it everywhere. It must never
    // be declared here, or installs break on platforms it cannot load on.
    it('never declares keytar', () => {
      const pkg = createBundlePackageJson(rootPkg, {
        entry: 'gemini.mjs',
        needsYogaLayout: true,
      });
      const declared = {
        ...pkg.dependencies,
        ...pkg.optionalDependencies,
      };
      expect(declared).not.toHaveProperty('@github/keytar');
      expect(declared).not.toHaveProperty('keytar');
    });
  });
});
