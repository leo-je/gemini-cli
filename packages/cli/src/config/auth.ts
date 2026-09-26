/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, loadApiKey, parseHeaderJson } from '@google/gemini-cli-core';
import { loadEnvironment, loadSettings } from './settings.js';

export async function validateAuthMethod(
  authMethod: string,
): Promise<string | null> {
  loadEnvironment(loadSettings().merged, process.cwd());
  if (
    authMethod === AuthType.LOGIN_WITH_GOOGLE ||
    authMethod === AuthType.COMPUTE_ADC
  ) {
    return null;
  }

  if (authMethod === AuthType.USE_GEMINI) {
    const key = process.env['GEMINI_API_KEY'] || (await loadApiKey());
    if (!key) {
      return (
        'When using Gemini API, you must specify the GEMINI_API_KEY environment variable.\n' +
        'Update your environment and try again (no reload needed if using .env)!'
      );
    }
    return null;
  }

  if (authMethod === AuthType.USE_VERTEX_AI) {
    const hasVertexProjectLocationConfig =
      !!process.env['GOOGLE_CLOUD_PROJECT'] &&
      !!process.env['GOOGLE_CLOUD_LOCATION'];
    const hasGoogleApiKey = !!process.env['GOOGLE_API_KEY'];
    if (!hasVertexProjectLocationConfig && !hasGoogleApiKey) {
      return (
        'When using Vertex AI, you must specify either:\n' +
        '• GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION environment variables.\n' +
        '• GOOGLE_API_KEY environment variable (if using express mode).\n' +
        'Update your environment and try again (no reload needed if using .env)!'
      );
    }
    return null;
  }

  if (authMethod === AuthType.USE_OPENAI) {
    // Each setting falls back to the name the Gemini path already uses, so a
    // configuration written before the `GEMINI_OPENAI_*` prefix keeps working.
    // The OpenAI-named variable wins whenever it is set.
    if (
      !process.env['GEMINI_OPENAI_BASE_URL'] &&
      !process.env['GOOGLE_GEMINI_BASE_URL']
    ) {
      return (
        'When using an OpenAI-compatible API, you must specify the GEMINI_OPENAI_BASE_URL environment variable.\n' +
        'Update your environment and try again (no reload needed if using .env)!'
      );
    }
    if (!process.env['GEMINI_OPENAI_MODELID'] && !process.env['GEMINI_MODEL']) {
      return (
        'When using an OpenAI-compatible API, you must specify the GEMINI_OPENAI_MODELID environment variable.\n' +
        'Update your environment and try again (no reload needed if using .env)!'
      );
    }
    // A malformed GEMINI_OPENAI_HEADERS is reported here so the user sees the
    // reason at startup instead of an unexplained rejection from the endpoint.
    try {
      parseHeaderJson(process.env['GEMINI_OPENAI_HEADERS']);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    // GEMINI_OPENAI_API_KEY is intentionally not required: local servers such as
    // Ollama and LM Studio accept unauthenticated requests.
    return null;
  }

  return 'Invalid auth method selected.';
}
