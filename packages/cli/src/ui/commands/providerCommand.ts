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
import {
  persistProviderId,
  providerHasDefaultModel,
} from '../openai/openAiProviderPreference.js';

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

    // A provider with no default model cannot send a message until one is
    // chosen, so ask for it here rather than leaving a session that fails on the
    // next prompt. The dialog action is the one `/model list` uses.
    if (!providerHasDefaultModel(id)) {
      context.ui.addItem({
        type: MessageType.INFO,
        text: `Provider switched to ${id}. It has no default model, so pick one from the list.`,
      });
      return {
        type: 'dialog',
        dialog: 'model',
        props: {
          openAiEndpoint: config.getContentGeneratorConfig()?.baseUrl,
        },
      };
    }

    context.ui.addItem({
      type: MessageType.INFO,
      text: `Provider switched to ${id}.`,
    });
    return undefined;
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
