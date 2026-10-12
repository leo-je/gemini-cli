/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Confirms a release bundle carries the native modules it promises, and that
// the one which has to work does work on the machine that unpacked it.
//
// `gemini --version` does not cover this: the CLI requires these modules lazily
// and falls back when they are missing, so a bundle without them stays green
// right up until a user runs a shell command.
//
// Resolution is anchored at the bundle entry point, which is how the CLI finds
// them at runtime (`createRequire(import.meta.url)` inside the bundle).
//
// Usage:
//   node scripts/verify-native-modules.js <path to an extracted gemini.mjs>

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const entry = process.argv[2];

if (!entry) {
  console.error(
    'Usage: node verify-native-modules.js <path to an extracted gemini.mjs>',
  );
  process.exit(2);
}

const bundleRequire = createRequire(path.resolve(entry));
const failures = [];

// The prebuilt binary ships as an optional dependency for one platform only, so
// requiring the package is what proves the archive carries the right one. This
// is also the module whose absence silently degrades shell execution.
try {
  bundleRequire('@lydell/node-pty');
  console.log('ok - @lydell/node-pty');
} catch (error) {
  failures.push(`@lydell/node-pty: ${error.message.split('\n')[0]}`);
}

// @github/keytar is held to a different bar. It ships prebuilds for every OS, so
// there is no "wrong platform's copy" to catch, and on Linux its addon links
// libsecret-1, which a headless machine may not have. `getNativeKeychain()`
// treats a keytar that fails to load exactly like an absent one and falls back
// to FileKeychain, so a load failure is a warning here rather than a build
// failure. Being absent from the archive is still fatal.
let keytarRoot;
try {
  keytarRoot = path.dirname(
    bundleRequire.resolve('@github/keytar/package.json'),
  );
} catch {
  keytarRoot = undefined;
}

if (!keytarRoot) {
  failures.push('@github/keytar: not present in the bundle');
} else {
  const prebuild = path.join(
    keytarRoot,
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'keytar.node',
  );

  if (!fs.existsSync(prebuild)) {
    failures.push(
      `@github/keytar: no prebuild for ${process.platform}-${process.arch}`,
    );
  } else {
    console.log(
      `ok - @github/keytar (prebuild for ${process.platform}-${process.arch})`,
    );
    try {
      bundleRequire('@github/keytar');
      console.log('ok - @github/keytar loaded');
    } catch (error) {
      // keytar's own loader swallows the underlying dlopen error, so ask for it
      // directly; otherwise the reason (typically a missing libsecret-1) cannot
      // be seen from CI at all.
      let reason = error.message.split('\n')[0];
      try {
        process.dlopen({ exports: {} }, prebuild);
      } catch (dlopenError) {
        reason = dlopenError.message.split('\n')[0];
      }
      console.warn(`warning - @github/keytar did not load: ${reason}`);
      console.warn('warning - the CLI falls back to FileKeychain');
    }
  }
}

if (failures.length > 0) {
  console.error('\nBundle verification failed:');
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log('Native modules verified.');
