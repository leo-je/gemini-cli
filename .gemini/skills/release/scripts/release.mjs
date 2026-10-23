#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Mechanical half of the release flow described in ../SKILL.md: it does the
// git/npm/registry steps that are easy to get subtly wrong (root version left
// behind by `npm version --workspaces`, stale npm CLI cache, a release branch
// cut from the wrong commit) and prints what a human still has to decide.
//
// Mutating subcommands refuse to run without --yes so an agent cannot bump a
// version or push a branch by accident.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const REGISTRY = 'https://registry.npmjs.org';
const API = 'https://api.github.com';
const PACKAGE_NAME = 'gemini-cli-leo';
const RELEASE_BRANCH_PREFIX = 'releases/';

function run(cmd, args, { cwd, allowFailure = false } = {}) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
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

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      continue;
    }
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

function repoRoot() {
  return git(['rev-parse', '--show-toplevel']);
}

/** `owner/repo`, taken from origin so forks and upstream both work. */
function repoSlug(root) {
  const url = git(['remote', 'get-url', 'origin'], { cwd: root });
  const match = /github\.com[:/](?<slug>[^/]+\/[^/.]+)(\.git)?$/.exec(url);
  if (!match?.groups?.slug) {
    throw new Error(`Cannot parse a GitHub slug out of the origin remote: ${url}`);
  }
  return match.groups.slug;
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`✓ ${message}`);
}

function warn(message) {
  console.log(`! ${message}`);
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Reads the published versions straight from the registry. `npm view` goes
 * through a locally cached copy and has twice reported an older `latest` than
 * the registry actually served, so it is not trustworthy for this check.
 */
async function registryState(name = PACKAGE_NAME) {
  const payload = await getJson(`${REGISTRY}/${encodeURIComponent(name)}`);
  const versions = Object.keys(payload.versions ?? {}).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  return {
    latest: payload['dist-tags']?.latest ?? null,
    versions,
  };
}

function bumpVersionParts(version) {
  const match = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/.exec(version);
  if (!match?.groups) {
    throw new Error(`Only plain X.Y.Z versions are supported here, got: ${version}`);
  }
  const { major, minor, patch } = match.groups;
  return {
    major: `${Number(major) + 1}.0.0`,
    minor: `${major}.${Number(minor) + 1}.0`,
    patch: `${major}.${minor}.${Number(patch) + 1}`,
  };
}

function assertReleaseVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    throw new Error(`Expected --version X.Y.Z, got: ${version ?? '(missing)'}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Stamps the new version into every manifest and lockfile entry.
 *
 * `npm version --workspaces` looks like the obvious tool, but it rewrites the
 * lockfile through the registry resolver and has hung for twenty minutes in a
 * worktree without `node_modules`. The release diff is only ever version lines
 * in six manifests plus the lockfile, so the edits are done directly here and
 * the result is checked against that shape below.
 */
function writeJson(path, mutate) {
  const original = readFileSync(path, 'utf8');
  const next = mutate(JSON.parse(original));
  const trailing = original.endsWith('\n') ? '\n' : '';
  writeFileSync(path, `${JSON.stringify(next, null, 2)}${trailing}`);
}

function stampVersions(root, version) {
  const lockPath = `${root}/package-lock.json`;
  const lock = readJson(lockPath);

  // Workspace entries in the lock are the authoritative list: no glob library,
  // and it cannot disagree with what npm will install.
  const workspaceKeys = Object.keys(lock.packages ?? {}).filter(
    (key) =>
      /^packages\/[^/]+$/.test(key) &&
      typeof lock.packages[key]?.name === 'string' &&
      typeof lock.packages[key]?.version === 'string',
  );
  if (workspaceKeys.length === 0) {
    throw new Error('no workspace entries found in package-lock.json');
  }

  writeJson(`${root}/package.json`, (json) => ({ ...json, version }));
  for (const key of workspaceKeys) {
    writeJson(`${root}/${key}/package.json`, (json) => ({ ...json, version }));
    lock.packages[key].version = version;
  }
  lock.version = version;
  if (lock.packages['']) {
    lock.packages[''].version = version;
  }
  writeJson(lockPath, () => lock);
  return workspaceKeys;
}

async function cmdLatest(root) {
  const state = await registryState();
  const patchBase = state.latest ?? '0.0.0';
  console.log(`published latest: ${state.latest}`);
  console.log(`published versions: ${state.versions.join(', ') || '(none)'}`);
  console.log('candidates:');
  for (const [kind, value] of Object.entries(bumpVersionParts(patchBase))) {
    console.log(`  ${kind.padEnd(6)} ${value}`);
  }
  const branches = git(['branch', '--list', `${RELEASE_BRANCH_PREFIX}*`], {
    cwd: root,
  })
    .split('\n')
    .map((line) => line.replace(/^\*?\s+/, '').trim())
    .filter(Boolean);
  console.log(`release branches present: ${branches.join(', ') || '(none)'}`);
}

function cmdPreflight(root, flags) {
  const version = flags.version;
  assertReleaseVersion(version);
  const source = flags.branch ?? 'new-version-openai';

  const dirty = git(['status', '--porcelain'], { cwd: root });
  if (dirty) {
    throw new Error(`working tree is not clean:\n${dirty}`);
  }
  ok('working tree clean');

  git(['fetch', 'origin', '--tags', '--prune'], { cwd: root });

  const localSha = git(['rev-parse', source], { cwd: root, allowFailure: true });
  if (!localSha) {
    throw new Error(`source branch not found: ${source}`);
  }
  const remoteSha = git(['rev-parse', `origin/${source}`], {
    cwd: root,
    allowFailure: true,
  });
  if (!remoteSha) {
    warn(`${source} has no origin counterpart; releasing from a local-only branch`);
  } else if (localSha !== remoteSha) {
    const counts = git(
      ['rev-list', '--left-right', '--count', `${source}...origin/${source}`],
      { cwd: root },
    );
    throw new Error(
      `${source} is out of sync with origin/${source} (${counts}); push or pull first`,
    );
  } else {
    ok(`${source} in sync with origin/${source} @ ${localSha.slice(0, 9)}`);
  }

  const branch = `${RELEASE_BRANCH_PREFIX}${version}`;
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: root,
    allowFailure: true,
  })) {
    throw new Error(`local branch ${branch} already exists`);
  }
  if (git(['ls-remote', '--exit-code', '--heads', 'origin', branch], {
    cwd: root,
    allowFailure: true,
  })) {
    throw new Error(`remote branch ${branch} already exists`);
  }
  if (git(['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`], {
    cwd: root,
    allowFailure: true,
  })) {
    throw new Error(`tag v${version} already exists`);
  }
  ok(`no branch or tag for ${version}`);

  return { version, source, branch };
}

async function cmdPrepare(root, flags) {
  if (flags.yes !== true) {
    throw new Error('prepare mutates the repo; re-run with --yes');
  }
  const { version, source, branch } = cmdPreflight(root, flags);
  const state = await registryState();
  if (state.versions.includes(version)) {
    throw new Error(`${PACKAGE_NAME}@${version} is already published on npm`);
  }
  ok(`${version} is not published yet`);

  const sourceVersion = readJson(`${root}/package.json`).version;
  git(['checkout', '-b', branch, source], { cwd: root });
  ok(`created ${branch} from ${source}`);

  const stamped = stampVersions(root, version);
  ok(`bumped ${stamped.length} workspace manifests, the root manifest and the lockfile to ${version}`);

  const diffStat = git(['diff', '--shortstat'], { cwd: root });
  console.log(`diff: ${diffStat}`);

  const lock = readFileSync(`${root}/package-lock.json`, 'utf8');
  if (sourceVersion && lock.includes(sourceVersion)) {
    warn(`package-lock.json still mentions ${sourceVersion}; inspect before committing`);
  } else {
    ok('no leftover source version in the lockfile');
  }

  const files = git(['diff', '--name-only'], { cwd: root })
    .split('\n')
    .filter(Boolean);
  const unexpected = files.filter(
    (file) => !/(^|\/)(package\.json|package-lock\.json)$/.test(file),
  );
  if (unexpected.length > 0) {
    warn(`version bump touched non-manifest files: ${unexpected.join(', ')}`);
  }

  git(['add', '-A'], { cwd: root });
  git(['commit', '-m', `chore(release): bump version to ${version}`], { cwd: root });
  ok(`committed ${git(['rev-parse', '--short', 'HEAD'], { cwd: root })}`);
  console.log(`next: node .gemini/skills/release/scripts/release.mjs push --version ${version} --branch ${branch} --yes`);
}

function cmdPush(root, flags) {
  if (flags.yes !== true) {
    throw new Error('push publishes the branch and starts the build; re-run with --yes');
  }
  const version = flags.version;
  assertReleaseVersion(version);
  const branch = flags.branch ?? `${RELEASE_BRANCH_PREFIX}${version}`;
  git(['push', '-u', 'origin', branch], { cwd: root });
  ok(`pushed ${branch}`);

  const slug = repoSlug(root);
  console.log(`watch: node .gemini/skills/release/scripts/release.mjs watch --version ${version} --slug ${slug}`);
}

async function findRun(slug, branch, { headSha } = {}) {
  const runs = await getJson(
    `${API}/repos/${slug}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=10`,
  );
  const candidates = (runs.workflow_runs ?? []).filter(
    (item) => !headSha || item.head_sha === headSha,
  );
  return candidates[0] ?? null;
}

async function cmdWatch(root, flags) {
  const version = flags.version;
  assertReleaseVersion(version);
  const slug = flags.slug ?? repoSlug(root);
  const branch = `${RELEASE_BRANCH_PREFIX}${version}`;
  const headSha = git(['rev-parse', branch], { cwd: root, allowFailure: true }) || undefined;
  const timeoutMinutes = Number(flags.timeout ?? 40);
  const deadline = Date.now() + timeoutMinutes * 60_000;

  let run = null;
  while (Date.now() < deadline) {
    run = await findRun(slug, branch, { headSha });
    if (!run) {
      await sleep(10_000);
      continue;
    }
    console.log(`run ${run.id}: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}`);
    if (run.status === 'completed') {
      break;
    }
    await sleep(30_000);
  }

  if (!run) {
    throw new Error(`no workflow run found for ${branch} within ${timeoutMinutes}m`);
  }
  if (run.status !== 'completed') {
    throw new Error(`run ${run.id} still ${run.status} after ${timeoutMinutes}m`);
  }

  const jobs = await getJson(`${API}/repos/${slug}/actions/runs/${run.id}/jobs?per_page=30`);
  for (const job of jobs.jobs ?? []) {
    console.log(`  ${job.conclusion === 'success' ? '✓' : '✗'} ${job.name} (${job.conclusion})`);
    if (job.conclusion === 'failure') {
      const failed = (job.steps ?? []).filter((step) => step.conclusion === 'failure');
      for (const step of failed) {
        console.log(`      failed step: ${step.name}`);
      }
      console.log(`      job id: ${job.id}`);
    }
  }

  if (run.conclusion !== 'success') {
    console.log(
      [
        '',
        'Job logs need admin rights and usually answer 403 without a token, so',
        'diagnose from the failing step name. A failure confined to',
        "`Build (darwin-x64)` / `Build Binary` has been transient every time so far:",
        `rerun with an empty commit, do not bump the version again:`,
        `  node .gemini/skills/release/scripts/release.mjs retrigger --version ${version} --yes`,
      ].join('\n'),
    );
    console.log(`run url: ${run.html_url}`);
    process.exitCode = 1;
    return;
  }
  ok(`run ${run.id} succeeded`);
  console.log(`next: node .gemini/skills/release/scripts/release.mjs verify --version ${version}`);
}

function cmdRetrigger(root, flags) {
  if (flags.yes !== true) {
    throw new Error('retrigger pushes a commit; re-run with --yes');
  }
  const version = flags.version;
  assertReleaseVersion(version);
  const branch = `${RELEASE_BRANCH_PREFIX}${version}`;
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  if (current !== branch) {
    throw new Error(`checked out ${current}, expected ${branch}`);
  }
  git(
    ['commit', '--allow-empty', '-m', `chore(release): retrigger ${version} build`],
    { cwd: root },
  );
  git(['push', 'origin', branch], { cwd: root });
  ok(`retriggered ${branch} with an empty commit`);
}

async function cmdVerify(root, flags) {
  const version = flags.version;
  assertReleaseVersion(version);
  const slug = flags.slug ?? repoSlug(root);

  const state = await registryState();
  if (state.versions.includes(version)) {
    ok(`npm has ${PACKAGE_NAME}@${version} (latest: ${state.latest})`);
  } else {
    fail(`npm does not list ${version} yet (latest: ${state.latest})`);
  }
  if (state.latest !== version) {
    warn(`dist-tags.latest is ${state.latest}, not ${version}`);
  }

  const release = await getJson(`${API}/repos/${slug}/releases/tags/v${version}`);
  const assets = release.assets ?? [];
  console.log(`release v${version}: ${assets.length} asset(s)`);
  for (const asset of assets) {
    console.log(`  - ${asset.name} ${(asset.size / 1048576).toFixed(1)} MB`);
  }
  if (!assets.some((asset) => asset.name.includes(`bundle-linux-x64-${version}`))) {
    fail('bundle-linux-x64 asset missing');
  }

  git(['fetch', 'origin', '--tags', '--prune'], { cwd: root });
  if (git(['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`], {
    cwd: root,
    allowFailure: true,
  })) {
    ok(`tag v${version} present locally`);
  } else {
    warn(`tag v${version} not fetched locally`);
  }
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const root = repoRoot();

  switch (command) {
    case 'latest':
      await cmdLatest(root);
      return;
    case 'preflight':
      cmdPreflight(root, flags);
      return;
    case 'prepare':
      await cmdPrepare(root, flags);
      return;
    case 'push':
      cmdPush(root, flags);
      return;
    case 'watch':
      await cmdWatch(root, flags);
      return;
    case 'retrigger':
      cmdRetrigger(root, flags);
      return;
    case 'verify':
      await cmdVerify(root, flags);
      return;
    default:
      console.log(
        [
          'usage: release.mjs <command> [--flag value]',
          '',
          '  latest                    published versions, next-version candidates',
          '  preflight --version V     read-only checks for a release of V',
          '  prepare   --version V     create releases/V, bump, commit (--branch, --yes)',
          '  push      --version V     push the branch, trigger the build (--yes)',
          '  watch     --version V     poll the workflow run and report jobs',
          '  retrigger --version V     empty commit to rerun a failed build (--yes)',
          '  verify    --version V     npm version, release assets, local tag',
        ].join('\n'),
      );
      if (command) {
        process.exitCode = 1;
      }
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
