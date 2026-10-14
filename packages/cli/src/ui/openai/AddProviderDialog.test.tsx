/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { renderWithProviders } from '../../test-utils/render.js';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { AddProviderDialog } from './AddProviderDialog.js';
import { useTextBuffer } from '../components/shared/text-buffer.js';
import { TextInput } from '../components/shared/TextInput.js';

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
// reduced to the two callbacks the dialog hands it.
vi.mock('../components/shared/TextInput.js', () => ({
  TextInput: vi.fn(() => null),
}));

const mockedTextInput = TextInput as Mock;
const mockedUseTextBuffer = useTextBuffer as Mock;

describe('AddProviderDialog', () => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseTextBuffer.mockReturnValue({});
  });

  /** The submit handler the dialog passed to the currently rendered input. */
  function currentOnSubmit(): (value: string) => void {
    const props = mockedTextInput.mock.calls.at(-1)?.[0] as {
      onSubmit: (value: string) => void;
    };
    return props.onSubmit;
  }

  async function renderDialog(): Promise<void> {
    await renderWithProviders(
      <AddProviderDialog onSubmit={onSubmit} onCancel={onCancel} />,
    );
  }

  async function answer(value: string): Promise<void> {
    await act(async () => {
      currentOnSubmit()(value);
    });
  }

  it('renders an input for the first step', async () => {
    await renderDialog();

    const props = mockedTextInput.mock.calls.at(-1)?.[0] as {
      placeholder: string;
    };
    expect(mockedTextInput).toHaveBeenCalled();
    expect(props.placeholder).toBe('openrouter');
  });

  it('collects all four answers and submits them', async () => {
    await renderDialog();

    await answer('openrouter');
    await answer('https://openrouter.ai/api/v1');
    await answer('gpt-4o');
    await answer('sk-secret');

    expect(onSubmit).toHaveBeenCalledWith({
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'gpt-4o',
      apiKey: 'sk-secret',
    });
  });

  it('allows the two optional steps to be skipped', async () => {
    await renderDialog();

    await answer('ollama');
    await answer('http://localhost:11434/v1');
    await answer('');
    await answer('');

    expect(onSubmit).toHaveBeenCalledWith({
      id: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
    });
  });

  it('does not advance past an empty required step', async () => {
    await renderDialog();

    await answer('');
    expect(onSubmit).not.toHaveBeenCalled();
    // Still on the first step, so a valid id can be entered.
    expect(
      (mockedTextInput.mock.calls.at(-1)?.[0] as { placeholder: string })
        .placeholder,
    ).toBe('openrouter');

    await answer('ok');
    await answer('https://x/v1');
    await answer('');
    await answer('');

    expect(onSubmit).toHaveBeenCalledWith({
      id: 'ok',
      baseUrl: 'https://x/v1',
    });
  });

  it('reports cancellation through onCancel', async () => {
    await renderDialog();

    await act(async () => {
      (
        mockedTextInput.mock.calls.at(-1)?.[0] as { onCancel: () => void }
      ).onCancel();
    });

    expect(onCancel).toHaveBeenCalled();
  });
});
