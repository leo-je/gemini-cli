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
import {
  OPENAI_PROVIDER_ENV,
  persistProviderModelId,
  resolveProvider,
  resolveProviderFromEnv,
  type OpenAiProviderProfile,
} from './providers.js';
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

  const provider = resolveActiveProvider({
    sessionProviderId: config?.getActiveOpenAiProviderId?.(),
    env: config?.env,
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
  contentGeneratorConfig.modelId = provider?.modelId;
}

/**
 * Resolves the provider profile this session should talk to, if any.
 *
 * Only an *explicit* opt-in is honoured: a requested id, a session-scoped choice
 * made by `/provider`, or `GEMINI_OPENAI_PROVIDER`. A bare provider file is
 * deliberately not enough — reading it unconditionally would make every caller
 * of `createContentGeneratorConfig` (embedding-only sessions, tests passing a
 * stub `Config`, subagents) depend on the user's personal provider file.
 *
 * `undefined` therefore means "no provider involvement": the caller keeps the
 * upstream behaviour where the ambient variables describe the endpoint.
 */
export function resolveActiveProvider(options: {
  requestedId?: string;
  sessionProviderId?: string;
  env?: Record<string, string>;
}): OpenAiProviderProfile | undefined {
  const { requestedId, sessionProviderId, env } = options;
  const choice = requestedId ?? sessionProviderId;
  const envChoice = env?.[OPENAI_PROVIDER_ENV];
  if (!choice && !envChoice) {
    return undefined;
  }
  if (choice) {
    return resolveProvider(choice, undefined, env);
  }
  return resolveProviderFromEnv(env);
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
