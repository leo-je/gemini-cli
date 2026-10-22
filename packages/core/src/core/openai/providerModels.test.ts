/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getAutoSettingsPath,
  getProviderModelSettings,
  getProviderModels,
  mergeProviderModels,
  saveProviderModelSettings,
  setProviderModels,
} from './providerModels.js';
import { loadProviderEntries, type OpenAiProviderModel } from './providers.js';

let tmpDir: string;
let filePath: string;

function writeProviders(content: unknown, mode = 0o600): string {
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), {
    encoding: 'utf8',
    mode,
  });
  return filePath;
}

function readProviders(): {
  providers: Array<Record<string, unknown>>;
  extra?: unknown;
} {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
    providers: Array<Record<string, unknown>>;
    extra?: unknown;
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-provider-models-'));
  filePath = path.join(tmpDir, 'openai-providers.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getProviderModels', () => {
  it('returns an empty list when the provider has no models', () => {
    writeProviders({
      providers: [{ id: 'openrouter', baseUrl: 'https://x/v1' }],
    });
    expect(getProviderModels('openrouter', filePath)).toEqual([]);
  });

  it('returns the saved entries with their token settings', () => {
    writeProviders({
      providers: [
        {
          id: 'openrouter',
          baseUrl: 'https://x/v1',
          models: [
            { modelId: 'm1', contextWindowSize: 131_072, maxToken: 8_192 },
            { modelId: 'm2' },
          ],
        },
      ],
    });
    expect(getProviderModels('openrouter', filePath)).toEqual([
      { modelId: 'm1', contextWindowSize: 131_072, maxToken: 8_192 },
      { modelId: 'm2' },
    ]);
  });

  it('returns an empty list instead of throwing on a broken file', () => {
    fs.writeFileSync(filePath, '{not json', 'utf8');
    expect(getProviderModels('openrouter', filePath)).toEqual([]);
  });

  it('returns an empty list when the provider is unknown', () => {
    writeProviders({ providers: [] });
    expect(getProviderModels('missing', filePath)).toEqual([]);
  });
});

describe('getProviderModelSettings', () => {
  it('finds the entry for one model', () => {
    writeProviders({
      providers: [
        {
          id: 'openrouter',
          baseUrl: 'https://x/v1',
          models: [{ modelId: 'm1', maxToken: 4_096 }],
        },
      ],
    });
    expect(getProviderModelSettings('openrouter', 'm1', filePath)).toEqual({
      modelId: 'm1',
      maxToken: 4_096,
    });
  });

  it('returns undefined for an unknown model', () => {
    writeProviders({
      providers: [
        {
          id: 'openrouter',
          baseUrl: 'https://x/v1',
          models: [{ modelId: 'm1' }],
        },
      ],
    });
    expect(
      getProviderModelSettings('openrouter', 'm2', filePath),
    ).toBeUndefined();
  });
});

describe('setProviderModels', () => {
  it('writes the list and keeps fields it does not model', () => {
    writeProviders({
      extra: 'kept',
      providers: [
        { id: 'openrouter', baseUrl: 'https://x/v1', comment: 'hand written' },
      ],
    });
    expect(
      setProviderModels(
        'openrouter',
        [{ modelId: 'm1', contextWindowSize: 65_536 }],
        filePath,
      ),
    ).toBe(true);

    const document = readProviders();
    expect(document.extra).toBe('kept');
    expect(document.providers[0]['comment']).toBe('hand written');
    expect(document.providers[0]['models']).toEqual([
      { modelId: 'm1', contextWindowSize: 65_536 },
    ]);
  });

  it('produces a file the reader accepts', () => {
    writeProviders({
      providers: [{ id: 'openrouter', baseUrl: 'https://x/v1' }],
    });
    setProviderModels(
      'openrouter',
      [{ modelId: 'm1', contextWindowSize: 65_536, maxToken: 8_192 }],
      filePath,
    );
    expect(loadProviderEntries(filePath)[0].models).toEqual([
      { modelId: 'm1', contextWindowSize: 65_536, maxToken: 8_192 },
    ]);
  });

  it('writes the provider file with private permissions', () => {
    writeProviders({
      providers: [{ id: 'openrouter', baseUrl: 'https://x/v1' }],
    });
    setProviderModels('openrouter', [{ modelId: 'm1' }], filePath);
    if (process.platform !== 'win32') {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects a duplicate model id', () => {
    writeProviders({
      providers: [{ id: 'openrouter', baseUrl: 'https://x/v1' }],
    });
    expect(() =>
      setProviderModels(
        'openrouter',
        [{ modelId: 'm1' }, { modelId: 'm1' }],
        filePath,
      ),
    ).toThrow(/more than once/);
  });

  it('rejects a non-positive token count', () => {
    writeProviders({
      providers: [{ id: 'openrouter', baseUrl: 'https://x/v1' }],
    });
    expect(() =>
      setProviderModels(
        'openrouter',
        [{ modelId: 'm1', contextWindowSize: 0 }],
        filePath,
      ),
    ).toThrow(/Invalid models list/);
  });

  it('reports failure for an unknown provider without touching the file', () => {
    writeProviders({ providers: [{ id: 'other', baseUrl: 'https://x/v1' }] });
    const before = fs.readFileSync(filePath, 'utf8');
    expect(setProviderModels('openrouter', [{ modelId: 'm1' }], filePath)).toBe(
      false,
    );
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('reports failure for a missing file', () => {
    expect(setProviderModels('openrouter', [{ modelId: 'm1' }], filePath)).toBe(
      false,
    );
  });
});

describe('mergeProviderModels', () => {
  it('keeps the token settings already saved for a fetched model', () => {
    writeProviders({
      providers: [
        {
          id: 'openrouter',
          baseUrl: 'https://x/v1',
          models: [{ modelId: 'm1', contextWindowSize: 131_072 }],
        },
      ],
    });
    expect(mergeProviderModels('openrouter', ['m1', 'm2'], filePath)).toBe(
      true,
    );
    expect(getProviderModels('openrouter', filePath)).toEqual([
      { modelId: 'm1', contextWindowSize: 131_072 },
      { modelId: 'm2' },
    ]);
  });

  it('drops saved models the endpoint no longer serves', () => {
    writeProviders({
      providers: [
        {
          id: 'openrouter',
          baseUrl: 'https://x/v1',
          models: [{ modelId: 'retired', maxToken: 1_024 }],
        },
      ],
    });
    mergeProviderModels('openrouter', ['m1'], filePath);
    expect(getProviderModels('openrouter', filePath)).toEqual([
      { modelId: 'm1' },
    ]);
  });

  it('ignores an empty fetch instead of wiping the saved list', () => {
    writeProviders({
      providers: [
        {
          id: 'openrouter',
          baseUrl: 'https://x/v1',
          models: [{ modelId: 'm1', maxToken: 1_024 }],
        },
      ],
    });
    expect(mergeProviderModels('openrouter', [], filePath)).toBe(false);
    expect(getProviderModels('openrouter', filePath)).toEqual([
      { modelId: 'm1', maxToken: 1_024 },
    ]);
  });
});

describe('mergeProviderModels auto-fills from the endpoint', () => {
  function readAuto(): unknown {
    return JSON.parse(fs.readFileSync(getAutoSettingsPath(filePath), 'utf8'));
  }

  function seed(models?: unknown[]): void {
    writeProviders({
      providers: [
        {
          id: 'openrouter',
          baseUrl: 'https://x/v1',
          ...(models ? { models } : {}),
        },
      ],
    });
  }

  it('fills an empty field and records where the number came from', () => {
    seed();
    expect(
      mergeProviderModels(
        'openrouter',
        [{ modelId: 'm1', contextWindowSize: 262_144, maxToken: 8_192 }],
        filePath,
      ),
    ).toBe(true);
    expect(getProviderModels('openrouter', filePath)).toEqual([
      { modelId: 'm1', contextWindowSize: 262_144, maxToken: 8_192 },
    ]);

    const auto = readAuto() as Record<string, Record<string, unknown>>;
    expect(auto['openrouter']).toEqual({
      m1: {
        contextWindowSize: {
          value: 262_144,
          fetchedAt: expect.any(String) as unknown as string,
        },
        maxToken: {
          value: 8_192,
          fetchedAt: expect.any(String) as unknown as string,
        },
      },
    });
  });

  it('never overwrites a number the user typed', () => {
    seed([{ modelId: 'm1', contextWindowSize: 131_072 }]);
    mergeProviderModels(
      'openrouter',
      [{ modelId: 'm1', contextWindowSize: 262_144 }],
      filePath,
    );
    // No provenance record exists, so the saved number is the user's.
    expect(getProviderModels('openrouter', filePath)).toEqual([
      { modelId: 'm1', contextWindowSize: 131_072 },
    ]);
    expect(fs.existsSync(getAutoSettingsPath(filePath))).toBe(false);
  });

  it('follows the endpoint for a number it filled in itself', () => {
    seed();
    mergeProviderModels(
      'openrouter',
      [{ modelId: 'm1', contextWindowSize: 200_000 }],
      filePath,
    );
    mergeProviderModels(
      'openrouter',
      [{ modelId: 'm1', contextWindowSize: 300_000 }],
      filePath,
    );
    expect(getProviderModels('openrouter', filePath)).toEqual([
      { modelId: 'm1', contextWindowSize: 300_000 },
    ]);
  });

  it('gives up ownership as soon as the value was edited by hand', () => {
    seed();
    mergeProviderModels(
      'openrouter',
      [{ modelId: 'm1', contextWindowSize: 200_000 }],
      filePath,
    );
    seed([{ modelId: 'm1', contextWindowSize: 150_000 }]);
    mergeProviderModels(
      'openrouter',
      [{ modelId: 'm1', contextWindowSize: 300_000 }],
      filePath,
    );
    expect(getProviderModels('openrouter', filePath)).toEqual([
      { modelId: 'm1', contextWindowSize: 150_000 },
    ]);

    // And the stale record must not come back to life on the next fetch.
    mergeProviderModels(
      'openrouter',
      [{ modelId: 'm1', contextWindowSize: 400_000 }],
      filePath,
    );
    expect(getProviderModels('openrouter', filePath)).toEqual([
      { modelId: 'm1', contextWindowSize: 150_000 },
    ]);
  });

  it("treats every number as the user's when the record is unreadable", () => {
    seed([{ modelId: 'm1', contextWindowSize: 131_072 }]);
    fs.writeFileSync(getAutoSettingsPath(filePath), '{ not json', 'utf8');
    mergeProviderModels(
      'openrouter',
      [{ modelId: 'm1', contextWindowSize: 262_144 }],
      filePath,
    );
    expect(getProviderModels('openrouter', filePath)).toEqual([
      { modelId: 'm1', contextWindowSize: 131_072 },
    ]);
  });

  it('leaves a field alone when the endpoint reports nothing for it', () => {
    seed([{ modelId: 'm1', maxToken: 4_096 }]);
    mergeProviderModels(
      'openrouter',
      [{ modelId: 'm1', contextWindowSize: 200_000 }],
      filePath,
    );
    expect(getProviderModels('openrouter', filePath)).toEqual([
      { modelId: 'm1', contextWindowSize: 200_000, maxToken: 4_096 },
    ]);
  });

  it('drops the provenance of a retired model', () => {
    seed();
    mergeProviderModels(
      'openrouter',
      [{ modelId: 'gone', contextWindowSize: 200_000 }],
      filePath,
    );
    mergeProviderModels('openrouter', ['m1'], filePath);
    expect(fs.existsSync(getAutoSettingsPath(filePath))).toBe(false);
  });

  it('hands ownership to the user when a number is saved by hand', () => {
    seed();
    mergeProviderModels(
      'openrouter',
      [{ modelId: 'm1', contextWindowSize: 200_000 }],
      filePath,
    );
    saveProviderModelSettings(
      'openrouter',
      'm1',
      { contextWindowSize: 200_000 },
      filePath,
    );
    mergeProviderModels(
      'openrouter',
      [{ modelId: 'm1', contextWindowSize: 300_000 }],
      filePath,
    );
    expect(getProviderModels('openrouter', filePath)).toEqual([
      { modelId: 'm1', contextWindowSize: 200_000 },
    ]);
  });
});

describe('token count shorthand', () => {
  it('parses k as binary and normalizes the value on load', () => {
    writeProviders({
      providers: [
        {
          id: 'openrouter',
          baseUrl: 'https://x/v1',
          models: [
            { modelId: 'm1', contextWindowSize: '128k', maxToken: '8k' },
            { modelId: 'm2', contextWindowSize: '1M' },
            { modelId: 'm3', contextWindowSize: '1.5k' },
          ],
        },
      ],
    });
    expect(getProviderModels('openrouter', filePath)).toEqual([
      { modelId: 'm1', contextWindowSize: 131_072, maxToken: 8_192 },
      { modelId: 'm2', contextWindowSize: 1_048_576 },
      { modelId: 'm3', contextWindowSize: 1_536 },
    ]);
  });

  it('accepts a suffix when saving and writes plain numbers', () => {
    writeProviders({
      providers: [{ id: 'openrouter', baseUrl: 'https://x/v1' }],
    });
    expect(
      setProviderModels(
        'openrouter',
        [
          {
            modelId: 'm1',
            contextWindowSize: '128k',
            maxToken: '8k',
          } as unknown as OpenAiProviderModel,
        ],
        filePath,
      ),
    ).toBe(true);
    expect(readProviders().providers[0]['models']).toEqual([
      { modelId: 'm1', contextWindowSize: 131_072, maxToken: 8_192 },
    ]);
  });

  it('rejects an unknown suffix', () => {
    writeProviders({
      providers: [{ id: 'openrouter', baseUrl: 'https://x/v1' }],
    });
    expect(() =>
      setProviderModels(
        'openrouter',
        [{ modelId: 'm1', maxToken: '12x' } as unknown as OpenAiProviderModel],
        filePath,
      ),
    ).toThrow(/k or m suffix/);
  });

  it('rejects a fractional count without a suffix', () => {
    writeProviders({
      providers: [{ id: 'openrouter', baseUrl: 'https://x/v1' }],
    });
    expect(() =>
      setProviderModels(
        'openrouter',
        [
          {
            modelId: 'm1',
            maxToken: '128.5',
          } as unknown as OpenAiProviderModel,
        ],
        filePath,
      ),
    ).toThrow(/k or m suffix/);
  });
});

describe('saveProviderModelSettings', () => {
  it('adds an entry when the model is not in the list yet', () => {
    writeProviders({
      providers: [{ id: 'openrouter', baseUrl: 'https://x/v1' }],
    });
    expect(
      saveProviderModelSettings(
        'openrouter',
        'm1',
        { contextWindowSize: 131_072, maxToken: 8_192 },
        filePath,
      ),
    ).toBe(true);
    expect(getProviderModels('openrouter', filePath)).toEqual([
      { modelId: 'm1', contextWindowSize: 131_072, maxToken: 8_192 },
    ]);
  });

  it('updates one field and keeps the other', () => {
    writeProviders({
      providers: [
        {
          id: 'openrouter',
          baseUrl: 'https://x/v1',
          models: [
            { modelId: 'm1', contextWindowSize: 131_072, maxToken: 1_024 },
          ],
        },
      ],
    });
    saveProviderModelSettings(
      'openrouter',
      'm1',
      { maxToken: 8_192 },
      filePath,
    );
    expect(getProviderModels('openrouter', filePath)).toEqual([
      { modelId: 'm1', contextWindowSize: 131_072, maxToken: 8_192 },
    ]);
  });

  it('does not clear a saved value when no replacement is supplied', () => {
    writeProviders({
      providers: [
        {
          id: 'openrouter',
          baseUrl: 'https://x/v1',
          models: [{ modelId: 'm1', contextWindowSize: 131_072 }],
        },
      ],
    });
    saveProviderModelSettings(
      'openrouter',
      'm1',
      { contextWindowSize: undefined, maxToken: undefined },
      filePath,
    );
    expect(getProviderModels('openrouter', filePath)).toEqual([
      { modelId: 'm1', contextWindowSize: 131_072 },
    ]);
  });
});
