/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthType, type Config } from '@google/gemini-cli-core';
import { fetchRemoteModels, isOpenAiBackend } from './openAiModelList.js';

function configWith(generatorConfig: Record<string, unknown>): Config {
  return {
    getContentGeneratorConfig: () => generatorConfig,
  } as unknown as Config;
}

describe('isOpenAiBackend', () => {
  beforeEach(() => {
    // The check also consults the explicit switch, so the ambient environment
    // must not decide the outcome of these cases.
    vi.stubEnv('GEMINI_API_TYPE', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is true only for the OpenAI-compatible backend', () => {
    expect(isOpenAiBackend(configWith({ authType: AuthType.USE_OPENAI }))).toBe(
      true,
    );
    expect(isOpenAiBackend(configWith({ authType: AuthType.USE_GEMINI }))).toBe(
      false,
    );
    expect(isOpenAiBackend(undefined)).toBe(false);
  });

  it('is true when GEMINI_API_TYPE=openai has not been resolved onto the config yet', () => {
    // Regression: `/provider add` reported the mode as off and opened nothing
    // because the auth type is only populated after refreshAuth runs.
    vi.stubEnv('GEMINI_API_TYPE', 'openai');
    expect(isOpenAiBackend(configWith({}))).toBe(true);
    expect(isOpenAiBackend(undefined)).toBe(true);
  });

  it('ignores a non-openai GEMINI_API_TYPE', () => {
    vi.stubEnv('GEMINI_API_TYPE', 'gemini');
    expect(isOpenAiBackend(configWith({}))).toBe(false);
  });
});

describe('fetchRemoteModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns null outside OpenAI mode without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchRemoteModels(
      configWith({ authType: AuthType.USE_GEMINI }),
    );

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('errors rather than fetching when no endpoint is configured', async () => {
    await expect(
      fetchRemoteModels(configWith({ authType: AuthType.USE_OPENAI })),
    ).rejects.toThrow(/GEMINI_OPENAI_BASE_URL/);
  });

  it('lists models from the configured endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'a', context_length: 128_000, max_completion_tokens: 4_096 },
            { id: 'b' },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchRemoteModels(
      configWith({
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'k',
      }),
    );

    // The listing carries the limits the endpoint advertises, not just ids.
    expect(result).toEqual({
      models: [
        { modelId: 'a', contextWindowSize: 128_000, maxToken: 4_096 },
        { modelId: 'b' },
      ],
      endpoint: 'https://openrouter.ai/api/v1',
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://openrouter.ai/api/v1/models',
    );
  });

  it('surfaces a failing endpoint so the dialog can explain itself', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('nope', { status: 401 })),
    );

    await expect(
      fetchRemoteModels(
        configWith({
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://example.test/v1',
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});
