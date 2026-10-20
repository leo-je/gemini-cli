/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { tokenLimit, DEFAULT_TOKEN_LIMIT } from './tokenLimits.js';
import {
  clearDeclaredContextWindows,
  declareContextWindow,
} from './contextWindow.js';
import {
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL,
  PREVIEW_GEMINI_FLASH_MODEL,
  PREVIEW_GEMINI_MODEL,
} from '../config/models.js';

describe('tokenLimit', () => {
  it('should return the correct token limit for default models', () => {
    expect(tokenLimit(DEFAULT_GEMINI_MODEL)).toBe(1_048_576);
    expect(tokenLimit(DEFAULT_GEMINI_FLASH_MODEL)).toBe(1_048_576);
    expect(tokenLimit(DEFAULT_GEMINI_FLASH_LITE_MODEL)).toBe(1_048_576);
  });

  it('should return the correct token limit for preview models', () => {
    expect(tokenLimit(PREVIEW_GEMINI_MODEL)).toBe(1_048_576);
    expect(tokenLimit(PREVIEW_GEMINI_FLASH_MODEL)).toBe(1_048_576);
  });

  it('should return the default token limit for an unknown model', () => {
    expect(tokenLimit('unknown-model')).toBe(DEFAULT_TOKEN_LIMIT);
  });

  it('should return the default token limit if no model is provided', () => {
    // @ts-expect-error testing invalid input
    expect(tokenLimit(undefined)).toBe(DEFAULT_TOKEN_LIMIT);
  });

  it('should have the correct default token limit value', () => {
    expect(DEFAULT_TOKEN_LIMIT).toBe(1_048_576);
  });
});

describe('tokenLimit with a provider-declared window', () => {
  afterEach(() => clearDeclaredContextWindows());

  it('prefers the declared window over the compiled-in default', () => {
    declareContextWindow('deepseek-v4.1-flash', 131_072);
    // An OpenAI-compatible model id the CLI has never heard of: writing it into
    // the provider file is what tells the CLI its real window.
    expect(tokenLimit('deepseek-v4.1-flash')).toBe(131_072);
  });

  it('leaves other models on their compiled-in limits', () => {
    declareContextWindow('deepseek-v4.1-flash', 131_072);
    expect(tokenLimit(DEFAULT_GEMINI_MODEL)).toBe(1_048_576);
    expect(tokenLimit('unknown-model')).toBe(DEFAULT_TOKEN_LIMIT);
  });

  it('forgets the declaration when the registry is cleared', () => {
    declareContextWindow('deepseek-v4.1-flash', 131_072);
    clearDeclaredContextWindows();
    expect(tokenLimit('deepseek-v4.1-flash')).toBe(DEFAULT_TOKEN_LIMIT);
  });
});
