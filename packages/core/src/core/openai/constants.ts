/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Environment variables that switch the CLI into OpenAI-compatible mode.
 *
 * This module intentionally has no imports. `contentGenerator.ts` needs these
 * names to decide which backend to construct, and importing them from a module
 * that reaches back into `contentGenerator.js` would create an import cycle.
 */

/** Explicit opt-in switch. Only the exact value `openai` enables this backend. */
export const GEMINI_API_TYPE_ENV = 'GEMINI_API_TYPE';
export const OPENAI_API_TYPE = 'openai';
export const OPENAI_BASE_URL_ENV = 'GEMINI_OPENAI_BASE_URL';
export const OPENAI_API_KEY_ENV = 'GEMINI_OPENAI_API_KEY';
export const OPENAI_MODEL_ID_ENV = 'GEMINI_OPENAI_MODELID';

/**
 * Reads an environment variable, preferring values injected through
 * `Config.env` (which `.env` loading and settings populate) over the ambient
 * process environment.
 */
export function readEnvValue(
  key: string,
  configEnv?: Record<string, string>,
): string | undefined {
  const fromConfig = configEnv?.[key];
  if (fromConfig !== undefined) {
    return fromConfig;
  }
  return process.env[key];
}
