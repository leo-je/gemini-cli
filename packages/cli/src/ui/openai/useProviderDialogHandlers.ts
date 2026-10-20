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
import { getProviderModels, type Config } from '@google/gemini-cli-core';
import { addOpenAiProvider } from './addProvider.js';
import {
  persistProviderId,
  type ProviderPreferenceWriter,
} from './openAiProviderPreference.js';
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
  /** Where the chosen provider is recorded, so it survives a restart. */
  settings: ProviderPreferenceWriter;
  /**
   * Opens the endpoint's model list. Used right after a switch to a provider
   * that declares no default model, because such a session cannot send a
   * message until one is chosen.
   */
  openModelDialog: (openAiEndpoint?: string) => void;
  closeProviderDialog: () => void;
  closeAddProviderDialog: () => void;
}): ProviderDialogHandlers {
  const {
    config,
    historyManager,
    settings,
    openModelDialog,
    closeProviderDialog,
    closeAddProviderDialog,
  } = options;

  /**
   * Reports a completed switch and opens the provider's model picker.
   *
   * The picker is always opened, even when the provider declares a default
   * model: switching also picks which model the session runs and records its
   * token settings, and a saved model list means the dialog can show it
   * immediately instead of fetching. An empty list is fetched by the dialog
   * itself, so an endpoint with no saved catalog still works.
   */
  const reportSwitch = useCallback(
    (providerId: string, suffix = '') => {
      const savedModels = getProviderModels(providerId).length;
      const next =
        savedModels > 0
          ? 'Pick a model and its token settings below.'
          : 'Its model list is being fetched; pick a model and its token settings below.';
      historyManager.addItem({
        type: MessageType.INFO,
        text: `Switched to provider ${providerId}.${suffix} ${next}`,
      });
      openModelDialog(config.getContentGeneratorConfig()?.baseUrl);
    },
    [config, historyManager, openModelDialog],
  );

  const handleProviderSelect = useCallback(
    async (providerId: string) => {
      closeProviderDialog();
      try {
        await config.switchOpenAiProvider(providerId);
        // Persisted only after the switch succeeded, so a rejected provider is
        // never the one the next session starts on.
        persistProviderId(settings, providerId);
        reportSwitch(providerId);
      } catch (e) {
        historyManager.addItem({
          type: MessageType.ERROR,
          text: `Could not switch provider: ${
            e instanceof Error ? e.message : String(e)
          }`,
        });
      }
    },
    [config, settings, closeProviderDialog, historyManager, reportSwitch],
  );

  const handleAddProviderSubmit = useCallback(
    async (values: NewProviderValues) => {
      closeAddProviderDialog();
      try {
        const saved = addOpenAiProvider(values);
        // Switch straight away: saving an endpoint the session does not use
        // leaves the user unsure whether it worked.
        await config.switchOpenAiProvider(values.id);
        persistProviderId(settings, values.id);
        const keyNote = saved.apiKeyEnv
          ? ` Its API key was stored in ${saved.envPath} as ${saved.apiKeyEnv}.`
          : '';
        // The add form lets the default model be left blank, so the same
        // follow-up applies as for an existing provider.
        reportSwitch(values.id, keyNote);
      } catch (e) {
        historyManager.addItem({
          type: MessageType.ERROR,
          text: `Could not add provider: ${
            e instanceof Error ? e.message : String(e)
          }`,
        });
      }
    },
    [config, settings, closeAddProviderDialog, historyManager, reportSwitch],
  );

  return { handleProviderSelect, handleAddProviderSubmit };
}
