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
import type { OpenAiEndpointEnv } from '../../utils/openAiEndpointEnv.js';

/**
 * Collects the endpoint settings OpenAI mode needs.
 *
 * The mode is configured purely through environment variables, so before this
 * existed a first-run user who picked "OpenAI API (compatible)" was told to go
 * set `GEMINI_OPENAI_BASE_URL` and had no way to finish from inside the CLI.
 */
interface OpenAiEndpointDialogProps {
  onSubmit: (settings: OpenAiEndpointEnv) => void;
  onCancel: () => void;
  error?: string | null;
  defaultBaseUrl?: string;
  defaultModelId?: string;
}

interface Step {
  key: keyof OpenAiEndpointEnv;
  title: string;
  description: string;
  placeholder: string;
  optional: boolean;
}

const STEPS: Step[] = [
  {
    key: 'baseUrl',
    title: 'OpenAI-compatible endpoint',
    description:
      'The base URL of the endpoint. A URL without a path gets "/v1" appended, so write the path yourself if the endpoint needs something else.',
    placeholder: 'https://openrouter.ai/api/v1',
    optional: false,
  },
  {
    key: 'modelId',
    title: 'Model id',
    description:
      'The model name sent to the endpoint. This is authoritative in this mode; --model has no effect.',
    placeholder: 'gpt-4o',
    optional: false,
  },
  {
    key: 'apiKey',
    title: 'API key',
    description:
      'Leave empty for a local server that accepts unauthenticated requests (Ollama, LM Studio).',
    placeholder: '(optional)',
    optional: true,
  },
];

export function OpenAiEndpointDialog({
  onSubmit,
  onCancel,
  error,
  defaultBaseUrl = '',
  defaultModelId = '',
}: OpenAiEndpointDialogProps): React.JSX.Element {
  const [stepIndex, setStepIndex] = useState(0);
  const [values, setValues] = useState<Partial<OpenAiEndpointEnv>>({
    baseUrl: defaultBaseUrl,
    modelId: defaultModelId,
  });
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
        baseUrl: next.baseUrl!,
        modelId: next.modelId!,
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
        Configure OpenAI-compatible API
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
    // URLs and model ids need characters the API-key dialog strips, so only
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
