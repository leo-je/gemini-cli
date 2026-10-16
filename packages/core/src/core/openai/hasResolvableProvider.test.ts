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
