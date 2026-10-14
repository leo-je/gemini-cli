/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addProvider, loadProviderEntries } from './providers.js';

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'add-provider-'));
  filePath = path.join(tmpDir, 'openai-providers.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('addProvider', () => {
  it('creates the file when none exists', () => {
    addProvider({ id: 'openrouter', baseUrl: 'https://x/v1' }, filePath);

    expect(loadProviderEntries(filePath)).toEqual([
      { id: 'openrouter', baseUrl: 'https://x/v1' },
    ]);
  });

  it('creates the parent directory', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'openai-providers.json');
    addProvider({ id: 'a', baseUrl: 'https://x/v1' }, nested);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('appends to an existing file', () => {
    addProvider({ id: 'first', baseUrl: 'https://first/v1' }, filePath);
    addProvider({ id: 'second', baseUrl: 'https://second/v1' }, filePath);
    expect(loadProviderEntries(filePath).map((e) => e.id)).toEqual([
      'first',
      'second',
    ]);
  });

  it('preserves unknown top-level keys and provider fields', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        unknownTopLevel: 'keep',
        providers: [{ id: 'existing', baseUrl: 'https://x/v1', future: true }],
      }),
      'utf8',
    );

    addProvider({ id: 'added', baseUrl: 'https://y/v1' }, filePath);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      unknownTopLevel?: string;
      providers: Array<Record<string, unknown>>;
    };
    expect(written.unknownTopLevel).toBe('keep');
    expect(written.providers[0]['future']).toBe(true);
    expect(written.providers).toHaveLength(2);
  });

  it('records an apiKeyEnv reference rather than the key', () => {
    addProvider(
      { id: 'a', baseUrl: 'https://x/v1', apiKeyEnv: 'A_API_KEY' },
      filePath,
    );
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      providers: Array<Record<string, unknown>>;
    };
    expect(written.providers[0]['apiKeyEnv']).toBe('A_API_KEY');
    expect(written.providers[0]).not.toHaveProperty('apiKey');
  });

  it('rejects a duplicate id and changes nothing', () => {
    addProvider({ id: 'a', baseUrl: 'https://x/v1' }, filePath);
    expect(() =>
      addProvider({ id: 'a', baseUrl: 'https://y/v1' }, filePath),
    ).toThrow(/already exists/);
    expect(loadProviderEntries(filePath)[0].baseUrl).toBe('https://x/v1');
  });

  it('rejects an invalid id', () => {
    expect(() =>
      addProvider({ id: 'has space', baseUrl: 'https://x/v1' }, filePath),
    ).toThrow(/Cannot save provider/);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('rejects an invalid apiKeyEnv name', () => {
    expect(() =>
      addProvider(
        { id: 'a', baseUrl: 'https://x/v1', apiKeyEnv: 'not a name' },
        filePath,
      ),
    ).toThrow(/Cannot save provider/);
  });

  it('reports malformed existing JSON instead of overwriting it', () => {
    fs.writeFileSync(filePath, '{oops', 'utf8');
    expect(() =>
      addProvider({ id: 'a', baseUrl: 'https://x/v1' }, filePath),
    ).toThrow(/must be valid JSON/);
    // The bad file is left exactly as the user wrote it.
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{oops');
  });

  it('reports a providers key that is not an array', () => {
    fs.writeFileSync(filePath, JSON.stringify({ providers: 'nope' }), 'utf8');
    expect(() =>
      addProvider({ id: 'a', baseUrl: 'https://x/v1' }, filePath),
    ).toThrow(/not an array/);
  });

  it('writes the file with private permissions', () => {
    addProvider(
      { id: 'a', baseUrl: 'https://x/v1', apiKey: 'sk-literal' },
      filePath,
    );
    expect(fs.statSync(filePath).mode & 0o077).toBe(0);
  });
});
