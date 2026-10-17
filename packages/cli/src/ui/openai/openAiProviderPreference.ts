/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Remembers which OpenAI-compatible provider the user chose.
 *
 * The choice used to live only in `Config.activeOpenAiProviderId`, a
 * session-scoped field, so every start forgot it and fell back to the provider
 * file's first entry — switching to a provider, quitting, and starting again
 * appeared to lose the selection.
 *
 * It is stored in `settings.json` rather than in the provider file on purpose.
 * The provider file is validated with a *strict* schema, so an extra top-level
 * key makes it unreadable to a build that does not know that key: writing the
 * preference there would break the file for anyone on another version. Settings
 * already store the neighbouring `security.auth.selectedType`, and a preference
 * belongs there anyway — the provider file says which providers exist, this says
 * which one is in use.
 *
 * All of the preference logic lives here so the upstream settings schema and
 * `Config` only gain a key and a call site.
 */

import {
  SettingScope,
  type LoadableSettingScope,
  type MergedSettings,
} from '../../config/settings.js';
import {
  AuthType,
  loadProviderEntries,
  persistProviderModelId,
} from '@google/gemini-cli-core';

/** The persisted provider choice, under `security.auth`. */
export const OPENAI_PROVIDER_SETTING_KEY = 'security.auth.openAiProviderId';

/** The persisted auth mode, next to the provider choice. */
const AUTH_MODE_SETTING_KEY = 'security.auth.selectedType';

/** The subset of settings this module reads; kept structural for tests. */
export interface ProviderPreferenceSettings {
  security?: {
    auth?: {
      openAiProviderId?: string;
    };
  };
}

/**
 * The provider id the user last selected, if any.
 *
 * Returns `undefined` when nothing was ever persisted, which is the signal for
 * the caller to fall back to the provider file's first entry.
 */
export function readPersistedProviderId(
  settings: ProviderPreferenceSettings | undefined,
): string | undefined {
  const id = settings?.security?.auth?.openAiProviderId;
  return typeof id === 'string' && id.trim().length > 0 ? id : undefined;
}

/** The slice of `LoadedSettings` needed to persist; kept structural for tests. */
export interface ProviderPreferenceWriter {
  setValue: (scope: LoadableSettingScope, key: string, value: unknown) => void;
  merged?: MergedSettings;
}

/**
 * Records the chosen provider so the next start uses it.
 *
 * Written at user scope, matching how the auth method itself is persisted: the
 * choice is a property of the person, not of the directory they happen to run
 * the CLI in.
 *
 * Best effort. A read-only home directory must not fail a switch that otherwise
 * worked, so a write error is swallowed rather than surfaced — the session is
 * already using the provider the user asked for.
 */
export function persistProviderId(
  settings: ProviderPreferenceWriter,
  providerId: string,
): void {
  try {
    settings.setValue(
      SettingScope.User,
      OPENAI_PROVIDER_SETTING_KEY,
      providerId,
    );
  } catch {
    // Ignored on purpose; see the doc comment above.
  }
}

/**
 * Records OpenAI mode as the chosen auth type.
 *
 * The auth dialog normally writes `security.auth.selectedType`, but the setup
 * step a first run goes through replaces that dialog: it collects a provider
 * profile without ever naming a mode. A start that then found nothing recorded
 * asked which mode to use, which is how a user who had just built a complete
 * endpoint was sent back to the mode picker on the next launch.
 */
export function persistOpenAiMode(settings: ProviderPreferenceWriter): void {
  try {
    settings.setValue(
      SettingScope.User,
      AUTH_MODE_SETTING_KEY,
      AuthType.USE_OPENAI,
    );
  } catch {
    // Ignored on purpose; see the doc comment on `persistProviderId`.
  }
}

/**
 * Whether a provider declares a default model.
 *
 * A provider without one is supported by design — the session is meant to pick
 * from the endpoint's catalog — but nothing used to ask for that pick, so the
 * next message failed with a message about environment variables. The caller
 * uses this to open the model list right after a switch.
 *
 * Anything unreadable or unrecognizable reports `true`, so the caller takes the
 * ordinary path. This only runs after a switch succeeded, so a provider that
 * cannot be found here means the file changed underneath the session, and
 * guessing "no default model" would open a list for the wrong reason.
 */
/**
 * Whether the provider file holds at least one entry, readable or not — an
 * unreadable file is reported by the auth gate, and treating it as empty here
 * would hide the picker behind a form the user did not ask for.
 */
export function hasConfiguredProviders(): boolean {
  try {
    return loadProviderEntries().length > 0;
  } catch {
    return false;
  }
}

export function providerHasDefaultModel(providerId: string): boolean {
  try {
    const entry = loadProviderEntries().find(
      (candidate) => candidate.id === providerId,
    );
    if (!entry) {
      return true;
    }
    return Boolean(entry.modelId);
  } catch {
    return true;
  }
}

/**
 * Records the model the user picked from a provider's catalog.
 *
 * The OpenAI model list offers no "remember this" control: `ModelDialog` returns
 * the fork's dialog before the Gemini branch renders that toggle, so in practice
 * the flag keeps its `false` default and every pick was applied with
 * `isTemporary`, i.e. for this session only. Restarting then showed the
 * provider's default or `auto`.
 *
 * Written as the provider's own `modelId` rather than into the Gemini model
 * setting, so one provider cannot inherit another's model and a Gemini session
 * keeps its own selection. `refreshAuth` already pins a provider's `modelId` at
 * startup, so restoring the choice needs nothing else.
 *
 * Nothing to do without an active provider — an env-configured single endpoint
 * keeps `GEMINI_OPENAI_MODELID` as its persistent source. Best effort, like the
 * other writers here: a read-only home directory must not break the session.
 */
export function rememberModelForProvider(
  providerId: string | undefined,
  modelId: string,
): void {
  if (!providerId || modelId.trim().length === 0) {
    return;
  }
  persistProviderModelId(providerId, modelId);
}
