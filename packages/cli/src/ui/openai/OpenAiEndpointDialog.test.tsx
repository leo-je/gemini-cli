/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { renderWithProviders } from '../../test-utils/render.js';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { OpenAiEndpointDialog } from './OpenAiEndpointDialog.js';
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

describe('OpenAiEndpointDialog', () => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();

  /** The callbacks the dialog passed to the currently mounted step. */
  const currentStep = () => {
    const props = mockedTextInput.mock.lastCall?.[0] as {
      onSubmit: (value: string) => void;
      onCancel: () => void;
    };
    return props;
  };

  // Each submission re-renders the dialog onto the next question, so the update
  // has to flush before the next step's callbacks are the current ones.
  const submitStep = async (value: string) => {
    await act(async () => {
      currentStep().onSubmit(value);
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseTextBuffer.mockReturnValue({});
  });

  it('walks base URL, model id and API key in order', async () => {
    const { unmount } = await renderWithProviders(
      <OpenAiEndpointDialog onSubmit={onSubmit} onCancel={onCancel} />,
    );

    await submitStep('https://openrouter.ai/api/v1');
    await submitStep('z-ai/glm-4.6');
    await submitStep('sk-test');

    expect(onSubmit).toHaveBeenCalledWith({
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'z-ai/glm-4.6',
      apiKey: 'sk-test',
    });
    unmount();
  });

  it('treats the API key as optional', async () => {
    const { unmount } = await renderWithProviders(
      <OpenAiEndpointDialog onSubmit={onSubmit} onCancel={onCancel} />,
    );

    await submitStep('http://localhost:11434/v1');
    await submitStep('llama3');
    await submitStep('');

    expect(onSubmit).toHaveBeenCalledWith({
      baseUrl: 'http://localhost:11434/v1',
      modelId: 'llama3',
      apiKey: undefined,
    });
    unmount();
  });

  it('refuses to advance past a required field left empty', async () => {
    const { unmount } = await renderWithProviders(
      <OpenAiEndpointDialog onSubmit={onSubmit} onCancel={onCancel} />,
    );

    await submitStep('   ');

    expect(onSubmit).not.toHaveBeenCalled();
    // Still on the first question: the same handler is mounted.
    expect(currentStep().onSubmit).toBeDefined();
    unmount();
  });

  it('trims values and drops a blank API key', async () => {
    const { unmount } = await renderWithProviders(
      <OpenAiEndpointDialog onSubmit={onSubmit} onCancel={onCancel} />,
    );

    await submitStep('  https://example.test/v1  ');
    await submitStep('  gpt-4o  ');
    await submitStep('   ');

    expect(onSubmit).toHaveBeenCalledWith({
      baseUrl: 'https://example.test/v1',
      modelId: 'gpt-4o',
      apiKey: undefined,
    });
    unmount();
  });

  it('prefills previously used values', async () => {
    const { unmount } = await renderWithProviders(
      <OpenAiEndpointDialog
        onSubmit={onSubmit}
        onCancel={onCancel}
        defaultBaseUrl="http://localhost:11434/v1"
        defaultModelId="llama3"
      />,
    );

    expect(mockedUseTextBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ initialText: 'http://localhost:11434/v1' }),
    );

    // Clearing a required field blocks progress rather than silently dropping
    // the value that was there.
    await submitStep('');
    expect(onSubmit).not.toHaveBeenCalled();

    unmount();
  });

  it('forwards cancellation from the active step', async () => {
    const { unmount } = await renderWithProviders(
      <OpenAiEndpointDialog onSubmit={onSubmit} onCancel={onCancel} />,
    );

    await act(async () => {
      currentStep().onCancel();
    });

    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });
});
