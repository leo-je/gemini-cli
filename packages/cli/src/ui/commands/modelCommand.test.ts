/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { modelCommand } from './modelCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { AuthType, type Config } from '@google/gemini-cli-core';
import { MessageType } from '../types.js';

describe('modelCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext();
  });

  it('should return a dialog action to open the model dialog when no args', async () => {
    if (!modelCommand.action) {
      throw new Error('The model command must have an action.');
    }

    const result = await modelCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'model',
    });
  });

  it('should call refreshUserQuota if config is available when opening dialog', async () => {
    if (!modelCommand.action) {
      throw new Error('The model command must have an action.');
    }

    const mockRefreshUserQuota = vi.fn();
    mockContext.services.agentContext = {
      refreshUserQuota: mockRefreshUserQuota,
      get config() {
        return this;
      },
    } as unknown as Config;

    await modelCommand.action(mockContext, '');

    expect(mockRefreshUserQuota).toHaveBeenCalled();
  });

  describe('manage subcommand', () => {
    it('should return a dialog action to open the model dialog', async () => {
      const manageCommand = modelCommand.subCommands?.find(
        (c) => c.name === 'manage',
      );
      expect(manageCommand).toBeDefined();

      const result = await manageCommand!.action!(mockContext, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'model',
      });
    });

    it('should call refreshUserQuota if config is available', async () => {
      const manageCommand = modelCommand.subCommands?.find(
        (c) => c.name === 'manage',
      );
      const mockRefreshUserQuota = vi.fn();
      mockContext.services.agentContext = {
        refreshUserQuota: mockRefreshUserQuota,
        get config() {
          return this;
        },
      } as unknown as Config;

      await manageCommand!.action!(mockContext, '');

      expect(mockRefreshUserQuota).toHaveBeenCalled();
    });
  });

  describe('set subcommand', () => {
    it('should set the model and log the command', async () => {
      const setCommand = modelCommand.subCommands?.find(
        (c) => c.name === 'set',
      );
      expect(setCommand).toBeDefined();

      const mockSetModel = vi.fn();
      mockContext.services.agentContext = {
        setModel: mockSetModel,
        getHasAccessToPreviewModel: vi.fn().mockReturnValue(true),
        getUserId: vi.fn().mockReturnValue('test-user'),
        getUsageStatisticsEnabled: vi.fn().mockReturnValue(true),
        getSessionId: vi.fn().mockReturnValue('test-session'),
        getContentGeneratorConfig: vi
          .fn()
          .mockReturnValue({ authType: 'test-auth' }),
        isInteractive: vi.fn().mockReturnValue(true),
        getExperiments: vi.fn().mockReturnValue({ experimentIds: [] }),
        getPolicyEngine: vi.fn().mockReturnValue({
          getApprovalMode: vi.fn().mockReturnValue('auto'),
        }),
        get config() {
          return this;
        },
      } as unknown as Config;

      await setCommand!.action!(mockContext, 'gemini-pro');

      expect(mockSetModel).toHaveBeenCalledWith('gemini-pro', true);
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('Model set to gemini-pro'),
        }),
      );
    });

    it('should set the model with persistence when --persist is used', async () => {
      const setCommand = modelCommand.subCommands?.find(
        (c) => c.name === 'set',
      );
      const mockSetModel = vi.fn();
      mockContext.services.agentContext = {
        setModel: mockSetModel,
        getHasAccessToPreviewModel: vi.fn().mockReturnValue(true),
        getUserId: vi.fn().mockReturnValue('test-user'),
        getUsageStatisticsEnabled: vi.fn().mockReturnValue(true),
        getSessionId: vi.fn().mockReturnValue('test-session'),
        getContentGeneratorConfig: vi
          .fn()
          .mockReturnValue({ authType: 'test-auth' }),
        isInteractive: vi.fn().mockReturnValue(true),
        getExperiments: vi.fn().mockReturnValue({ experimentIds: [] }),
        getPolicyEngine: vi.fn().mockReturnValue({
          getApprovalMode: vi.fn().mockReturnValue('auto'),
        }),
        get config() {
          return this;
        },
      } as unknown as Config;

      await setCommand!.action!(mockContext, 'gemini-pro --persist');

      expect(mockSetModel).toHaveBeenCalledWith('gemini-pro', false);
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('Model set to gemini-pro (persisted)'),
        }),
      );
    });

    it('should show error if no model name is provided', async () => {
      const setCommand = modelCommand.subCommands?.find(
        (c) => c.name === 'set',
      );
      await setCommand!.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: expect.stringContaining('Usage: /model set <model-name>'),
        }),
      );
    });
  });

  describe('list subcommand', () => {
    function configWith(
      generatorConfig: Record<string, unknown> | undefined,
    ): CommandContext['services']['agentContext'] {
      return {
        getContentGeneratorConfig: vi.fn().mockReturnValue(generatorConfig),
        get config() {
          return this;
        },
      } as unknown as Config;
    }

    it('should open the picker with the configured endpoint', async () => {
      const listCommand = modelCommand.subCommands?.find(
        (c) => c.name === 'list',
      );
      expect(listCommand).toBeDefined();

      mockContext.services.agentContext = configWith({
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://openrouter.ai/api/v1',
      });

      const result = await listCommand!.action!(mockContext, '');

      // Reuses the `model` dialog with an endpoint prop rather than adding a
      // second dialog kind, so `/model` and `/model list` share one entry point.
      expect(result).toEqual({
        type: 'dialog',
        dialog: 'model',
        props: { openAiEndpoint: 'https://openrouter.ai/api/v1' },
      });
    });

    it('should decline outside OpenAI-compatible mode', async () => {
      const listCommand = modelCommand.subCommands?.find(
        (c) => c.name === 'list',
      );

      mockContext.services.agentContext = configWith({
        authType: AuthType.USE_GEMINI,
      });

      const result = await listCommand!.action!(mockContext, '');

      expect(result).toBeUndefined();
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('only available in OpenAI'),
        }),
      );
    });

    it('should error when OpenAI mode has no endpoint configured', async () => {
      const listCommand = modelCommand.subCommands?.find(
        (c) => c.name === 'list',
      );

      mockContext.services.agentContext = configWith({
        authType: AuthType.USE_OPENAI,
      });

      const result = await listCommand!.action!(mockContext, '');

      expect(result).toBeUndefined();
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: expect.stringContaining('GEMINI_OPENAI_BASE_URL'),
        }),
      );
    });
  });

  it('should have the correct name and description', () => {
    expect(modelCommand.name).toBe('model');
    expect(modelCommand.description).toBe('Manage model configuration');
  });
});
