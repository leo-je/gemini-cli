#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Unattended upstream-sync + release pipeline for this fork.
//
// Once every 12 hours this checks whether google-gemini/gemini-cli moved, and if
// it did it mirrors upstream into `rep-main`, cuts `releases/<version>` from
// `new-version-openai`, merges the upstream delta into that release branch,
// resolves conflicts by a per-path policy, runs the fork's test gate, then
// pushes the branch — which is what starts `build-release-binaries.yml` (binary
// matrix + GitHub release + npm publish).
//
// Design constraints that shaped the code, all of them observed on this repo:
//
//   * `releases/*` (plural) is the workflow trigger. `release/*` would build
//     nothing, silently.
//   * The version must be valid semver (so `-pre.N`, never `.pre-N`) or npm
//     refuses to publish a prerelease that carries no tag.
//   * `latest` on the registry is a *prerelease* after the first automated run,
//     so the patch bump is computed from the newest plain X.Y.Z, never from
//     `dist-tags.latest`. Otherwise every run would jump another patch.
//   * An npm version is permanent. `ensureVersionIsFree` is therefore checked
//     against the registry directly, not `npm view` (which serves a cache).
//   * All mutating work happens in throwaway worktrees, so an interrupted run
//     cannot leave the main checkout on a half-merged branch.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const REGISTRY = 'https://registry.npmjs.org';
const API = 'https://api.github.com';
const PACKAGE_NAME = 'gemini-cli-leo';
const RELEASE_PREFIX = 'releases/';
const SOURCE_BRANCH = 'new-version-openai';
const MIRROR_BRANCH = 'rep-main';
const UPSTREAM_REMOTE = 'upstream';
const UPSTREAM_BRANCH = 'main';
const WORKFLOW_FILE = 'build-release-binaries.yml';

// ---------------------------------------------------------------------------
// process plumbing
// ---------------------------------------------------------------------------

/** Filled in by main(); every log line is mirrored into the run log file. */
let LOG_PATH = null;

function stamp() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function log(message = '') {
  const line = message === '' ? '' : `[${stamp()}] ${message}`;
  console.log(line);
  if (LOG_PATH) {
    try {
      writeFileSync(LOG_PATH, `${line}\n`, { flag: 'a' });
    } catch {
      // A full disk must not abort a release run.
    }
  }
}

function step(title) {
  log('');
  log(`── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

function ok(message) {
  log(`  ✓ ${message}`);
}

function warn(message) {
  log(`  ! ${message}`);
}

function fail(message) {
  log(`  ✗ ${message}`);
}

class Abort extends Error {}

function abort(message) {
  throw new Abort(message);
}

function run(cmd, args, { cwd, allowFailure = false, env, input } = {}) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      input,
      env: env ? { ...process.env, ...env } : process.env,
    }).trim();
  } catch (error) {
    if (allowFailure) {
      return '';
    }
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${cmd} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
}

function git(args, options = {}) {
  return run('git', args, options);
}

/**
 * Like run(), but returns stdout even when the command exits non-zero.
 *
 * `git merge-file --union` exits with the number of unresolved overlaps while
 * still writing the correct union body to stdout, so the normal helpers would
 * discard exactly the output that is needed.
 */
function runCapture(cmd, args, { cwd, env } = {}) {
  try {
    return {
      status: 0,
      stdout: execFileSync(cmd, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env ? { ...process.env, ...env } : process.env,
      }),
    };
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { command, flags };
}

// ---------------------------------------------------------------------------
// repo + registry queries
// ---------------------------------------------------------------------------

function repoRoot() {
  return git(['rev-parse', '--show-toplevel']);
}

function repoSlug(root) {
  const url = git(['remote', 'get-url', 'origin'], { cwd: root });
  const match = /github\.com[:/](?<slug>[^/]+\/[^/.]+?)(\.git)?$/.exec(url);
  if (!match?.groups?.slug) {
    throw new Error(`cannot parse a GitHub slug out of the origin remote: ${url}`);
  }
  return match.groups.slug;
}

async function getJson(url, { token } = {}) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Published versions straight from the registry. `npm view` goes through a
 * local cache that has served stale answers on this host (and its cache is not
 * writable here), so the registry is queried directly.
 */
async function registryState() {
  const payload = await getJson(`${REGISTRY}/${encodeURIComponent(PACKAGE_NAME)}`);
  const versions = Object.keys(payload.versions ?? {}).sort(compareVersions);
  return {
    latest: payload['dist-tags']?.latest ?? null,
    versions,
  };
}

/** Numeric-aware compare for the fork's version shapes (`0.1.29-fix-1`). */
function compareVersions(a, b) {
  const split = (value) =>
    value
      .split(/[-.]/)
      .map((part) => (/^\d+$/.test(part) ? { n: Number(part) } : { s: part }));
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l.n !== undefined && r.n !== undefined) {
      if (l.n !== r.n) return l.n - r.n;
    } else if (l.s !== undefined && r.s !== undefined) {
      const cmp = l.s.localeCompare(r.s);
      if (cmp !== 0) return cmp;
    } else {
      // A prerelease part sorts before the numeric-only release it decorates.
      return l.n === undefined ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Next `releases/<X.Y.Z>-pre.<N>` version.
 *
 * The patch bump comes from the newest *plain* X.Y.Z on the registry: the
 * automated runs publish prereleases under the `latest` tag, so reading
 * `dist-tags.latest` would move the patch base forward on every single run.
 * `N` accumulates within that base, so repeated syncs stay inside one target
 * version instead of inventing a patch per run.
 */
function decideVersion({ versions, branches, tags }) {
  const plain = versions.filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  const latestPlain = plain.sort(compareVersions).at(-1);

  let base;
  if (latestPlain) {
    const [major, minor, patch] = latestPlain.split('.').map(Number);
    base = `${major}.${minor}.${patch + 1}`;
  } else {
    // Nothing published yet: fall back to the manifest's minor line.
    const current = readFileSync('package.json', 'utf8');
    const [major, minor] = JSON.parse(current).version.split('.');
    base = `${major}.${minor}.1`;
  }

  const prePattern = new RegExp(`^${base.replaceAll('.', '\\.')}-pre\\.(\\d+)$`);
  const seen = [];
  const note = (value) => {
    const match = prePattern.exec(value);
    if (match) seen.push(Number(match[1]));
  };
  versions.forEach(note);
  for (const branch of branches) note(branch.replace(RELEASE_PREFIX, ''));
  for (const tag of tags) note(tag.replace(/^v/, ''));

  const pre = (seen.length > 0 ? Math.max(...seen) : 0) + 1;
  return {
    base,
    pre,
    version: `${base}-pre.${pre}`,
    branch: `${RELEASE_PREFIX}${base}-pre.${pre}`,
    tag: `v${base}-pre.${pre}`,
    basedOn: latestPlain,
  };
}

function remoteBranches(root) {
  return git(['ls-remote', '--heads', 'origin'], { cwd: root })
    .split('\n')
    .map((line) => line.split('\t')[1] ?? '')
    .map((ref) => ref.replace('refs/heads/', ''))
    .filter(Boolean);
}

function remoteTags(root) {
  return git(['ls-remote', '--tags', 'origin'], { cwd: root })
    .split('\n')
    .map((line) => line.split('\t')[1] ?? '')
    .map((ref) => ref.replace('refs/tags/', '').replace(/\^\{\}$/, ''))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// conflict resolution policy
// ---------------------------------------------------------------------------

// Derived from .gemini/skills/sync-fork-upstream/SKILL.md. `ours` = the fork
// side of the merge (the release branch before the merge), `theirs` = upstream.
const CONFLICT_POLICIES = [
  {
    match: /^packages\/core\/src\/core\/openai\//,
    policy: 'ours',
    reason: 'fork-owned OpenAI backend',
  },
  {
    match: /^packages\/cli\/src\/ui\/openai\//,
    policy: 'ours',
    reason: 'fork-owned OpenAI UI',
  },
  {
    match: /^packages\/core\/src\/core\/(tokenLimits|providerModels)\.ts$/,
    policy: 'ours',
    reason: 'fork-owned provider logic',
  },
  {
    match: /^packages\/core\/src\/core\/integration\.ts$/,
    policy: 'ours',
    reason: 'fork-owned provider logic',
  },
  {
    match: /^scripts\/verify-native-modules\.js$/,
    policy: 'ours',
    reason: 'fork-only native module guard',
  },
  {
    match: /^\.github\/workflows\//,
    policy: 'ours',
    reason: 'fork trims triggers deliberately; upstream on: blocks must not return',
  },
  {
    match: /^schemas\//,
    policy: 'theirs',
    reason: 'generated from upstream settings schema',
  },
  {
    match: /^docs\//,
    policy: 'theirs',
    reason: 'upstream-owned documentation',
  },
  {
    match: /^package-lock\.json$/,
    policy: 'theirs',
    reason: 'rebuilt from the merged manifests afterwards',
  },
  {
    match: /^package\.json$/,
    policy: 'json',
    reason: 'union of dependency keys, fork version wins',
  },
  {
    match: /^packages\/[^/]+\/package\.json$/,
    policy: 'json',
    reason: 'union of dependency keys, fork version wins',
  },
  {
    match: /^packages\/cli\/src\/(config\/config\.ts|gemini\.tsx|ui\/AppContainer\.tsx)$/,
    policy: 'union',
    reason: 'both sides append; keep both',
  },
  {
    match: /^packages\/core\/src\/core\/contentGenerator\.ts$/,
    policy: 'union',
    reason: 'fork branches on USE_OPENAI; keep upstream around it',
  },
];

function policyFor(path) {
  for (const entry of CONFLICT_POLICIES) {
    if (entry.match.test(path)) return entry;
  }
  return { policy: 'union', reason: 'unclassified; keep both sides and rely on the test gate' };
}

/** Deep-union of two parsed JSON documents. `preferred` wins on scalars. */
function mergeJsonValues(mine, theirs, preferred) {
  if (Array.isArray(mine) || Array.isArray(theirs)) {
    const left = Array.isArray(mine) ? mine : [];
    const right = Array.isArray(theirs) ? theirs : [];
    if (preferred === 'theirs') return [...new Set([...right, ...left])];
    return [...new Set([...left, ...right])];
  }
  if (mine && theirs && typeof mine === 'object' && typeof theirs === 'object') {
    const out = {};
    for (const key of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
      if (!(key in mine)) {
        out[key] = theirs[key];
      } else if (!(key in theirs)) {
        out[key] = mine[key];
      } else {
        out[key] = mergeJsonValues(mine[key], theirs[key], preferred);
      }
    }
    return out;
  }
  return preferred === 'theirs' ? theirs : mine;
}

function trailingNewline(path) {
  try {
    return readFileSync(path, 'utf8').endsWith('\n') ? '\n' : '';
  } catch {
    return '\n';
  }
}

/**
 * Resolve every unmerged path in the worktree. Returns the decisions taken so
 * the caller can report them and refuse to push on anything but a clean result.
 */
function resolveConflicts(worktree) {
  const conflicted = git(['diff', '--name-only', '--diff-filter=U'], { cwd: worktree })
    .split('\n')
    .filter(Boolean);

  const decisions = [];
  for (const path of conflicted) {
    const { policy, reason } = policyFor(path);
    const target = join(worktree, path);
    let applied = policy;

    if (policy === 'ours') {
      git(['checkout', '--ours', '--', path], { cwd: worktree });
    } else if (policy === 'theirs') {
      git(['checkout', '--theirs', '--', path], { cwd: worktree });
    } else if (policy === 'union') {
      // A three-way union keeps both sides' hunks and drops the markers. This is
      // the skill's documented default posture: both features belong.
      const base = join(worktree, `.merge-base.${basename(path)}`);
      const ours = join(worktree, `.merge-ours.${basename(path)}`);
      const theirs = join(worktree, `.merge-theirs.${basename(path)}`);
      for (const [stage, out] of [
        [1, base],
        [2, ours],
        [3, theirs],
      ]) {
        const blob = git(['show', `:${stage}:${path}`], { cwd: worktree, allowFailure: true });
        writeFileSync(out, blob === '' ? '' : `${blob}\n`);
      }
      const merged = runCapture('git', ['merge-file', '--union', '-p', ours, base, theirs], {
        cwd: worktree,
      });
      if (merged.stdout === '') {
        // No usable union body: keep the fork side rather than write an empty file.
        applied = 'union-ours-fallback';
        writeFileSync(target, readFileSync(ours, 'utf8'));
      } else {
        writeFileSync(target, `${merged.stdout}\n`);
      }
      for (const stale of [base, ours, theirs]) rmSync(stale, { force: true });
    } else if (policy === 'json') {
      const parseStage = (stage) => {
        const blob = git(['show', `:${stage}:${path}`], { cwd: worktree, allowFailure: true });
        try {
          return blob ? JSON.parse(blob) : null;
        } catch {
          return null;
        }
      };
      const mine = parseStage(2);
      const theirs = parseStage(3);
      if (!mine || !theirs) {
        // Unparseable side: keep the fork copy rather than corrupt the manifest.
        git(['checkout', '--ours', '--', path], { cwd: worktree });
        applied = 'json-ours-fallback';
      } else {
        const union = mergeJsonValues(mine, theirs, 'ours');
        if (typeof mine.version === 'string') union.version = mine.version;
        writeFileSync(target, `${JSON.stringify(union, null, 2)}${trailingNewline(target)}`);
      }
    }

    git(['add', '--', path], { cwd: worktree });
    decisions.push({ path, policy: applied, reason });
    log(`    ${path} → ${applied}${applied === policy ? '' : ` (fell back from ${policy})`}`);
  }

  return decisions;
}

// ---------------------------------------------------------------------------
// post-merge invariants
// ---------------------------------------------------------------------------

// From sync-fork-upstream step 7: a clean auto-merge still needs these checks,
// because a semantic regression produces neither a conflict marker nor a type
// error. `null` marker means "directory must simply exist and be non-empty".
const INVARIANTS = [
  {
    file: 'packages/core/src/core/contentGenerator.ts',
    pattern: /OpenAIContentGenerator/,
    count: 2,
    why: 'OpenAI branch in the content generator factory',
  },
  {
    file: 'packages/cli/src/ui/AppContainer.tsx',
    pattern: /useProviderDialogHandlers/,
    count: 2,
    why: 'provider dialog hooks',
  },
  {
    file: 'packages/cli/src/config/config.ts',
    pattern: /openAiProviderId/,
    count: 1,
    why: 'OpenCode provider flag',
  },
  {
    file: 'packages/cli/src/ui/components/AppHeader.tsx',
    pattern: /leo modify/,
    count: 2,
    why: 'fork header marker',
  },
  { dir: 'packages/core/src/core/openai', count: 20, why: 'fork OpenAI core files' },
  { dir: 'packages/cli/src/ui/openai', count: 25, why: 'fork OpenAI CLI files' },
];

function checkInvariants(root) {
  const problems = [];
  for (const invariant of INVARIANTS) {
    if (invariant.dir) {
      const dir = join(root, invariant.dir);
      if (!existsSync(dir)) {
        problems.push(`${invariant.dir} is missing (${invariant.why})`);
        continue;
      }
      const entries = run('ls', ['-1', dir]);
      const count = entries ? entries.split('\n').filter(Boolean).length : 0;
      if (count < invariant.count) {
        problems.push(
          `${invariant.dir} has ${count} entries, expected ${invariant.count} (${invariant.why})`,
        );
      } else {
        ok(`${invariant.dir} ${count} entries`);
      }
      continue;
    }
    const path = join(root, invariant.file);
    if (!existsSync(path)) {
      problems.push(`${invariant.file} is missing (${invariant.why})`);
      continue;
    }
    const content = readFileSync(path, 'utf8');
    // Count matching *lines*, matching `grep -c` in the sync-fork-upstream skill:
    // these markers legitimately appear twice on one line (import + usage).
    const matches = content
      .split('\n')
      .filter((line) => invariant.pattern.test(line)).length;
    if (matches !== invariant.count) {
      problems.push(
        `${invariant.file}: ${matches} matching line(s), expected ${invariant.count} (${invariant.why})`,
      );
    } else {
      ok(`${invariant.file} ${matches} matching line(s)`);
    }
  }
  return problems;
}

/**
 * Scan the files the merge actually touched. Walking every tracked file is far
 * too slow on this repository and no merge can corrupt a file it never wrote.
 */
function checkNoConflictMarkers(worktree) {
  const touched = git(['diff', '--name-only', 'HEAD'], { cwd: worktree })
    .split('\n')
    .filter(Boolean);
  const offenders = [];
  for (const path of touched) {
    const full = join(worktree, path);
    if (!existsSync(full)) continue;
    let content;
    try {
      content = readFileSync(full, 'utf8');
    } catch {
      continue; // binary or unreadable: cannot carry text markers
    }
    // Markers only count at column 0; documentation and tests quote them indented.
    if (/^<{7} /m.test(content) || /^>{7} /m.test(content) || /^\|{7} /.test(content)) {
      offenders.push(path);
    }
  }
  return offenders;
}

// ---------------------------------------------------------------------------
// version stamping (mirrors .gemini/skills/release/scripts/release.mjs)
// ---------------------------------------------------------------------------

function writeJson(path, mutate) {
  const original = readFileSync(path, 'utf8');
  const next = mutate(JSON.parse(original));
  const trailing = original.endsWith('\n') ? '\n' : '';
  writeFileSync(path, `${JSON.stringify(next, null, 2)}${trailing}`);
}

function stampVersions(root, version) {
  const lockPath = join(root, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const workspaceKeys = Object.keys(lock.packages ?? {}).filter(
    (key) =>
      /^packages\/[^/]+$/.test(key) &&
      typeof lock.packages[key]?.name === 'string' &&
      typeof lock.packages[key]?.version === 'string',
  );
  if (workspaceKeys.length === 0) {
    throw new Error('no workspace entries found in package-lock.json');
  }

  writeJson(join(root, 'package.json'), (json) => ({ ...json, version }));
  for (const key of workspaceKeys) {
    writeJson(join(root, key, 'package.json'), (json) => ({ ...json, version }));
    lock.packages[key].version = version;
  }
  lock.version = version;
  if (lock.packages['']) lock.packages[''].version = version;
  writeJson(lockPath, () => lock);
  return workspaceKeys.length + 1;
}

// ---------------------------------------------------------------------------
// worktrees
// ---------------------------------------------------------------------------

/**
 * Create a scratch worktree, tolerating the state a killed run leaves behind.
 *
 * A run that is interrupted after `git worktree add` but before `remove` leaves
 * a registered-but-missing worktree, and git refuses to re-add that path. The
 * path is removed from the registry first so every run starts clean.
 */
function addWorktree(root, path, ref) {
  git(['worktree', 'remove', '--force', path], { cwd: root, allowFailure: true });
  rmSync(path, { recursive: true, force: true });
  git(['worktree', 'prune'], { cwd: root, allowFailure: true });
  git(['worktree', 'add', '--detach', path, ref], { cwd: root });
}

function removeWorktree(root, path) {
  git(['worktree', 'remove', '--force', path], { cwd: root, allowFailure: true });
  rmSync(path, { recursive: true, force: true });
  git(['worktree', 'prune'], { cwd: root, allowFailure: true });
}

/**
 * Give the worktree a working dependency tree without a full `npm ci`.
 *
 * Two traps made this subtle enough to be worth spelling out:
 *
 *  1. `@google/gemini-cli-*` inside the installed tree are *relative* symlinks
 *     (`../../packages/core`) that resolve against the main checkout, so
 *     TypeScript and Node would read the main checkout's stale
 *     `packages/<pkg>/dist` and tests would pass while testing the wrong code.
 *  2. Building the worktree's `node_modules` by mutating entries *through* a
 *     symlink to the shared tree destroys the shared tree — it rewrote this
 *     repository's own `node_modules/@google/*` during a rehearsal.
 *
 * So the worktree gets a real directory whose entries are individual symlinks
 * back into the main checkout's tree, except the workspace packages, which
 * point at the worktree's own sources. Nothing outside the worktree is written.
 */
const WORKSPACE_PACKAGES = [
  ['@google/gemini-cli', 'cli'],
  ['@google/gemini-cli-core', 'core'],
  ['@google/gemini-cli-a2a-server', 'a2a-server'],
  ['@google/gemini-cli-devtools', 'devtools'],
  ['@google/gemini-cli-sdk', 'sdk'],
  ['@google/gemini-cli-test-utils', 'test-utils'],
  ['gemini-cli-vscode-ide-companion', 'vscode-ide-companion'],
];

/** Names inside `node_modules` (and `@scope/`) that must point at the worktree. */
function workspaceOverrides(worktree) {
  const overrides = new Map();
  for (const [name, dir] of WORKSPACE_PACKAGES) {
    const destination = join(worktree, 'packages', dir);
    if (existsSync(destination)) overrides.set(name, destination);
  }
  return overrides;
}

function linkNodeModules(root, worktree) {
  const rootModules = join(root, 'node_modules');
  const targetModules = join(worktree, 'node_modules');
  if (existsSync(targetModules)) {
    return;
  }
  if (!existsSync(rootModules)) {
    // Silently skipping this left the worktree without a dependency tree, and
    // the failure surfaced much later as a confusing build error.
    abort(`no dependency tree at ${rootModules}; run npm ci before the automated run`);
  }
  const overrides = workspaceOverrides(worktree);
  mkdirSync(targetModules, { recursive: true });

  // Shallow-link every top-level entry; a scoped directory is recreated so its
  // children can be overridden individually.
  for (const entry of readdirSync(rootModules)) {
    const source = join(rootModules, entry);
    const target = join(targetModules, entry);
    if (entry.startsWith('@')) {
      mkdirSync(target, { recursive: true });
      for (const child of readdirSync(source)) {
        const override = overrides.get(`${entry}/${child}`);
        symlinkSync(override ?? join(source, child), join(target, child), 'dir');
      }
      continue;
    }
    symlinkSync(overrides.get(entry) ?? source, target, 'dir');
  }
  ok('linked the dependency tree (workspace packages point at the worktree)');

  // Per-package node_modules (hoisting exceptions) are safe to reuse as-is.
  for (const [, dir] of WORKSPACE_PACKAGES) {
    const source = join(root, 'packages', dir, 'node_modules');
    const target = join(worktree, 'packages', dir, 'node_modules');
    if (existsSync(source) && !existsSync(target)) {
      try {
        symlinkSync(source, target, 'dir');
      } catch {
        // Only a slower run, never a correctness problem.
      }
    }
  }
}

/**
 * The build reads two gitignored inputs: the generated git-commit module and
 * the devtools client asset. Regenerate them in the worktree, otherwise `tsc`
 * fails on `Cannot find module '../../generated/git-commit.js'`. If generation
 * fails, fall back to copying the main checkout's copies: they are
 * version-agnostic build inputs.
 */
function prepareGeneratedFiles(root, worktree) {
  const pairs = [
    ['packages/cli/src/generated', 'git-commit.ts'],
    ['packages/core/src/generated', 'git-commit.ts'],
  ];
  const missing = pairs.filter(
    ([dir, file]) => !existsSync(join(worktree, dir, file)),
  );
  if (missing.length === 0) {
    return;
  }
  try {
    run('npm', ['run', 'generate'], { cwd: worktree, env: cleanEnv() });
    ok('regenerated the gitignore-managed generated sources');
    return;
  } catch (error) {
    warn(`could not regenerate the generated sources: ${messageOf(error)}`);
  }
  for (const [dir] of pairs) {
    const source = join(root, dir);
    const target = join(worktree, dir);
    if (existsSync(target) || !existsSync(source)) continue;
    try {
      run('cp', ['-R', source, target]);
      ok(`copied ${dir} from the main checkout`);
    } catch {
      // The test gate's typecheck will report the missing module clearly.
    }
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// test gate
// ---------------------------------------------------------------------------

const OPENAI_ENV_KEYS = [
  'GEMINI_OPENAI_BASE_URL',
  'GEMINI_OPENAI_API_KEY',
  'GEMINI_OPENAI_MODELID',
  'GEMINI_OPENAI_HEADERS',
  'GEMINI_API_TYPE',
];

/**
 * Run with the ambient OpenAI settings unset: they change auth resolution and
 * turn the auth suites into false failures.
 *
 * The npm cache is redirected because this host's `~/.npm` carries root-owned
 * cache entries, which makes every `npm install` die with EPERM. A run-scoped
 * cache directory keeps npm out of the broken one entirely.
 */
function cleanEnv() {
  const env = { ...process.env };
  for (const key of OPENAI_ENV_KEYS) delete env[key];
  if (!env.npm_config_cache) {
    const cache = join(tmpdir(), 'dsh-sync-release-npm-cache');
    mkdirSync(cache, { recursive: true });
    env.npm_config_cache = cache;
  }
  return env;
}

function runTest(worktree, label, cmd, args) {
  log(`  → ${label}`);
  const started = Date.now();
  try {
    run(cmd, args, { cwd: worktree, env: cleanEnv() });
  } catch (error) {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    fail(`${label} failed after ${seconds}s`);
    throw new Abort(
      `test gate failed at "${label}". Nothing was pushed.\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
  ok(`${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

function testGate(worktree, { quick }) {
  step('Test gate');
  runTest(worktree, 'typecheck', 'npm', ['run', 'typecheck']);
  runTest(worktree, 'core openai + chat suites', 'npx', [
    'vitest',
    'run',
    '--root',
    'packages/core',
    'src/core/openai',
    'src/core/geminiChat.test.ts',
    'src/tools/edit.test.ts',
    'src/tools/read-file.test.ts',
    'src/tools/write-file.test.ts',
    'src/utils/pathCorrector.test.ts',
  ]);
  if (quick) {
    warn('quick mode: skipped the CLI openai + auth suites');
    return;
  }
  runTest(worktree, 'cli openai + auth suites', 'npx', [
    'vitest',
    'run',
    '--root',
    'packages/cli',
    'src/ui/openai',
    'src/config/config.test.ts',
    'src/ui/auth/useAuth.test.tsx',
    'src/ui/hooks/useGeminiStream.test.tsx',
  ]);
}

// ---------------------------------------------------------------------------
// UI status reporting
// ---------------------------------------------------------------------------

async function workflowRuns(slug, branch) {
  const { token } = githubAuth();
  const payload = await getJson(
    `${API}/repos/${slug}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=5`,
    { token },
  );
  return payload.workflow_runs ?? [];
}

function githubAuth() {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
  return { token };
}

async function waitForRelease(slug, branch, headSha, timeoutMinutes) {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let lastLine = '';
  while (Date.now() < deadline) {
    const runs = await workflowRuns(slug, branch);
    const run = runs.find((item) => !headSha || item.head_sha === headSha) ?? runs[0];
    if (run) {
      const line = `${run.status}${run.conclusion ? `/${run.conclusion}` : ''}`;
      if (line !== lastLine) {
        log(`  workflow run ${run.id}: ${line}`);
        lastLine = line;
      }
      if (run.status === 'completed') return run;
    }
    await sleep(30_000);
  }
  return null;
}

async function reportRun(slug, run) {
  const { token } = githubAuth();
  const jobs = await getJson(`${API}/repos/${slug}/actions/runs/${run.id}/jobs?per_page=30`, {
    token,
  });
  for (const job of jobs.jobs ?? []) {
    const mark = job.conclusion === 'success' ? '✓' : '✗';
    log(`  ${mark} ${job.name} (${job.conclusion})`);
    if (job.conclusion === 'failure') {
      for (const failed of (job.steps ?? []).filter((s) => s.conclusion === 'failure')) {
        log(`      failed step: ${failed.name}`);
      }
    }
  }
  log(`  run url: ${run.html_url}`);
}

// ---------------------------------------------------------------------------
// main pipeline
// ---------------------------------------------------------------------------

function lockFile(root) {
  return join(root, '.git', 'dsh-sync-release.lock');
}

function acquireLock(root) {
  const path = lockFile(root);
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8').trim() || 0);
    let alive = false;
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) {
      abort(`another run (pid ${pid}) holds ${basename(path)}`);
    }
    warn(`removing stale lock from pid ${pid || '?'}`);
    rmSync(path, { force: true });
  }
  writeFileSync(path, String(process.pid));
  return () => rmSync(path, { force: true });
}

async function cmdCheck(root, flags) {
  step('Check for upstream changes');
  git(['fetch', '--prune', 'origin'], { cwd: root, allowFailure: true });
  git(['fetch', '--prune', UPSTREAM_REMOTE], { cwd: root });
  git(['fetch', '--tags', '--prune', 'origin'], { cwd: root, allowFailure: true });

  const upstreamSha = git(['rev-parse', `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`], { cwd: root });
  const behind = Number(
    git(['rev-list', '--count', `${SOURCE_BRANCH}..${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`], {
      cwd: root,
    }),
  );
  const state = await registryState();
  const decided = decideVersion({
    versions: state.versions,
    branches: remoteBranches(root),
    tags: remoteTags(root),
  });

  const summary = {
    upstreamSha,
    upstreamSubject: git(['log', '-1', '--format=%s', upstreamSha], { cwd: root }),
    behind,
    updateAvailable: behind > 0,
    npmLatest: state.latest,
    nextVersion: decided.version,
    nextBranch: decided.branch,
    basedOn: decided.basedOn,
    checkedAt: new Date().toISOString(),
  };

  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    log(`  upstream  ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} @ ${upstreamSha.slice(0, 9)} "${summary.upstreamSubject}"`);
    log(`  commits   ${behind} not in ${SOURCE_BRANCH}`);
    log(`  npm       ${PACKAGE_NAME} latest=${state.latest} (${state.versions.length} versions)`);
    log(`  next      ${decided.branch} (${decided.version})`);
    if (behind === 0) {
      ok('nothing to do');
    } else {
      ok(`${behind} upstream commit(s) to sync`);
    }
  }
  return summary;
}

async function cmdRun(root, flags) {
  const dryRun = flags['dry-run'] === true;
  const quick = flags.quick === true;
  const timeoutMinutes = Number(flags.timeout ?? 45);
  const keepWorktrees = flags['keep-worktrees'] === true;

  const logDir = join(root, '.gemini', 'automation', 'logs');
  mkdirSync(logDir, { recursive: true });
  LOG_PATH = join(logDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

  const releaseLock = acquireLock(root);
  const summary = { pushed: false, version: null, branch: null, runId: null };
  const worktrees = [];

  try {
    const check = await cmdCheck(root, {});
    summary.version = check.nextVersion;
    summary.branch = check.nextBranch;

    if (!check.updateAvailable) {
      ok('upstream is already merged; stopping before any mutation');
      summary.status = 'no-update';
      return summary;
    }

    const dirty = git(['status', '--porcelain'], { cwd: root });
    if (dirty) {
      abort(`working tree is not clean; refusing to start:\n${dirty}`);
    }
    ok('main working tree clean');

    // Fail fast on the one irreversible mistake: reusing a published version.
    const state = await registryState();
    if (state.versions.includes(check.nextVersion)) {
      abort(`${PACKAGE_NAME}@${check.nextVersion} is already published; refusing to reuse it`);
    }
    ok(`${check.nextVersion} is not published yet`);

    // ------------------------------------------------------------------
    step(`Mirror upstream into ${MIRROR_BRANCH}`);
    // ------------------------------------------------------------------
    const mirrorPath = join(root, '.gemini', 'automation', 'worktrees', 'mirror');
    rmSync(mirrorPath, { recursive: true, force: true });
    // A fresh clone has the mirror branch only as a remote-tracking ref, so take
    // whichever of the local branch or origin/<mirror> actually exists.
    const mirrorRef =
      git(['rev-parse', '--verify', '--quiet', MIRROR_BRANCH], { cwd: root, allowFailure: true }) ||
      `origin/${MIRROR_BRANCH}`;
    addWorktree(root, mirrorPath, mirrorRef);
    worktrees.push(mirrorPath);

    const remoteMirror = git(['rev-parse', '--verify', '--quiet', `origin/${MIRROR_BRANCH}`], {
      cwd: root,
      allowFailure: true,
    });
    let mirrorChanged = false;
    if (remoteMirror) {
      const localMirror = git(['rev-parse', 'HEAD'], { cwd: mirrorPath });
      if (localMirror !== remoteMirror) {
        try {
          git(['merge', '--ff-only', `origin/${MIRROR_BRANCH}`], { cwd: mirrorPath });
          ok(`fast-forwarded ${MIRROR_BRANCH} to origin/${MIRROR_BRANCH}`);
          mirrorChanged = true;
        } catch {
          warn(`local ${MIRROR_BRANCH} cannot fast-forward to origin; leaving it alone`);
        }
      }
    }

    const mirrorBehind = Number(
      git(['rev-list', '--count', `HEAD..${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`], {
        cwd: mirrorPath,
      }),
    );
    if (mirrorBehind > 0) {
      log(`  merging ${mirrorBehind} upstream commit(s) into ${MIRROR_BRANCH}`);
      try {
        git(
          [
            'merge',
            '--no-ff',
            '--no-edit',
            '-m',
            `Merge branch 'google-gemini:main' into ${MIRROR_BRANCH}`,
            `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`,
          ],
          { cwd: mirrorPath },
        );
      } catch {
        warn(`conflicts merging upstream into ${MIRROR_BRANCH}`);
        // resolveConflicts logs each decision itself; do not repeat them here.
        resolveConflicts(mirrorPath);
        const markers = checkNoConflictMarkers(mirrorPath);
        if (markers.length > 0) {
          abort(`conflict markers left in ${markers.join(', ')}`);
        }
        git(['commit', '--no-edit'], { cwd: mirrorPath });
      }
      mirrorChanged = true;
      ok(`${MIRROR_BRANCH} now contains upstream`);
    } else {
      ok(`${MIRROR_BRANCH} already contains upstream`);
    }

    if (mirrorChanged) {
      if (dryRun) {
        warn('dry-run: not pushing ' + MIRROR_BRANCH);
      } else {
        git(['push', 'origin', `HEAD:refs/heads/${MIRROR_BRANCH}`], { cwd: mirrorPath });
        ok(`pushed ${MIRROR_BRANCH}`);
      }
    }

    // ------------------------------------------------------------------
    step(`Cut ${check.nextBranch} from ${SOURCE_BRANCH} and merge upstream into it`);
    // ------------------------------------------------------------------
    const releasePath = join(root, '.gemini', 'automation', 'worktrees', 'release');
    rmSync(releasePath, { recursive: true, force: true });
    addWorktree(root, releasePath, SOURCE_BRANCH);
    worktrees.push(releasePath);
    linkNodeModules(root, releasePath);

    // A previous run that died before the push leaves a local branch behind.
    // It was never pushed and its version was never published (both are checked
    // above and below), so recreating it from the source branch is safe — and
    // refusing here would make every retry need manual cleanup.
    if (
      git(['rev-parse', '--verify', '--quiet', `refs/heads/${check.nextBranch}`], {
        cwd: releasePath,
        allowFailure: true,
      })
    ) {
      if (git(['ls-remote', '--exit-code', '--heads', 'origin', check.nextBranch], {
        cwd: releasePath,
        allowFailure: true,
      })) {
        abort(`${check.nextBranch} already exists on origin; refusing to reuse a pushed release branch`);
      }
      warn(`replacing the leftover local branch ${check.nextBranch} from the last aborted run`);
      git(['switch', '--detach'], { cwd: releasePath });
      git(['branch', '-D', check.nextBranch], { cwd: releasePath });
    }
    git(['switch', '-c', check.nextBranch], { cwd: releasePath });
    ok(`created ${check.nextBranch} at ${SOURCE_BRANCH}`);

    let mergeCommit = null;
    if (check.behind > 0) {
      log(`  merging ${check.behind} upstream commit(s) into ${check.nextBranch}`);
      try {
        git(
          [
            'merge',
            '--no-ff',
            '--no-edit',
            '-m',
            `Merge remote-tracking branch '${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}' into ${SOURCE_BRANCH}`,
            `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`,
          ],
          { cwd: releasePath },
        );
        mergeCommit = git(['rev-parse', 'HEAD'], { cwd: releasePath });
        ok(`merged cleanly at ${mergeCommit.slice(0, 9)}`);
      } catch {
        warn('merge produced conflicts; applying per-path policy');
        const decisions = resolveConflicts(releasePath);
        if (decisions.length === 0) {
          abort('merge failed but git reported no conflicted paths');
        }
        const markers = checkNoConflictMarkers(releasePath);
        if (markers.length > 0) {
          abort(`conflict markers left in:\n  ${markers.join('\n  ')}`);
        }
        ok(`resolved ${decisions.length} conflicted path(s)`);
        git(['commit', '--no-edit'], { cwd: releasePath });
        mergeCommit = git(['rev-parse', 'HEAD'], { cwd: releasePath });
      }
    }
    if (!mergeCommit) {
      mergeCommit = git(['rev-parse', 'HEAD'], { cwd: releasePath });
    }

    // ------------------------------------------------------------------
    step('Reconcile lockfile');
    // ------------------------------------------------------------------
    try {
      run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
        cwd: releasePath,
        env: cleanEnv(),
      });
      const drifted = git(['status', '--porcelain', '--', 'package-lock.json'], {
        cwd: releasePath,
      });
      if (drifted) {
        git(['add', '--', 'package-lock.json'], { cwd: releasePath });
        git(['commit', '-m', 'chore(deps): reconcile the lockfile after the upstream merge'], {
          cwd: releasePath,
        });
        mergeCommit = git(['rev-parse', 'HEAD'], { cwd: releasePath });
        ok('reconciled package-lock.json');
      } else {
        ok('lockfile already consistent');
      }
    } catch (error) {
      warn(`lockfile reconcile skipped: ${error instanceof Error ? error.message : error}`);
    }

    // ------------------------------------------------------------------
    step('Fork invariants');
    // ------------------------------------------------------------------
    const problems = checkInvariants(releasePath);
    if (problems.length > 0) {
      for (const problem of problems) fail(problem);
      abort('fork invariants were damaged by the merge; nothing was pushed');
    }

    // ------------------------------------------------------------------
    step(`Stamp version ${check.nextVersion}`);
    // ------------------------------------------------------------------
    const stamped = stampVersions(releasePath, check.nextVersion);
    ok(`${stamped} manifests + the lockfile set to ${check.nextVersion}`);
    const diffStat = git(['diff', '--shortstat'], { cwd: releasePath });
    log(`  diff: ${diffStat}`);
    const touched = git(['diff', '--name-only'], { cwd: releasePath }).split('\n').filter(Boolean);
    const unexpected = touched.filter((f) => !/(^|\/)(package\.json|package-lock\.json)$/.test(f));
    if (unexpected.length > 0) {
      abort(`version stamp touched non-manifest files: ${unexpected.join(', ')}`);
    }
    // Touching only the right *files* is not enough: a manifest edit that dropped
    // a dependency would also pass that check. Every changed line must be a
    // version field, which is the shape the release skill documents as 17±17.
    const changedLines = git(['diff', '-U0', '--', '*.json'], { cwd: releasePath })
      .split('\n')
      .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line));
    const notVersion = changedLines.filter((line) => !/^[+-]\s*"version":\s*"/.test(line));
    if (notVersion.length > 0) {
      abort(
        `version stamp changed something other than version fields:\n  ${notVersion
          .slice(0, 10)
          .join('\n  ')}`,
      );
    }
    ok(`every changed line is a version field (${changedLines.length} lines)`);
    git(['add', '-A'], { cwd: releasePath });
    git(['commit', '-m', `chore(release): bump version to ${check.nextVersion}`], {
      cwd: releasePath,
    });
    const releaseSha = git(['rev-parse', 'HEAD'], { cwd: releasePath });
    ok(`release commit ${releaseSha.slice(0, 9)}`);

    // ------------------------------------------------------------------
    step('Build the merged sources for the test gate');
    // ------------------------------------------------------------------
    prepareGeneratedFiles(root, releasePath);
    // Only the packages the gate compiles are built. `vscode-ide-companion` is
    // deliberately excluded: it needs a package-local esbuild that a shared
    // install cannot provide, and no gate suite touches it.
    // Build in dependency order using the real workspace names: `cli` is
    // `@google/gemini-cli` (not `@google/gemini-cli-cli`), so the name is taken
    // from WORKSPACE_PACKAGES rather than composed from the directory.
    // `devtools` must precede `cli`, which imports its types.
    const buildOrder = ['devtools', 'core', 'sdk', 'test-utils', 'a2a-server', 'cli'];
    for (const dir of buildOrder) {
      const entry = WORKSPACE_PACKAGES.find(([, d]) => d === dir);
      if (!entry) continue;
      const [name] = entry;
      log(`  → build ${name}`);
      try {
        run('npm', ['run', 'build', '--workspace', name], {
          cwd: releasePath,
          env: cleanEnv(),
        });
      } catch (error) {
        abort(
          `the merged tree does not build (${name}); nothing was pushed.\n${messageOf(error)}`,
        );
      }
    }
    ok('the packages the gate needs are built');

    // ------------------------------------------------------------------
    testGate(releasePath, { quick });

    // ------------------------------------------------------------------
    step(dryRun ? 'Dry run: stopping before push' : 'Push and release');
    // ------------------------------------------------------------------
    if (dryRun) {
      warn(`would push ${check.nextBranch} @ ${releaseSha.slice(0, 9)}`);
      warn(`would fast-forward ${SOURCE_BRANCH} to ${mergeCommit.slice(0, 9)}`);
      summary.status = 'dry-run';
      summary.releaseSha = releaseSha;
      summary.mergeCommit = mergeCommit;
      return summary;
    }

    git(['push', 'origin', `HEAD:refs/heads/${check.nextBranch}`], { cwd: releasePath });
    ok(`pushed ${check.nextBranch} (starts ${WORKFLOW_FILE})`);
    summary.pushed = true;

    // Merge the synced code back, so the next run does not re-merge the same
    // upstream delta. The version-stamp commit is deliberately excluded: the dev
    // branch never carries a release version.
    try {
      git(['push', 'origin', `${mergeCommit}:refs/heads/${SOURCE_BRANCH}`], { cwd: releasePath });
      ok(`pushed the synced merge to origin/${SOURCE_BRANCH}`);
    } catch (error) {
      warn(
        `could not fast-forward origin/${SOURCE_BRANCH} (it moved during the run?): ${
          error instanceof Error ? error.message.split('\n')[0] : error
        }`,
      );
    }
    // The *local* branch has to move too. `check` counts
    // `new-version-openai..upstream/main`, so a local branch left behind would
    // make the next run re-merge the same delta and publish another -pre.N
    // forever. A fast-forward only, never a reset.
    try {
      git(['fetch', 'origin', '--quiet'], { cwd: root });
      git(['merge', '--ff-only', `origin/${SOURCE_BRANCH}`], { cwd: root });
      ok(`fast-forwarded the local ${SOURCE_BRANCH} to the synced merge`);
    } catch {
      warn(
        `local ${SOURCE_BRANCH} could not fast-forward; the next run may re-merge. ` +
          `Fix with: git checkout ${SOURCE_BRANCH} && git merge --ff-only origin/${SOURCE_BRANCH}`,
      );
    }

    // ------------------------------------------------------------------
    step('Watch the release workflow');
    // ------------------------------------------------------------------
    // The push has already happened at this point, so a failure here must not
    // read as "the release did not happen". A non-GitHub origin (a clone of a
    // local path, as used for rehearsals) simply cannot be watched.
    let slug;
    try {
      slug = repoSlug(root);
    } catch {
      warn(`origin is not a GitHub remote; the release branch is pushed but cannot be watched`);
      summary.status = 'pushed-unwatched';
      return summary;
    }
    const workflowRun = await waitForRelease(slug, check.nextBranch, releaseSha, timeoutMinutes);
    if (!workflowRun) {
      warn(`no completed workflow run after ${timeoutMinutes}m; check the Actions tab`);
      summary.status = 'pushed-unwatched';
      return summary;
    }
    summary.runId = workflowRun.id;
    await reportRun(slug, workflowRun);
    if (workflowRun.conclusion !== 'success') {
      summary.status = 'build-failed';
      warn(
        'build failed; the release branch is already pushed. Diagnose from the failing step, ' +
          'fix on the source branch, and cut the next -pre.N rather than reusing this version.',
      );
      return summary;
    }

    // ------------------------------------------------------------------
    step('Verify the published artifacts');
    // ------------------------------------------------------------------
    let published = false;
    for (let attempt = 0; attempt < 10 && !published; attempt++) {
      const after = await registryState();
      if (after.versions.includes(check.nextVersion)) {
        published = true;
        ok(`npm has ${PACKAGE_NAME}@${check.nextVersion} (latest: ${after.latest})`);
        if (after.latest !== check.nextVersion) {
          warn(`dist-tags.latest is ${after.latest}, not ${check.nextVersion}`);
        }
      } else {
        await sleep(30_000);
      }
    }
    if (!published) {
      warn(`npm does not list ${check.nextVersion} yet; the publish job may have skipped`);
    }

    try {
      const release = await getJson(`${API}/repos/${slug}/releases/tags/${check.tag}`, {
        token: githubAuth().token,
      });
      const assets = release.assets ?? [];
      ok(`release ${check.tag}: ${assets.length} asset(s)`);
      for (const asset of assets) {
        log(`    - ${asset.name} ${(asset.size / 1048576).toFixed(1)} MB`);
      }
    } catch (error) {
      warn(`no GitHub release ${check.tag} yet: ${error instanceof Error ? error.message : error}`);
    }

    summary.status = published ? 'released' : 'built-not-published';
    return summary;
  } finally {
    if (!keepWorktrees) {
      for (const path of worktrees) removeWorktree(root, path);
    }
    releaseLock();
  }
}

function cmdStatus(root) {
  const logDir = join(root, '.gemini', 'automation', 'logs');
  if (!existsSync(logDir)) {
    console.log('no runs recorded yet');
    return;
  }
  const files = run('ls', ['-1t', logDir]).split('\n').filter(Boolean).slice(0, 10);
  for (const file of files) {
    console.log(file);
  }
  const latest = files[0];
  if (latest) {
    console.log(`\n--- ${latest} (tail) ---`);
    const lines = readFileSync(join(logDir, latest), 'utf8').split('\n');
    console.log(lines.slice(-25).join('\n'));
  }
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  process.chdir(root);

  switch (command) {
    case 'check':
      await cmdCheck(root, flags);
      return;
    case 'run':
      await cmdRun(root, flags);
      return;
    case 'status':
      cmdStatus(root);
      return;
    default:
      console.log(
        [
          'usage: sync-release-auto.mjs <command> [--flags]',
          '',
          '  check                  read-only: upstream lag + the next version it would cut',
          '  check --json           same, machine readable',
          '  run                    full pipeline (sync, release branch, tests, push, watch)',
          '  run --dry-run          stop right before the push',
          '  run --quick            skip the CLI suites in the test gate',
          '  run --timeout 45       minutes to wait for the release workflow',
          '  run --keep-worktrees   leave the scratch worktrees for inspection',
          '  status                 show the most recent run logs',
        ].join('\n'),
      );
      if (command) process.exitCode = 1;
  }
}

main().catch((error) => {
  if (error instanceof Abort) {
    fail(`ABORTED: ${error.message}`);
  } else {
    fail(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
