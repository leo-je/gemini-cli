/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Config, type ConfigParameters } from './config.js';
import { AuthType } from '../core/contentGenerator.js';
import {
  getOpenAiProvidersPath,
  persistProviderModelId,
} from '../core/openai/providers.js';

/**
 * `switchOpenAiProvider` is the only part of the provider feature that mutates
 * a live Config, and it is what `/provider` is built on. The surrounding
 * `config.test.ts` cannot run on every platform (it loads a native terminal
 * dependency), so the behaviour is pinned here instead of being left covered
 * only on CI.
 */
describe('Config.switchOpenAiProvider', () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    // The provider file lives under the user's home directory, so the home is
    // redirected rather than the path being injected — that keeps the test
    // exercising the real path resolution.
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-switch-home-'));
    originalHome = process.env['HOME'];
    process.env['HOME'] = homeDir;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = originalHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  function writeProviders(providers: unknown[]): void {
    const filePath = getOpenAiProvidersPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ providers }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  function makeConfig(overrides: Partial<ConfigParameters> = {}): Config {
    return new Config({
      sessionId: 'provider-switch',
      targetDir: homeDir,
      cwd: homeDir,
      debugMode: false,
      ...overrides,
    } as ConfigParameters);
  }

  it('refuses to switch outside OpenAI mode', async () => {
    const config = makeConfig();
    // No refreshAuth call happened, so `contentGeneratorConfig` has no OpenAI
    // auth type yet.
    await expect(config.switchOpenAiProvider('anything')).rejects.toThrow(
      /only.*OpenAI-compatible mode/i,
    );
  });

  it('records the session choice and rebuilds the generator', async () => {
    writeProviders([
      {
        id: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'gpt-4o',
      },
    ]);
    const config = makeConfig();
    // Put the config into OpenAI mode the same way a provider-based startup
    // does: the session choice is what opts into reading the provider file.
    config.setActiveOpenAiProvider('openrouter');
    await config.refreshAuth(AuthType.USE_OPENAI);

    const refreshSpy = vi
      .spyOn(config, 'refreshAuth')
      .mockResolvedValue(undefined);

    await config.switchOpenAiProvider('openrouter');

    expect(config.getActiveOpenAiProviderId()).toBe('openrouter');
    expect(refreshSpy).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      undefined,
      'https://openrouter.ai/api/v1',
      {},
    );
    // The profile's model is pinned so the next request cannot reuse a model
    // the new endpoint does not serve.
    expect(config.getModel()).toBe('gpt-4o');
  });

  it('surfaces an unknown provider id without changing the session', async () => {
    writeProviders([{ id: 'openrouter', baseUrl: 'https://openrouter.ai/v1' }]);
    const config = makeConfig();
    config.setActiveOpenAiProvider('openrouter');
    await config.refreshAuth(AuthType.USE_OPENAI);

    await expect(config.switchOpenAiProvider('nope')).rejects.toThrow(
      /Unknown provider "nope"/,
    );
    // The failed switch must leave the session on the provider it was already
    // using, rather than clearing the choice.
    expect(config.getActiveOpenAiProviderId()).toBe('openrouter');
  });

  it('leaves the model alone when the profile declares none', async () => {
    writeProviders([{ id: 'ollama', baseUrl: 'http://localhost:11434/v1' }]);
    const config = makeConfig();
    config.setActiveOpenAiProvider('ollama');
    await config.refreshAuth(AuthType.USE_OPENAI);
    const before = config.getModel();

    vi.spyOn(config, 'refreshAuth').mockResolvedValue(undefined);
    await config.switchOpenAiProvider('ollama');

    expect(config.getModel()).toBe(before);
  });

  it('persists the pinned model back to the provider file', () => {
    writeProviders([
      { id: 'openrouter', baseUrl: 'https://openrouter.ai/v1', modelId: 'a' },
    ]);
    // Directly asserting the persistence helper the switch relies on, so a
    // regression there is caught even without a live Config.
    expect(
      persistProviderModelId('openrouter', 'gpt-4o', getOpenAiProvidersPath()),
    ).toBe(true);
    const written = JSON.parse(
      fs.readFileSync(getOpenAiProvidersPath(), 'utf8'),
    ) as { providers: Array<{ modelId: string }> };
    expect(written.providers[0].modelId).toBe('gpt-4o');
  });

  it('seeds the session from the persisted provider id', () => {
    // What the CLI does on startup: it passes
    // `security.auth.openAiProviderId` through `ConfigParameters`. Without this
    // the choice made with `/provider` did not survive a restart and the
    // session silently fell back to the provider file's first entry.
    const config = makeConfig({ openAiProviderId: 'beta' });

    expect(config.getActiveOpenAiProviderId()).toBe('beta');
  });

  it('treats a blank persisted id as no choice', () => {
    expect(
      makeConfig({ openAiProviderId: '' }).getActiveOpenAiProviderId(),
    ).toBeUndefined();
    expect(
      makeConfig({ openAiProviderId: '  ' }).getActiveOpenAiProviderId(),
    ).toBeUndefined();
  });

  it('opens on the provider model, so a remembered pick survives a restart', async () => {
    // What `rememberModelForProvider` (CLI side) relies on: the pick is written
    // as the provider's own `modelId`, and startup pins it. Without this the
    // session came back on `auto`.
    writeProviders([
      { id: 'beta', baseUrl: 'https://beta/v1', modelId: 'remembered-model' },
    ]);
    const config = makeConfig({
      openAiProviderId: 'beta',
      model: 'auto',
    });

    await config.refreshAuth(AuthType.USE_OPENAI);

    expect(config.getModel()).toBe('remembered-model');
    expect(config.getActiveModel()).toBe('remembered-model');
  });

  it('falls back to the first provider when the persisted id is gone', async () => {
    // A persisted choice can outlive its provider: the CLI writes the selection
    // to settings.json while the provider file is edited by hand. Startup must
    // still work, on the file's first entry, and say why.
    writeProviders([
      { id: 'alpha', baseUrl: 'https://alpha/v1', modelId: 'alpha-1' },
      { id: 'beta', baseUrl: 'https://beta/v1', modelId: 'beta-1' },
    ]);
    const config = makeConfig({ openAiProviderId: 'deleted-provider' });

    await config.refreshAuth(AuthType.USE_OPENAI);

    // Startup survived, on the first entry rather than the missing one.
    expect(config.getContentGeneratorConfig()?.baseUrl).toBe(
      'https://alpha/v1',
    );
    expect(config.getContentGeneratorConfig()?.providerId).toBe('alpha');
  });
});
