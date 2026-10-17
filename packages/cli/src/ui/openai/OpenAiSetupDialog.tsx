/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { DescriptiveRadioButtonSelect } from '../components/shared/DescriptiveRadioButtonSelect.js';
import {
  AddProviderDialog,
  type NewProviderValues,
} from './AddProviderDialog.js';
import { loadProviderEntries } from '@google/gemini-cli-core';

/** The provider that "add a new one" is offered as. */
const ADD_NEW = '\u0000add-new';

interface OpenAiSetupDialogProps {
  /** Invoked when the add form is submitted. */
  onSubmit: (values: NewProviderValues) => void;
  /** Invoked with the id of an existing provider the user picked. */
  onPick: (providerId: string) => void;
  onCancel: () => void;
  error?: string | null;
}

interface ProviderChoice {
  id: string;
  label: string;
  baseUrl: string;
  modelId?: string;
}

/**
 * The OpenAI setup step in the auth flow.
 *
 * Having providers already configured used to be indistinguishable from having
 * none: the flow went straight to the add form, so a second endpoint could only
 * be reached by typing its details again, and an endpoint with no model had no
 * way to pick one. This lists what is already there and offers the form as one
 * more choice.
 *
 * Existing entries are listed even when they look incomplete — an entry without
 * a model is exactly the case where picking it and then choosing a model is the
 * thing to do.
 */
export function OpenAiSetupDialog({
  onSubmit,
  onPick,
  onCancel,
  error,
}: OpenAiSetupDialogProps): React.JSX.Element {
  const [providers] = useState<ProviderChoice[]>(() => readProviders());
  // With nothing configured there is nothing to choose, so start in the form —
  // that is the first-run path.
  const [mode, setMode] = useState<'pick' | 'add'>(
    providers.length === 0 ? 'add' : 'pick',
  );

  const items = useMemo(
    () => [
      ...providers.map((provider) => ({
        value: provider.id,
        title: provider.modelId
          ? `${provider.label}  (${provider.modelId})`
          : `${provider.label}  (no model yet)`,
        description: provider.baseUrl,
        key: provider.id,
      })),
      {
        value: ADD_NEW,
        title: 'Add a new provider',
        description: 'Enter another endpoint by hand.',
        key: ADD_NEW,
      },
    ],
    [providers],
  );

  if (mode === 'add') {
    return (
      <AddProviderDialog
        onSubmit={onSubmit}
        // Coming from the list, cancelling goes back to it rather than out of
        // the flow — the user had already seen a list of choices.
        onCancel={providers.length > 0 ? () => setMode('pick') : onCancel}
        error={error}
      />
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
    >
      <Text bold>Choose an OpenAI-compatible provider</Text>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          The model is chosen from the endpoint&apos;s own list next.
        </Text>
      </Box>
      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={items}
          onSelect={(value: string) => {
            if (value === ADD_NEW) {
              setMode('add');
              return;
            }
            onPick(value);
          }}
          showNumbers={true}
        />
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          (Enter to choose · Esc to cancel)
        </Text>
      </Box>
    </Box>
  );
}

function readProviders(): ProviderChoice[] {
  try {
    return loadProviderEntries().map((entry) => ({
      id: entry.id,
      label: entry.label ?? entry.id,
      baseUrl: entry.baseUrl,
      modelId: entry.modelId,
    }));
  } catch {
    // An unreadable file is reported by the auth gate, which then decides that
    // OpenAI is not configured. Falling back to the form keeps this dialog
    // usable instead of failing a second time for the same reason.
    return [];
  }
}
