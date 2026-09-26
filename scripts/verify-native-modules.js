/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Confirms the native modules shipped inside a release bundle load on the
// machine that unpacked it.
//
// This is not covered by `gemini --version`: the CLI requires these modules
// lazily and falls back to a non-PTY execution path when they are missing, so a
// bundle carrying another platform's .node binaries stays green right up until
// a user tries to run a shell command.
//
// Resolution is anchored at the bundle entry point, which is how the CLI finds
// them at runtime (`createRequire(import.meta.url)` inside the bundle).
//
// Usage:
//   node scripts/verify-native-modules.mjs <path to an extracted gemini.mjs>

import path from 'node:path';
import { createRequire } from 'node:module';

const entry = process.argv[2];

if (!entry) {
  console.error(
    'Usage: node verify-native-modules.mjs <path to an extracted gemini.mjs>',
  );
  process.exit(2);
}

const bundleRequire = createRequire(path.resolve(entry));

// yoga-layout is deliberately absent: it is a plain JavaScript package with the
// WASM inlined, and the bundle imports it statically, so loading gemini.mjs
// already proves it resolves.
const modules = ['@lydell/node-pty', '@github/keytar'];
const failures = [];

for (const name of modules) {
  try {
    bundleRequire(name);
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message.split('\n')[0]}`);
  }
}

if (failures.length > 0) {
  console.error('\nNative modules failed to load from the bundle:');
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log(`All ${modules.length} native modules loaded.`);
