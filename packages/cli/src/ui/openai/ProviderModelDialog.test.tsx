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
import { ProviderModelDialog } from './ProviderModelDialog.js';
import { useTextBuffer } from '../components/shared/text-buffer.js';
import { TextInput } from '../components/shared/TextInput.js';
import { fetchRemoteModels } from './openAiModelList.js';
import { rememberModelForProvider } from './openAiProviderPreference.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { createMockConfig } from '../../test-utils/mockConfig.js';

vi.mock('./openAiModelList.js', () => ({ fetchRemoteModels: vi.fn() }));

// `renderWithProviders` insists on a fully built Config; this dialog only needs
// two methods, so the context hook is stubbed instead.
vi.mock('../contexts/ConfigContext.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../contexts/ConfigContext.js')>();
  return { ...actual, useConfig: vi.fn() };
});

vi.mock('./openAiProviderPreference.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./openAiProviderPreference.js')>();
  return { ...actual, rememberModelForProvider: vi.fn() };
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

const mockedFetchRemoteModels = fetchRemoteModels as Mock;
const mockedUseConfig = useConfig as Mock;
const mockedTextInput = TextInput as Mock;
const mockedUseTextBuffer = useTextBuffer as Mock;
const mockedRememberModel = rememberModelForProvider as Mock;

const PROVIDER_ID = 'openrouter';
const ENDPOINT = 'https://openrouter.ai/api/v1';

describe('ProviderModelDialog', () => {
  const onClose = vi.fn();
  const setModel = vi.fn();
  let fakeHome: string;
  let providerPath: string;

  const config = createMockConfig({
    setModel: setModel as unknown as Config['setModel'],
    getModel: () => 'saved-model',
  });

  function seedProvider(models?: unknown[]): void {
    fs.writeFileSync(
      providerPath,
      JSON.stringify(
        {
          providers: [
            {
              id: PROVIDER_ID,
              baseUrl: ENDPOINT,
              ...(models ? { models } : {}),
            },
          ],
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  function readProviderDocument(): {
    providers: Array<{ models?: Array<Record<string, unknown>> }>;
  } {
    return JSON.parse(fs.readFileSync(providerPath, 'utf8')) as {
      providers: Array<{ models?: Array<Record<string, unknown>> }>;
    };
  }

  function currentInput(): { onSubmit: (value: string) => void } {
    return mockedTextInput.mock.calls.at(-1)?.[0] as {
      onSubmit: (value: string) => void;
    };
  }

  async function renderDialog() {
    return renderWithProviders(
      <ProviderModelDialog
        providerId={PROVIDER_ID}
        endpoint={ENDPOINT}
        onClose={onClose}
      />,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseConfig.mockReturnValue(config);
    mockedUseTextBuffer.mockReturnValue({});
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-model-dialog-'));
    vi.stubEnv('HOME', fakeHome);
    providerPath = path.join(fakeHome, '.gemini', 'openai-providers.json');
    fs.mkdirSync(path.dirname(providerPath), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('fetches the catalog when the provider has no saved models', async () => {
    seedProvider();
    mockedFetchRemoteModels.mockResolvedValue({
      models: [{ modelId: 'm1' }, { modelId: 'm2' }],
      endpoint: ENDPOINT,
    });

    const { lastFrame, waitUntilReady, unmount } = await renderDialog();
    await waitUntilReady();

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('m1');
    });
    expect(mockedFetchRemoteModels).toHaveBeenCalled();
    // The fetched catalog is merged into the provider file, so the next
    // session does not have to ask the endpoint again.
    expect(readProviderDocument().providers[0].models).toEqual([
      { modelId: 'm1' },
      { modelId: 'm2' },
    ]);
    unmount();
  });

  it('shows the number the endpoint reports without replacing the saved one', async () => {
    seedProvider([{ modelId: 'm1', contextWindowSize: 131_072 }]);
    mockedFetchRemoteModels.mockResolvedValue({
      models: [{ modelId: 'm1', contextWindowSize: 262_144 }],
      endpoint: ENDPOINT,
    });

    const { lastFrame, stdin, waitUntilReady, unmount } = await renderDialog();
    await waitUntilReady();

    // "Fetch model list" is the second source option.
    await act(async () => {
      stdin.write('\u001b[B');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });

    await vi.waitFor(() => expect(lastFrame()).toContain('262,144'));
    // Both numbers are visible, and the saved one is what stays in the file.
    expect(lastFrame()).toContain('131,072');
    expect(readProviderDocument().providers[0].models).toEqual([
      { modelId: 'm1', contextWindowSize: 131_072 },
    ]);
    unmount();
  });

  it('offers the saved catalog before touching the endpoint', async () => {
    seedProvider([{ modelId: 'saved-model' }, { modelId: 'other-model' }]);

    const { lastFrame, waitUntilReady, unmount } = await renderDialog();
    await waitUntilReady();

    expect(lastFrame()).toContain('Current model list (2)');
    expect(lastFrame()).toContain('Fetch model list');
    expect(mockedFetchRemoteModels).not.toHaveBeenCalled();
    unmount();
  });

  it('saves the token settings chosen for the picked model', async () => {
    seedProvider([{ modelId: 'saved-model' }]);

    const { lastFrame, stdin, waitUntilReady, unmount } = await renderDialog();
    await waitUntilReady();

    // "Current model list"
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('saved-model');

    // The model itself, then "Edit token settings" on the action menu.
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('Edit token settings');
    await act(async () => {
      stdin.write('\u001b[B');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('Context window size');

    await act(async () => {
      currentInput().onSubmit('128k');
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('Maximum output tokens');

    await act(async () => {
      currentInput().onSubmit('8k');
    });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(readProviderDocument().providers[0].models).toEqual([
      { modelId: 'saved-model', contextWindowSize: 131_072, maxToken: 8_192 },
    ]);
    // The pick is recorded even though the token settings are optional, and the
    // session switches to it with the settings just saved.
    expect(mockedRememberModel).toHaveBeenCalledWith(
      PROVIDER_ID,
      'saved-model',
    );
    expect(setModel).toHaveBeenCalledWith('saved-model', true);
    unmount();
  });

  it('rejects a malformed token count instead of saving it', async () => {
    seedProvider([{ modelId: 'saved-model' }]);

    const { lastFrame, stdin, waitUntilReady, unmount } = await renderDialog();
    await waitUntilReady();

    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    // Move to "Edit token settings" and open it.
    await act(async () => {
      stdin.write('\u001b[B');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    await act(async () => {
      currentInput().onSubmit('12x');
    });
    await waitUntilReady();

    expect(lastFrame()).toContain('128k or 131072');
    expect(readProviderDocument().providers[0].models).toEqual([
      { modelId: 'saved-model' },
    ]);
    unmount();
  });

  it('keeps the saved token settings when the optional steps are skipped', async () => {
    seedProvider([
      { modelId: 'saved-model', contextWindowSize: 131_072, maxToken: 8_192 },
    ]);

    const { lastFrame, stdin, waitUntilReady, unmount } = await renderDialog();
    await waitUntilReady();

    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('saved-model');
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    // "Edit token settings" is the second action.
    await act(async () => {
      stdin.write('\u001b[B');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    await act(async () => {
      currentInput().onSubmit('');
    });
    await waitUntilReady();
    await act(async () => {
      currentInput().onSubmit('');
    });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(readProviderDocument().providers[0].models).toEqual([
      { modelId: 'saved-model', contextWindowSize: 131_072, maxToken: 8_192 },
    ]);
    unmount();
  });

  it('applies the pick without opening the token settings', async () => {
    seedProvider([{ modelId: 'saved-model' }]);

    const { lastFrame, stdin, waitUntilReady, unmount } = await renderDialog();
    await waitUntilReady();

    // "Current model list"
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    // The model itself.
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('Apply model');

    // The first action applies the model as-is.
    await act(async () => {
      stdin.write('\r');
    });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(setModel).toHaveBeenCalledWith('saved-model', true);
    expect(mockedRememberModel).toHaveBeenCalledWith(
      PROVIDER_ID,
      'saved-model',
    );
    // No settings step ran, so the provider file is unchanged.
    expect(readProviderDocument().providers[0].models).toEqual([
      { modelId: 'saved-model' },
    ]);
    unmount();
  });

  it('reports a failing endpoint instead of showing an empty list', async () => {
    seedProvider();
    mockedFetchRemoteModels.mockRejectedValue(new Error('HTTP 403 forbidden'));

    const { lastFrame, waitUntilReady, unmount } = await renderDialog();
    await waitUntilReady();

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Could not list models');
    });
    expect(lastFrame()).toContain('HTTP 403 forbidden');
    unmount();
  });
});
