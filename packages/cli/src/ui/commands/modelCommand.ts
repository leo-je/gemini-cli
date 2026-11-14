/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_GEMINI_MODEL_AUTO,
  DEFAULT_MODEL_CONFIGS,
  GEMINI_MODEL_ALIAS_AUTO,
  GEMINI_MODEL_ALIAS_FLASH,
  GEMINI_MODEL_ALIAS_FLASH_LITE,
  GEMINI_MODEL_ALIAS_PRO,
  ModelSlashCommandEvent,
  PREVIEW_GEMINI_MODEL_AUTO,
  VALID_GEMINI_MODELS,
  logModelSlashCommand,
} from '@google/gemini-cli-core';
import {
  type CommandContext,
  CommandKind,
  type SlashCommand,
} from './types.js';
import { MessageType } from '../types.js';
import { isOpenAiBackend } from '../openai/index.js';

function getValidModelNames(context: CommandContext): Set<string> {
  const validModels = new Set<string>([
    ...Array.from(VALID_GEMINI_MODELS).filter((model) => model !== 'none'),
    ...Object.keys(DEFAULT_MODEL_CONFIGS.modelDefinitions ?? {}),
    GEMINI_MODEL_ALIAS_AUTO,
    GEMINI_MODEL_ALIAS_PRO,
    GEMINI_MODEL_ALIAS_FLASH,
    GEMINI_MODEL_ALIAS_FLASH_LITE,
    PREVIEW_GEMINI_MODEL_AUTO,
    DEFAULT_GEMINI_MODEL_AUTO,
  ]);

  const config = context.services.agentContext?.config;
  const serviceDefinitions = config
    ?.getModelConfigService?.()
    ?.getModelDefinitions?.();
  if (serviceDefinitions) {
    for (const model of Object.keys(serviceDefinitions)) {
      validModels.add(model);
    }
  }

  const modelConfigs = context.services.settings?.merged?.modelConfigs;
  if (modelConfigs?.customAliases) {
    for (const alias of Object.keys(modelConfigs.customAliases)) {
      validModels.add(alias);
    }
  }
  if (modelConfigs?.modelDefinitions) {
    for (const model of Object.keys(modelConfigs.modelDefinitions)) {
      validModels.add(model);
    }
  }

  return validModels;
}

const setModelCommand: SlashCommand = {
  name: 'set',
  description:
    'Set the model to use. Usage: /model set <model-name> [--persist]',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context: CommandContext, args: string) => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const persist = parts.includes('--persist');
    const nonFlagParts = parts.filter((part) => part !== '--persist');

    if (nonFlagParts.length === 0) {
      context.ui.addItem({
        type: MessageType.ERROR,
        text: 'Usage: /model set <model-name> [--persist]',
      });
      return;
    }

    const modelName = nonFlagParts[0];
    // The allowlist is Gemini-shaped: built-in Gemini models, the configured
    // aliases and the settings-declared definitions. An OpenAI-compatible
    // endpoint serves models this CLI cannot enumerate, so validating against
    // it would reject every endpoint-served name (`gpt-4o`, for instance) that
    // `/model list` and `/provider` are meant to install. Keep the validation
    // on the Gemini paths, which is where upstream added it.
    const config = context.services.agentContext?.config;
    if (
      !isOpenAiBackend(config) &&
      !getValidModelNames(context).has(modelName)
    ) {
      context.ui.addItem({
        type: MessageType.ERROR,
        text: `Invalid model "${modelName}". Run /model to view and select from available models.`,
      });
      return;
    }

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
  completion: async (context: CommandContext, partialArg: string) => {
    // Same reason as the action: the Gemini allowlist cannot name what an
    // OpenAI-compatible endpoint serves, so offering it there would complete to
    // names the endpoint does not have. `/model list` owns that flow.
    const config = context.services.agentContext?.config;
    if (isOpenAiBackend(config)) {
      return [];
    }
    const validModels = Array.from(getValidModelNames(context));
    return validModels.filter((model) => model.startsWith(partialArg));
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
  action: async (context: CommandContext, args: string) => {
    if (args.trim().length > 0) {
      return setModelCommand.action?.(context, args);
    }
    return manageModelCommand.action?.(context, args);
  },
};
