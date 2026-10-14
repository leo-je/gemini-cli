/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ModelSlashCommandEvent,
  logModelSlashCommand,
} from '@google/gemini-cli-core';
import {
  type CommandContext,
  CommandKind,
  type SlashCommand,
} from './types.js';
import { MessageType } from '../types.js';
import { isOpenAiBackend } from '../openai/index.js';

const setModelCommand: SlashCommand = {
  name: 'set',
  description:
    'Set the model to use. Usage: /model set <model-name> [--persist]',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context: CommandContext, args: string) => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      context.ui.addItem({
        type: MessageType.ERROR,
        text: 'Usage: /model set <model-name> [--persist]',
      });
      return;
    }

    const modelName = parts[0];
    const persist = parts.includes('--persist');

    if (context.services.agentContext?.config) {
      context.services.agentContext.config.setModel(modelName, !persist);
      const event = new ModelSlashCommandEvent(modelName);
      logModelSlashCommand(context.services.agentContext.config, event);

      context.ui.addItem({
        type: MessageType.INFO,
        text: `Model set to ${modelName}${persist ? ' (persisted)' : ''}`,
      });
    }
  },
};

const manageModelCommand: SlashCommand = {
  name: 'manage',
  description: 'Opens a dialog to configure the model',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context: CommandContext) => {
    if (context.services.agentContext?.config) {
      await context.services.agentContext.config.refreshUserQuota();
    }
    return {
      type: 'dialog',
      dialog: 'model',
    };
  },
};

const listModelsCommand: SlashCommand = {
  name: 'list',
  description: 'Choose from the models your OpenAI-compatible endpoint serves',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context: CommandContext) => {
    const config = context.services.agentContext?.config;
    if (!config) return;

    if (!isOpenAiBackend(config)) {
      context.ui.addItem({
        type: MessageType.INFO,
        text: '/model list is only available in OpenAI-compatible mode. Use /model to pick a Gemini model.',
      });
      return;
    }

    // The endpoint always comes from the active content generator rather than
    // from the provider file, so a provider switched this session is reflected
    // here without any extra bookkeeping.
    const baseUrl = config.getContentGeneratorConfig()?.baseUrl;
    if (!baseUrl) {
      context.ui.addItem({
        type: MessageType.ERROR,
        text: 'No OpenAI-compatible endpoint is configured. Set GEMINI_OPENAI_BASE_URL or add a provider with /provider add.',
      });
      return;
    }

    const providerId = config.getActiveOpenAiProviderId();
    if (providerId) {
      context.ui.addItem({
        type: MessageType.INFO,
        text: `Listing models served by provider "${providerId}" (${baseUrl}).`,
      });
    }

    return {
      type: 'dialog',
      dialog: 'model',
      props: { openAiEndpoint: baseUrl },
    };
  },
};

export const modelCommand: SlashCommand = {
  name: 'model',
  description: 'Manage model configuration',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [manageModelCommand, listModelsCommand, setModelCommand],
  action: async (context: CommandContext, args: string) =>
    manageModelCommand.action!(context, args),
};
