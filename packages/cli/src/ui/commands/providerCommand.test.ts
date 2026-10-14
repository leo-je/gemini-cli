/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { providerCommand } from './providerCommand.js';
import { CommandKind, type CommandContext } from './types.js';
import { MessageType } from '../types.js';

function makeContext(options: {
  isOpenAi: boolean;
  switchOpenAiProvider?: (id: string) => Promise<void>;
}): {
  context: CommandContext;
  addItem: ReturnType<typeof vi.fn>;
  switchOpenAiProvider: ReturnType<typeof vi.fn>;
} {
  const addItem = vi.fn();
  const switchOpenAiProvider = vi.fn(
    options.switchOpenAiProvider ?? (async () => {}),
  );
  const config = {
    getContentGeneratorConfig: () => ({
      authType: options.isOpenAi ? 'openai' : 'gemini',
    }),
    switchOpenAiProvider,
  };
  const context = {
    ui: { addItem },
    services: { agentContext: { config } },
  } as unknown as CommandContext;
  return { context, addItem, switchOpenAiProvider };
}

describe('providerCommand', () => {
  beforeEach(() => {
    // The OpenAI-mode check also consults GEMINI_API_TYPE, so clear it and let
    // each case's fake config decide.
    vi.stubEnv('GEMINI_API_TYPE', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is registered as a built-in with list, use and add subcommands', () => {
    expect(providerCommand.name).toBe('provider');
    expect(providerCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(providerCommand.subCommands?.map((c) => c.name)).toEqual([
      'list',
      'use',
      'add',
    ]);
  });

  it('add: opens the add form in OpenAI mode', async () => {
    const { context } = makeContext({ isOpenAi: true });
    const add = providerCommand.subCommands!.find((c) => c.name === 'add')!;
    const result = await add.action!(context, '');
    expect(result).toEqual({
      type: 'dialog',
      dialog: 'model',
      props: { geminiCliDialog: 'addProvider' },
    });
  });

  it('add: declines outside OpenAI mode', async () => {
    const { context, addItem } = makeContext({ isOpenAi: false });
    const add = providerCommand.subCommands!.find((c) => c.name === 'add')!;
    const result = await add.action!(context, '');
    expect(result).toBeUndefined();
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: MessageType.INFO }),
    );
  });

  it('opens the picker when no argument is given', async () => {
    const { context } = makeContext({ isOpenAi: true });
    const result = await providerCommand.action!(context, '');
    expect(result).toEqual({
      type: 'dialog',
      dialog: 'model',
      props: { geminiCliDialog: 'provider' },
    });
  });

  it('explains itself outside OpenAI mode instead of opening the picker', async () => {
    const { context, addItem } = makeContext({ isOpenAi: false });
    const result = await providerCommand.action!(context, '');
    expect(result).toBeUndefined();
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: MessageType.INFO }),
    );
  });

  it('switch: reports usage when the id is missing', async () => {
    const { context, addItem, switchOpenAiProvider } = makeContext({
      isOpenAi: true,
    });
    const use = providerCommand.subCommands!.find((c) => c.name === 'use')!;
    await use.action!(context, '   ');
    expect(switchOpenAiProvider).not.toHaveBeenCalled();
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: MessageType.ERROR }),
    );
  });

  it('switch: delegates to config and confirms', async () => {
    const { context, addItem, switchOpenAiProvider } = makeContext({
      isOpenAi: true,
    });
    const use = providerCommand.subCommands!.find((c) => c.name === 'use')!;
    await use.action!(context, 'openrouter');
    expect(switchOpenAiProvider).toHaveBeenCalledWith('openrouter');
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: expect.stringContaining('openrouter') as string,
      }),
    );
  });
});
