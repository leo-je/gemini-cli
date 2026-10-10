/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fetches the model ids an OpenAI-compatible endpoint serves.
 *
 * Kept out of the slash command and the dialog so both share one path: the
 * command needs it to decide whether a listing exists, and the dialog needs it
 * to render. The client is already a public export of the core package, so
 * nothing here needs to widen the `ContentGenerator` interface — model listing
 * is a property of the OpenAI endpoint, not of every backend.
 */

import {
  AuthType,
  OpenAICompatibleClient,
  type Config,
} from '@google/gemini-cli-core';

/** How long to wait for the listing before giving up on it. */
const LIST_TIMEOUT_MS = 20_000;

export interface RemoteModelListing {
  models: string[];
  /** The endpoint the list came from, for display. */
  endpoint: string;
}

/**
 * Whether this session talks to an OpenAI-compatible endpoint.
 */
export function isOpenAiBackend(config: Config | undefined): boolean {
  return config?.getContentGeneratorConfig()?.authType === AuthType.USE_OPENAI;
}

/**
 * Lists the endpoint's models, or returns null when this session is not on an
 * OpenAI-compatible endpoint.
 *
 * Returns null rather than throwing for the non-OpenAI case only — the caller
 * uses that to decide whether to offer `/model list` at all. A real request
 * failure is surfaced so the user learns why the list is unavailable instead of
 * seeing an empty dialog.
 */
export async function fetchRemoteModels(
  config: Config,
  signal?: AbortSignal,
): Promise<RemoteModelListing | null> {
  const generatorConfig = config.getContentGeneratorConfig();
  if (generatorConfig?.authType !== AuthType.USE_OPENAI) return null;

  const baseUrl = generatorConfig.baseUrl;
  if (!baseUrl) {
    throw new Error(
      'No OpenAI-compatible endpoint is configured. Set GEMINI_OPENAI_BASE_URL.',
    );
  }

  const client = new OpenAICompatibleClient({
    baseUrl,
    apiKey: generatorConfig.apiKey ?? '',
    proxy: generatorConfig.proxy,
    headers: generatorConfig.customHeaders,
  });

  // Compose the caller's abort with a timeout so a stalled endpoint does not
  // leave the dialog spinning indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const models = await client.listModels(controller.signal);
    return { models, endpoint: baseUrl };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
