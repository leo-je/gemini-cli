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
import * as path from 'node:path';
import { debugLogger } from '../../utils/debugLogger.js';
import { getErrorMessage } from '../../utils/errors.js';
import {
  getOpenAiProvidersPath,
  loadProviderEntries,
  validateProviderModels,
  type OpenAiProviderModel,
} from './providers.js';
import type { RemoteModel } from './openaiClient.js';

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

/** The two numbers a provider file can carry per model. */
const TOKEN_SETTING_FIELDS = ['contextWindowSize', 'maxToken'] as const;
type TokenSettingField = (typeof TOKEN_SETTING_FIELDS)[number];

/** One number this module filled in from the endpoint's own catalog. */
interface AutoTokenSetting {
  value: number;
  /** When the endpoint last reported this value. */
  fetchedAt: string;
}

type AutoModelSettings = Partial<Record<TokenSettingField, AutoTokenSetting>>;
type AutoProviderSettings = Record<string, AutoModelSettings>;
type AutoSettingsDocument = Record<string, AutoProviderSettings>;

/**
 * Where the values this module filled in itself are remembered.
 *
 * Kept beside the provider file rather than inside it on purpose: every
 * released version validates a provider entry with a strict schema, so an extra
 * key on a model entry makes an older CLI reject the whole provider file —
 * including its credentials. A sidecar file is invisible to those versions,
 * which simply keep treating the numbers they find as the user's own, so a
 * downgrade degrades into "no automatic refresh" instead of "cannot start".
 */
export function getAutoSettingsPath(
  filePath: string = getOpenAiProvidersPath(),
): string {
  return path.join(
    path.dirname(filePath),
    `${path.basename(filePath, '.json')}.auto.json`,
  );
}

/**
 * Reads the provenance file, best-effort.
 *
 * A missing, unreadable or malformed file reads as empty, which is the
 * conservative direction: without a record a saved number is the user's, so it
 * is never overwritten.
 */
/** A positive whole number, or `undefined` for anything else. */
function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** A non-empty string, or `undefined` for anything else. */
function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function readAutoSettings(filePath: string): AutoSettingsDocument {
  const document: AutoSettingsDocument = {};
  if (!fs.existsSync(filePath)) {
    return document;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''),
    );
  } catch (error) {
    debugLogger.debug(
      `Could not read ${filePath}; saved token settings count as user-set: ${getErrorMessage(error)}`,
    );
    return document;
  }
  if (!isRecord(parsed)) return document;

  for (const [providerId, models] of Object.entries(parsed)) {
    if (!isRecord(models)) continue;
    const providerSettings: AutoProviderSettings = {};
    for (const [modelId, fields] of Object.entries(models)) {
      if (!isRecord(fields)) continue;
      const modelSettings: AutoModelSettings = {};
      for (const field of TOKEN_SETTING_FIELDS) {
        const setting = fields[field];
        if (!isRecord(setting)) continue;
        const value = readPositiveInteger(setting['value']);
        if (value === undefined) continue;
        modelSettings[field] = {
          value,
          fetchedAt: readText(setting['fetchedAt']) ?? '',
        };
      }
      if (Object.keys(modelSettings).length > 0) {
        providerSettings[modelId] = modelSettings;
      }
    }
    if (Object.keys(providerSettings).length > 0) {
      document[providerId] = providerSettings;
    }
  }
  return document;
}

/**
 * Writes the provenance file, best-effort, and removes it once it holds nothing.
 *
 * Failing to record provenance is not a user-visible problem: it only means the
 * next fetch treats the number as hand-set and leaves it alone.
 */
function writeAutoSettings(
  document: AutoSettingsDocument,
  filePath: string,
): boolean {
  for (const providerId of Object.keys(document)) {
    const providerSettings = document[providerId];
    for (const modelId of Object.keys(providerSettings)) {
      if (Object.keys(providerSettings[modelId]).length === 0) {
        delete providerSettings[modelId];
      }
    }
    if (Object.keys(providerSettings).length === 0) delete document[providerId];
  }

  try {
    if (Object.keys(document).length === 0) {
      fs.rmSync(filePath, { force: true });
      return true;
    }
    fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return true;
  } catch (error) {
    debugLogger.debug(
      `Could not record auto-filled token settings in ${filePath}: ${getErrorMessage(error)}`,
    );
    return false;
  }
}

/** Forgets that this module supplied the given numbers, so they count as the user's. */
function forgetAutoSettings(
  providerId: string,
  modelId: string,
  fields: TokenSettingField[],
  filePath: string,
): void {
  if (fields.length === 0) return;
  const autoPath = getAutoSettingsPath(filePath);
  const document = readAutoSettings(autoPath);
  const providerSettings = document[providerId];
  const record = providerSettings?.[modelId];
  if (!providerSettings || !record) return;

  for (const field of fields) delete record[field];
  if (Object.keys(record).length === 0) delete providerSettings[modelId];
  writeAutoSettings(document, autoPath);
}

/**
 * Merges freshly fetched models into the saved list, filling in the token
 * limits the endpoint advertises.
 *
 * The rules, in the order they matter:
 *
 * 1. A number the user typed is never overwritten. Requirement, not politeness:
 *    providers get these wrong, and the value drives compression.
 * 2. An empty field is filled from the endpoint, and the fact that it was
 *    filled here is recorded, so a later fetch may revise its own value.
 * 3. A number without that record counts as the user's, which is also what
 *    happens when the sidecar is missing or a value was edited by hand.
 *
 * `fetched` must come from the endpoint, so an empty list is a no-op rather
 * than a wipe of what the user configured.
 */
export function mergeProviderModels(
  providerId: string,
  fetched: Array<string | RemoteModel>,
  filePath: string = getOpenAiProvidersPath(),
): boolean {
  const incoming = new Map<
    string,
    Pick<RemoteModel, 'contextWindowSize' | 'maxToken'>
  >();
  for (const entry of fetched) {
    const model = typeof entry === 'string' ? { modelId: entry } : entry;
    const modelId = model?.modelId.trim();
    if (!modelId) continue;
    const previous = incoming.get(modelId);
    incoming.set(modelId, {
      contextWindowSize: model.contextWindowSize ?? previous?.contextWindowSize,
      maxToken: model.maxToken ?? previous?.maxToken,
    });
  }
  if (incoming.size === 0) {
    return false;
  }

  const existing = new Map(
    getProviderModels(providerId, filePath).map((model) => [
      model.modelId,
      model,
    ]),
  );
  const autoPath = getAutoSettingsPath(filePath);
  const autoDocument = readAutoSettings(autoPath);
  const providerAuto: AutoProviderSettings = { ...autoDocument[providerId] };
  const fetchedAt = new Date().toISOString();
  const merged: OpenAiProviderModel[] = [];

  for (const [modelId, limits] of incoming) {
    const saved = cleanModel(existing.get(modelId) ?? { modelId });
    const record: AutoModelSettings = { ...providerAuto[modelId] };

    for (const field of TOKEN_SETTING_FIELDS) {
      const reported = limits[field];
      if (reported === undefined) continue;
      const value = saved[field];
      // A record whose value no longer matches means the user has edited it
      // since; from here on the number is theirs.
      if (record[field] && record[field].value !== value) delete record[field];

      if (value === undefined) {
        saved[field] = reported;
        record[field] = { value: reported, fetchedAt };
      } else if (value !== reported && record[field]) {
        saved[field] = reported;
        record[field] = { value: reported, fetchedAt };
      }
    }

    if (Object.keys(record).length === 0) delete providerAuto[modelId];
    else providerAuto[modelId] = record;
    merged.push(saved);
  }

  // Retired models must not leave provenance behind, or a model that comes back
  // later would silently reclaim ownership of a number the user has since set.
  for (const modelId of Object.keys(providerAuto)) {
    if (!incoming.has(modelId)) delete providerAuto[modelId];
  }

  if (!setProviderModels(providerId, merged, filePath)) {
    return false;
  }
  if (Object.keys(providerAuto).length > 0) {
    autoDocument[providerId] = providerAuto;
  } else {
    delete autoDocument[providerId];
  }
  writeAutoSettings(autoDocument, autoPath);
  return true;
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
  if (!setProviderModels(providerId, updated, filePath)) {
    return false;
  }
  // Hand-entered numbers take ownership away from any auto-filled value.
  forgetAutoSettings(
    providerId,
    modelId,
    TOKEN_SETTING_FIELDS.filter((field) => settings[field] !== undefined),
    filePath,
  );
  return true;
}
