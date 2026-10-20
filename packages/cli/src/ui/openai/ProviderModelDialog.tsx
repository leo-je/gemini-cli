/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The model picker for a configured provider.
 *
 * Reached from `/model list` and from `/provider` after a switch, instead of
 * `OpenAiModelDialog`, because a provider file records what the endpoint does
 * not advertise: the model's real context window and its maximum output tokens.
 * An OpenAI-compatible `/v1/models` response has no standard field for either,
 * so they live in the provider file and this dialog is where they are captured.
 *
 * The flow is: a non-empty saved list offers "use it" or "fetch it again"; an
 * empty list fetches immediately. Either way the endpoint's catalog is merged
 * into the provider file (existing entries keep their token settings), then the
 * chosen model's settings are collected and saved before the session switches.
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import {
  ModelSlashCommandEvent,
  getProviderModels,
  logModelSlashCommand,
  mergeProviderModels,
  parseTokenCount,
  saveProviderModelSettings,
  type OpenAiProviderModel,
} from '@google/gemini-cli-core';
import { useConfig } from '../contexts/ConfigContext.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from '../components/shared/DescriptiveRadioButtonSelect.js';
import { TextInput } from '../components/shared/TextInput.js';
import { useTextBuffer } from '../components/shared/text-buffer.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { theme } from '../semantic-colors.js';
import { fetchRemoteModels } from './openAiModelList.js';
import { rememberModelForProvider } from './openAiProviderPreference.js';

interface ProviderModelDialogProps {
  /** The provider whose `models` array is read and written. */
  providerId: string;
  /** The endpoint shown in the header and used for a fetch. */
  endpoint: string;
  onClose: () => void;
}

type SettingsStep = 'contextWindowSize' | 'maxToken';

type Phase =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'source' }
  | { status: 'list' }
  | { status: 'actions'; modelId: string }
  | { status: 'settings'; modelId: string; step: SettingsStep };

/** Items that are actions rather than model ids. */
const FETCH_ITEM = '__fetch__';
const REFRESH_ITEM = '__refresh__';

/**
 * Parses a token count the user typed.
 *
 * `undefined` means "not supplied" (keep the saved value) and must stay
 * distinguishable from a number, so an invalid input is reported separately.
 * The shorthand (`128k`, `1m`) is accepted and converted to whole tokens.
 */
function parseTokenField(raw: string): number | undefined | 'invalid' {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return parseTokenCount(trimmed);
}

function describeModel(
  model: OpenAiProviderModel,
  currentModel: string | undefined,
): string {
  const parts: string[] = [];
  if (model.modelId === currentModel) {
    parts.push('current model');
  }
  if (model.contextWindowSize !== undefined) {
    parts.push(`context ${model.contextWindowSize.toLocaleString('en-US')}`);
  }
  if (model.maxToken !== undefined) {
    parts.push(`max output ${model.maxToken.toLocaleString('en-US')}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'no token settings';
}

export function ProviderModelDialog({
  providerId,
  endpoint,
  onClose,
}: ProviderModelDialogProps): React.JSX.Element {
  const config = useConfig();
  const initialModels = useMemo(
    () => getProviderModels(providerId),
    [providerId],
  );
  const [models, setModels] = useState<OpenAiProviderModel[]>(initialModels);
  const [phase, setPhase] = useState<Phase>(() =>
    initialModels.length > 0 ? { status: 'source' } : { status: 'loading' },
  );
  const [notice, setNotice] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [filter, setFilter] = useState('');
  const [settingsValues, setSettingsValues] = useState<{
    contextWindowSize?: string;
    maxToken?: string;
  }>({});
  const fetchedOnMount = useRef(false);

  const loadRemote = useCallback(() => {
    if (!config) {
      setPhase({ status: 'error', message: 'The CLI is not ready yet.' });
      return;
    }
    setPhase({ status: 'loading' });
    setNotice(undefined);
    setFormError(undefined);
    void fetchRemoteModels(config)
      .then((listing) => {
        if (!listing) {
          setPhase({ status: 'error', message: 'No endpoint is configured.' });
          return;
        }
        if (listing.models.length === 0) {
          setPhase({
            status: 'error',
            message: `${endpoint} returned no models. You can still pick one directly with /model set <model-name>.`,
          });
          return;
        }
        const saved = mergeProviderModels(providerId, listing.models);
        // Read back rather than reusing `listing` so the token settings already
        // saved for these models are displayed.
        setModels(
          saved
            ? getProviderModels(providerId)
            : listing.models.map((modelId) => ({ modelId })),
        );
        setPhase({ status: 'list' });
        if (!saved) {
          setNotice(
            'Fetched the model list but could not save it to the provider file; this list is for this session only.',
          );
        }
      })
      .catch((error: unknown) => {
        setPhase({
          status: 'error',
          message: `Could not list models from ${endpoint}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });
  }, [config, endpoint, providerId]);

  useEffect(() => {
    if (initialModels.length > 0 || fetchedOnMount.current) {
      return;
    }
    fetchedOnMount.current = true;
    loadRemote();
  }, [initialModels.length, loadRemote]);

  // Escape moves back one stage, or closes from the top level. Not active while
  // a text field is focused: that field owns Escape (see the input's onCancel).
  useKeypress(
    useCallback(
      (key) => {
        if (key.name !== 'escape') {
          return false;
        }
        if (phase.status === 'settings') {
          setPhase({ status: 'list' });
          setFormError(undefined);
          return true;
        }
        if (phase.status === 'actions') {
          setPhase({ status: 'list' });
          setFormError(undefined);
          return true;
        }
        onClose();
        return true;
      },
      [phase.status, onClose],
    ),
    { isActive: phase.status !== 'settings' },
  );

  // Typing filters the model list. Same conventions as OpenAiModelDialog:
  // model ids contain digits and punctuation, so any printable character is
  // part of the filter; Backspace widens it.
  useKeypress(
    useCallback(
      (key) => {
        if (phase.status !== 'list') {
          return false;
        }
        if (key.name === 'backspace' || key.name === 'delete') {
          setFilter((prev) => prev.slice(0, -1));
          return true;
        }
        if (key.name === 'tab') {
          loadRemote();
          return true;
        }
        const typed = (key as { sequence?: string }).sequence;
        if (
          typed &&
          typed.length === 1 &&
          typed >= ' ' &&
          typed.charCodeAt(0) >= 0x20 &&
          typed.charCodeAt(0) !== 0x7f
        ) {
          setFilter((prev) => prev + typed);
          return true;
        }
        return false;
      },
      [phase.status, loadRemote],
    ),
    { isActive: phase.status === 'list' },
  );

  const currentModel = config?.getModel();

  const sourceItems = useMemo(
    () => [
      {
        key: 'current',
        value: 'current',
        title: `Current model list (${models.length})`,
        description: 'Pick a model from the list saved for this provider',
      },
      {
        key: FETCH_ITEM,
        value: FETCH_ITEM,
        title: 'Fetch model list',
        description: `Ask ${endpoint} for its current catalog`,
      },
    ],
    [models.length, endpoint],
  );

  const modelItems = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const visible = needle
      ? models.filter((model) => model.modelId.toLowerCase().includes(needle))
      : models;
    return [
      ...visible.map((model) => ({
        key: model.modelId,
        value: model.modelId,
        title: model.modelId,
        description: describeModel(model, currentModel),
      })),
      {
        key: REFRESH_ITEM,
        value: REFRESH_ITEM,
        title: 'Fetch model list again',
        description: `Ask ${endpoint} and merge the result`,
      },
    ];
  }, [models, filter, currentModel, endpoint]);

  const handleSourceSelect = useCallback(
    (value: string) => {
      if (value === FETCH_ITEM) {
        loadRemote();
        return;
      }
      setPhase({ status: 'list' });
    },
    [loadRemote],
  );

  const handleModelSelect = useCallback(
    (value: string) => {
      if (value === REFRESH_ITEM) {
        loadRemote();
        return;
      }
      if (config) {
        // Record the pick right away: the token settings that follow are
        // optional, so backing out of them must not leave the session on the
        // previous model.
        rememberModelForProvider(providerId, value);
        config.setModel(value, true);
        logModelSlashCommand(config, new ModelSlashCommandEvent(value));
      }
      setSettingsValues({});
      setFormError(undefined);
      setPhase({ status: 'actions', modelId: value });
    },
    [config, loadRemote, providerId],
  );

  const finishSettings = useCallback(
    (modelId: string, maxTokenRaw: string) => {
      const contextWindowSize = parseTokenField(
        settingsValues.contextWindowSize ?? '',
      );
      const maxToken = parseTokenField(maxTokenRaw);
      if (contextWindowSize === 'invalid' || maxToken === 'invalid') {
        setFormError(
          'Token counts must be a positive whole number, optionally with a k or m suffix (e.g. 128k, 1m), or empty.',
        );
        return;
      }
      const saved = saveProviderModelSettings(providerId, modelId, {
        contextWindowSize,
        maxToken,
      });
      if (!saved) {
        setFormError(
          `Could not save the model settings to the provider file for "${providerId}".`,
        );
        return;
      }
      if (config) {
        // Re-apply the model so the window just saved takes effect in this
        // session; the pick itself was recorded when the model was selected.
        config.setModel(modelId, true);
      }
      onClose();
    },
    [config, onClose, providerId, settingsValues.contextWindowSize],
  );

  const handleSettingsSubmit = useCallback(
    (value: string) => {
      if (phase.status !== 'settings') {
        return;
      }
      if (phase.step === 'contextWindowSize') {
        if (parseTokenField(value) === 'invalid') {
          setFormError(
            'Context window must be a positive whole number (e.g. 128k or 131072), or empty.',
          );
          return;
        }
        setSettingsValues((prev) => ({
          ...prev,
          contextWindowSize: value.trim() || undefined,
        }));
        setFormError(undefined);
        setPhase({
          status: 'settings',
          modelId: phase.modelId,
          step: 'maxToken',
        });
        return;
      }
      finishSettings(phase.modelId, value);
    },
    [phase, finishSettings],
  );

  const actionItems = useMemo(() => {
    const selected =
      phase.status === 'actions'
        ? models.find((model) => model.modelId === phase.modelId)
        : undefined;
    const savedSettings =
      selected &&
      (selected.contextWindowSize !== undefined ||
        selected.maxToken !== undefined)
        ? describeModel(selected, undefined)
        : undefined;
    return [
      {
        key: 'apply',
        value: 'apply',
        title: 'Apply model',
        description: savedSettings
          ? `Use it now with its saved settings (${savedSettings})`
          : 'Use it now; no token settings are saved for it',
      },
      {
        key: 'customize',
        value: 'customize',
        title: 'Edit token settings',
        description: 'Set the context window and maximum output tokens',
      },
    ];
  }, [models, phase]);

  const handleActionSelect = useCallback(
    (value: string) => {
      if (phase.status !== 'actions') {
        return;
      }
      if (value === 'customize') {
        setSettingsValues({});
        setFormError(undefined);
        setPhase({
          status: 'settings',
          modelId: phase.modelId,
          step: 'contextWindowSize',
        });
        return;
      }
      onClose();
    },
    [onClose, phase],
  );

  if (phase.status === 'loading') {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.border.default}
        flexDirection="column"
        padding={1}
      >
        <Text bold>Select Model</Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            Loading models from {endpoint}…
          </Text>
        </Box>
      </Box>
    );
  }

  if (phase.status === 'error') {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.border.default}
        flexDirection="column"
        padding={1}
      >
        <Text bold>Select Model</Text>
        <Box marginTop={1}>
          <Text color={theme.status.error}>{phase.message}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            (Press Tab to retry, Esc to close)
          </Text>
        </Box>
      </Box>
    );
  }

  if (phase.status === 'actions') {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.border.default}
        flexDirection="column"
        padding={1}
      >
        <Text bold>Select Model</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.text.primary}>{phase.modelId}</Text>
          <Text color={theme.text.secondary}>
            Provider: {providerId} · {endpoint}
          </Text>
        </Box>
        <Box marginTop={1}>
          <DescriptiveRadioButtonSelect
            items={actionItems}
            onSelect={handleActionSelect}
            showNumbers={true}
          />
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            (Enter to select · Esc to go back)
          </Text>
        </Box>
      </Box>
    );
  }

  if (phase.status === 'settings') {
    const step = phase.step;
    const isLastStep = step === 'maxToken';
    return (
      <Box
        borderStyle="round"
        borderColor={theme.border.default}
        flexDirection="column"
        padding={1}
      >
        <Text bold>Token settings for {phase.modelId}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.text.primary}>
            {isLastStep ? 'Maximum output tokens' : 'Context window size'}
          </Text>
          <Text color={theme.text.secondary}>
            {isLastStep
              ? 'The most output tokens to request from this model, e.g. 8192 or 8k. Leave empty to keep the saved value.'
              : 'The real context window of this model in tokens, e.g. 131072 or 128k. Leave empty to keep the saved value.'}
          </Text>
        </Box>
        <Box
          marginTop={1}
          flexDirection="row"
          borderStyle="round"
          borderColor={theme.border.default}
          paddingX={1}
        >
          {/* Keyed on the step so the buffer starts empty for each question. */}
          <SettingsInput
            key={step}
            initialValue={
              isLastStep
                ? (settingsValues.maxToken ?? '')
                : (settingsValues.contextWindowSize ?? '')
            }
            placeholder="(optional)"
            onSubmit={handleSettingsSubmit}
            onCancel={() => {
              setPhase({ status: 'list' });
              setFormError(undefined);
            }}
          />
        </Box>
        {(formError ?? notice) && (
          <Box marginTop={1}>
            <Text color={formError ? theme.status.error : theme.status.warning}>
              {formError ?? notice}
            </Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            (Press Enter to continue, Esc to go back) — step{' '}
            {isLastStep ? 2 : 1} of 2
          </Text>
        </Box>
      </Box>
    );
  }

  const isSource = phase.status === 'source';
  const items = isSource ? sourceItems : modelItems;

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
    >
      <Text bold>Select Model</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          Provider: {providerId} · {endpoint}
        </Text>
        {!isSource && (
          <Text>
            <Text bold color={theme.text.primary}>
              Filter:{' '}
            </Text>
            <Text color={theme.status.success}>{filter}</Text>
            <Text color={theme.text.secondary}>
              {filter ? '' : ' (type to filter)'}
            </Text>
          </Text>
        )}
      </Box>

      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={items}
          onSelect={isSource ? handleSourceSelect : handleModelSelect}
          showNumbers={true}
        />
      </Box>

      {notice && (
        <Box marginTop={1}>
          <Text color={theme.status.warning}>{notice}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          {isSource
            ? '(Enter to select · Esc to close)'
            : '(Enter to select · type to filter · Tab to fetch again · Esc to close)'}
        </Text>
      </Box>
    </Box>
  );
}

interface SettingsInputProps {
  initialValue: string;
  placeholder: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** A single-line, digits-only field for one token count. */
function SettingsInput({
  initialValue,
  placeholder,
  onSubmit,
  onCancel,
}: SettingsInputProps): React.JSX.Element {
  const { terminalWidth } = useUIState();
  const buffer = useTextBuffer({
    initialText: initialValue,
    initialCursorOffset: initialValue.length,
    viewport: { width: terminalWidth - 8, height: 1 },
    inputFilter: (text) => text.replace(/[^0-9.kmKM]/g, ''),
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
