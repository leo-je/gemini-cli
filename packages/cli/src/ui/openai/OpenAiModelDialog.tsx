/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { useConfig } from '../contexts/ConfigContext.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from '../components/shared/DescriptiveRadioButtonSelect.js';
import { theme } from '../semantic-colors.js';
import { fetchRemoteModels } from './openAiModelList.js';

interface OpenAiModelDialogProps {
  onClose: () => void;
  /** The endpoint the listing came from, shown in the header. */
  endpoint: string;
  /** Invoked with the chosen model id. */
  onSelect: (modelId: string) => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; models: string[] }
  | { status: 'error'; message: string };

/**
 * Lists the models an OpenAI-compatible endpoint serves and lets one be picked.
 *
 * The listing is fetched here rather than passed in because the set changes
 * without a CLI restart — a gateway can gain a model at any time — so opening
 * the dialog is the moment worth asking.
 */
export function OpenAiModelDialog({
  onClose,
  endpoint,
  onSelect,
}: OpenAiModelDialogProps): React.JSX.Element {
  const config = useConfig();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [filter, setFilter] = useState('');

  const load = useCallback(() => {
    if (!config) return;
    let cancelled = false;
    setState({ status: 'loading' });
    void fetchRemoteModels(config)
      .then((listing) => {
        if (cancelled || !listing) return;
        if (listing.models.length === 0) {
          setState({
            status: 'error',
            message: `${listing.endpoint} returned no models. Use /model set <model-name> to choose one directly.`,
          });
          return;
        }
        setState({ status: 'ready', models: listing.models });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: `Could not list models from ${endpoint}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [config, endpoint]);

  useEffect(() => load(), [load]);

  // Typing filters; Backspace widens the filter. Digits and punctuation are
  // model ids too (`gpt-4.1`, `qwen/qwen3-coder:free`), so the filter takes any
  // printable character rather than letters alone.
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onClose();
        return true;
      }
      if (key.name === 'backspace' || key.name === 'delete') {
        setFilter((prev) => prev.slice(0, -1));
        return true;
      }
      if (key.name === 'tab') {
        load();
        return true;
      }
      const typed = (key as { sequence?: string }).sequence;
      if (
        typed &&
        typed.length === 1 &&
        typed >= ' ' &&
        typed !== '\t' &&
        // Enter and the arrow/navigation sequences arrive with a multi-char
        // sequence or a name; a single printable char is the user's own input.
        typed.charCodeAt(0) >= 0x20 &&
        typed.charCodeAt(0) !== 0x7f
      ) {
        setFilter((prev) => prev + typed);
        return true;
      }
      return false;
    },
    { isActive: true },
  );

  const visibleModels = useMemo(() => {
    if (state.status !== 'ready') return [];
    const needle = filter.trim().toLowerCase();
    const all = state.models;
    if (!needle) return all;
    return all.filter((m) => m.toLowerCase().includes(needle));
  }, [state, filter]);

  const currentModel = config?.getModel();
  const items = useMemo(
    () =>
      visibleModels.map((modelId) => ({
        value: modelId,
        title: modelId,
        description: modelId === currentModel ? 'current model' : undefined,
        key: modelId,
      })),
    [visibleModels, currentModel],
  );

  const initialIndex = useMemo(
    () =>
      Math.max(
        0,
        items.findIndex((i) => i.value === currentModel),
      ),
    [items, currentModel],
  );

  if (state.status === 'loading') {
    return (
      <Box borderStyle="round" borderColor={theme.border.default} padding={1}>
        <Text bold>Select Model</Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            Loading models from {endpoint}…
          </Text>
        </Box>
      </Box>
    );
  }

  if (state.status === 'error') {
    return (
      <Box borderStyle="round" borderColor={theme.border.default} padding={1}>
        <Text bold>Select Model</Text>
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

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
    >
      <Text bold>Select Model</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>{endpoint}</Text>
        <Text>
          <Text bold color={theme.text.primary}>
            Filter:{' '}
          </Text>
          <Text color={theme.status.success}>{filter}</Text>
          <Text color={theme.text.secondary}>
            {filter ? '' : ' (type to filter)'}
          </Text>
        </Text>
        <Text color={theme.text.secondary}>
          {visibleModels.length} of {state.models.length} models
        </Text>
      </Box>

      <Box marginTop={1}>
        {items.length === 0 ? (
          <Text color={theme.status.warning}>No model matches “{filter}”.</Text>
        ) : (
          <DescriptiveRadioButtonSelect
            items={items}
            onSelect={onSelect}
            initialIndex={initialIndex}
            showNumbers={true}
          />
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          (Enter to select · type to filter · Tab to reload · Esc to close)
        </Text>
      </Box>
    </Box>
  );
}
