/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The provider dialog handlers, kept out of `AppContainer.tsx`.
 *
 * `AppContainer` is one of the most frequently rewritten upstream files, so the
 * fork contributes only a single `useProviderDialogHandlers(...)` call there
 * instead of two inline `useCallback` blocks.
 */

import { useCallback } from 'react';
import { MessageType } from '../types.js';
import type { Config } from '@google/gemini-cli-core';
import { addOpenAiProvider } from './addProvider.js';
import type { NewProviderValues } from './AddProviderDialog.js';

/** The slice of the history manager these handlers report through. */
export interface HistoryReporter {
  addItem: (item: { type: MessageType; text: string }) => void;
}

export interface ProviderDialogHandlers {
  handleProviderSelect: (providerId: string) => Promise<void>;
  handleAddProviderSubmit: (values: NewProviderValues) => Promise<void>;
}

export function useProviderDialogHandlers(options: {
  config: Config;
  historyManager: HistoryReporter;
  closeProviderDialog: () => void;
  closeAddProviderDialog: () => void;
}): ProviderDialogHandlers {
  const {
    config,
    historyManager,
    closeProviderDialog,
    closeAddProviderDialog,
  } = options;

  const handleProviderSelect = useCallback(
    async (providerId: string) => {
      closeProviderDialog();
      try {
        await config.switchOpenAiProvider(providerId);
        historyManager.addItem({
          type: MessageType.INFO,
          text: `Switched to provider ${providerId}. Run /model list to pick a model, or /provider to switch again.`,
        });
      } catch (e) {
        historyManager.addItem({
          type: MessageType.ERROR,
          text: `Could not switch provider: ${
            e instanceof Error ? e.message : String(e)
          }`,
        });
      }
    },
    [config, closeProviderDialog, historyManager],
  );

  const handleAddProviderSubmit = useCallback(
    async (values: NewProviderValues) => {
      closeAddProviderDialog();
      try {
        const saved = addOpenAiProvider(values);
        // Switch straight away: saving an endpoint the session does not use
        // leaves the user unsure whether it worked.
        await config.switchOpenAiProvider(values.id);
        const keyNote = saved.apiKeyEnv
          ? ` Its API key was stored in ${saved.envPath} as ${saved.apiKeyEnv}.`
          : '';
        historyManager.addItem({
          type: MessageType.INFO,
          text: `Added provider ${values.id} and switched to it.${keyNote} Run /model list to pick a model.`,
        });
      } catch (e) {
        historyManager.addItem({
          type: MessageType.ERROR,
          text: `Could not add provider: ${
            e instanceof Error ? e.message : String(e)
          }`,
        });
      }
    },
    [config, closeAddProviderDialog, historyManager],
  );

  return { handleProviderSelect, handleAddProviderSubmit };
}
