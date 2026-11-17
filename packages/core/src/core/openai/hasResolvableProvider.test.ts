/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../config/config.js';
import { AuthType, type ContentGeneratorConfig } from '../contentGenerator.js';
import { coreEvents } from '../../utils/events.js';
import {
  applyProviderToContentGeneratorConfig,
  describeUnusableOpenAiProvider,
  hasResolvableOpenAiProvider,
  resolveActiveProvider,
} from './integration.js';

/** Matches `Storage.getGlobalGeminiDir()`: `<home>/.gemini`. */
const GEMINI_DIR_NAME = '.gemini';

let tmpDir: string;
let providersPath: string;

function writeProviders(content: unknown): void {
  fs.writeFileSync(providersPath, JSON.stringify(content, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-provider-gate-'));
  providersPath = path.join(tmpDir, 'openai-providers.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('hasResolvableOpenAiProvider', () => {
  it('is false when no provider file exists', () => {
    expect(hasResolvableOpenAiProvider({}, providersPath)).toBe(false);
  });

  it('is false for a profile without a model id', () => {
    writeProviders({
      providers: [{ id: 'a', baseUrl: 'https://x/v1' }],
    });
    expect(fs.existsSync(providersPath)).toBe(true);
    expect(hasResolvableOpenAiProvider({}, providersPath)).toBe(false);
  });

  it('is true for a complete first-entry profile', () => {
    writeProviders({
      providers: [{ id: 'a', baseUrl: 'https://x/v1', modelId: 'm1' }],
    });
    expect(hasResolvableOpenAiProvider({}, providersPath)).toBe(true);
  });

  it('honours GEMINI_OPENAI_PROVIDER over the first entry', () => {
    writeProviders({
      providers: [
        { id: 'a', baseUrl: 'https://x/v1', modelId: 'm1' },
        { id: 'b', baseUrl: 'https://y/v1', modelId: 'm2' },
      ],
    });
    expect(
      hasResolvableOpenAiProvider(
        { GEMINI_OPENAI_PROVIDER: 'b' },
        providersPath,
      ),
    ).toBe(true);
    expect(
      hasResolvableOpenAiProvider(
        { GEMINI_OPENAI_PROVIDER: 'nope' },
        providersPath,
      ),
    ).toBe(false);
  });

  it('is false rather than throwing on a malformed file', () => {
    fs.writeFileSync(providersPath, '{ not json', 'utf8');
    expect(hasResolvableOpenAiProvider({}, providersPath)).toBe(false);
  });

  it('accepts an env with undefined values (process.env shape)', () => {
    writeProviders({
      providers: [{ id: 'a', baseUrl: 'https://x/v1', modelId: 'm1' }],
    });
    const env: Record<string, string | undefined> = {
      GEMINI_OPENAI_PROVIDER: undefined,
      SOMETHING: 'x',
    };
    expect(hasResolvableOpenAiProvider(env, providersPath)).toBe(true);
  });
});

/**
 * The gate and the session builder must agree.
 *
 * When they disagreed, the gate skipped the endpoint dialog because a provider
 * file existed while the builder resolved no profile at all. The session was
 * then constructed with an empty base URL and died with
 * "OpenAI-compatible mode requires GEMINI_OPENAI_BASE_URL to be set." — seen on
 * a first start with several providers configured and none selected yet.
 *
 * These cases point `HOME` at a temporary directory, so the builder reads the
 * fixture through its real default path. That keeps the test on the production
 * code path and independent of whatever the machine running it has configured.
 */
describe('auth gate and session builder agree on the endpoint', () => {
  let fakeHome: string;

  function writeDefaultProviders(providers: unknown[]): void {
    const geminiDir = path.join(fakeHome, GEMINI_DIR_NAME);
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(
      path.join(geminiDir, 'openai-providers.json'),
      JSON.stringify({ providers }, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  function buildSessionConfig(env: Record<string, string>) {
    const contentGeneratorConfig = {
      authType: AuthType.USE_OPENAI,
    } as ContentGeneratorConfig;
    applyProviderToContentGeneratorConfig({
      config: {
        getActiveOpenAiProviderId: () => undefined,
        env,
      } as unknown as Config,
      authType: AuthType.USE_OPENAI,
      contentGeneratorConfig,
      getEnv: () => undefined,
    });
    return contentGeneratorConfig;
  }

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-gate-home-'));
    vi.stubEnv('HOME', fakeHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('resolves the first entry for a first start with several providers', () => {
    // The reported case: more than one provider configured, the session has no
    // choice yet, and every provider is complete.
    writeDefaultProviders([
      { id: 'alpha', baseUrl: 'https://alpha/v1', modelId: 'alpha-1' },
      { id: 'beta', baseUrl: 'https://beta/v1', modelId: 'beta-1' },
    ]);
    const env = {};

    const gateSaysConfigured = hasResolvableOpenAiProvider(env);
    const built = buildSessionConfig(env);

    expect(gateSaysConfigured).toBe(true);
    // The builder must produce the endpoint the gate relied on, otherwise the
    // dialog was skipped for nothing.
    expect(built.baseUrl).toBe('https://alpha/v1');
    expect(built.modelId).toBe('alpha-1');
    expect(built.providerId).toBe('alpha');
  });

  it('resolves the profile named by GEMINI_OPENAI_PROVIDER', () => {
    writeDefaultProviders([
      { id: 'alpha', baseUrl: 'https://alpha/v1', modelId: 'alpha-1' },
      { id: 'beta', baseUrl: 'https://beta/v1', modelId: 'beta-1' },
    ]);
    const env = { GEMINI_OPENAI_PROVIDER: 'beta' };

    expect(hasResolvableOpenAiProvider(env)).toBe(true);
    const built = buildSessionConfig(env);

    expect(built.baseUrl).toBe('https://beta/v1');
    expect(built.providerId).toBe('beta');
  });

  it('leaves the endpoint to the environment when no provider file exists', () => {
    // Single-endpoint configuration: nothing to resolve, so the ambient
    // variables must still describe the endpoint exactly as before.
    expect(hasResolvableOpenAiProvider({})).toBe(false);

    const contentGeneratorConfig = {
      authType: AuthType.USE_OPENAI,
    } as ContentGeneratorConfig;
    applyProviderToContentGeneratorConfig({
      config: {
        getActiveOpenAiProviderId: () => undefined,
        env: {},
      } as unknown as Config,
      authType: AuthType.USE_OPENAI,
      contentGeneratorConfig,
      getEnv: (key: string) =>
        key === 'GEMINI_OPENAI_BASE_URL' ? 'https://env/v1' : undefined,
    });

    expect(contentGeneratorConfig.baseUrl).toBe('https://env/v1');
    expect(contentGeneratorConfig.providerId).toBeUndefined();
  });
});

describe('a persisted choice whose provider is gone', () => {
  let fakeHome: string;

  function writeDefaultProviders(providers: unknown[]): void {
    const geminiDir = path.join(fakeHome, GEMINI_DIR_NAME);
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(
      path.join(geminiDir, 'openai-providers.json'),
      JSON.stringify({ providers }, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-stale-home-'));
    vi.stubEnv('HOME', fakeHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('degrades to the first entry and warns instead of throwing', () => {
    // The CLI persists the choice to settings.json while the provider file is
    // edited by hand, so a stored id can outlive its provider. Startup has to
    // survive that, on the file's first entry.
    writeDefaultProviders([
      { id: 'alpha', baseUrl: 'https://alpha/v1', modelId: 'alpha-1' },
      { id: 'beta', baseUrl: 'https://beta/v1', modelId: 'beta-1' },
    ]);
    const warn = vi
      .spyOn(coreEvents, 'emitFeedback')
      .mockImplementation(() => {});

    const resolved = resolveActiveProvider({
      sessionProviderId: 'deleted-provider',
      env: {},
      allowImplicitProvider: true,
    });

    expect(resolved?.id).toBe('alpha');
    expect(warn).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('deleted-provider'),
    );
    warn.mockRestore();
  });

  it('still fails loudly when the caller named the provider', () => {
    // `/provider use nope` is a live instruction, not a stale preference.
    writeDefaultProviders([
      { id: 'alpha', baseUrl: 'https://alpha/v1', modelId: 'alpha-1' },
    ]);

    expect(() =>
      resolveActiveProvider({ requestedId: 'nope', env: {} }),
    ).toThrow(/Unknown provider "nope"/);
  });
});

describe('an unusable provider file is reported, not just ignored', () => {
  it('warns about a key in a file other users can read', () => {
    // The loader rejects a literal key in a group/world-readable file. The gate
    // has to swallow the error to keep startup working, so without this the user
    // only saw the endpoint dialog — which describes nothing that is wrong.
    writeProviders({
      providers: [
        { id: 'a', baseUrl: 'https://x/v1', modelId: 'm1', apiKey: 'literal' },
      ],
    });
    fs.chmodSync(providersPath, 0o644);
    const warn = vi
      .spyOn(coreEvents, 'emitFeedback')
      .mockImplementation(() => {});

    expect(hasResolvableOpenAiProvider({}, providersPath)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('chmod 600'),
    );
    warn.mockRestore();
  });

  it('warns about a malformed file', () => {
    // Bypasses writeProviders so the JSON is deliberately invalid.
    fs.writeFileSync(providersPath, '{ not json', {
      encoding: 'utf8',
      mode: 0o600,
    });
    const warn = vi
      .spyOn(coreEvents, 'emitFeedback')
      .mockImplementation(() => {});

    expect(hasResolvableOpenAiProvider({}, providersPath)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('Ignoring the OpenAI provider file'),
    );
    warn.mockRestore();
  });

  it('stays silent for an absent file', () => {
    // The normal single-endpoint state; a warning on every start would be noise.
    const warn = vi
      .spyOn(coreEvents, 'emitFeedback')
      .mockImplementation(() => {});
    expect(hasResolvableOpenAiProvider({}, providersPath)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * A provider that exists but cannot be resolved is not a stale choice.
 *
 * The reported failure: choosing `linksub-008` produced
 * `Failed to use provider "linksub-008": Provider "ytoken-01" references the
 * environment variable …, which is not set.` The chosen provider was present
 * and its own key was the one missing; the message named a different entry
 * because the resolver degraded to the file's first provider and reported that
 * provider's error instead. Worse, when the first provider's key *did* exist
 * the degradation succeeded, silently moving the session to an endpoint the
 * user never chose.
 */
describe('a selected provider that exists but is misconfigured', () => {
  let fakeHome: string;

  function writeDefaultProviders(providers: unknown[]): void {
    const geminiDir = path.join(fakeHome, GEMINI_DIR_NAME);
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(
      path.join(geminiDir, 'openai-providers.json'),
      JSON.stringify({ providers }, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  const twoProviders = [
    {
      id: 'ytoken-01',
      baseUrl: 'https://api.ytoken/v1',
      // Test-unique names: `readEnvValue` falls back to `process.env` when the
      // supplied env omits a key, so a realistic name that happens to be set on
      // the machine running the suite would make the "unset" case succeed.
      apiKeyEnv: 'TEST_UNSET_FALLBACK_KEY_ALPHA',
      modelId: 'ytoken-model',
    },
    {
      id: 'linksub-008',
      baseUrl: 'https://api.linksub/v1',
      apiKeyEnv: 'TEST_UNSET_CHOSEN_KEY_BETA',
      modelId: 'deepseek-v4.1-flash',
    },
  ];

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-misconfigured-'));
    vi.stubEnv('HOME', fakeHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('blames the chosen provider, not the first entry', () => {
    writeDefaultProviders(twoProviders);

    expect(() =>
      resolveActiveProvider({
        sessionProviderId: 'linksub-008',
        env: {},
        allowImplicitProvider: true,
      }),
    ).toThrow(/linksub-008.*TEST_UNSET_CHOSEN_KEY_BETA/);
  });

  it('does not silently switch endpoints when the fallback would work', () => {
    // The dangerous variant: the first provider is fully usable, so degrading
    // "succeeds" and the session talks to an endpoint the user never picked.
    writeDefaultProviders(twoProviders);

    expect(() =>
      resolveActiveProvider({
        sessionProviderId: 'linksub-008',
        // Only the fallback's credential is available.
        env: { TEST_UNSET_FALLBACK_KEY_ALPHA: 'sk-fallback' },
        allowImplicitProvider: true,
      }),
    ).toThrow(/linksub-008/);
  });

  it('still degrades when the provider is genuinely absent', () => {
    // The one case worth degrading: a persisted id whose entry was removed.
    // Startup must survive that, on the file's first entry.
    writeDefaultProviders(twoProviders);
    const warn = vi
      .spyOn(coreEvents, 'emitFeedback')
      .mockImplementation(() => {});

    const resolved = resolveActiveProvider({
      sessionProviderId: 'deleted-provider',
      env: { TEST_UNSET_FALLBACK_KEY_ALPHA: 'sk-fallback' },
      allowImplicitProvider: true,
    });

    expect(resolved?.id).toBe('ytoken-01');
    expect(warn).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('not configured'),
    );
    warn.mockRestore();
  });
});

/**
 * The gate must judge the entry the session will actually use.
 *
 * It previously read only `GEMINI_OPENAI_PROVIDER` and otherwise always
 * resolved the file's first entry, ignoring the choice persisted in
 * `security.auth.openAiProviderId`. With an incomplete first entry — one
 * lacking a model id — a complete, explicitly chosen provider still failed the
 * gate, and the user was told to set `GEMINI_OPENAI_BASE_URL`, which was never
 * the problem.
 */
describe('hasResolvableOpenAiProvider and the persisted selection', () => {
  it('accepts a selected provider that the first entry would fail', () => {
    // Entry zero has no model id, so the first-entry rule rejects the file
    // outright even though every key is present.
    writeProviders({
      providers: [
        { id: 'ytoken-01', baseUrl: 'https://x/v1' },
        { id: 'linksub-008', baseUrl: 'https://y/v1', modelId: 'm1' },
      ],
    });

    expect(hasResolvableOpenAiProvider({}, providersPath)).toBe(false);
    expect(hasResolvableOpenAiProvider({}, providersPath, 'linksub-008')).toBe(
      true,
    );
  });

  it('lets the persisted choice outrank GEMINI_OPENAI_PROVIDER', () => {
    writeProviders({
      providers: [
        { id: 'a', baseUrl: 'https://a/v1', modelId: 'm-a' },
        { id: 'b', baseUrl: 'https://b/v1', modelId: 'm-b' },
      ],
    });

    // Entry `a` is fine and the env var names it, but the user picked `b`,
    // which lacks a model id — the builder will use `b`, so the gate must
    // judge `b`.
    expect(
      hasResolvableOpenAiProvider(
        { GEMINI_OPENAI_PROVIDER: 'a' },
        providersPath,
        'b',
      ),
    ).toBe(true);
  });

  it('ignores a blank persisted id', () => {
    writeProviders({
      providers: [{ id: 'a', baseUrl: 'https://x/v1', modelId: 'm1' }],
    });
    expect(hasResolvableOpenAiProvider({}, providersPath, '   ')).toBe(true);
  });
});

describe('describeUnusableOpenAiProvider', () => {
  it('names the missing variable of the selected provider', () => {
    writeProviders({
      providers: [
        {
          id: 'linksub-008',
          baseUrl: 'https://y/v1',
          modelId: 'm1',
          // Test-unique, so a same-named variable on the host cannot make this
          // profile resolve and turn the assertion into a no-op.
          apiKeyEnv: 'TEST_UNSET_CHOSEN_KEY_BETA',
        },
      ],
    });

    expect(
      describeUnusableOpenAiProvider({}, providersPath, 'linksub-008'),
    ).toMatch(/linksub-008.*TEST_UNSET_CHOSEN_KEY_BETA/);
  });

  it('says nothing when the selected provider is usable', () => {
    writeProviders({
      providers: [{ id: 'a', baseUrl: 'https://x/v1', modelId: 'm1' }],
    });
    expect(describeUnusableOpenAiProvider({}, providersPath, 'a')).toBeNull();
  });

  it('says nothing for a stale id, which degrades instead', () => {
    writeProviders({
      providers: [{ id: 'a', baseUrl: 'https://x/v1', modelId: 'm1' }],
    });
    expect(
      describeUnusableOpenAiProvider({}, providersPath, 'deleted'),
    ).toBeNull();
  });

  it('says nothing when no provider was named', () => {
    writeProviders({
      providers: [{ id: 'a', baseUrl: 'https://x/v1', modelId: 'm1' }],
    });
    expect(describeUnusableOpenAiProvider({}, providersPath)).toBeNull();
  });
});
