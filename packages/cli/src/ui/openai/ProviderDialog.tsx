/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lists the configured OpenAI-compatible providers and acts on the chosen one:
 * switch to it, edit its name/URL/key, or delete it.
 *
 * The file is read through the core loader rather than parsed here so the
 * dialog and the backend always agree on what a valid provider is — a file the
 * dialog accepted but the generator rejected would be a confusing way to fail.
 */

import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  getErrorMessage,
  getOpenAiProvidersPath,
  loadProviderEntries,
  removeProvider,
} from '@google/gemini-cli-core';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from '../components/shared/DescriptiveRadioButtonSelect.js';
import { theme } from '../semantic-colors.js';
import { EditProviderDialog } from './EditProviderDialog.js';
import { persistProviderId } from './openAiProviderPreference.js';

interface ProviderDialogProps {
  onClose: () => void;
  /** Invoked with the chosen provider id, so the caller can switch to it. */
  onSelect: (providerId: string) => void;
}

interface ProviderSummary {
  id: string;
  label: string;
  baseUrl: string;
}

type LoadState =
  | { status: 'ready'; providers: ProviderSummary[] }
  | { status: 'error'; message: string };

type Phase =
  | { status: 'list' }
  | { status: 'actions'; providerId: string }
  | { status: 'edit'; providerId: string }
  | { status: 'confirmDelete'; providerId: string };

/**
 * Lists the configured OpenAI-compatible providers and lets one be chosen.
 *
 * Choosing a provider is a step, not the end: the action menu then offers the
 * switch, an edit of its human-facing fields, or a deletion. Everything stays
 * inside this dialog so the upstream `DialogManager` keeps its single insertion
 * point for the fork's provider UI.
 */
export function ProviderDialog({
  onClose,
  onSelect,
}: ProviderDialogProps): React.JSX.Element {
  const config = useConfig();
  const settings = useSettings();
  const [state, setState] = useState<LoadState>(() => readProviders());
  const [phase, setPhase] = useState<Phase>({ status: 'list' });
  const [notice, setNotice] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const activeId = config?.getActiveOpenAiProviderId();

  const handleEditSaved = useCallback(
    async (providerId: string) => {
      if (config?.getActiveOpenAiProviderId() === providerId) {
        try {
          // The generator keeps the config it was built with, so a change to
          // the active provider only takes effect after resolving it again.
          await config.switchOpenAiProvider(providerId);
        } catch (switchError) {
          setError(getErrorMessage(switchError));
        }
      }
      setState(readProviders());
      setPhase({ status: 'actions', providerId });
      setNotice(`Updated "${providerId}".`);
    },
    [config],
  );

  const handleDelete = useCallback(
    async (providerId: string) => {
      setBusy(true);
      setError(undefined);
      try {
        removeProvider(providerId);
        const remaining = readProviders();
        const wasActive = config?.getActiveOpenAiProviderId() === providerId;
        if (wasActive) {
          if (remaining.status === 'ready' && remaining.providers.length > 0) {
            const next = remaining.providers[0];
            await config?.switchOpenAiProvider(next.id);
            persistProviderId(settings, next.id);
            setNotice(`Deleted "${providerId}" and switched to "${next.id}".`);
          } else {
            // Nothing is left to resolve, so the stale preference has to go too
            // or the next start would fail on an unknown provider.
            persistProviderId(settings, '');
            setNotice(
              `Deleted "${providerId}". No providers remain; add one with /provider add.`,
            );
          }
        } else {
          setNotice(`Deleted "${providerId}".`);
        }
        setState(remaining);
        setPhase({ status: 'list' });
      } catch (deleteError) {
        setError(getErrorMessage(deleteError));
        setState(readProviders());
      } finally {
        setBusy(false);
      }
    },
    [config, settings],
  );

  useKeypress(
    (key) => {
      if (busy) {
        return false;
      }
      if (key.name === 'escape') {
        if (phase.status === 'list') {
          onClose();
          return true;
        }
        // The edit dialog owns Escape while it is open (its input cancels it).
        if (phase.status === 'edit') {
          return false;
        }
        setError(undefined);
        setNotice(undefined);
        setPhase({ status: 'list' });
        return true;
      }
      // The file is hand-editable, so Tab re-reads it without closing the
      // dialog — the list is only accurate as of the last read.
      if (key.name === 'tab' && phase.status === 'list') {
        setState(readProviders());
        return true;
      }
      return false;
    },
    { isActive: phase.status !== 'edit' },
  );

  const providerItems = useMemo(() => {
    if (state.status !== 'ready') return [];
    return state.providers.map(({ id, label }) => ({
      value: id,
      title: label,
      // The active provider is marked rather than hidden so the list still
      // shows where you are after a switch.
      description: id === activeId ? '● current provider' : undefined,
      key: id,
    }));
  }, [state, activeId]);

  const selectedProvider =
    state.status === 'ready' && phase.status !== 'list'
      ? state.providers.find((provider) => provider.id === phase.providerId)
      : undefined;

  const actionItems = useMemo(() => {
    if (!selectedProvider) return [];
    return [
      {
        key: 'use',
        value: 'use',
        title: 'Use this provider',
        description:
          selectedProvider.id === activeId
            ? 'Already current; pick one of its models'
            : 'Switch the session to it and pick a model',
      },
      {
        key: 'edit',
        value: 'edit',
        title: 'Edit provider',
        description: 'Change its name, base URL or API key',
      },
      {
        key: 'delete',
        value: 'delete',
        title: 'Delete provider',
        description: 'Remove it from the provider file',
      },
    ];
  }, [selectedProvider, activeId]);

  const handleActionSelect = useCallback(
    (value: string) => {
      if (phase.status !== 'actions') return;
      if (value === 'use') {
        onSelect(phase.providerId);
        return;
      }
      setNotice(undefined);
      setError(undefined);
      setPhase({
        status: value === 'edit' ? 'edit' : 'confirmDelete',
        providerId: phase.providerId,
      });
    },
    [onSelect, phase],
  );

  const confirmItems = useMemo(() => {
    if (!selectedProvider) return [];
    return [
      {
        key: 'delete',
        value: 'delete',
        title: `Delete "${selectedProvider.label}"`,
        description: 'This removes the provider from the file.',
      },
      {
        key: 'cancel',
        value: 'cancel',
        title: 'Cancel',
        description: 'Keep the provider',
      },
    ];
  }, [selectedProvider]);

  const handleConfirmSelect = useCallback(
    (value: string) => {
      if (phase.status !== 'confirmDelete') return;
      if (value !== 'delete') {
        setPhase({ status: 'actions', providerId: phase.providerId });
        return;
      }
      void handleDelete(phase.providerId);
    },
    [handleDelete, phase],
  );

  if (phase.status === 'edit') {
    return (
      <EditProviderDialog
        providerId={phase.providerId}
        onCancel={() =>
          setPhase({ status: 'actions', providerId: phase.providerId })
        }
        onSaved={() => void handleEditSaved(phase.providerId)}
      />
    );
  }

  if (state.status === 'error') {
    return (
      <DialogFrame title="Provider">
        <Box marginTop={1}>
          <Text color={theme.status.error}>{state.message}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            (Press Tab to retry, Esc to close)
          </Text>
        </Box>
      </DialogFrame>
    );
  }

  if (state.providers.length === 0) {
    return (
      <DialogFrame title="Provider">
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.status.warning}>
            No providers are configured in {getOpenAiProvidersPath()}.
          </Text>
          <Text color={theme.text.secondary}>
            Add one with /provider add, or use the endpoint described by
            GEMINI_OPENAI_BASE_URL.
          </Text>
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color={theme.status.error}>{error}</Text>
          </Box>
        )}
        {notice && (
          <Box marginTop={1}>
            <Text color={theme.status.warning}>{notice}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>(Press Esc to close)</Text>
        </Box>
      </DialogFrame>
    );
  }

  if (phase.status === 'confirmDelete' && selectedProvider) {
    return (
      <DialogFrame title="Delete provider?">
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.text.secondary}>
            {selectedProvider.label} · {selectedProvider.baseUrl}
          </Text>
          {selectedProvider.id === activeId && (
            <Text color={theme.status.warning}>
              This is the current provider; another configured provider will be
              used instead.
            </Text>
          )}
        </Box>
        <Box marginTop={1}>
          <DescriptiveRadioButtonSelect
            items={confirmItems}
            onSelect={handleConfirmSelect}
            showNumbers={true}
          />
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color={theme.status.error}>{error}</Text>
          </Box>
        )}
        {notice && (
          <Box marginTop={1}>
            <Text color={theme.status.warning}>{notice}</Text>
          </Box>
        )}
        <Footer busy={busy} text="(Enter to select · Esc to go back)" />
      </DialogFrame>
    );
  }

  if (phase.status === 'actions' && selectedProvider) {
    return (
      <DialogFrame title="Provider actions">
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.text.primary}>{selectedProvider.label}</Text>
          <Text color={theme.text.secondary}>
            {selectedProvider.id} · {selectedProvider.baseUrl}
          </Text>
          {selectedProvider.id === activeId && (
            <Text color={theme.status.success}>● current provider</Text>
          )}
        </Box>
        <Box marginTop={1}>
          <DescriptiveRadioButtonSelect
            items={actionItems}
            onSelect={handleActionSelect}
            showNumbers={true}
          />
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color={theme.status.error}>{error}</Text>
          </Box>
        )}
        {notice && (
          <Box marginTop={1}>
            <Text color={theme.status.warning}>{notice}</Text>
          </Box>
        )}
        <Footer busy={busy} text="(Enter to select · Esc to go back)" />
      </DialogFrame>
    );
  }

  return (
    <DialogFrame title="Select Provider">
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>{getOpenAiProvidersPath()}</Text>
      </Box>
      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={providerItems}
          onSelect={(providerId) => setPhase({ status: 'actions', providerId })}
          initialIndex={Math.max(
            0,
            providerItems.findIndex((item) => item.value === activeId),
          )}
          showNumbers={true}
        />
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{error}</Text>
        </Box>
      )}
      {notice && (
        <Box marginTop={1}>
          <Text color={theme.status.warning}>{notice}</Text>
        </Box>
      )}
      <Footer
        busy={busy}
        text="(Enter to manage · Tab to reload · Esc to close)"
      />
    </DialogFrame>
  );
}

interface DialogFrameProps {
  title: string;
  children: React.ReactNode;
}

function DialogFrame({ title, children }: DialogFrameProps): React.JSX.Element {
  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
    >
      <Text bold>{title}</Text>
      {children}
    </Box>
  );
}

interface FooterProps {
  busy: boolean;
  text: string;
}

function Footer({ busy, text }: FooterProps): React.JSX.Element {
  return (
    <Box marginTop={1}>
      <Text color={busy ? theme.status.warning : theme.text.secondary}>
        {busy ? 'Working…' : text}
      </Text>
    </Box>
  );
}

function readProviders(): LoadState {
  try {
    const entries = loadProviderEntries();
    return {
      status: 'ready',
      providers: entries.map((entry) => ({
        id: entry.id,
        label: entry.label ?? entry.id,
        baseUrl: entry.baseUrl,
      })),
    };
  } catch (error) {
    return { status: 'error', message: getErrorMessage(error) };
  }
}
