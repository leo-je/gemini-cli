---
name: sync-release-auto
description:
  Use this skill when running or changing the unattended every-12-hours pipeline
  that syncs this fork with google-gemini/gemini-cli and, when upstream has
  moved, cuts and publishes a `releases/<version>` build. Triggers include
  "automated sync and release", "scheduled upstream check", "12 hour release
  run", and any debugging of `.gemini/automation/logs`. For a manual,
  step-by-step sync see `sync-fork-upstream`; for a hand-cut release see
  `release`.
---

# Automated upstream sync + release

`scripts/sync-release-auto.mjs` is the whole pipeline. It runs unattended every
12 hours and is **allowed to push and publish without asking**, so the guard
rails below are what stand between a bad merge and a permanent npm version.

## What one run does

1. **Check** — `git fetch` upstream and origin, then count
   `new-version-openai..upstream/main`. Zero means stop here; nothing is touched.
2. **Version** — the next `releases/<X.Y.Z>-pre.<N>`, computed from the newest
   *plain* X.Y.Z on the registry (see the version rule below).
3. **Mirror** — merge upstream into `rep-main` and push it.
4. **Release branch** — cut `releases/<version>` from `new-version-openai` and
   merge the upstream delta into **that release branch**.
5. **Resolve** — apply the per-path conflict policy, then re-check the fork
   invariants and for leftover conflict markers.
6. **Stamp** — write the version into the 8 manifests plus the lockfile, and
   assert the diff is exactly 9 files / 17±17 lines.
7. **Build + test** — build the workspace packages, then the test gate.
8. **Push** — push the release branch, which is what starts
   `build-release-binaries.yml` (4 platform binaries, GitHub release, npm publish).
9. **Merge back** — fast-forward `new-version-openai` to the synced *merge*
   commit, so the next run does not merge the same upstream delta again. The
   version-stamp commit is deliberately excluded.
10. **Watch** — poll the workflow run and verify the npm version and release assets.

Any failure before step 8 aborts without pushing. A failure after step 8 leaves
a pushed branch, and the log says so.

## Commands

```bash
node .gemini/skills/sync-release-auto/scripts/sync-release-auto.mjs check
node .gemini/skills/sync-release-auto/scripts/sync-release-auto.mjs check --json
node .gemini/skills/sync-release-auto/scripts/sync-release-auto.mjs run
node .gemini/skills/sync-release-auto/scripts/sync-release-auto.mjs run --dry-run
node .gemini/skills/sync-release-auto/scripts/sync-release-auto.mjs run --quick
node .gemini/skills/sync-release-auto/scripts/sync-release-auto.mjs status
```

`check` is read-only and safe to run any time. `run --dry-run` executes
everything up to the push, which is how a policy change should be validated.

## The version rule (the one that is easy to get wrong)

Versions look like `0.1.30-pre.1`:

- **Bump the patch of the newest plain `X.Y.Z`**, not of `dist-tags.latest`.
  Automated runs publish prereleases *under the `latest` tag*, so deriving the
  base from `latest` would advance a patch on every single run.
- **`N` accumulates inside a base.** Several syncs before a human cuts a real
  release stay at `-pre.1`, `-pre.2`, … instead of inventing patches.
- The version must be valid semver: `0.1.30-pre.1`, never `0.1.30.pre.1`. npm
  refuses a prerelease with no tag and the whole publish step fails.

## Branch shape

- `releases/<version>` — prefix is **plural**. `build-release-binaries.yml`
  triggers on `releases/*`; `release/*` would build nothing and fail silently.
- The release branch carries the version stamp **and** the upstream merge,
  because this pipeline is configured to merge into the release branch rather
  than `new-version-openai` first.
- The merge-back in step 9 is what keeps that choice from diverging: after every
  run, `new-version-openai` contains the same upstream merge, so the next release
  branch is cut from a line that is already synced.

## Conflict policy

Applied per path; `ours` is the fork side, `theirs` is upstream.

| Path | Policy | Why |
| :--- | :--- | :--- |
| `packages/core/src/core/openai/**` | ours | fork-owned OpenAI backend |
| `packages/cli/src/ui/openai/**` | ours | fork-owned OpenAI UI |
| `core/{tokenLimits,providerModels,integration}.ts` | ours | fork-owned provider logic |
| `scripts/verify-native-modules.js` | ours | fork-only guard |
| `.github/workflows/**` | ours | the fork trims triggers on purpose; upstream's `on:` blocks must not return |
| `schemas/**`, `docs/**` | theirs | generated or upstream-owned |
| `package-lock.json` | theirs, then reconciled | rebuilt from the merged manifests |
| `package.json`, `packages/*/package.json` | json union | keep both sides' dependency keys; the fork version wins |
| `config.ts`, `gemini.tsx`, `AppContainer.tsx`, `contentGenerator.ts` | union | both sides append; keep both |
| anything else | union | unclassified: keep both and let the test gate judge |

The union policy uses `git merge-file --union`, so both hunks survive. Anything
unmatched defaults to union rather than to a silent either/or.

## Guard rails

- **Never reuse a published version.** The registry is checked directly (not
  `npm view`, which serves a cache and has reported stale answers on this host)
  and the run aborts if the version already exists.
- **Never push a damaged merge.** Six invariant markers are checked after the
  merge — the OpenAI factory branch, the provider dialog hooks, the OpenCode
  flag, the fork header marker, and the two fork-owned `openai/` directories.
  A clean auto-merge can still be semantically wrong, and those markers are the
  only thing that catches it.
- **Never leave conflict markers.** Touched files are scanned for column-0
  markers before any commit is made.
- **The stamp must stay a version stamp.** If the diff is anything other than
  the 8 manifests and the lockfile, the run aborts.
- **A broken build never ships.** The workspace is compiled and the gate run
  before the push.
- **Concurrency is locked.** `.git/automation.lock` holds a pid; a live holder
  aborts the new run, a dead one is reclaimed.
- **Only the main checkout's `node_modules` is shared, never modified.** The
  worktree gets its own `node_modules` directory whose entries are symlinks
  into the main tree, except the workspace packages, which point at the
  worktree's own sources. Mutating entries *through* a symlink to the shared
  tree once rewrote this repo's own `node_modules`, so do not "simplify" this
  back into a single `symlinkSync`.

## Scoping facts that were verified, not assumed

- `npm run build --workspaces` fails here: `vscode-ide-companion` needs a
  package-local `esbuild` that a shared install cannot provide. Only
  `devtools, core, sdk, test-utils, a2a-server, cli` are built, in that order —
  `cli` imports `devtools` types.
- The workspace package names are not derived from directory names: `cli` is
  `@google/gemini-cli`, not `@google/gemini-cli-cli`.
- `npm` dies with `EPERM` on this host because `~/.npm` holds root-owned cache
  entries. `cleanEnv()` redirects `npm_config_cache` to a temp directory.
- Test suites run with `GEMINI_OPENAI_*` unset; ambient values change auth
  resolution and cause false failures.
- Two gitignored build inputs (`packages/cli/src/generated/git-commit.ts`, same
  for core) are regenerated in the worktree, or copied from the main checkout.

## Exit states

| `status` | Meaning |
| :--- | :--- |
| `no-update` | upstream already merged; nothing was touched |
| `dry-run` | everything validated, stopped before the push |
| `released` | build green, npm version and release assets verified |
| `built-not-published` | workflow green but the npm version has not appeared yet (propagation can lag) |
| `build-failed` | branch pushed, workflow failed — fix on the source branch and cut the next `-pre.N`, never reuse the version |
| `pushed-unwatched` | push done, workflow did not finish inside `--timeout` |

Logs are written to `.gemini/automation/logs/run-<timestamp>.log`; `status`
prints the newest one.

## When something needs a human

- A conflict the policy sent to `union` that still fails the build: read the
  log, decide the merge by hand in a worktree, and land it on
  `new-version-openai` — the next run cuts a fresh `-pre.N` from it.
- An upstream change that legitimately removes one of the invariant markers:
  update `INVARIANTS` in the script in the same commit that accepts the change,
  otherwise every later run aborts.
- `build-failed` on a version that was never published: fix, then re-run; the
  next version is `-pre.N+1` on the same base.
