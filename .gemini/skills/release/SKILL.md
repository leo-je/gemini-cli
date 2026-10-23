---
name: release
description:
  Use this skill when asked to publish a release of this fork (the
  `gemini-cli-leo` package). It cuts a `releases/X.Y.Z` branch from a source
  branch the user picks, bumps every manifest and the lockfile, pushes to trigger
  the binary + npm workflow, watches the run, and verifies the published
  artifacts. Do not use it for upstream `@google/gemini-cli` releases.
---

# Release

Publishes `gemini-cli-leo` from this fork. The mechanical steps live in
`scripts/release.mjs`; this file is the decisions and the traps around them.

## Inputs (ask first, never guess)

1. **Source branch** — where the release is cut from. Default `new-version-openai`.
   Other candidates: whatever `git branch -r` shows and the user names.
2. **Target version** — plain `X.Y.Z`.

Run `node .gemini/skills/release/scripts/release.mjs latest` first: it prints the
published versions, three candidate numbers from the current `latest`, and the
release branches that already exist. Present the candidates and let the user pick.

## Steps

1. **Preflight** (read-only):
   `node .gemini/skills/release/scripts/release.mjs preflight --version X.Y.Z --branch <src>`
   It requires a clean tree, a source branch matching `origin/<src>`, and no
   existing `releases/X.Y.Z` branch or `vX.Y.Z` tag anywhere. Fix what it
   complains about; do not work around it.
2. **Prepare** (mutates the repo):
   `... prepare --version X.Y.Z --branch <src> --yes`
   Creates `releases/X.Y.Z`, stamps the version into the root manifest, all
   workspace manifests and the lockfile, and commits
   `chore(release): bump version to X.Y.Z`. It also refuses to continue when
   npm already lists that version.
   **Expected diff: 9 files, 17 insertions / 17 deletions**, touching only
   `package*.json` version fields. Anything else means the source branch drifted
   from the shape the script assumes — stop and look.
3. **Confirm with the user**, then push:
   `... push --version X.Y.Z --yes`
   Push is the point of no return: it starts the build and the npm publish.
4. **Watch**:
   `... watch --version X.Y.Z`
   Polls the workflow run, prints one line per job, and on failure names the
   failing step and the job id.
5. **Verify**:
   `... verify --version X.Y.Z`
   Checks the npm version list, the GitHub release assets, and the local tag.
6. **Switch back**: `git checkout <src>`, then report the run id, the asset
   list, the npm `latest`, and anything left unverified (binaries are never
   executed as part of a release).

## Hard rules

- **Never `npm version --workspaces`.** It resends the lockfile through the
  registry resolver and has hung for 20+ minutes in a worktree without
  `node_modules`. The script stamps the manifests directly, which reproduces the
  npm output exactly for this repo (internal deps are `file:` links, so no
  dependency pins move).
- **Never bump the same version twice.** npm refuses to overwrite a published
  version, so a mis-bumped release can only be superseded, not fixed.
- **Never create the tag by hand.** The workflow creates `vX.Y.Z` and the GitHub
  release from the branch after every platform builds.
- **Do not touch `sandboxImageUri`** in the workspace manifests; it intentionally
  points at an upstream nightly image.
- **`npm view` is not authoritative.** It serves a cached copy and has reported
  an older `latest` than the registry actually had. The script queries
  `registry.npmjs.org` directly; trust that, or `curl` the registry yourself.
- **Minimum version guard**: don't release a version lower than the published
  `latest` unless the user explicitly asks for a rollback.

## Failure playbook

- **Only `Build (darwin-x64)` fails, at `Build Binary`** — historically transient
  (the same commit builds fine on arm64 and win32, and a re-run goes green).
  Retrigger, do not bump:
  `git checkout releases/X.Y.Z && ... retrigger --version X.Y.Z --yes`
  The empty commit triggers the workflow again because it fires on any push to
  `releases/*`.
- **Any other failure** — job logs answer HTTP 403 without an admin token, so
  replicate locally instead:
  `npm ci && npm run build:binary`. Fix, commit on the source branch, and cut a
  new patch version rather than reusing a published one.
- **`Publish to npm` succeeded but the version is missing** — check
  `registry.npmjs.org/<pkg>` before believing anything; propagation through the
  npm CLI cache can lag by minutes.

## Checklist

- [ ] Source branch and version confirmed out loud by the user
- [ ] `preflight` all green
- [ ] Diff shape exactly 9 files / 17±17, version lines only
- [ ] Push only after explicit go-ahead
- [ ] All 10 workflow jobs green
- [ ] npm `latest` equals the new version (checked against the registry, not `npm view`)
- [ ] 8 release assets present
- [ ] Switched back to the source branch
