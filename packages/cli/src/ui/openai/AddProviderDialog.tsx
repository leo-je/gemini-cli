/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { TextInput } from '../components/shared/TextInput.js';
import { useTextBuffer } from '../components/shared/text-buffer.js';
import { useUIState } from '../contexts/UIStateContext.js';

/** What the add flow collected, ready to be written to the provider file. */
export interface NewProviderValues {
  id: string;
  label?: string;
  baseUrl: string;
  modelId?: string;
  apiKey?: string;
}

interface AddProviderDialogProps {
  onSubmit: (values: NewProviderValues) => void;
  onCancel: () => void;
  error?: string | null;
}

interface Step {
  key: keyof NewProviderValues;
  title: string;
  description: string;
  placeholder: string;
  optional: boolean;
}

/**
 * The order matters: the id comes first so a rejected duplicate is reported
 * before the user has typed a URL and a key, and the key comes last so it is
 * the value most likely to be pasted without further reading.
 */
const STEPS: Step[] = [
  {
    key: 'id',
    title: 'Provider id',
    description:
      'A short name used by "/provider use <id>". Letters, digits, "-", and "_" only.',
    placeholder: 'openrouter',
    optional: false,
  },
  {
    key: 'baseUrl',
    title: 'Base URL',
    description:
      'The endpoint root. A URL without a path gets "/v1" appended, so write the path yourself if the endpoint needs something else.',
    placeholder: 'https://openrouter.ai/api/v1',
    optional: false,
  },
  {
    key: 'modelId',
    title: 'Default model id',
    description:
      'Optional. The model this provider should open with; leave empty to keep using the current model.',
    placeholder: '(optional)',
    optional: true,
  },
  {
    key: 'apiKey',
    title: 'API key',
    description:
      'Optional. Stored in ~/.gemini/.env as a variable, and referenced from the provider file by name so the key never lands in the JSON.',
    placeholder: '(optional, leave empty for a local server)',
    optional: true,
  },
];

/**
 * Collects one new provider profile.
 *
 * Mirrors `OpenAiEndpointDialog`, but writes a provider entry instead of the
 * single-endpoint environment variables. The API key is deliberately the last
 * question and is described as going to `.env` rather than to the provider
 * file, because that is where the writer puts it.
 */
export function AddProviderDialog({
  onSubmit,
  onCancel,
  error,
}: AddProviderDialogProps): React.JSX.Element {
  const [stepIndex, setStepIndex] = useState(0);
  const [values, setValues] = useState<Partial<NewProviderValues>>({});
  const [stepError, setStepError] = useState<string | null>(null);

  const step = STEPS[stepIndex];
  const collected = values[step.key] ?? '';

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!step.optional && trimmed.length === 0) {
      setStepError(`${step.title} cannot be empty.`);
      return;
    }

    const next = { ...values };
    if (trimmed.length > 0) {
      next[step.key] = trimmed;
    } else {
      delete next[step.key];
    }
    setValues(next);
    setStepError(null);

    if (stepIndex === STEPS.length - 1) {
      onSubmit({
        id: next.id!,
        baseUrl: next.baseUrl!,
        modelId: next.modelId,
        apiKey: next.apiKey,
      });
      return;
    }
    setStepIndex(stepIndex + 1);
  };

  return (
    <Box
      borderStyle="round"
      borderColor={theme.ui.focus}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold color={theme.text.primary}>
        Add an OpenAI-compatible provider
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
          {/* Keyed on the step so the buffer starts empty for each question. */}
          <StepInput
            key={step.key}
            initialValue={collected}
            placeholder={step.placeholder}
            onSubmit={handleSubmit}
            onCancel={onCancel}
          />
        </Box>
      </Box>
      {(stepError ?? error) && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{stepError ?? error}</Text>
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

interface StepInputProps {
  initialValue: string;
  placeholder: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function StepInput({
  initialValue,
  placeholder,
  onSubmit,
  onCancel,
}: StepInputProps): React.JSX.Element {
  const { terminalWidth } = useUIState();
  const viewportWidth = terminalWidth - 8;

  const buffer = useTextBuffer({
    initialText: initialValue,
    initialCursorOffset: initialValue.length,
    viewport: { width: viewportWidth, height: 1 },
    // URLs, ids, and keys need characters the API-key dialog strips, so only
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
