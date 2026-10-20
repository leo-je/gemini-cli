/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reads and writes the `models` array of a provider profile.
 *
 * Split from `providers.ts` so the reader/writer of the profile file keeps its
 * focused job, and so the numerically sensitive part — the per-model overrides
 * the rest of the CLI consumes — has a single implementation. The writers
 * follow `persistProviderModelId`: the raw JSON is rewritten, which preserves
 * hand-edited key order and any field this version does not know about.
 *
 * Every reader is best-effort. A provider file that cannot be read or parsed is
 * already reported by the auth gate; failing again from a display path would
 * only hide the picker behind an error the user cannot act on.
 */

import * as fs from 'node:fs';
import { debugLogger } from '../../utils/debugLogger.js';
import { getErrorMessage } from '../../utils/errors.js';
import {
  getOpenAiProvidersPath,
  loadProviderEntries,
  validateProviderModels,
  type OpenAiProviderModel,
} from './providers.js';

/** Narrows an unknown to a plain JSON object. Arrays are excluded. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Drops `undefined` fields so they do not survive as explicit nulls. */
function cleanModel(model: OpenAiProviderModel): OpenAiProviderModel {
  const cleaned: OpenAiProviderModel = { modelId: model.modelId };
  if (model.contextWindowSize !== undefined) {
    cleaned.contextWindowSize = model.contextWindowSize;
  }
  if (model.maxToken !== undefined) {
    cleaned.maxToken = model.maxToken;
  }
  return cleaned;
}

/**
 * The saved model entries for one provider, or `[]` when there are none.
 *
 * Reads the credential-free view: `loadProviderEntries` deliberately does not
 * resolve keys, so listing models keeps working when the key's environment
 * variable is only set in the session being started.
 */
export function getProviderModels(
  providerId: string | undefined,
  filePath: string = getOpenAiProvidersPath(),
): OpenAiProviderModel[] {
  if (!providerId) {
    return [];
  }
  try {
    const entry = loadProviderEntries(filePath).find(
      (candidate) => candidate.id === providerId,
    );
    return entry?.models ?? [];
  } catch (error) {
    debugLogger.debug(
      `Could not read the models of provider "${providerId}": ${getErrorMessage(error)}`,
    );
    return [];
  }
}

/** The saved settings for one model, if the provider records them. */
export function getProviderModelSettings(
  providerId: string | undefined,
  modelId: string | undefined,
  filePath: string = getOpenAiProvidersPath(),
): OpenAiProviderModel | undefined {
  if (!providerId || !modelId) {
    return undefined;
  }
  return getProviderModels(providerId, filePath).find(
    (model) => model.modelId === modelId,
  );
}

/**
 * Rewrites one provider entry in the raw document.
 *
 * Returns `false` instead of throwing for every failure: callers are UI paths
 * that report their own message, and a read-only home directory must not break
 * the dialog. The mutation receives the raw entry so the caller can write a
 * field this module does not model.
 */
function updateProviderEntry(
  providerId: string,
  mutate: (entry: Record<string, unknown>) => void,
  filePath: string,
  what: string,
): boolean {
  let document: unknown;
  try {
    document = JSON.parse(
      fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''),
    );
  } catch (error) {
    debugLogger.debug(
      `Could not read ${filePath} to record the ${what} of "${providerId}": ${getErrorMessage(error)}`,
    );
    return false;
  }

  if (!isRecord(document) || !Array.isArray(document['providers'])) {
    return false;
  }

  let changed = false;
  for (const entry of document['providers'] as unknown[]) {
    if (isRecord(entry) && entry['id'] === providerId) {
      mutate(entry);
      changed = true;
    }
  }
  if (!changed) {
    return false;
  }

  try {
    fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      // The file may carry a literal key, so it keeps its private mode.
      mode: 0o600,
    });
    return true;
  } catch (error) {
    debugLogger.debug(
      `Could not record the ${what} of "${providerId}" in ${filePath}: ${getErrorMessage(error)}`,
    );
    return false;
  }
}

/**
 * Replaces a provider's model list wholesale.
 *
 * Throws when the input is not a valid list — that is a programming error, not
 * a disk problem, and silently dropping it would leave the UI showing a list
 * that was never saved.
 */
export function setProviderModels(
  providerId: string,
  models: OpenAiProviderModel[],
  filePath: string = getOpenAiProvidersPath(),
): boolean {
  const validated = validateProviderModels(models).map(cleanModel);
  return updateProviderEntry(
    providerId,
    (entry) => {
      entry['models'] = validated;
    },
    filePath,
    'model list',
  );
}

/**
 * Merges freshly fetched model ids into the saved list.
 *
 * Entries already saved keep their `contextWindowSize` / `maxToken` overrides;
 * only the set of ids is refreshed. `fetched` must come from the endpoint, so
 * an empty list is a no-op rather than a wipe of what the user configured.
 */
export function mergeProviderModels(
  providerId: string,
  fetched: string[],
  filePath: string = getOpenAiProvidersPath(),
): boolean {
  const unique = [...new Set(fetched.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return false;
  }
  const existing = getProviderModels(providerId, filePath);
  const byId = new Map(existing.map((model) => [model.modelId, model]));
  const merged = unique.map((id) => byId.get(id) ?? { modelId: id });
  return setProviderModels(providerId, merged, filePath);
}

/**
 * Records the chosen model and, when supplied, its token overrides.
 *
 * An omitted override means "leave what is there"; passing `undefined`
 * explicitly is the same as omitting it. To clear a value, pass a number — the
 * two entries the UI writes are both optional numbers, so there is no
 * meaningful "explicitly empty" state to distinguish.
 */
export function saveProviderModelSettings(
  providerId: string,
  modelId: string,
  settings: Pick<OpenAiProviderModel, 'contextWindowSize' | 'maxToken'>,
  filePath: string = getOpenAiProvidersPath(),
): boolean {
  const existing = getProviderModels(providerId, filePath);
  const index = existing.findIndex((model) => model.modelId === modelId);
  const current = index >= 0 ? existing[index] : { modelId };

  const updated = [...existing];
  const next: OpenAiProviderModel = {
    ...current,
    contextWindowSize: settings.contextWindowSize ?? current.contextWindowSize,
    maxToken: settings.maxToken ?? current.maxToken,
  };
  if (index >= 0) {
    updated[index] = next;
  } else {
    updated.push(next);
  }
  return setProviderModels(providerId, updated, filePath);
}
