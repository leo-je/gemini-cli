/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasResolvableOpenAiProvider } from './integration.js';

let tmpDir: string;
let providersPath: string;

function writeProviders(content: unknown): void {
  fs.writeFileSync(providersPath, JSON.stringify(content, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-provider-gate-'));
  providersPath = path.join(tmpDir, 'openai-providers.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('hasResolvableOpenAiProvider', () => {
  it('is false when no provider file exists', () => {
    expect(hasResolvableOpenAiProvider({}, providersPath)).toBe(false);
  });

  it('is false for a profile without a model id', () => {
    writeProviders({
      providers: [{ id: 'a', baseUrl: 'https://x/v1' }],
    });
    expect(fs.existsSync(providersPath)).toBe(true);
    expect(hasResolvableOpenAiProvider({}, providersPath)).toBe(false);
  });

  it('is true for a complete first-entry profile', () => {
    writeProviders({
      providers: [{ id: 'a', baseUrl: 'https://x/v1', modelId: 'm1' }],
    });
    expect(hasResolvableOpenAiProvider({}, providersPath)).toBe(true);
  });

  it('honours GEMINI_OPENAI_PROVIDER over the first entry', () => {
    writeProviders({
      providers: [
        { id: 'a', baseUrl: 'https://x/v1', modelId: 'm1' },
        { id: 'b', baseUrl: 'https://y/v1', modelId: 'm2' },
      ],
    });
    expect(
      hasResolvableOpenAiProvider(
        { GEMINI_OPENAI_PROVIDER: 'b' },
        providersPath,
      ),
    ).toBe(true);
    expect(
      hasResolvableOpenAiProvider(
        { GEMINI_OPENAI_PROVIDER: 'nope' },
        providersPath,
      ),
    ).toBe(false);
  });

  it('is false rather than throwing on a malformed file', () => {
    fs.writeFileSync(providersPath, '{ not json', 'utf8');
    expect(hasResolvableOpenAiProvider({}, providersPath)).toBe(false);
  });

  it('accepts an env with undefined values (process.env shape)', () => {
    writeProviders({
      providers: [{ id: 'a', baseUrl: 'https://x/v1', modelId: 'm1' }],
    });
    const env: Record<string, string | undefined> = {
      GEMINI_OPENAI_PROVIDER: undefined,
      SOMETHING: 'x',
    };
    expect(hasResolvableOpenAiProvider(env, providersPath)).toBe(true);
  });
});
