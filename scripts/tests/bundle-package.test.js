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
} from '../bundle_package.js';

describe('createBundlePackageJson', () => {
  const rootPkg = { version: '0.1.13' };

  it('names the package so it cannot shadow the upstream global install', () => {
    const pkg = createBundlePackageJson(rootPkg, { entry: 'gemini.js' });
    expect(pkg.name).toBe(BUNDLE_PACKAGE_NAME);
    expect(pkg.name).toBe('@leo-je/gemini-cli');
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
});
