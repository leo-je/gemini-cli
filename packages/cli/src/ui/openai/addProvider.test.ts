/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadProviderEntries } from '@google/gemini-cli-core';
import { addOpenAiProvider, apiKeyEnvName } from './addProvider.js';

let tmpDir: string;
let providerPath: string;
let envPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-add-provider-'));
  providerPath = path.join(tmpDir, 'openai-providers.json');
  envPath = path.join(tmpDir, '.env');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('apiKeyEnvName', () => {
  it('derives an uppercase variable name', () => {
    expect(apiKeyEnvName('openrouter')).toBe('OPENROUTER_API_KEY');
  });

  it('folds characters that are illegal in a shell variable name', () => {
    expect(apiKeyEnvName('my-provider')).toBe('MY_PROVIDER_API_KEY');
  });
});

describe('addOpenAiProvider', () => {
  it('writes the provider and no env file when there is no key', () => {
    const result = addOpenAiProvider(
      { id: 'ollama', baseUrl: 'http://localhost:11434/v1' },
      providerPath,
      envPath,
    );

    expect(result.envPath).toBeNull();
    expect(result.apiKeyEnv).toBeUndefined();
    expect(fs.existsSync(envPath)).toBe(false);
    expect(loadProviderEntries(providerPath)).toEqual([
      { id: 'ollama', baseUrl: 'http://localhost:11434/v1' },
    ]);
  });

  it('stores the key in .env and references it by name', () => {
    const result = addOpenAiProvider(
      {
        id: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-secret',
      },
      providerPath,
      envPath,
    );

    expect(result.apiKeyEnv).toBe('OPENROUTER_API_KEY');
    expect(fs.readFileSync(envPath, 'utf8')).toContain(
      'OPENROUTER_API_KEY=sk-secret',
    );
    // The secret must not appear in the provider file.
    expect(fs.readFileSync(providerPath, 'utf8')).not.toContain('sk-secret');
    expect(loadProviderEntries(providerPath)[0].apiKeyEnv).toBe(
      'OPENROUTER_API_KEY',
    );
  });

  it('makes the key visible to the running process without a restart', () => {
    addOpenAiProvider(
      {
        id: 'openrouter',
        baseUrl: 'https://openrouter.ai/v1',
        apiKey: 'sk-secret',
      },
      providerPath,
      envPath,
    );
    expect(process.env['OPENROUTER_API_KEY']).toBe('sk-secret');
  });

  it('writes .env with private permissions', () => {
    addOpenAiProvider(
      {
        id: 'openrouter',
        baseUrl: 'https://openrouter.ai/v1',
        apiKey: 'sk-secret',
      },
      providerPath,
      envPath,
    );
    expect(fs.statSync(envPath).mode & 0o077).toBe(0);
  });

  it('preserves comments and unrelated variables in an existing .env', () => {
    fs.writeFileSync(envPath, '# keep me\nOTHER=value\n', 'utf8');

    addOpenAiProvider(
      { id: 'a', baseUrl: 'https://x/v1', apiKey: 'sk-secret' },
      providerPath,
      envPath,
    );

    const written = fs.readFileSync(envPath, 'utf8');
    expect(written).toContain('# keep me');
    expect(written).toContain('OTHER=value');
    expect(written).toContain('A_API_KEY=sk-secret');
  });

  it('writes nothing when the provider is rejected', () => {
    addOpenAiProvider(
      { id: 'a', baseUrl: 'https://x/v1' },
      providerPath,
      envPath,
    );

    expect(() =>
      addOpenAiProvider(
        { id: 'a', baseUrl: 'https://y/v1', apiKey: 'sk-secret' },
        providerPath,
        envPath,
      ),
    ).toThrow(/already exists/);
    // A rejected duplicate must not leave its key behind in .env.
    expect(fs.existsSync(envPath)).toBe(false);
  });

  it('quotes a key containing characters the shell would split on', () => {
    addOpenAiProvider(
      { id: 'a', baseUrl: 'https://x/v1', apiKey: 'has space' },
      providerPath,
      envPath,
    );
    expect(fs.readFileSync(envPath, 'utf8')).toContain('A_API_KEY="has space"');
  });
});
