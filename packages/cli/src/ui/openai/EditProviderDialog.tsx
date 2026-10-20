/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Edits the human-facing fields of a configured provider.
 *
 * Only the name, base URL and API key are exposed: the id is what the rest of
 * the CLI refers to, and silently renaming it would orphan the model settings
 * saved under it. The key is never displayed — the provider file and `.env`
 * only ever give it back by variable name — so leaving the field empty keeps
 * whatever credential is already configured.
 */

import type React from 'react';
import { useState } from 'react';
import { Box, Text } from 'ink';
import {
  getErrorMessage,
  loadProviderEntries,
  updateProvider,
  type OpenAiProviderUpdate,
} from '@google/gemini-cli-core';
import { theme } from '../semantic-colors.js';
import { TextInput } from '../components/shared/TextInput.js';
import { useTextBuffer } from '../components/shared/text-buffer.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { saveProviderApiKey } from './addProvider.js';

interface EditProviderDialogProps {
  providerId: string;
  onCancel: () => void;
  /** Called after the provider file was written; the caller refreshes. */
  onSaved: () => void;
}

type StepKey = 'label' | 'baseUrl' | 'apiKey';

interface Step {
  key: StepKey;
  title: string;
  description: string;
  placeholder: string;
  required: boolean;
}

const STEPS: Step[] = [
  {
    key: 'label',
    title: 'Provider name',
    description:
      'How the provider is shown in /provider list. Leave empty to keep the current name.',
    placeholder: 'OpenRouter',
    required: false,
  },
  {
    key: 'baseUrl',
    title: 'Base URL',
    description:
      'The endpoint root. A URL without a path gets "/v1" appended, so write the path yourself if the endpoint needs something else.',
    placeholder: 'https://openrouter.ai/api/v1',
    required: true,
  },
  {
    key: 'apiKey',
    title: 'API key',
    description:
      'Leave empty to keep the current key. A new key is stored in ~/.gemini/.env and referenced from the provider file by name.',
    placeholder: '(leave empty to keep the current key)',
    required: false,
  },
];

/**
 * Collects one edit of an existing provider profile and writes it.
 *
 * The current name and URL are prefilled so the user can see what they are
 * changing; the key is not, because the CLI deliberately never reads it back
 * into the UI.
 */
export function EditProviderDialog({
  providerId,
  onCancel,
  onSaved,
}: EditProviderDialogProps): React.JSX.Element {
  const [stepIndex, setStepIndex] = useState(0);
  const [values, setValues] = useState<Partial<Record<StepKey, string>>>({});
  const [stepError, setStepError] = useState<string | null>(null);
  const [initial] = useState(() => readProvider(providerId));

  const step = STEPS[stepIndex];
  const collected =
    values[step.key] ??
    (stepIndex === 0
      ? (initial.label ?? '')
      : stepIndex === 1
        ? (initial.baseUrl ?? '')
        : '');

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    if (step.required && trimmed.length === 0) {
      setStepError(`${step.title} cannot be empty.`);
      return;
    }
    const next = { ...values };
    // Empty is meaningful: it keeps the current name/URL/key.
    if (trimmed.length > 0) {
      next[step.key] = trimmed;
    }
    setValues(next);
    setStepError(null);

    if (stepIndex < STEPS.length - 1) {
      setStepIndex(stepIndex + 1);
      return;
    }
    save(next);
  };

  const save = (next: Partial<Record<StepKey, string>>) => {
    const update: OpenAiProviderUpdate = { baseUrl: next.baseUrl!.trim() };
    if (next.label) {
      update.label = next.label;
    }
    if (next.apiKey) {
      const apiKeyEnv = saveProviderApiKey(providerId, next.apiKey);
      if (!apiKeyEnv) {
        setStepError('Could not save the API key to ~/.gemini/.env.');
        return;
      }
      update.apiKeyEnv = apiKeyEnv;
    }
    try {
      updateProvider(providerId, update);
    } catch (error) {
      setStepError(getErrorMessage(error));
      return;
    }
    onSaved();
  };

  if (initial.error) {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.border.default}
        flexDirection="column"
        padding={1}
      >
        <Text bold>Edit Provider</Text>
        <Box marginTop={1}>
          <Text color={theme.status.error}>{initial.error}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>(Press Esc to cancel)</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor={theme.ui.focus}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold color={theme.text.primary}>
        Edit provider {providerId}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.primary}>{step.title}</Text>
        <Text color={theme.text.secondary}>{step.description}</Text>
      </Box>
      <Box marginTop={1} flexDirection="row">
        <Box
          borderStyle="round"
          borderColor={theme.border.default}
          paddingX={1}
          flexGrow={1}
        >
          {/* Keyed on the step so the buffer starts with that step's value. */}
          <EditStepInput
            key={step.key}
            initialValue={collected}
            placeholder={step.placeholder}
            onSubmit={handleSubmit}
            onCancel={onCancel}
          />
        </Box>
      </Box>
      {stepError && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{stepError}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          (Press Enter to continue, Esc to cancel) — step {stepIndex + 1} of{' '}
          {STEPS.length}
        </Text>
      </Box>
    </Box>
  );
}

interface ProviderSnapshot {
  label?: string;
  baseUrl?: string;
  error?: string;
}

/** Reads the current name and URL, without resolving the credential. */
function readProvider(providerId: string): ProviderSnapshot {
  try {
    const entry = loadProviderEntries().find(
      (candidate) => candidate.id === providerId,
    );
    if (!entry) {
      return {
        error: `No provider with the id "${providerId}" is configured.`,
      };
    }
    return { label: entry.label, baseUrl: entry.baseUrl };
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
}

interface EditStepInputProps {
  initialValue: string;
  placeholder: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function EditStepInput({
  initialValue,
  placeholder,
  onSubmit,
  onCancel,
}: EditStepInputProps): React.JSX.Element {
  const { terminalWidth } = useUIState();
  const buffer = useTextBuffer({
    initialText: initialValue,
    initialCursorOffset: initialValue.length,
    viewport: { width: terminalWidth - 8, height: 1 },
    // URLs and keys need characters the token-count dialog strips, so only
    // control characters are removed here.
    inputFilter: (text) =>
      // eslint-disable-next-line no-control-regex
      text.replace(/[\u0000-\u001f\u007f]/g, ''),
    singleLine: true,
  });

  return (
    <TextInput
      buffer={buffer}
      onSubmit={onSubmit}
      onCancel={onCancel}
      placeholder={placeholder}
    />
  );
}
