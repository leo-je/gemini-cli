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
  UnknownProviderError,
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
      //
      // A session-scoped choice may degrade, but only when the provider is
      // simply absent from the file. Anything else — the entry exists and its
      // credential variable is unset, its headers are invalid, the file cannot
      // be read — means the provider the user picked is configured but broken,
      // and swapping it out is wrong twice over: the error surfaced the
      // *fallback* provider's name (so the user was told about "ytoken-01"
      // after choosing "linksub-008"), and when the fallback happened to work
      // the session silently moved to a different endpoint. Rethrowing keeps
      // both failures attributable to the provider that actually has them.
      if (
        requestedId !== undefined ||
        !(error instanceof UnknownProviderError)
      ) {
        throw error;
      }
      // The provider is gone: a hand-edited provider file must not leave the
      // CLI unstartable. `resolveImplicitProvider` reports what took over.
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
 * `staleId` is a selection whose provider is absent from the file — a persisted
 * `security.auth.openAiProviderId` whose entry was removed or renamed. It is
 * reported to the user and then ignored, so a hand-edited provider file cannot
 * leave the CLI unable to start.
 *
 * Only absence reaches here. A provider that exists but is misconfigured (its
 * credential variable unset, invalid headers) is *not* a stale choice and is
 * never replaced by another endpoint; `resolveActiveProvider` rethrows it.
 */
function resolveImplicitProvider(
  staleId: string | undefined,
  env: Record<string, string> | undefined,
): OpenAiProviderProfile | undefined {
  const fallback = resolveProvider(undefined, undefined, env);
  if (staleId && fallback) {
    coreEvents.emitFeedback(
      'warning',
      `The selected OpenAI provider "${staleId}" is not configured in the provider file, so this session is using "${fallback.id}" instead. Run /provider to choose another.`,
    );
  }
  return fallback;
}

/**
 * Whether a provider profile can stand in for the missing `GEMINI_OPENAI_*`
 * environment variables.
 *
 * Used by the CLI's auth gate: a user whose endpoint lives only in the
 * provider file must not be forced through the endpoint dialog the
 * single-endpoint mode needs. Both a base URL and a model id are required — the
 * dialog collects exactly those two, and a provider without a model id cannot
 * satisfy what the dialog would have provided.
 *
 * Which entry is judged is decided the same way the session builder decides,
 * because the two must agree (see `resolveActiveProvider`). In order:
 * `selectedProviderId` — the choice persisted in
 * `security.auth.openAiProviderId` — then `GEMINI_OPENAI_PROVIDER`, then the
 * file's first entry. Reading only `GEMINI_OPENAI_PROVIDER` meant a user who
 * picked a provider with `/provider` was still judged by entry zero, so one
 * incomplete entry at the top of the file sent a perfectly configured
 * selection back through the endpoint dialog.
 *
 * This definition of "usable" is the contract the session-building path must
 * honour: the gate skipping the dialog only works if
 * `applyProviderToContentGeneratorConfig` can then resolve the same profile
 * (it passes `allowImplicitProvider: true` for exactly that reason). Keep the
 * two in step — if this accepts something the builder cannot resolve, the
 * session ends up with no endpoint and fails at construction instead.
 *
 * Deliberately swallow errors: a malformed provider file, an entry whose
 * credential variable is unset, or one whose permissions the loader rejects
 * must degrade to "not configured" (the dialog) rather than become a new
 * startup failure. The reason is reported though — see
 * `reportUnreadableProviderFile` and `describeUnusableOpenAiProvider` —
 * because the user otherwise only sees the endpoint dialog, which describes
 * nothing that is wrong.
 */
export function hasResolvableOpenAiProvider(
  env?: Record<string, string | undefined>,
  filePath?: string,
  selectedProviderId?: string,
): boolean {
  const cleanEnv = toCleanEnv(env);
  try {
    const requestedId = pickRequestedId(cleanEnv, selectedProviderId);
    const profile = resolveProvider(requestedId, filePath, cleanEnv);
    return Boolean(profile?.baseUrl && profile?.modelId);
  } catch (error) {
    // Silent by design: this runs from React render paths (see
    // `isOpenAiEndpointConfigured`), so emitting here would repeat the warning
    // on every render. `describeUnusableOpenAiProvider` is the reporting
    // counterpart, called once from `validateAuthMethod`.
    reportUnreadableProviderFile(error, filePath);
    return false;
  }
}

/**
 * Why the auth gate rejected a configured provider, for the startup error path.
 *
 * `hasResolvableOpenAiProvider` has to answer yes/no, and its `false` sends the
 * user to a dialog or to the `GEMINI_OPENAI_BASE_URL` message — neither of
 * which names the actual problem when a provider *is* configured but its
 * credential variable is unset. This returns that reason so
 * `validateAuthMethod` can report it verbatim instead.
 *
 * `null` when there is nothing provider-specific to say: no provider was named,
 * the profile resolved, or the provider is absent (a stale preference the
 * session builder degrades from with its own warning).
 */
export function describeUnusableOpenAiProvider(
  env?: Record<string, string | undefined>,
  filePath?: string,
  selectedProviderId?: string,
): string | null {
  const cleanEnv = toCleanEnv(env);
  const requestedId = pickRequestedId(cleanEnv, selectedProviderId);
  if (!requestedId) {
    return null;
  }
  try {
    // Only the *failure* is reported here; whether the profile satisfies the
    // gate is `hasResolvableOpenAiProvider`'s question, and a profile without a
    // model id is the endpoint dialog's job rather than an error.
    resolveProvider(requestedId, filePath, cleanEnv);
    return null;
  } catch (error) {
    // An absent provider is a stale preference, which the session builder
    // degrades from and reports itself. Anything else is the user's real
    // problem: the entry exists, so its own name and variable belong in the
    // message.
    if (error instanceof UnknownProviderError) {
      return null;
    }
    return getErrorMessage(error);
  }
}

/**
 * The provider id the gate and the builder both act on.
 *
 * Mirrors `resolveActiveProvider`: a persisted selection outranks
 * `GEMINI_OPENAI_PROVIDER`, which outranks the file's first entry. Kept in one
 * place so the two callers cannot drift.
 */
function pickRequestedId(
  cleanEnv: Record<string, string> | undefined,
  selectedProviderId: string | undefined,
): string | undefined {
  const persisted = selectedProviderId?.trim();
  return persisted ? persisted : cleanEnv?.[OPENAI_PROVIDER_ENV];
}

/** Drops undefined values so resolvers can take a `Record<string, string>`. */
function toCleanEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined {
  if (!env) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
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
