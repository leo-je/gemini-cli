---
name: sync-fork-upstream
description:
  Use this skill when asked to sync this fork (leo-je/gemini-cli) with upstream
  google-gemini/gemini-cli: fetch upstream into the `rep-main` mirror branch,
  fast-forward `rep-main`, merge `rep-main` into the `new-version-openai`
  development line, and assess or resolve the resulting conflicts. Triggers
  include "sync fork", "pull upstream", "update from google-gemini/main",
  "merge rep-main", "will this conflict", and "resolve the merge conflicts".
---

# Sync upstream into the fork (leo-je/gemini-cli)

## Branch roles

- `rep-main` — upstream-mirror branch and the fork's **GitHub default branch**.
  The fork's `Merge branch 'google-gemini:main' into rep-main` commits and the
  fork's CI/workflow trims land here. Because it is the default branch, GitHub's
  web **"Sync fork"** button merges upstream's *default branch* into it; the web
  UI cannot pick another target.
- `new-version-openai` — the fork's development/integration line (OpenAI
  backend). This is where the merge under test happens.
- `releases/0.1.N` — release branches cut from `new-version-openai` (see skill
  `release`).
- `upstream` — `https://github.com/google-gemini/gemini-cli.git`.
- `origin` — `git@github.com:leo-je/gemini-cli.git`.

**The web sync may have already run.** `origin/rep-main` is often ahead of the
local `rep-main` because someone clicked "Sync fork". Always fetch and compare
first; fast-forward instead of merging upstream a second time.

## Procedure

### 1. Inspect state

```bash
git status --short --branch
git --no-pager branch -vv
git --no-pager remote -v
```

A dirty tree must be resolved first — the worktree probes below need a clean
index. Confirm which branch is checked out before anything else; the whole
procedure assumes you can move freely.

### 2. Ensure the `upstream` remote and fetch both

```bash
git remote add upstream https://github.com/google-gemini/gemini-cli.git  # only if absent
git -c core.sshCommand=ssh fetch upstream --prune
git -c core.sshCommand=ssh fetch origin --prune
```

### 3. Move `rep-main` to the synced state

```bash
git checkout rep-main
git merge --ff-only origin/rep-main
```

If `origin/rep-main` is *behind* `upstream/main` (the web sync has not run),
merge upstream yourself:

```bash
git merge upstream/main        # commit message: Merge branch 'google-gemini:main' into rep-main
```

That merge is normally clean because `rep-main`-only content is confined to
`.github/workflows/**` and `scripts/verify-native-modules.js`, which upstream
rarely touches.

### 4. Measure the gap

```bash
git --no-pager rev-list --left-right --count rep-main...upstream/main    # expect "<n> 0"
git --no-pager rev-list --left-right --count rep-main...new-version-openai
```

A nonzero right-hand number in the first command means upstream moved again
during the sync — repeat step 3 before continuing.

### 5. Pre-assess conflicts before touching `new-version-openai`

Textual conflicts come only from files **both** sides changed since their merge
base.

```bash
git --no-pager merge-base rep-main new-version-openai      # copy the SHA, paste it literally below
git --no-pager diff --name-only <base>..rep-main           | sort > "$TMPDIR/a.txt"
git --no-pager diff --name-only <base>..new-version-openai | sort > "$TMPDIR/b.txt"
comm -12 "$TMPDIR/a.txt" "$TMPDIR/b.txt"
```

Disjoint sets mean the merge is textually clean. **Do not stop at set overlap —
run the real probe**, because a clean auto-merge can still be semantically
wrong:

```bash
git worktree add --detach "$TMPDIR/probe" rep-main
cd "$TMPDIR/probe"
git checkout -b probe-nvo new-version-openai
git merge <rep-main-sha> --no-commit --no-ff
git --no-pager diff --name-only --diff-filter=U      # empty output = no conflicts
```

Probe in a worktree, never in the main checkout: the main checkout is the thing
you are protecting. Tear down with:

```bash
git worktree remove --force "$TMPDIR/probe"
git branch -D probe-nvo
```

Report the overlapping-file list and the conflict verdict to the user **before**
merging.

### 6. Merge

```bash
git checkout new-version-openai
git merge rep-main
```

The `ort` strategy auto-resolves the usual disjoint cases. Expect auto-merges in
`packages/cli/src/config/config.ts`, `packages/cli/src/gemini.tsx` and
`packages/cli/src/test-utils/render.tsx` — all three are touched by both sides,
yet merge cleanly because the hunks are far apart.

Default posture when resolving: **keep both sides**. Upstream adds a feature, the
fork adds a sibling feature, and both belong in the file. Only make a real
either/or decision when the two sides edit the *same* lines or encode the same
invariant.

### 7. Verify the fork's invariants survived

A clean auto-merge does not guarantee the OpenAI backend still works. These
markers must be non-zero (or at the stated count):

```bash
grep -c "OpenAIContentGenerator"    packages/core/src/core/contentGenerator.ts   # 2
grep -c "useProviderDialogHandlers" packages/cli/src/ui/AppContainer.tsx         # 2
grep -c "openAiProviderId"          packages/cli/src/config/config.ts            # 1
grep -c "leo modify"                packages/cli/src/ui/components/AppHeader.tsx # 2
ls packages/core/src/core/openai/ | wc -l   # 20
ls packages/cli/src/ui/openai/    | wc -l   # 25
```

The two `openai/` directories are fork-owned and must not shrink. If a count
dropped, upstream's copy of the file replaced a fork hunk — recover the fork
side with `git show ORIG_HEAD:<path>` and re-apply it.

### 8. Verify, cheapest first

Run everything with the ambient `GEMINI_OPENAI_*` variables **unset**. A real
`GEMINI_OPENAI_BASE_URL` / `GEMINI_OPENAI_API_KEY` in the environment changes
auth resolution and produces false failures.

```bash
env -u GEMINI_OPENAI_BASE_URL -u GEMINI_OPENAI_API_KEY -u GEMINI_OPENAI_MODELID \
    -u GEMINI_OPENAI_HEADERS -u GEMINI_API_TYPE npm run typecheck
```

```bash
env -u GEMINI_OPENAI_BASE_URL -u GEMINI_OPENAI_API_KEY -u GEMINI_OPENAI_MODELID \
    -u GEMINI_OPENAI_HEADERS -u GEMINI_API_TYPE \
    npx vitest run --root packages/core src/core/openai src/core/geminiChat.test.ts \
      src/tools/edit.test.ts src/tools/read-file.test.ts src/tools/write-file.test.ts \
      src/utils/pathCorrector.test.ts
```

```bash
npx vitest run --root packages/cli src/ui/openai src/core/initializer.test.ts \
  src/validateNonInterActiveAuth.test.ts src/ui/auth/useAuth.test.tsx \
  src/ui/hooks/useGeminiStream.test.tsx src/ui/AppContainer.test.tsx
```

Then lint only the files the merge touched (`npx eslint <files...>`). A
full-workspace lint takes too long for a merge check and reports unrelated
pre-existing noise.

**A failing fork-owned test is not automatically merge damage.** Prove it either
way before reporting: check out the pre-merge commit in a worktree with a
symlinked `node_modules` and run the same test there.

```bash
git worktree add --detach "$TMPDIR/prefix" <pre-merge-sha>
ln -s /data/data/com.termux/files/home/git/gemini-cli/node_modules "$TMPDIR/prefix/node_modules"
cd "$TMPDIR/prefix" && npx vitest run --root packages/cli src/ui/openai/<file>.test.tsx
```

Regenerate generated artifacts instead of hand-merging them:

```bash
npm run schema:settings    # schemas/settings.schema.json and related docs
```

### 9. Report, do not push

```bash
git --no-pager rev-list --left-right --count new-version-openai...upstream/main
```

State the new gap, what merged cleanly, what conflicted and how it was resolved,
which tests failed and whether they are pre-existing, and that nothing was
pushed. Leave the user on `new-version-openai` unless they ask otherwise.

## Conflict resolution rules

- **`packages/cli/src/config/config.ts`** — `CliArgs` is a bag of optional flags
  plus yargs registrations. Keep upstream's new flags *and* the fork's
  `openAiProviderId` / OpenCode settings. Both sides append to the same lists;
  never drop one side's entry to settle a conflict.
- **`packages/cli/src/gemini.tsx`** — a long `main()` with early-exit branches.
  Upstream adds command branches (e.g. `--list-models`), the fork adds OpenAI
  detection before the auth gate. Order matters: the fork's early OpenAI-mode
  detection must stay ahead of the Gemini-only setup it exists to bypass.
- **`packages/cli/src/ui/AppContainer.tsx`** — the fork owns `useProviderCommand`,
  `useProviderDialogHandlers` and the provider dialogs. Upstream keeps adding
  hooks and props here. Accept upstream's additions wholesale, then re-add the
  fork's imports, hook calls and JSX props; do not let a rewritten block drop
  them.
- **`packages/core/src/core/contentGenerator.ts`** — the fork branches on
  `USE_OPENAI` to construct `OpenAIContentGenerator`, and keeps that diff
  deliberately "upstream-shaped". Preserve the fork's branch; adopt upstream's
  changes to the Gemini paths around it.
- **`packages/core/src/core/tokenLimits.ts`**, **`providerModels.ts`**,
  **`integration.ts`** — fork-owned provider logic; upstream does not touch
  these, so a conflict here means the branch roles were inverted. Stop and
  investigate.
- **`.github/workflows/**`** — fork-only by design. The triggers are trimmed to
  the `package` branch and the `schedule:` crons are removed to save Actions
  quota (see the Chinese comment block at the top of `.github/workflows/ci.yml`).
  Upstream regularly rewrites these files. Take upstream's file, then re-apply
  the fork's trigger block; never wholesale-accept upstream's `on:` sections,
  which reintroduce `schedule`/`pull_request` triggers the fork removed on
  purpose.
- **`scripts/verify-native-modules.js`** — fork-only file (absent upstream).
  Keep it, and keep the `revert: keep the native module bundle check` decision in
  mind when the surrounding build scripts change.
- **`schemas/settings.schema.json`** and **`docs/**`** — generated or
  upstream-owned. Do not hand-merge; regenerate (see step 8) after the code merge
  settles.

## Pitfalls

- Command substitution (`$(...)`, backticks, `<()`/`>()`) is rejected by this
  CLI's shell with "Command injection detected". Compute `git merge-base` /
  `git rev-parse` in a separate call and paste the literal SHA. This is also why
  the recipes above spell out `$TMPDIR` paths instead of nesting commands.
- `git checkout <sha> -- .` in the main checkout rewrites the entire working tree
  and can silently discard a completed merge. Never use it for inspection; use
  `git show ORIG_HEAD:<path>` or a separate worktree.
- All git network commands need `git -c core.sshCommand=ssh ...` on this host;
  plain `git fetch` over SSH can fail.
- Never bump `package.json` versions during an upstream sync. Version bumps
  belong only on `releases/0.1.N` (skill `release`).
- Never force-push, and never push `rep-main` / `new-version-openai` / `main`
  unless asked.
- `local main` is intentionally behind `origin/main`; do not "fix" it as part of
  a sync.
- `bundle-single/` and `packages/*/junit.xml` appear as untracked noise after
  tests; leave them alone.
- A clean merge still needs the step 7 marker checks — a semantic regression
  produces no conflict marker and no type error.

## Verification

- `git merge` reports `Merge made by the 'ort' strategy`, or leaves explicit
  conflict markers; after resolution `git status` is clean with no `UU` entries.
- Step 7 markers all present at their expected counts.
- `npm run typecheck` exits 0.
- Targeted `npx eslint` on the merge-touched files exits 0.
- The OpenAI core/CLI suites and the auth suites pass with `GEMINI_OPENAI_*`
  unset, and any failure is proven pre-existing against the pre-merge commit.
- Nothing was pushed.
