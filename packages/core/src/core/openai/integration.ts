/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single entry point for every hook this fork adds to upstream Gemini CLI
 * files.
 *
 * Rationale: this feature is a local extension. Upstream files such as
 * `contentGenerator.ts`, `config.ts`, and `slashCommandProcessor.ts` are
 * rewritten frequently, so every line added to them is a future merge conflict.
 * Keeping the *logic* here and calling it through one thin function means an
 * upstream change touches at most a one-line call site, which is trivial to
 * re-apply.
 *
 * Rules for this directory:
 *   - Nothing upstream imports from here except through the small functions
 *     exported below.
 *   - This directory imports from upstream; upstream must not import its
 *     internals.
 */

import type { Config } from '../../config/config.js';
import { AuthType, type ContentGeneratorConfig } from '../contentGenerator.js';
import { coreEvents } from '../../utils/events.js';
import { getErrorMessage } from '../../utils/errors.js';
import * as fs from 'node:fs';
import {
  OPENAI_PROVIDER_ENV,
  getOpenAiProvidersPath,
  persistProviderModelId,
  resolveProvider,
  resolveProviderFromEnv,
  type OpenAiProviderProfile,
} from './providers.js';
import { buildOpencodeDisguiseHeaders } from './opencode/headers.js';
import {
  OPENAI_API_KEY_ENV,
  OPENAI_API_KEY_FALLBACK_ENV,
  OPENAI_BASE_URL_ENV,
  OPENAI_BASE_URL_FALLBACK_ENV,
  type readEnvValue,
} from './constants.js';

/** Signature of the upstream env reader, injected to avoid a hard import. */
type EnvReader = typeof readEnvValue;

/**
 * Fills the OpenAI fields of a content-generator config from a provider
 * profile, leaving whatever the caller already passed untouched.
 *
 * Called from `createContentGeneratorConfig` as a single line. Explicit
 * arguments still win over the profile, because that is the path the
 * `/provider` hot-switch uses to inject the endpoint it chose.
 */
export function applyProviderToContentGeneratorConfig(options: {
  config: Config | undefined;
  authType: AuthType | undefined;
  contentGeneratorConfig: ContentGeneratorConfig;
  apiKey?: string;
  baseUrl?: string;
  customHeaders?: Record<string, string>;
  getEnv: (key: string) => string | undefined;
}): void {
  const {
    config,
    authType,
    contentGeneratorConfig,
    apiKey,
    baseUrl,
    customHeaders,
    getEnv,
  } = options;

  if (authType !== AuthType.USE_OPENAI) {
    return;
  }

  // `allowImplicitProvider` because this call *is* the session setup for the
  // auth type the CLI already committed to. The gate that decided OpenAI mode
  // was usable resolved the provider file's first entry; this must resolve the
  // same profile or the session ends up with no endpoint. See
  // `resolveActiveProvider` for the full reasoning.
  const provider = resolveActiveProvider({
    sessionProviderId: config?.getActiveOpenAiProviderId?.(),
    env: config?.env,
    allowImplicitProvider: true,
  });

  contentGeneratorConfig.providerId = provider?.id;
  // The upstream chains run unconditionally; a provider profile is simply
  // inserted ahead of the environment values, so an existing single-endpoint
  // configuration resolves exactly as it did before.
  contentGeneratorConfig.apiKey =
    apiKey ||
    provider?.apiKey ||
    getEnv(OPENAI_API_KEY_ENV) ||
    getEnv(OPENAI_API_KEY_FALLBACK_ENV) ||
    '';
  contentGeneratorConfig.baseUrl =
    baseUrl ||
    provider?.baseUrl ||
    getEnv(OPENAI_BASE_URL_ENV) ||
    getEnv(OPENAI_BASE_URL_FALLBACK_ENV) ||
    '';
  // Provider headers sit *under* the environment-configured ones so a
  // per-session override still wins, matching the request layer's precedence.
  if (provider && Object.keys(provider.headers).length > 0) {
    contentGeneratorConfig.customHeaders = {
      ...provider.headers,
      ...customHeaders,
    };
  }
  // OpenCode-compatible endpoints gate on the client identity rather than on
  // the credential, so the disguise sits at the *bottom* of the precedence
  // chain: provider headers above, and any caller-supplied header, still win.
  // Skipped when the session has no id — a fresh random session per request
  // would defeat the endpoint's cache affinity, which keys off this value.
  const opencodeSessionId = config?.getSessionId?.();
  if (config?.getOpenAiOpencodeHeaders?.() && opencodeSessionId) {
    contentGeneratorConfig.customHeaders = {
      ...buildOpencodeDisguiseHeaders({ sessionSignal: opencodeSessionId }),
      // The caller's headers (session-scoped override) still win, including the
      // case where no provider profile was resolved and the block above did not
      // merge them in.
      ...customHeaders,
      ...contentGeneratorConfig.customHeaders,
    };
  }
  contentGeneratorConfig.modelId = provider?.modelId;
}

/**
 * Resolves the provider profile this session should talk to, if any.
 *
 * An *explicit* opt-in is always honoured first: a requested id, a
 * session-scoped choice made by `/provider`, or `GEMINI_OPENAI_PROVIDER`.
 *
 * `allowImplicitProvider` decides what happens when none of those exist:
 *
 *   - `false` (default) returns `undefined`, meaning "no provider
 *     involvement". Every generic caller of `createContentGeneratorConfig`
 *     keeps the upstream behaviour where the ambient variables describe the
 *     endpoint, and nothing depends on the user's personal provider file.
 *     Use this from opt-in paths such as `/provider`.
 *   - `true` falls back to the provider file's first entry. Use this only where
 *     the caller is already committed to OpenAI-compatible mode, because the
 *     answer has to agree with the CLI's auth gate: that gate treats a
 *     configured provider file as enough to skip the endpoint dialog
 *     (`hasResolvableOpenAiProvider` resolves the file's first entry the same
 *     way). When the two disagree, the dialog is skipped and the session is
 *     then built with no endpoint at all, which surfaces as
 *     "OpenAI-compatible mode requires GEMINI_OPENAI_BASE_URL to be set."
 *
 * `resolveProvider` is what supplies the first-entry fallback: an empty
 * `requestedId` resolves to entry zero.
 */
export function resolveActiveProvider(options: {
  requestedId?: string;
  sessionProviderId?: string;
  env?: Record<string, string>;
  allowImplicitProvider?: boolean;
}): OpenAiProviderProfile | undefined {
  const { requestedId, sessionProviderId, env, allowImplicitProvider } =
    options;
  const choice = requestedId ?? sessionProviderId;
  const envChoice = env?.[OPENAI_PROVIDER_ENV];
  if (!choice && !envChoice && !allowImplicitProvider) {
    return undefined;
  }
  if (choice) {
    try {
      return resolveProvider(choice, undefined, env);
    } catch (error) {
      // A choice that came from the caller (`/provider`, or a provider named on
      // the command line) is a live instruction, so a bad id is a real error and
      // must stay one.
      if (requestedId !== undefined) {
        throw error;
      }
      // A session-scoped choice can outlive its provider, because the CLI
      // persists the selection to `settings.json` while the provider file is
      // edited by hand. Degrade to the implicit resolution instead of making
      // the CLI unstartable; `resolveImplicitProvider` reports why.
      return resolveImplicitProvider(sessionProviderId, env);
    }
  }
  if (envChoice) {
    return resolveProviderFromEnv(env);
  }
  return resolveImplicitProvider(undefined, env);
}

/**
 * Resolves the endpoint when nothing usable named a provider.
 *
 * Reading the provider file is allowed here because the caller already
 * committed to OpenAI-compatible mode (`allowImplicitProvider`), and the answer
 * has to match what the auth gate decided — see `resolveActiveProvider`.
 *
 * `staleId` is a selection that could not be resolved, such as a persisted
 * `security.auth.openAiProviderId` whose provider was removed or renamed. It is
 * reported to the user and then ignored, so a hand-edited provider file cannot
 * leave the CLI unable to start.
 */
function resolveImplicitProvider(
  staleId: string | undefined,
  env: Record<string, string> | undefined,
): OpenAiProviderProfile | undefined {
  const fallback = resolveProvider(undefined, undefined, env);
  if (staleId && fallback) {
    coreEvents.emitFeedback(
      'warning',
      `The selected OpenAI provider "${staleId}" is no longer configured, so this session is using "${fallback.id}" instead. Run /provider to choose another.`,
    );
  }
  return fallback;
}

/**
 * Whether a provider profile can stand in for the missing `GEMINI_OPENAI_*`
 * environment variables.
 *
 * Used by the CLI's auth gate: a user whose endpoint lives only in the
 * provider file (chosen via `GEMINI_OPENAI_PROVIDER` or the file's first
 * entry) must not be forced through the endpoint dialog the single-endpoint
 * mode needs. Both a base URL and a model id are required — the dialog
 * collects exactly those two, and a provider without a model id cannot
 * satisfy what the dialog would have provided.
 *
 * This definition of "usable" is the contract the session-building path must
 * honour: the gate skipping the dialog only works if
 * `applyProviderToContentGeneratorConfig` can then resolve the same profile
 * (it passes `allowImplicitProvider: true` for exactly that reason). Keep the
 * two in step — if this accepts something the builder cannot resolve, the
 * session ends up with no endpoint and fails at construction instead.
 *
 * Deliberately swallow errors: a malformed provider file, or one whose
 * permissions the loader rejects, must degrade to "not configured" (the
 * dialog) rather than become a new startup failure. The reason is reported
 * though — see `reportUnreadableProviderFile` — because the user otherwise
 * only sees the endpoint dialog, which describes nothing that is wrong.
 */
export function hasResolvableOpenAiProvider(
  env?: Record<string, string | undefined>,
  filePath?: string,
): boolean {
  try {
    // Callers often hold `process.env`, whose values may be undefined;
    // resolveProvider's contract takes defined strings only, so drop the
    // holes instead of widening every resolver signature.
    const cleanEnv = env
      ? Object.fromEntries(
          Object.entries(env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        )
      : undefined;
    const requestedId = cleanEnv?.[OPENAI_PROVIDER_ENV];
    const profile = resolveProvider(requestedId, filePath, cleanEnv);
    return Boolean(profile?.baseUrl && profile?.modelId);
  } catch (error) {
    reportUnreadableProviderFile(error, filePath);
    return false;
  }
}

/**
 * Says why a provider file that exists could not be used.
 *
 * The reasons the loader raises are all actionable — a file readable by other
 * users while it holds a literal key, invalid JSON, an entry that fails
 * validation — but the caller has to swallow them to keep a broken file from
 * blocking startup. Swallowing the message too made the failure unguessable:
 * the user was sent back to the endpoint dialog with nothing to act on.
 *
 * Only reported when the file is actually there. An absent file is the normal
 * single-endpoint state, not a failure worth a warning on every start.
 */
function reportUnreadableProviderFile(
  error: unknown,
  filePath: string | undefined,
): void {
  const path = filePath ?? getOpenAiProvidersPath();
  try {
    if (!fs.existsSync(path)) {
      return;
    }
  } catch {
    // A path that cannot even be inspected is reported below anyway.
  }
  coreEvents.emitFeedback(
    'warning',
    `Ignoring the OpenAI provider file at ${path}: ${getErrorMessage(error)}`,
  );
}

/**
 * The model a provider profile pins, if any.
 *
 * Read by `refreshAuth` so a provider's own default outranks
 * `GEMINI_OPENAI_MODELID`, which stays the fallback for the single-endpoint
 * configuration.
 */
export function providerPinnedModelId(
  config: ContentGeneratorConfig | undefined,
): string | undefined {
  return config?.modelId;
}

/**
 * Switches a session to a configured provider.
 *
 * Lives here rather than in `Config` so the upstream class gains only a
 * delegating one-liner. The provider id is stored through the two accessors the
 * class already exposes, keeping all provider state in one place.
 */
export async function switchProvider(params: {
  currentAuthType: AuthType | undefined;
  providerId: string;
  env: Record<string, string> | undefined;
  setActiveProviderId: (id: string | undefined) => void;
  refreshAuth: (
    authType: AuthType,
    apiKey?: string,
    baseUrl?: string,
    customHeaders?: Record<string, string>,
  ) => Promise<void>;
  setModel: (modelId: string) => void;
  getErrorMessage: (error: unknown) => string;
}): Promise<void> {
  const {
    currentAuthType,
    providerId,
    env,
    setActiveProviderId,
    refreshAuth,
    setModel,
    getErrorMessage,
  } = params;

  if (currentAuthType !== AuthType.USE_OPENAI) {
    throw new Error(
      'Providers can only be switched while running in OpenAI-compatible mode.',
    );
  }

  // Resolve before mutating anything so a bad id cannot leave the session
  // half-switched. Passing the id explicitly is the opt-in that permits reading
  // the provider file.
  const profile = resolveActiveProvider({ requestedId: providerId, env });

  setActiveProviderId(providerId);
  try {
    await refreshAuth(
      AuthType.USE_OPENAI,
      profile?.apiKey,
      profile?.baseUrl,
      profile?.headers,
    );
  } catch (error) {
    throw new Error(
      `Failed to switch to provider "${providerId}": ${getErrorMessage(error)}`,
    );
  }

  // The previous model almost certainly does not exist on the new endpoint, so
  // the profile's own default is pinned and written back for the next session.
  if (profile?.modelId) {
    setModel(profile.modelId);
    persistProviderModelId(profile.id, profile.modelId);
  }
}

/**
 * Whether this session talks to an OpenAI-compatible endpoint.
 *
 * Two sources are consulted because they disagree during startup: the content
 * generator config only carries an `authType` once `refreshAuth` has run, while
 * `GEMINI_API_TYPE=openai` is true from the first tick.
 */
export function isOpenAiProviderBackend(
  config: Config | undefined,
  isApiTypeSwitch: () => boolean,
): boolean {
  if (config?.getContentGeneratorConfig()?.authType === AuthType.USE_OPENAI) {
    return true;
  }
  return isApiTypeSwitch();
}

export type { EnvReader };
