/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { useConfig } from '../contexts/ConfigContext.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from '../components/shared/DescriptiveRadioButtonSelect.js';
import { theme } from '../semantic-colors.js';
import {
  getErrorMessage,
  getOpenAiProvidersPath,
  loadProviderEntries,
} from '@google/gemini-cli-core';

interface ProviderDialogProps {
  onClose: () => void;
  /** Invoked with the chosen provider id. */
  onSelect: (providerId: string) => void;
}

type LoadState =
  | { status: 'ready'; ids: Array<{ id: string; label: string }> }
  | { status: 'error'; message: string };

/**
 * Lists the configured OpenAI-compatible providers and lets one be chosen.
 *
 * The file is read through the core loader rather than parsed here so the
 * dialog and the backend always agree on what a valid provider is — a file the
 * dialog accepted but the generator rejected would be a confusing way to fail.
 */
export function ProviderDialog({
  onClose,
  onSelect,
}: ProviderDialogProps): React.JSX.Element {
  const config = useConfig();
  const [state, setState] = useState<LoadState>(() => readProviders());

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onClose();
        return true;
      }
      // The file is hand-editable, so Tab re-reads it without closing the
      // dialog — the list is only accurate as of the last read.
      if (key.name === 'tab') {
        setState(readProviders());
        return true;
      }
      return false;
    },
    { isActive: true },
  );

  const activeId = config?.getActiveOpenAiProviderId();

  const items = useMemo(() => {
    if (state.status !== 'ready') return [];
    return state.ids.map(({ id, label }) => ({
      value: id,
      title: label,
      // The active provider is marked rather than hidden so the list still
      // shows where you are after a switch.
      description: id === activeId ? '● current provider' : undefined,
      key: id,
    }));
  }, [state, activeId]);

  if (state.status === 'error') {
    return (
      <Box borderStyle="round" borderColor={theme.border.default} padding={1}>
        <Text bold>Select Provider</Text>
        <Box marginTop={1}>
          <Text color={theme.status.error}>{state.message}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            (Press Tab to retry, Esc to close)
          </Text>
        </Box>
      </Box>
    );
  }

  if (state.ids.length === 0) {
    return (
      <Box borderStyle="round" borderColor={theme.border.default} padding={1}>
        <Text bold>Select Provider</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.status.warning}>
            No providers are configured in {getOpenAiProvidersPath()}.
          </Text>
          <Text color={theme.text.secondary}>
            Add one with /provider add, or use the endpoint described by
            GEMINI_OPENAI_BASE_URL.
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>(Press Esc to close)</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
    >
      <Text bold>Select Provider</Text>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>{getOpenAiProvidersPath()}</Text>
      </Box>
      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={items}
          onSelect={onSelect}
          initialIndex={Math.max(
            0,
            items.findIndex((item) => item.value === activeId),
          )}
          showNumbers={true}
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          (Enter to switch · Tab to reload · Esc to close)
        </Text>
      </Box>
    </Box>
  );
}

function readProviders(): LoadState {
  try {
    const entries = loadProviderEntries();
    return {
      status: 'ready',
      ids: entries.map((entry) => ({
        id: entry.id,
        label: entry.label ?? entry.id,
      })),
    };
  } catch (error) {
    return { status: 'error', message: getErrorMessage(error) };
  }
}
