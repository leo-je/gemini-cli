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
import {
  persistProviderId,
  providerHasDefaultModel,
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
   * Reports a completed switch, and asks for a model when the provider has no
   * default one.
   *
   * A provider may leave `modelId` unset, which is supported by design — the
   * session is meant to pick from the endpoint's catalog. Nothing did the
   * picking, though, so the next message failed. Opening the list here closes
   * that gap; the endpoint is passed so the dialog lists this provider's models
   * rather than the compiled-in Gemini ones.
   */
  const reportSwitch = useCallback(
    (providerId: string, suffix = '') => {
      if (providerHasDefaultModel(providerId)) {
        historyManager.addItem({
          type: MessageType.INFO,
          text: `Switched to provider ${providerId}.${suffix} Run /model list to pick a model, or /provider to switch again.`,
        });
        return;
      }
      historyManager.addItem({
        type: MessageType.INFO,
        text: `Switched to provider ${providerId}.${suffix} It has no default model, so pick one from the list below.`,
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
