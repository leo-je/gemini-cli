/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  CommandKind,
  type SlashCommand,
} from './types.js';
import { MessageType } from '../types.js';
import { isOpenAiBackend } from '../openai/index.js';
import { providerDialogAction } from '../openai/providerDialogRouting.js';
import { persistProviderId } from '../openai/openAiProviderPreference.js';

const listProvidersCommand: SlashCommand = {
  name: 'list',
  description: 'List the configured OpenAI-compatible providers',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context: CommandContext) => {
    const config = context.services.agentContext?.config;
    if (!config) return undefined;

    if (!isOpenAiBackend(config)) {
      context.ui.addItem({
        type: MessageType.INFO,
        text: '/provider is only available in OpenAI-compatible mode. Set GEMINI_API_TYPE=openai.',
      });
      return undefined;
    }

    return providerDialogAction('provider');
  },
};

const useProviderCommand: SlashCommand = {
  name: 'use',
  description:
    'Switch to a configured provider. Usage: /provider use <provider-id>',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context: CommandContext, args: string) => {
    const config = context.services.agentContext?.config;
    if (!config) return undefined;

    const id = args.trim();
    if (!id) {
      context.ui.addItem({
        type: MessageType.ERROR,
        text: 'Usage: /provider use <provider-id>',
      });
      return undefined;
    }

    if (!isOpenAiBackend(config)) {
      context.ui.addItem({
        type: MessageType.INFO,
        text: '/provider is only available in OpenAI-compatible mode. Set GEMINI_API_TYPE=openai.',
      });
      return undefined;
    }

    // Switching rebuilds the content generator; opening the picker instead is
    // the discoverable path, so this is the scriptable one.
    await config.switchOpenAiProvider(id);
    // Fork-owned: record the choice so the next start uses it too. Without this
    // the selection only lived in memory and every restart fell back to the
    // provider file's first entry.
    persistProviderId(context.services.settings, id);

    // Always open the picker: a provider with no saved model list is fetched
    // into one, and a provider that has one still needs its per-model token
    // settings collected before the session can size its context window.
    context.ui.addItem({
      type: MessageType.INFO,
      text: `Provider switched to ${id}. Pick a model and its token settings below.`,
    });
    return {
      type: 'dialog',
      dialog: 'model',
      props: {
        openAiEndpoint: config.getContentGeneratorConfig()?.baseUrl,
      },
    };
  },
};

const addProviderCommand: SlashCommand = {
  name: 'add',
  description: 'Add a new OpenAI-compatible provider',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context: CommandContext) => {
    const config = context.services.agentContext?.config;
    if (!config) return undefined;

    if (!isOpenAiBackend(config)) {
      context.ui.addItem({
        type: MessageType.INFO,
        text: '/provider is only available in OpenAI-compatible mode. Set GEMINI_API_TYPE=openai.',
      });
      return undefined;
    }

    return providerDialogAction('addProvider');
  },
};

export const providerCommand: SlashCommand = {
  name: 'provider',
  description: 'Manage OpenAI-compatible providers',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [listProvidersCommand, useProviderCommand, addProviderCommand],
  action: async (context: CommandContext, args: string) =>
    listProvidersCommand.action!(context, args),
};
