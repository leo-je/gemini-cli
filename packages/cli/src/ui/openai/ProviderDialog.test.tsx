/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderWithProviders } from '../../test-utils/render.js';
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import type { Config } from '@google/gemini-cli-core';
import { ProviderDialog } from './ProviderDialog.js';
import { useTextBuffer } from '../components/shared/text-buffer.js';
import { TextInput } from '../components/shared/TextInput.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { createMockConfig } from '../../test-utils/mockConfig.js';

// `renderWithProviders` insists on a fully built Config; this dialog only needs
// two methods, so the context hook is stubbed instead.
vi.mock('../contexts/ConfigContext.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../contexts/ConfigContext.js')>();
  return { ...actual, useConfig: vi.fn() };
});

vi.mock('../contexts/SettingsContext.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../contexts/SettingsContext.js')>();
  return { ...actual, useSettings: vi.fn() };
});

vi.mock('../components/shared/text-buffer.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../components/shared/text-buffer.js')
    >();
  return { ...actual, useTextBuffer: vi.fn(() => ({})) };
});

vi.mock('../contexts/UIStateContext.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../contexts/UIStateContext.js')>();
  return { ...actual, useUIState: vi.fn(() => ({ terminalWidth: 80 })) };
});

// The dialog's job is the step machine, not the text box, so the input is
// reduced to the callback the dialog hands it.
vi.mock('../components/shared/TextInput.js', () => ({
  TextInput: vi.fn(() => null),
}));

const mockedUseConfig = useConfig as Mock;
const mockedUseSettings = useSettings as Mock;
const mockedTextInput = TextInput as Mock;
const mockedUseTextBuffer = useTextBuffer as Mock;

describe('ProviderDialog', () => {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const setValue = vi.fn();
  const switchOpenAiProvider = vi.fn(async () => undefined);
  let fakeHome: string;
  let providerPath: string;

  const config = createMockConfig({
    getActiveOpenAiProviderId: () => 'current',
    switchOpenAiProvider:
      switchOpenAiProvider as unknown as Config['switchOpenAiProvider'],
  } as unknown as Partial<Config>);

  function seedProviders(
    providers: Array<Record<string, unknown>> = [
      {
        id: 'current',
        label: 'Current',
        baseUrl: 'https://current.test/v1',
        modelId: 'm1',
        models: [{ modelId: 'm1', contextWindowSize: 131072 }],
      },
      { id: 'other', label: 'Other', baseUrl: 'https://other.test/v1' },
    ],
  ): void {
    fs.writeFileSync(providerPath, JSON.stringify({ providers }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  function readProviderDocument(): {
    providers: Array<Record<string, unknown>>;
  } {
    return JSON.parse(fs.readFileSync(providerPath, 'utf8')) as {
      providers: Array<Record<string, unknown>>;
    };
  }

  function currentInput(): { onSubmit: (value: string) => void } {
    return mockedTextInput.mock.calls.at(-1)?.[0] as {
      onSubmit: (value: string) => void;
    };
  }

  async function renderDialog() {
    return renderWithProviders(
      <ProviderDialog onClose={onClose} onSelect={onSelect} />,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseConfig.mockReturnValue(config);
    mockedUseSettings.mockReturnValue({ setValue });
    mockedUseTextBuffer.mockReturnValue({});
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-dialog-'));
    vi.stubEnv('HOME', fakeHome);
    providerPath = path.join(fakeHome, '.gemini', 'openai-providers.json');
    fs.mkdirSync(path.dirname(providerPath), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }, 15000);

  it('shows the management actions after a provider is picked', async () => {
    seedProviders();

    const { lastFrame, stdin, waitUntilReady, unmount } = await renderDialog();
    await waitUntilReady();
    expect(lastFrame()).toContain('Current');

    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    expect(lastFrame()).toContain('Use this provider');
    expect(lastFrame()).toContain('Edit provider');
    expect(lastFrame()).toContain('Delete provider');
    expect(onSelect).not.toHaveBeenCalled();
    unmount();
  }, 15000);

  it('edits the name and URL without touching the rest of the profile', async () => {
    seedProviders();

    const { lastFrame, stdin, waitUntilReady, unmount } = await renderDialog();
    await waitUntilReady();

    // Pick the first provider, then "Edit provider".
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\u001b[B');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('Provider name');

    // Label
    await act(async () => {
      currentInput().onSubmit('Renamed');
    });
    await waitUntilReady();
    // Base URL
    await act(async () => {
      currentInput().onSubmit('https://current.test/v2');
    });
    await waitUntilReady();
    // API key: empty keeps the configured credential.
    await act(async () => {
      currentInput().onSubmit('');
    });
    await waitUntilReady();

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Updated "current"');
    });
    // Editing the active provider re-resolves it so the new base URL is used
    // without a restart.
    expect(switchOpenAiProvider).toHaveBeenCalledWith('current');

    const doc = readProviderDocument();
    expect(doc.providers[0]).toMatchObject({
      id: 'current',
      label: 'Renamed',
      baseUrl: 'https://current.test/v2',
      modelId: 'm1',
      models: [{ modelId: 'm1', contextWindowSize: 131072 }],
    });
    unmount();
  }, 15000);

  it('deletes a provider that is not the active one', async () => {
    seedProviders([
      { id: 'other', label: 'Other', baseUrl: 'https://other.test/v1' },
      {
        id: 'current',
        label: 'Current',
        baseUrl: 'https://current.test/v1',
        modelId: 'm1',
      },
    ]);

    const { lastFrame, stdin, waitUntilReady, unmount } = await renderDialog();
    await waitUntilReady();

    // The cursor starts on the active provider ("current"); move up to "other".
    await act(async () => {
      stdin.write('\u001b[A');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    // Delete is the third action.
    await act(async () => {
      stdin.write('\u001b[B');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\u001b[B');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('Delete provider?');

    // The confirmation lists Delete first.
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Deleted "other"');
    });
    expect(switchOpenAiProvider).not.toHaveBeenCalled();
    expect(readProviderDocument().providers.map((p) => p['id'])).toEqual([
      'current',
    ]);
    unmount();
  }, 15000);

  it('switches to the remaining provider when the active one is deleted', async () => {
    seedProviders();

    const { lastFrame, stdin, waitUntilReady, unmount } = await renderDialog();
    await waitUntilReady();

    // The active provider is first here.
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    // Delete is the third action.
    await act(async () => {
      stdin.write('\u001b[B');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\u001b[B');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('switched to "other"');
    });
    expect(switchOpenAiProvider).toHaveBeenCalledWith('other');
    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'security.auth.openAiProviderId',
      'other',
    );
    unmount();
  }, 15000);

  it('clears the saved provider when the last one is deleted', async () => {
    seedProviders([
      { id: 'current', label: 'Current', baseUrl: 'https://current.test/v1' },
    ]);

    const { lastFrame, stdin, waitUntilReady, unmount } = await renderDialog();
    await waitUntilReady();

    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    // Delete is the third action.
    await act(async () => {
      stdin.write('\u001b[B');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\u001b[B');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('No providers remain');
    });
    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'security.auth.openAiProviderId',
      '',
    );
    expect(readProviderDocument().providers).toEqual([]);
    unmount();
  }, 15000);

  it('keeps the provider when the deletion is cancelled', async () => {
    seedProviders();

    const { stdin, waitUntilReady, unmount } = await renderDialog();
    await waitUntilReady();

    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    // Delete is the third action.
    await act(async () => {
      stdin.write('\u001b[B');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\u001b[B');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    // Cancel is the second confirmation entry.
    await act(async () => {
      stdin.write('\u001b[B');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    expect(readProviderDocument().providers).toHaveLength(2);
    unmount();
  }, 15000);
});
