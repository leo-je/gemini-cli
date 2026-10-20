/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Named OpenAI-compatible provider profiles.
 *
 * The single-endpoint mode configured through `GEMINI_OPENAI_*` can only ever
 * describe one destination per process: one base URL, one key, one header set.
 * A user who alternates between OpenRouter, a local Ollama, and a corporate
 * gateway has to edit environment variables and restart.
 *
 * This module introduces the missing noun — a named provider — and keeps it in
 * a user-level file so the set of destinations belongs to the person, not to
 * whichever workspace happens to be open.
 *
 * The file is deliberately *not* the place credentials normally live. A
 * provider usually names the environment variable holding its key
 * (`apiKeyEnv`), which keeps keys in `.env`, under the same trust filtering and
 * file permissions as the rest of the CLI. A literal `apiKey` is still accepted
 * because a first-run user has to get the value from somewhere, but the file is
 * only trusted when it is unreadable by anyone else.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { Storage } from '../../config/storage.js';
import { debugLogger } from '../../utils/debugLogger.js';
import { getErrorMessage } from '../../utils/errors.js';
import {
  HEADER_NAME_PATTERN,
  readEnvValue,
  toHeaderValue,
} from './constants.js';

/** The user-level provider file, alongside `settings.json` and `.env`. */
export function getOpenAiProvidersPath(): string {
  return path.join(Storage.getGlobalGeminiDir(), 'openai-providers.json');
}

/**
 * A provider id ends up in error messages and in `/provider use <id>`, so it is
 * kept to an unambiguous token: no whitespace, no leading dash (which would
 * read as a flag), and nothing that needs escaping in a shell.
 */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Env var names must be usable as `process.env[...]` keys and in `.env`. */
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * One model entry under a provider's optional `models` array.
 *
 * The array is the place a provider records the numbers an OpenAI-compatible
 * endpoint does not advertise: the real context window and the maximum output
 * tokens. Both are optional, so the array can also just be a saved copy of the
 * endpoint's model list.
 */
export interface OpenAiProviderModel {
  modelId: string;
  /** Total context window of the model, in tokens. */
  contextWindowSize?: number;
  /** Maximum output tokens to request from the model. */
  maxToken?: number;
}

const providerModelSchema = z
  .object({
    modelId: z.string().min(1),
    contextWindowSize: z.number().int().positive().optional(),
    maxToken: z.number().int().positive().optional(),
  })
  .strict();

const providerSchema = z
  .object({
    id: z
      .string()
      .regex(
        PROVIDER_ID_PATTERN,
        'must start with a letter or digit and contain only letters, digits, "-", and "_"',
      ),
    label: z.string().min(1).optional(),
    baseUrl: z.string().min(1),
    modelId: z.string().min(1).optional(),
    apiKeyEnv: z
      .string()
      .regex(ENV_VAR_NAME_PATTERN, 'must be a valid environment variable name')
      .optional(),
    apiKey: z.string().min(1).optional(),
    headers: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    /** Saved model list with optional per-model overrides. */
    models: z.array(providerModelSchema).optional(),
  })
  .strict();

const providersFileSchema = z
  .object({
    providers: z.array(providerSchema),
  })
  .strict();

/** A provider profile as the rest of the CLI consumes it. */
export interface OpenAiProviderProfile {
  id: string;
  label: string;
  baseUrl: string;
  modelId?: string;
  /** Resolved credential for this session, if any. */
  apiKey?: string;
  /** Resolved headers, coerced to strings. */
  headers: Record<string, string>;
}

type ProviderEntry = z.infer<typeof providerSchema>;

/**
 * Reads and validates the provider file.
 *
 * A missing file is not an error — it is the state every existing user is in,
 * and the caller falls back to the environment-variable endpoint. A file that
 * exists but is malformed *is* an error: it was written by someone who expects
 * it to be used, and silently ignoring it would leave them talking to a
 * different endpoint than the one they configured.
 */
export function loadProviderEntries(
  filePath: string = getOpenAiProvidersPath(),
): ProviderEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    // An absent file is the normal state, not a failure. Checked with an `in`
    // guard rather than a cast so an error of an unexpected shape falls through
    // to being reported instead of being trusted into a code field.
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return [];
    }
    throw new Error(`Could not read ${filePath}: ${getErrorMessage(error)}`);
  }

  // A BOM (added by some editors) survives JSON.parse into the first key and
  // makes the whole file unreadable, which is a confusing way to learn that.
  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `${filePath} must be valid JSON (${getErrorMessage(error)}).`,
    );
  }

  const result = providersFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `${filePath} is not a valid provider file: ${formatZodError(result.error)}`,
    );
  }

  const seen = new Set<string>();
  for (const entry of result.data.providers) {
    if (seen.has(entry.id)) {
      throw new Error(
        `${filePath} defines the provider id "${entry.id}" more than once. Provider ids must be unique.`,
      );
    }
    seen.add(entry.id);
  }

  assertSafeFilePermissions(filePath, result.data.providers);
  return result.data.providers;
}

/**
 * Rejects a provider file that holds a literal key but is readable by others.
 *
 * A credential in a world- or group-readable file is exactly what `.env` mode
 * 0600 exists to prevent, and the check has to happen before the value is used
 * rather than as a warning: by the time the user notices, the secret has been
 * sitting on disk in the clear.
 *
 * Only literal `apiKey` fields trigger this. `apiKeyEnv` names a variable and
 * is not itself a secret, so a shared-but-readable file remains usable for the
 * common case.
 */
function assertSafeFilePermissions(
  filePath: string,
  providers: ProviderEntry[],
): void {
  const holdsLiteralKey = providers.some(
    (provider) => provider.apiKey !== undefined,
  );
  if (!holdsLiteralKey) {
    return;
  }

  let mode: number;
  try {
    mode = fs.statSync(filePath).mode;
  } catch (error) {
    throw new Error(
      `${filePath} could not be inspected: ${getErrorMessage(error)}`,
    );
  }

  // Windows does not model POSIX permission bits; reporting every file as
  // insecure there would make the feature unusable rather than safer.
  if (process.platform === 'win32') {
    return;
  }

  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${filePath} contains a literal "apiKey" but is readable by other users (mode ${(mode & 0o777).toString(8)}). Restrict it with "chmod 600 ${filePath}", or move the key into an environment variable and reference it with "apiKeyEnv".`,
    );
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${at}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Validates a `models` array before it is written back to the provider file.
 *
 * The writer rewrites the raw JSON without a round-trip through the reader, so
 * an invalid entry would only be discovered on the next start — when the whole
 * provider file fails to load. Checking here keeps a bad edit a rejected write
 * instead of a file the CLI can no longer read.
 */
export function validateProviderModels(models: unknown): OpenAiProviderModel[] {
  const parsed = z.array(providerModelSchema).safeParse(models);
  if (!parsed.success) {
    throw new Error(`Invalid models list: ${formatZodError(parsed.error)}`);
  }
  const seen = new Set<string>();
  for (const model of parsed.data) {
    if (seen.has(model.modelId)) {
      throw new Error(
        `The model "${model.modelId}" is listed more than once in this provider.`,
      );
    }
    seen.add(model.modelId);
  }
  return parsed.data;
}

/** Narrows an unknown to a plain JSON object. Arrays are excluded. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolves the credential for one provider.
 *
 * `apiKeyEnv` is read through `readEnvValue` so `Config.env` (populated by
 * `.env` loading) takes priority exactly as it does for the single-endpoint
 * mode. A literal `apiKey` is the fallback, not the primary: a user who has
 * both has just added an env var and expects it to win.
 */
function resolveApiKey(
  entry: ProviderEntry,
  configEnv?: Record<string, string>,
): string | undefined {
  if (entry.apiKeyEnv) {
    const fromEnv = readEnvValue(entry.apiKeyEnv, configEnv);
    if (fromEnv !== undefined) {
      return fromEnv;
    }
    // Naming a variable that is not set is a configuration mistake, not an
    // unauthenticated endpoint. Saying so beats sending no credential and
    // letting the endpoint answer with an unexplained 401.
    throw new Error(
      `Provider "${entry.id}" references the environment variable ${entry.apiKeyEnv}, which is not set.`,
    );
  }
  return entry.apiKey;
}

/**
 * Validates and normalizes a provider's headers.
 *
 * Deliberately routed through the same guards `GEMINI_OPENAI_HEADERS` uses:
 * header names must be RFC 9110 field-names, values must be free of control
 * characters (CR/LF are the header-injection vector) and representable in
 * Latin-1. A second, laxer path here would just be a way to smuggle in a header
 * the environment-variable route would have rejected.
 */
function toHeaders(
  entry: ProviderEntry,
  filePath: string,
): Record<string, string> {
  if (!entry.headers) {
    return {};
  }
  const source = `${filePath} (provider "${entry.id}")`;
  const headers = new Map<string, string>();
  const spellings = new Map<string, string>();
  for (const [name, value] of Object.entries(entry.headers)) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new Error(
        `${source} contains an invalid header name: ${JSON.stringify(name)}.`,
      );
    }
    // HTTP header names are case-insensitive, so two spellings of one name is a
    // typo, not a merge — the same rule the env-var parser applies.
    const folded = name.toLowerCase();
    const previous = spellings.get(folded);
    if (previous !== undefined) {
      throw new Error(
        `${source} sets the same header twice under different names: ${JSON.stringify(previous)} and ${JSON.stringify(name)}.`,
      );
    }
    spellings.set(folded, name);
    headers.set(name, toHeaderValue(name, value, source));
  }
  return Object.fromEntries(headers);
}

/** Materializes a profile, resolving its credential and headers. */
export function toProfile(
  entry: ProviderEntry,
  configEnv?: Record<string, string>,
  filePath: string = getOpenAiProvidersPath(),
): OpenAiProviderProfile {
  return {
    id: entry.id,
    label: entry.label ?? entry.id,
    baseUrl: entry.baseUrl,
    modelId: entry.modelId,
    apiKey: resolveApiKey(entry, configEnv),
    headers: toHeaders(entry, filePath),
  };
}

/**
 * Resolves which provider the session should use, if any.
 *
 * Precedence is: an explicit session choice (the `/provider` command, held in
 * memory) > `GEMINI_OPENAI_PROVIDER` > the first entry in the file. The file
 * wins over the ambient `GEMINI_OPENAI_*` variables only when it actually
 * yields a provider, so every existing single-endpoint configuration keeps
 * working untouched.
 */
export function resolveProvider(
  requestedId: string | undefined,
  filePath: string = getOpenAiProvidersPath(),
  configEnv?: Record<string, string>,
): OpenAiProviderProfile | undefined {
  const entries = loadProviderEntries(filePath);
  if (entries.length === 0) {
    if (requestedId) {
      throw new Error(
        `No providers are configured in ${filePath}, so "${requestedId}" cannot be resolved. Run /provider add to create one.`,
      );
    }
    return undefined;
  }

  if (!requestedId) {
    return toProfile(entries[0], configEnv, filePath);
  }

  const entry = entries.find((candidate) => candidate.id === requestedId);
  if (!entry) {
    const known = entries.map((candidate) => candidate.id).join(', ');
    throw new Error(
      `Unknown provider "${requestedId}". Configured providers: ${known}.`,
    );
  }
  return toProfile(entry, configEnv, filePath);
}

/** The env variable that preselects a provider without the slash command. */
export const OPENAI_PROVIDER_ENV = 'GEMINI_OPENAI_PROVIDER';

/**
 * Reads a provider with no explicit session choice, consulting
 * `GEMINI_OPENAI_PROVIDER`.
 */
export function resolveProviderFromEnv(
  configEnv?: Record<string, string>,
): OpenAiProviderProfile | undefined {
  const requested = readEnvValue(OPENAI_PROVIDER_ENV, configEnv);
  return resolveProvider(requested, getOpenAiProvidersPath(), configEnv);
}

/**
 * The fields a caller supplies when creating a provider.
 *
 * Deliberately narrower than the on-disk entry: `apiKey` is accepted here but
 * callers are expected to store it in `.env` and pass `apiKeyEnv` instead, so
 * the file stays free of secrets in the common case.
 */
export interface OpenAiProviderInput {
  id: string;
  label?: string;
  baseUrl: string;
  modelId?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

/**
 * Appends a provider to the user-level file, creating it when absent.
 *
 * The entry is validated through the same schema the reader uses before it is
 * written, so a file the writer produced can always be read back. Unknown
 * top-level keys in an existing file are preserved for the same reason
 * `persistProviderModelId` preserves them: a hand-edited file is the norm here.
 *
 * Throws with a message intended for the user when the input is rejected; the
 * caller surfaces it in the transcript rather than failing the session.
 */
export function addProvider(
  input: OpenAiProviderInput,
  filePath: string = getOpenAiProvidersPath(),
): void {
  const parsed = providerSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Cannot save provider: ${formatZodError(parsed.error)}`);
  }

  let document: unknown = { providers: [] };
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch {
    // First provider: start from an empty document.
  }

  if (existing.trim().length > 0) {
    try {
      document = JSON.parse(existing.replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new Error(
        `${filePath} must be valid JSON before a provider can be added (${getErrorMessage(error)}).`,
      );
    }
  }

  if (!isRecord(document)) {
    throw new Error(
      `${filePath} must contain a JSON object with a "providers" array.`,
    );
  }

  const providers = document['providers'];
  if (providers !== undefined && !Array.isArray(providers)) {
    throw new Error(`${filePath} has a "providers" key that is not an array.`);
  }
  const list: unknown[] = Array.isArray(providers) ? providers : [];

  for (const provider of list) {
    if (isRecord(provider) && provider['id'] === input.id) {
      throw new Error(
        `A provider with the id "${input.id}" already exists in ${filePath}.`,
      );
    }
  }

  list.push(parsed.data);
  document['providers'] = list;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      // The entry may carry a literal key; creating the file private avoids
      // relying on the umask for a secret.
      mode: 0o600,
    });
  } catch (error) {
    throw new Error(`Could not write ${filePath}: ${getErrorMessage(error)}`);
  }
}

/**
 * Records the model the user picked for a provider, so the next session opens
 * on the same one.
 *
 * The file is rewritten from the raw JSON rather than from the validated
 * entries: a hand-edited file keeps its key order, and fields this version does
 * not know about are preserved instead of being dropped by a round-trip through
 * the schema. Best-effort — a read-only home directory must not stop a session
 * that is otherwise working.
 */
export function persistProviderModelId(
  providerId: string,
  modelId: string,
  filePath: string = getOpenAiProvidersPath(),
): boolean {
  let document: unknown;
  try {
    document = JSON.parse(
      fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''),
    );
  } catch (error) {
    debugLogger.debug(
      `Could not read ${filePath} to record the model for "${providerId}": ${getErrorMessage(error)}`,
    );
    return false;
  }

  if (!isRecord(document)) {
    return false;
  }
  const providers = document['providers'];
  if (!Array.isArray(providers)) {
    return false;
  }

  let changed = false;
  for (const provider of providers as unknown[]) {
    if (!isRecord(provider)) {
      continue;
    }
    if (provider['id'] === providerId) {
      provider['modelId'] = modelId;
      changed = true;
    }
  }
  if (!changed) {
    return false;
  }

  try {
    fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      // The file may carry a literal key, so it is created private by default
      // rather than left to the umask.
      mode: 0o600,
    });
    return true;
  } catch (error) {
    debugLogger.debug(
      `Could not record the model for "${providerId}" in ${filePath}: ${getErrorMessage(error)}`,
    );
    return false;
  }
}
