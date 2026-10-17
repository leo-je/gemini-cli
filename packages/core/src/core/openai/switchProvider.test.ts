/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuthType, type ContentGeneratorConfig } from '../contentGenerator.js';
import {
  applyProviderToContentGeneratorConfig,
  switchProvider,
} from './integration.js';

describe('switchProvider', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-provider-'));
    vi.stubEnv('HOME', home);
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gemini', 'openai-providers.json'),
      JSON.stringify({
        providers: [
          {
            id: 'alpha',
            baseUrl: 'https://alpha.example/v1',
            modelId: 'alpha-model',
            apiKey: 'alpha-key',
          },
        ],
      }),
      { mode: 0o600 },
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const makeParams = (currentAuthType: AuthType | undefined) => ({
    currentAuthType,
    providerId: 'alpha',
    env: {},
    setActiveProviderId: vi.fn(),
    refreshAuth: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn(),
    getErrorMessage: (error: unknown) => String(error),
  });

  // The auth flow reaches this before `refreshAuth` has put the session into
  // OpenAI mode. Switching first — which is what a first-run "add a provider"
  // submit used to do — fails here and sends the user back to the mode picker.
  // Callers in that position have to establish OpenAI mode first.
  it('refuses to switch while the session is still in another mode', async () => {
    const params = makeParams(AuthType.USE_GEMINI);

    await expect(switchProvider(params)).rejects.toThrow(
      'Providers can only be switched while running in OpenAI-compatible mode.',
    );
    expect(params.setActiveProviderId).not.toHaveBeenCalled();
    expect(params.refreshAuth).not.toHaveBeenCalled();
  });

  // What the auth flow does instead: record the profile as the session's choice
  // and let `refreshAuth` resolve it, which needs no mode guard.
  it('resolves the profile recorded as the session choice', () => {
    const contentGeneratorConfig = {
      authType: AuthType.USE_OPENAI,
    } as ContentGeneratorConfig;

    applyProviderToContentGeneratorConfig({
      contentGeneratorConfig,
      getEnv: () => undefined,
      config: {
        getActiveOpenAiProviderId: () => 'alpha',
        env: {},
      } as unknown as Parameters<
        typeof applyProviderToContentGeneratorConfig
      >[0]['config'],
      authType: AuthType.USE_OPENAI,
    });

    expect(contentGeneratorConfig.baseUrl).toBe('https://alpha.example/v1');
    expect(contentGeneratorConfig.providerId).toBe('alpha');
  });

  it('refreshes with the profile and pins its model once OpenAI mode is on', async () => {
    const params = makeParams(AuthType.USE_OPENAI);

    await switchProvider(params);

    expect(params.setActiveProviderId).toHaveBeenCalledWith('alpha');
    expect(params.refreshAuth).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'alpha-key',
      'https://alpha.example/v1',
      {},
    );
    expect(params.setModel).toHaveBeenCalledWith('alpha-model');
  });
});
