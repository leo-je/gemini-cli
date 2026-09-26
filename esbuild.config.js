/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { wasmLoader } from 'esbuild-plugin-wasm';

let esbuild;
try {
  esbuild = (await import('esbuild')).default;
} catch {
  console.error('esbuild not available - cannot build bundle');
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const pkg = require(path.resolve(__dirname, 'package.json'));

// SINGLE_FILE=true collapses the CLI build into a single .mjs file instead of
// the default code-split bundle/ directory (see `npm run bundle:single`). The
// runtime assets in copy_bundle_assets.js still have to sit next to it, and
// native modules (node-pty, keytar) and yoga-layout stay external.
const SINGLE_FILE = process.env.SINGLE_FILE === 'true';
const OUT_DIR = SINGLE_FILE ? 'bundle-single' : 'bundle';
const CLI_ENTRY_FILE = SINGLE_FILE ? 'gemini.mjs' : 'gemini.js';

function createWasmPlugins() {
  const wasmBinaryPlugin = {
    name: 'wasm-binary',
    setup(build) {
      build.onResolve({ filter: /\.wasm\?binary$/ }, (args) => {
        const specifier = args.path.replace(/\?binary$/, '');
        const resolveDir = args.resolveDir || '';
        const isBareSpecifier =
          !path.isAbsolute(specifier) &&
          !specifier.startsWith('./') &&
          !specifier.startsWith('../');

        let resolvedPath;
        if (isBareSpecifier) {
          resolvedPath = require.resolve(specifier, {
            paths: resolveDir ? [resolveDir, __dirname] : [__dirname],
          });
        } else {
          resolvedPath = path.isAbsolute(specifier)
            ? specifier
            : path.join(resolveDir, specifier);
        }

        return { path: resolvedPath, namespace: 'wasm-embedded' };
      });
    },
  };

  return [wasmBinaryPlugin, wasmLoader({ mode: 'embedded' })];
}

/**
 * ink's reconciler opens with a top-level `await import('./devtools.js')`
 * guarded by `process.env['DEV']`. Two things make it incompatible with a
 * single-file build:
 *   - it is written with bracket notation, so the `process.env.DEV` define
 *     below cannot fold the branch away, and
 *   - top-level await is only legal while the module stays a real ES module.
 *     Without code splitting esbuild inlines it into a non-async `__esm`
 *     lazy-init wrapper, which is a syntax error.
 * DEV is false in every shipped build, so dropping the await costs nothing.
 */
function createTopLevelAwaitPlugin() {
  return {
    name: 'strip-ink-top-level-await',
    setup(build) {
      build.onLoad(
        { filter: /[\\/]ink[\\/]build[\\/]reconciler\.js$/ },
        (args) => {
          const original = readFileSync(args.path, 'utf8');
          const patched = original.replace(
            "await import('./devtools.js')",
            "void import('./devtools.js')",
          );
          if (patched === original) {
            throw new Error(
              `No top-level "await import('./devtools.js')" found in ${args.path}. ` +
                'The single-file build would emit invalid JS. Update the patch in esbuild.config.js.',
            );
          }
          return { contents: patched, loader: 'js' };
        },
      );
    },
  };
}

/**
 * esbuild emits syntactically invalid JS (rather than failing) whenever a
 * top-level await survives into an inlined lazy-init wrapper, so parse the
 * single-file output before declaring the build a success.
 */
function verifySingleFileSyntax(file) {
  const { status, stderr } = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
  });
  if (status !== 0) {
    throw new Error(`Single-file bundle failed a syntax check:\n${stderr}`);
  }
}

const external = [
  '@lydell/node-pty',
  'node-pty',
  '@lydell/node-pty-darwin-arm64',
  '@lydell/node-pty-darwin-x64',
  '@lydell/node-pty-linux-x64',
  '@lydell/node-pty-win32-arm64',
  '@lydell/node-pty-win32-x64',
  '@github/keytar',
];

const baseConfig = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  external,
  loader: { '.node': 'file' },
  write: true,
};

const commonAliases = {
  punycode: 'punycode/',
  'https-proxy-agent': path.resolve(
    __dirname,
    'packages/cli/src/patches/https-proxy-agent.ts',
  ),
  'http-proxy-agent': path.resolve(
    __dirname,
    'packages/cli/src/patches/http-proxy-agent.ts',
  ),
};

const cliConfig = {
  ...baseConfig,
  banner: {
    js: `const require = (await import('node:module')).createRequire(import.meta.url); const __chunk_filename = (await import('node:url')).fileURLToPath(import.meta.url); const __chunk_dirname = (await import('node:path')).dirname(__chunk_filename);`,
  },
  entryPoints: { gemini: 'packages/cli/index.ts' },
  ...(SINGLE_FILE
    ? {
        // A single entry point with splitting off collapses the whole CLI into
        // one file. The .mjs extension keeps it an ES module once it is copied
        // outside this repo, where there is no package.json to say so.
        splitting: false,
        outfile: `${OUT_DIR}/${CLI_ENTRY_FILE}`,
      }
    : {
        outdir: OUT_DIR,
        splitting: true,
      }),
  // yoga-layout is the one dependency whose entry point uses top-level await
  // (`wrapAssembly(await loadYoga())`). It cannot be inlined without splitting,
  // so the single-file build loads it from node_modules instead — it is already
  // a transitive dependency of ink, so nothing extra has to be installed.
  external: SINGLE_FILE ? [...external, 'yoga-layout'] : external,
  define: {
    __filename: '__chunk_filename',
    __dirname: '__chunk_dirname',
    'process.env.CLI_VERSION': JSON.stringify(pkg.version),
    'process.env.GEMINI_SANDBOX_IMAGE_DEFAULT': JSON.stringify(
      pkg.config?.sandboxImageUri,
    ),
    'process.env.NODE_ENV': JSON.stringify(
      process.env.NODE_ENV || 'production',
    ),
    'process.env.DEV': JSON.stringify(process.env.DEV || 'false'),
  },
  plugins: SINGLE_FILE
    ? [createTopLevelAwaitPlugin(), ...createWasmPlugins()]
    : createWasmPlugins(),
  alias: {
    'is-in-ci': path.resolve(__dirname, 'packages/cli/src/patches/is-in-ci.ts'),
    '@google/gemini-cli-devtools': path.resolve(
      __dirname,
      'packages/devtools/src/index.ts',
    ),
    ...commonAliases,
  },
  metafile: true,
};

const workerConfig = {
  ...baseConfig,
  banner: {
    js: `const require = (await import('node:module')).createRequire(import.meta.url); const __chunk_filename = (await import('node:url')).fileURLToPath(import.meta.url); const __chunk_dirname = (await import('node:path')).dirname(__chunk_filename);`,
  },
  entryPoints: {
    'worker/worker-entry': path.join(
      path.dirname(require.resolve('ink')),
      'worker/worker-entry.js',
    ),
  },
  outdir: OUT_DIR,
  define: {
    __filename: '__chunk_filename',
    __dirname: '__chunk_dirname',
    'process.env.NODE_ENV': JSON.stringify(
      process.env.NODE_ENV || 'production',
    ),
  },
  plugins: createWasmPlugins(),
  alias: commonAliases,
};

const a2aServerConfig = {
  ...baseConfig,
  banner: {
    js: `const require = (await import('node:module')).createRequire(import.meta.url); const __chunk_filename = (await import('node:url')).fileURLToPath(import.meta.url); const __chunk_dirname = (await import('node:path')).dirname(__chunk_filename);`,
  },
  entryPoints: ['packages/a2a-server/src/http/server.ts'],
  outfile: 'packages/a2a-server/dist/a2a-server.mjs',
  define: {
    __filename: '__chunk_filename',
    __dirname: '__chunk_dirname',
    'process.env.CLI_VERSION': JSON.stringify(pkg.version),
    'process.env.NODE_ENV': JSON.stringify(
      process.env.NODE_ENV || 'production',
    ),
    'process.env.DEV': JSON.stringify(process.env.DEV || 'false'),
  },
  plugins: createWasmPlugins(),
  alias: commonAliases,
};

Promise.allSettled([
  esbuild.build(cliConfig).then(({ metafile }) => {
    if (process.env.DEV === 'true') {
      writeFileSync(
        `./${OUT_DIR}/esbuild.json`,
        JSON.stringify(metafile, null, 2),
      );
    }
    if (SINGLE_FILE) {
      verifySingleFileSyntax(`${OUT_DIR}/${CLI_ENTRY_FILE}`);
    }
  }),
  esbuild.build(workerConfig),
  esbuild.build(a2aServerConfig),
]).then((results) => {
  const [cliResult, workerResult, a2aResult] = results;
  if (cliResult.status === 'rejected') {
    console.error('gemini.js build failed:', cliResult.reason);
    process.exit(1);
  }
  if (workerResult.status === 'rejected') {
    console.error('worker-entry.js build failed:', workerResult.reason);
    process.exit(1);
  }
  // error in a2a-server bundling will not stop gemini.js bundling process
  if (a2aResult.status === 'rejected') {
    console.warn('a2a-server build failed:', a2aResult.reason);
  }
});
