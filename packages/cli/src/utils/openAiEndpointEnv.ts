/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import {
  debugLogger,
  GEMINI_DIR,
  OPENAI_API_KEY_ENV,
  OPENAI_BASE_URL_ENV,
  OPENAI_MODEL_ID_ENV,
} from '@google/gemini-cli-core';

export interface OpenAiEndpointEnv {
  baseUrl: string;
  modelId: string;
  /** Optional: local servers such as Ollama and LM Studio accept no auth. */
  apiKey?: string;
}

export function defaultOpenAiEnvPath(): string {
  return path.join(homedir(), GEMINI_DIR, '.env');
}

/**
 * Records the endpoint collected in the auth dialog so the next run works
 * without hand-editing files.
 *
 * OpenAI mode is configured entirely through environment variables, so the
 * values go into the user-level `.gemini/.env`, which `loadEnvironment` reads on
 * every start. They are applied to `process.env` as well, for two reasons:
 * `loadEnvironment` only fills variables that are not already set, and it reads
 * only the first `.env` it finds walking up from the workspace — so a
 * project-level `.env` would otherwise shadow this file and the session would
 * keep failing validation after a successful save.
 *
 * Returns the path written to, or null when the file could not be written. The
 * session is usable either way; persistence is best-effort.
 */
export function applyOpenAiEndpointEnv(
  settings: OpenAiEndpointEnv,
  envPath: string = defaultOpenAiEnvPath(),
): string | null {
  process.env[OPENAI_BASE_URL_ENV] = settings.baseUrl;
  process.env[OPENAI_MODEL_ID_ENV] = settings.modelId;
  if (settings.apiKey) {
    process.env[OPENAI_API_KEY_ENV] = settings.apiKey;
  }

  const entries: Array<[string, string | undefined]> = [
    [OPENAI_BASE_URL_ENV, settings.baseUrl],
    [OPENAI_MODEL_ID_ENV, settings.modelId],
    [OPENAI_API_KEY_ENV, settings.apiKey],
  ];

  try {
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, renderEnvFile(envPath, entries), {
      encoding: 'utf8',
      // The file may hold an API key, and the rest of the CLI already treats
      // `.env` files as sensitive.
      mode: 0o600,
    });
    return envPath;
  } catch (error) {
    debugLogger.debug('Failed to persist OpenAI endpoint settings:', error);
    return null;
  }
}

/**
 * Merges the given keys into an existing env file, rewriting values in place so
 * comments and unrelated variables survive.
 */
function renderEnvFile(
  envPath: string,
  entries: Array<[string, string | undefined]>,
): string {
  let existing = '';
  try {
    existing = fs.readFileSync(envPath, 'utf8');
  } catch {
    // First run: there is nothing to merge into.
  }

  const pending = new Map(entries);
  const lines = existing.length > 0 ? existing.split('\n') : [];
  // A file ending in a newline leaves an empty trailing element; dropping it
  // keeps appended entries next to the last real line instead of after a blank.
  if (lines.at(-1) === '') {
    lines.pop();
  }

  const merged = lines.map((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[1];
    if (key === undefined || !pending.has(key)) {
      return line;
    }
    const value = pending.get(key);
    pending.delete(key);
    // Undefined means "the dialog did not collect this one", so whatever is
    // already in the file stays.
    return value === undefined ? line : `${key}=${quoteEnvValue(value)}`;
  });

  for (const [key, value] of pending) {
    if (value !== undefined) {
      merged.push(`${key}=${quoteEnvValue(value)}`);
    }
  }

  const text = merged.join('\n');
  return text.endsWith('\n') ? text : `${text}\n`;
}

function quoteEnvValue(value: string): string {
  return /[\s#'"\\]/.test(value)
    ? `"${value.replace(/(["\\])/g, '\\$1')}"`
    : value;
}
