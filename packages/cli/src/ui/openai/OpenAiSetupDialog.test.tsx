/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { renderWithProviders } from '../../test-utils/render.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Text, useInput } from 'ink';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpenAiSetupDialog } from './OpenAiSetupDialog.js';

// The form has its own test; here it only has to be identifiable and to pass
// Escape through, which is what decides where cancelling leads.
vi.mock('./AddProviderDialog.js', () => ({
  AddProviderDialog: ({ onCancel }: { onCancel: () => void }) => {
    useInput((_input, key) => {
      if (key.escape) {
        onCancel();
      }
    });
    return <Text>AddProviderDialog</Text>;
  },
}));

const onSubmit = vi.fn();
const onPick = vi.fn();
const onCancel = vi.fn();

describe('OpenAiSetupDialog', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-setup-'));
    vi.stubEnv('HOME', home);
    onSubmit.mockReset();
    onPick.mockReset();
    onCancel.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeProviders(
    providers: Array<Record<string, unknown>> = [],
  ): void {
    const dir = path.join(home, '.gemini');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'openai-providers.json'),
      JSON.stringify({ providers }),
      { mode: 0o600 },
    );
  }

  const render = () =>
    renderWithProviders(
      <OpenAiSetupDialog
        onSubmit={onSubmit}
        onPick={onPick}
        onCancel={onCancel}
      />,
    );

  async function press(
    stdin: { write: (data: string) => void },
    sequence: string,
    waitUntilReady: () => Promise<void>,
  ): Promise<void> {
    await act(async () => {
      stdin.write(sequence);
    });
    await waitUntilReady();
  }

  it('lists the providers already configured', async () => {
    writeProviders([
      {
        id: 'alpha',
        label: 'Alpha',
        baseUrl: 'https://alpha/v1',
        modelId: 'a-1',
      },
      { id: 'beta', label: 'Beta', baseUrl: 'https://beta/v1' },
    ]);

    const { lastFrame, unmount } = await render();

    expect(lastFrame()).toContain('Alpha');
    expect(lastFrame()).toContain('(a-1)');
    expect(lastFrame()).toContain('Beta');
    expect(lastFrame()).toContain('(no model yet)');
    expect(lastFrame()).toContain('https://beta/v1');
    expect(lastFrame()).toContain('Add a new provider');
    expect(lastFrame()).not.toContain('AddProviderDialog');
    unmount();
  });

  it('reports the provider the user chose', async () => {
    writeProviders([
      { id: 'alpha', baseUrl: 'https://alpha/v1' },
      { id: 'beta', baseUrl: 'https://beta/v1' },
    ]);

    const { stdin, waitUntilReady, unmount } = await render();
    await press(stdin, '\u001B[B', waitUntilReady); // Down arrow
    await press(stdin, '\r', waitUntilReady); // Enter

    expect(onPick).toHaveBeenCalledWith('beta');
    unmount();
  });

  it('opens the form when nothing is configured yet', async () => {
    const { lastFrame, unmount } = await render();

    expect(lastFrame()).toContain('AddProviderDialog');
    expect(lastFrame()).not.toContain('Add a new provider');
    unmount();
  });

  it('opens the form from the list, and Escape returns to the list', async () => {
    writeProviders([{ id: 'alpha', baseUrl: 'https://alpha/v1' }]);

    const { lastFrame, stdin, waitUntilReady, unmount } = await render();
    expect(lastFrame()).toContain('Add a new provider');

    // The only provider is first, so one step down reaches the form itself.
    await press(stdin, '\u001B[B', waitUntilReady);
    await press(stdin, '\r', waitUntilReady);
    expect(lastFrame()).toContain('AddProviderDialog');

    await press(stdin, '\u001B', waitUntilReady); // Esc
    expect(lastFrame()).toContain('Add a new provider');
    // The user had choices to go back to, so cancelling did not leave the flow.
    expect(onCancel).not.toHaveBeenCalled();
    unmount();
  });

  it('leaves the flow when the form is the only thing shown', async () => {
    const { lastFrame, stdin, waitUntilReady, unmount } = await render();
    expect(lastFrame()).toContain('AddProviderDialog');

    await press(stdin, '\u001B', waitUntilReady); // Esc

    expect(onCancel).toHaveBeenCalled();
    unmount();
  });
});
