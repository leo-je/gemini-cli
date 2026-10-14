/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadProviderEntries,
  persistProviderModelId,
  resolveProvider,
  toProfile,
} from './providers.js';

let tmpDir: string;
let filePath: string;

function writeProviders(content: unknown): string {
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return filePath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-providers-'));
  filePath = path.join(tmpDir, 'openai-providers.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('loadProviderEntries', () => {
  it('treats a missing file as no providers', () => {
    expect(loadProviderEntries(filePath)).toEqual([]);
  });

  it('treats a blank file as no providers', () => {
    fs.writeFileSync(filePath, '   \n', 'utf8');
    expect(loadProviderEntries(filePath)).toEqual([]);
  });

  it('parses a well-formed file', () => {
    writeProviders({
      providers: [
        {
          id: 'openrouter',
          label: 'OpenRouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          modelId: 'gpt-4o',
          apiKeyEnv: 'OPENROUTER_API_KEY',
        },
      ],
    });
    expect(loadProviderEntries(filePath)).toEqual([
      {
        id: 'openrouter',
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'gpt-4o',
        apiKeyEnv: 'OPENROUTER_API_KEY',
      },
    ]);
  });

  it('strips a byte order mark', () => {
    fs.writeFileSync(
      filePath,
      `\uFEFF${JSON.stringify({ providers: [{ id: 'a', baseUrl: 'https://x/v1' }] })}`,
      'utf8',
    );
    expect(loadProviderEntries(filePath)).toHaveLength(1);
  });

  it('reports malformed JSON with the file name', () => {
    fs.writeFileSync(filePath, '{not json', 'utf8');
    expect(() => loadProviderEntries(filePath)).toThrow(/must be valid JSON/);
  });

  it('rejects an unknown field rather than ignoring it', () => {
    writeProviders({
      providers: [{ id: 'a', baseUrl: 'https://x/v1', typo: 1 }],
    });
    expect(() => loadProviderEntries(filePath)).toThrow(
      /not a valid provider file/,
    );
  });

  it('rejects a duplicate provider id', () => {
    writeProviders({
      providers: [
        { id: 'a', baseUrl: 'https://x/v1' },
        { id: 'a', baseUrl: 'https://y/v1' },
      ],
    });
    expect(() => loadProviderEntries(filePath)).toThrow(
      /defines the provider id "a" more than once/,
    );
  });

  it('rejects an id that is not shell-safe', () => {
    writeProviders({ providers: [{ id: '-n', baseUrl: 'https://x/v1' }] });
    expect(() => loadProviderEntries(filePath)).toThrow(
      /not a valid provider file/,
    );
  });

  it('rejects an apiKeyEnv that is not a variable name', () => {
    writeProviders({
      providers: [
        { id: 'a', baseUrl: 'https://x/v1', apiKeyEnv: 'not a name' },
      ],
    });
    expect(() => loadProviderEntries(filePath)).toThrow(
      /not a valid provider file/,
    );
  });
});

describe('provider file permissions', () => {
  it('rejects a literal apiKey in a readable file', () => {
    writeProviders({
      providers: [{ id: 'a', baseUrl: 'https://x/v1', apiKey: 'sk-secret' }],
    });
    fs.chmodSync(filePath, 0o644);
    expect(() => loadProviderEntries(filePath)).toThrow(
      /readable by other users/,
    );
  });

  it('accepts a literal apiKey in a 0600 file', () => {
    writeProviders({
      providers: [{ id: 'a', baseUrl: 'https://x/v1', apiKey: 'sk-secret' }],
    });
    fs.chmodSync(filePath, 0o600);
    expect(loadProviderEntries(filePath)).toHaveLength(1);
  });

  it('does not require private permissions for an apiKeyEnv reference', () => {
    writeProviders({
      providers: [{ id: 'a', baseUrl: 'https://x/v1', apiKeyEnv: 'KEY_A' }],
    });
    fs.chmodSync(filePath, 0o644);
    expect(loadProviderEntries(filePath)).toHaveLength(1);
  });
});

describe('toProfile', () => {
  it('resolves a key from the referenced environment variable', () => {
    vi.stubEnv('KEY_A', 'sk-from-env');
    const profile = toProfile(
      { id: 'a', baseUrl: 'https://x/v1', apiKeyEnv: 'KEY_A' },
      undefined,
      filePath,
    );
    expect(profile.apiKey).toBe('sk-from-env');
  });

  it('prefers Config.env over the ambient process environment', () => {
    vi.stubEnv('KEY_A', 'ambient');
    const profile = toProfile(
      { id: 'a', baseUrl: 'https://x/v1', apiKeyEnv: 'KEY_A' },
      { KEY_A: 'from-config' },
      filePath,
    );
    expect(profile.apiKey).toBe('from-config');
  });

  it('reports an unset apiKeyEnv by name', () => {
    expect(() =>
      toProfile(
        { id: 'a', baseUrl: 'https://x/v1', apiKeyEnv: 'MISSING_KEY' },
        undefined,
        filePath,
      ),
    ).toThrow(/references the environment variable MISSING_KEY/);
  });

  it('falls back to a literal key when no apiKeyEnv is given', () => {
    const profile = toProfile(
      { id: 'a', baseUrl: 'https://x/v1', apiKey: 'sk-literal' },
      undefined,
      filePath,
    );
    expect(profile.apiKey).toBe('sk-literal');
  });

  it('leaves the key undefined for an unauthenticated endpoint', () => {
    const profile = toProfile(
      { id: 'ollama', baseUrl: 'http://localhost:11434/v1' },
      undefined,
      filePath,
    );
    expect(profile.apiKey).toBeUndefined();
  });

  it('defaults the label to the id', () => {
    const profile = toProfile(
      { id: 'a', baseUrl: 'https://x/v1' },
      undefined,
      filePath,
    );
    expect(profile.label).toBe('a');
  });

  it('coerces header values to strings', () => {
    const profile = toProfile(
      { id: 'a', baseUrl: 'https://x/v1', headers: { 'X-Retries': 3 } },
      undefined,
      filePath,
    );
    expect(profile.headers).toEqual({ 'X-Retries': '3' });
  });

  it('rejects an invalid header name', () => {
    expect(() =>
      toProfile(
        { id: 'a', baseUrl: 'https://x/v1', headers: { 'Bad Header': 'v' } },
        undefined,
        filePath,
      ),
    ).toThrow(/invalid header name/);
  });

  it('rejects a header value carrying a newline', () => {
    expect(() =>
      toProfile(
        { id: 'a', baseUrl: 'https://x/v1', headers: { 'X-A': 'v\r\nX-B: 1' } },
        undefined,
        filePath,
      ),
    ).toThrow(/control character/);
  });
});

describe('resolveProvider', () => {
  beforeEach(() => {
    writeProviders({
      providers: [
        { id: 'first', baseUrl: 'https://first/v1' },
        { id: 'second', baseUrl: 'https://second/v1' },
      ],
    });
  });

  it('returns undefined when no provider is configured and none was requested', () => {
    fs.rmSync(filePath);
    expect(resolveProvider(undefined, filePath)).toBeUndefined();
  });

  it('errors when a specific provider is requested but none are configured', () => {
    fs.rmSync(filePath);
    expect(() => resolveProvider('first', filePath)).toThrow(
      /No providers are configured/,
    );
  });

  it('defaults to the first entry', () => {
    expect(resolveProvider(undefined, filePath)?.id).toBe('first');
  });

  it('resolves a requested id', () => {
    expect(resolveProvider('second', filePath)?.id).toBe('second');
  });

  it('lists the known ids when the requested one is unknown', () => {
    expect(() => resolveProvider('third', filePath)).toThrow(
      /Unknown provider "third".*first, second/s,
    );
  });
});

describe('resolveProviderFromEnv', () => {
  it('exposes the documented provider selection variable', async () => {
    const { OPENAI_PROVIDER_ENV } = await import('./providers.js');
    expect(OPENAI_PROVIDER_ENV).toBe('GEMINI_OPENAI_PROVIDER');
  });

  it('fails loudly when the selection names a provider that does not exist', () => {
    writeProviders({
      providers: [{ id: 'first', baseUrl: 'https://first/v1' }],
    });
    expect(() => resolveProvider('missing', filePath)).toThrow(
      /Unknown provider "missing"/,
    );
  });
});

describe('persistProviderModelId', () => {
  it('records the model and preserves unknown fields', () => {
    writeProviders({
      providers: [
        { id: 'a', baseUrl: 'https://x/v1', futureField: true },
        { id: 'b', baseUrl: 'https://y/v1', modelId: 'keep-me' },
      ],
      unknownTopLevel: 'preserved',
    });

    expect(persistProviderModelId('a', 'gpt-4o', filePath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      providers: Array<Record<string, unknown>>;
      unknownTopLevel?: string;
    };
    expect(written.providers[0]['modelId']).toBe('gpt-4o');
    expect(written.providers[0]['futureField']).toBe(true);
    expect(written.providers[1]['modelId']).toBe('keep-me');
    expect(written.unknownTopLevel).toBe('preserved');
  });

  it('returns false for an unknown provider id', () => {
    writeProviders({ providers: [{ id: 'a', baseUrl: 'https://x/v1' }] });
    expect(persistProviderModelId('nope', 'gpt-4o', filePath)).toBe(false);
  });

  it('returns false rather than throwing when the file is unreadable', () => {
    expect(persistProviderModelId('a', 'gpt-4o', filePath)).toBe(false);
  });

  it('writes the file with private permissions', () => {
    writeProviders({ providers: [{ id: 'a', baseUrl: 'https://x/v1' }] });
    persistProviderModelId('a', 'gpt-4o', filePath);
    expect(fs.statSync(filePath).mode & 0o077).toBe(0);
  });
});
