/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  addProvider,
  debugLogger,
  getOpenAiProvidersPath,
} from '@google/gemini-cli-core';
import { defaultOpenAiEnvPath, renderEnvFile } from './openAiEndpointEnv.js';
import type { NewProviderValues } from './AddProviderDialog.js';

/** The environment variable name a provider's key is stored under. */
export function apiKeyEnvName(providerId: string): string {
  // The id is restricted to `[A-Za-z0-9_-]` by the provider schema, but `-` is
  // not valid in a shell variable name, so it is folded to `_` here.
  return `${providerId.replace(/-/g, '_').toUpperCase()}_API_KEY`;
}

/**
 * Saves a provider collected by the add dialog.
 *
 * The credential never goes into the provider file: it is written to
 * `~/.gemini/.env` under a derived variable name, and the file records only
 * that name. That keeps keys under the same permission and trust handling as
 * the rest of the CLI's secrets, and keeps the provider file safe to read.
 *
 * The provider entry is validated before anything is written, so a rejected id
 * cannot leave a stray variable behind in `.env`.
 */
export function addOpenAiProvider(
  values: NewProviderValues,
  providerPath: string = getOpenAiProvidersPath(),
  envPath: string = defaultOpenAiEnvPath(),
): { providerPath: string; envPath: string | null; apiKeyEnv?: string } {
  const apiKeyEnv = values.apiKey ? apiKeyEnvName(values.id) : undefined;

  // Throws on an invalid or duplicate id; nothing is written in that case.
  addProvider(
    {
      id: values.id,
      label: values.label,
      baseUrl: values.baseUrl,
      modelId: values.modelId,
      apiKeyEnv,
    },
    providerPath,
  );

  if (!apiKeyEnv || !values.apiKey) {
    return { providerPath, envPath: null };
  }

  const savedEnv = saveProviderApiKey(values.id, values.apiKey, envPath);
  return { providerPath, envPath: savedEnv ? envPath : null, apiKeyEnv };
}

/**
 * Writes a provider's key to the user-level `.env` and makes it visible here.
 *
 * Shared by the add and edit flows so both store credentials the same way.
 * Returns the variable name the key was stored under, or null when the file
 * could not be written; the caller decides whether that aborts the change.
 */
export function saveProviderApiKey(
  providerId: string,
  apiKey: string,
  envPath: string = defaultOpenAiEnvPath(),
): string | null {
  const apiKeyEnv = apiKeyEnvName(providerId);
  try {
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, renderEnvFile(envPath, [[apiKeyEnv, apiKey]]), {
      encoding: 'utf8',
      mode: 0o600,
    });
    // Made visible to this process as well, so the provider resolves without a
    // restart. `loadEnvironment` only fills unset variables, so a project-level
    // `.env` would otherwise shadow the value just written.
    process.env[apiKeyEnv] = apiKey;
    return apiKeyEnv;
  } catch (error) {
    debugLogger.debug('Failed to persist the provider API key:', error);
    return null;
  }
}
