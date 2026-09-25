/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenAI-compatible backend for the CLI.
 *
 * Enabling it is entirely env-driven: set `GEMINI_API_TYPE=openai` along with
 * `GEMINI_OPENAI_BASE_URL`, `GEMINI_OPENAI_API_KEY`, and
 * `GEMINI_OPENAI_MODELID`.
 */

export * from './types.js';
export * from './constants.js';
export * from './converters.js';
export * from './openaiClient.js';
export * from './openaiContentGenerator.js';
