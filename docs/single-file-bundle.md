# Single-file bundle

`npm run bundle:single` compiles the CLI into a single ES module,
`bundle-single/gemini.mjs`, instead of the code-split `bundle/` directory that
`npm run bundle` produces.

## Why the default build is split

`esbuild.config.js` builds the CLI with `splitting: true`, so the entry point
(`bundle/gemini.js`) is a small shell that imports a set of `chunk-*.js` files.
The source relies on dynamic `import()` — the main entry, the interactive UI,
and other heavy modules are only pulled in when needed — and splitting keeps
each of those in its own file. The single-file build turns splitting off and
emits one file instead; esbuild still defers those modules through its `__esm`
lazy-init wrappers, but they now all live in the same file.

## Building and running

```bash
npm run bundle:single
node bundle-single/gemini.mjs --version
```

The underlying scripts take environment variables, which is what the npm script
sets:

| Variable      | Effect                                              |
| ------------- | --------------------------------------------------- |
| `SINGLE_FILE` | Set to `true` to emit one file instead of `bundle/` |
| `BUNDLE_DIR`  | Output directory for `copy_bundle_assets.js`        |

The output file is `.mjs` rather than `.js` on purpose. Node decides whether a
file is CommonJS or an ES module from the nearest `package.json`, so a `.js`
file copied outside this repository is loaded as CommonJS and fails with
`Identifier 'require' has already been declared`. The `.mjs` extension keeps it
an ES module wherever it lands.

## What still has to sit next to the file

The single file is **not** self-contained. Runtime assets are resolved relative
to the JavaScript file (not the working directory), so they must be copied
alongside it. `scripts/copy_bundle_assets.js` does this, and the same list
applies to both bundle layouts:

| Path                              | Used by                                     |
| --------------------------------- | ------------------------------------------- |
| `policies/*.toml`                 | Policy engine (`DEFAULT_CORE_POLICIES_DIR`) |
| `docs/`                           | The internal documentation tool             |
| `builtin/`                        | Built-in agent skills                       |
| `examples/`                       | `gemini extensions new`                     |
| `bundled/chrome-devtools-mcp.mjs` | Browser agent (spawned as a child process)  |
| `worker/worker-entry.js`          | ink render worker                           |
| `sandbox-macos-*.sb`              | macOS seatbelt sandbox profiles             |

Two of these are worth calling out:

- If `worker/worker-entry.js` is missing, ink falls back to rendering in the
  main process and prints a warning, which corrupts the terminal UI. The build
  emits it next to the entry file for this reason.
- ripgrep is not part of either bundle. `resolveRipgrepPath` looks for
  `rg-<platform>-<arch>` next to the bundle and in `vendor/ripgrep/`, then falls
  back to `rg` on `PATH`.

Native modules — `@lydell/node-pty`, `node-pty`, and `@github/keytar` — stay
external in every build because they ship `.node` binaries that cannot be
inlined into JavaScript. They are loaded at runtime with a dynamic `require`, so
`node_modules` has to be resolvable from the bundle.

## Top-level await

Turning off code splitting exposes a constraint that the default build does not
have: **top-level await is only valid while each module remains a real ES
module**. When esbuild inlines a module into a lazy-init wrapper instead, it
emits `await` inside a non-async function and produces a file that does not
parse. The failure looks like this:

```
SyntaxError: Unexpected reserved word
    await init_gemini();
    ^^^^^
```

Only one dependency in the graph uses top-level await at its entry point:
`yoga-layout`, which does `wrapAssembly(await loadYoga())` to load its WASM. The
single-file build therefore marks it external. Because `yoga-layout` is already
a transitive dependency of `ink`, this does not add anything to install.

`ink/build/reconciler.js` has a second top-level await:

```js
if (process.env['DEV'] === 'true') {
  await import('./devtools.js');
}
```

The bracket notation means the `process.env.DEV` define cannot fold the branch
away, and `DEV` is false in shipped builds, so an `onLoad` plugin rewrites the
import to `void import(...)`.

Two guards keep this from regressing silently:

- The plugin throws if it cannot find the expected text in ink's reconciler, so
  an ink upgrade fails the build instead of emitting a broken file.
- After a single-file build, the output is parsed with `node --check`. esbuild
  reports no error of its own for this case, so without the check a broken file
  would ship.

## When to use this instead of the SEA binary

`npm run build:binary` (see `scripts/build_binary.js` and `sea/sea-launch.cjs`)
already produces a single artifact: it embeds the whole `bundle/` directory into
a Node binary as SEA assets and extracts them to a temporary directory at
startup. That is the better answer when the goal is "one file to distribute",
because it needs neither a Node install nor `node_modules` next to it.

Reach for the single-file bundle when you specifically want a JavaScript entry
point — for example, embedding the CLI in another Node program, or distributing
a readable artifact that runs under an existing Node installation. It still
needs the assets and `node_modules` described above, so it trades fewer files
for an unchanged runtime layout rather than removing the layout entirely.
