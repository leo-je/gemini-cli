/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuthType, getOpenAiProvidersPath } from '@google/gemini-cli-core';
import { SettingScope } from '../../config/settings.js';
import {
  OPENAI_PROVIDER_SETTING_KEY,
  persistOpenAiMode,
  persistProviderId,
  providerHasDefaultModel,
  readPersistedProviderId,
  rememberModelForProvider,
} from './openAiProviderPreference.js';

describe('readPersistedProviderId', () => {
  it('reads the id out of security.auth', () => {
    expect(
      readPersistedProviderId({
        security: { auth: { openAiProviderId: 'openrouter' } },
      }),
    ).toBe('openrouter');
  });

  it('returns undefined when nothing was persisted', () => {
    expect(readPersistedProviderId(undefined)).toBeUndefined();
    expect(readPersistedProviderId({})).toBeUndefined();
    expect(readPersistedProviderId({ security: {} })).toBeUndefined();
    expect(readPersistedProviderId({ security: { auth: {} } })).toBeUndefined();
  });

  it('treats a blank id as no choice', () => {
    // An empty setting must not be read as a provider named "".
    expect(
      readPersistedProviderId({
        security: { auth: { openAiProviderId: '' } },
      }),
    ).toBeUndefined();
    expect(
      readPersistedProviderId({
        security: { auth: { openAiProviderId: '   ' } },
      }),
    ).toBeUndefined();
  });
});

describe('persistOpenAiMode', () => {
  it('records OpenAI as the chosen auth mode', () => {
    // The setup step replaces the auth dialog, which is what normally writes
    // this key; without it the next start asked which mode to use.
    const settings = { setValue: vi.fn() };

    persistOpenAiMode(settings);

    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'security.auth.selectedType',
      AuthType.USE_OPENAI,
    );
  });

  it('does not fail the switch when settings cannot be written', () => {
    const settings = {
      setValue: vi.fn(() => {
        throw new Error('read-only');
      }),
    };

    expect(() => persistOpenAiMode(settings)).not.toThrow();
  });
});

describe('persistProviderId', () => {
  it('writes the id at user scope', () => {
    const settings = { setValue: vi.fn() };

    persistProviderId(settings, 'openrouter');

    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      OPENAI_PROVIDER_SETTING_KEY,
      'openrouter',
    );
  });

  it('does not fail the switch when settings cannot be written', () => {
    // A read-only home directory must not break a switch that otherwise worked.
    const settings = {
      setValue: vi.fn(() => {
        throw new Error('read-only');
      }),
    };

    expect(() => persistProviderId(settings, 'openrouter')).not.toThrow();
  });
});

describe('providerHasDefaultModel', () => {
  let fakeHome: string;

  function writeProviders(providers: unknown[]): void {
    const file = getOpenAiProvidersPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ providers }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-default-home-'));
    vi.stubEnv('HOME', fakeHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('is false when the provider declares no model', () => {
    // The case that used to leave a session unable to send a message.
    writeProviders([{ id: 'no-model', baseUrl: 'https://x/v1' }]);
    expect(providerHasDefaultModel('no-model')).toBe(false);
  });

  it('is true when the provider declares a model', () => {
    writeProviders([
      { id: 'with-model', baseUrl: 'https://x/v1', modelId: 'm1' },
    ]);
    expect(providerHasDefaultModel('with-model')).toBe(true);
  });

  it('reports a default when the provider cannot be found', () => {
    // Only reached if the file changed after a successful switch, so the
    // ordinary path is taken rather than opening a list for the wrong reason.
    writeProviders([{ id: 'known', baseUrl: 'https://x/v1', modelId: 'm1' }]);
    expect(providerHasDefaultModel('unknown')).toBe(true);
  });

  it('reports a default when no provider file exists', () => {
    // `loadProviderEntries` returns an empty list for an absent file, which is
    // the normal single-endpoint state and must not open the model list.
    expect(providerHasDefaultModel('anything')).toBe(true);
  });
});

describe('rememberModelForProvider', () => {
  let fakeHome: string;

  function writeProviders(providers: unknown[]): void {
    const file = getOpenAiProvidersPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ providers }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  function readProviders(): Array<{ id: string; modelId?: string }> {
    return JSON.parse(fs.readFileSync(getOpenAiProvidersPath(), 'utf8'))
      .providers as Array<{ id: string; modelId?: string }>;
  }

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'remember-model-home-'));
    vi.stubEnv('HOME', fakeHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('records the pick as the provider default, so a restart restores it', () => {
    // Regression: the OpenAI model list has no "remember" toggle, so a pick was
    // applied for the session only and every restart fell back to `auto`.
    writeProviders([
      { id: 'openrouter', baseUrl: 'https://openrouter.ai/v1' },
      { id: 'other', baseUrl: 'https://other/v1', modelId: 'keep-me' },
    ]);

    rememberModelForProvider('openrouter', 'anthropic/claude-haiku-5.5');

    expect(readProviders()).toEqual([
      {
        id: 'openrouter',
        baseUrl: 'https://openrouter.ai/v1',
        modelId: 'anthropic/claude-haiku-5.5',
      },
      { id: 'other', baseUrl: 'https://other/v1', modelId: 'keep-me' },
    ]);
    // The pick is now the provider's default, which is what startup reads.
    expect(providerHasDefaultModel('openrouter')).toBe(true);
  });

  it('overwrites a previous choice for the same provider', () => {
    writeProviders([
      { id: 'openrouter', baseUrl: 'https://openrouter.ai/v1', modelId: 'old' },
    ]);

    rememberModelForProvider('openrouter', 'new');

    expect(readProviders()[0].modelId).toBe('new');
  });

  it('does nothing without an active provider', () => {
    // An env-configured single endpoint keeps GEMINI_OPENAI_MODELID as its
    // persistent source; there is no provider entry to write.
    writeProviders([{ id: 'openrouter', baseUrl: 'https://openrouter.ai/v1' }]);

    rememberModelForProvider(undefined, 'some-model');

    expect(readProviders()[0].modelId).toBeUndefined();
  });

  it('does nothing for a blank model id', () => {
    writeProviders([{ id: 'openrouter', baseUrl: 'https://openrouter.ai/v1' }]);

    rememberModelForProvider('openrouter', '   ');

    expect(readProviders()[0].modelId).toBeUndefined();
  });

  it('does not throw when the provider file cannot be written', () => {
    // No file at all: the session must keep working.
    expect(() =>
      rememberModelForProvider('openrouter', 'some-model'),
    ).not.toThrow();
  });
});
