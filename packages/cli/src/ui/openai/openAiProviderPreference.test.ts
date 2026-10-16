/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { SettingScope } from '../../config/settings.js';
import {
  OPENAI_PROVIDER_SETTING_KEY,
  persistProviderId,
  readPersistedProviderId,
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
