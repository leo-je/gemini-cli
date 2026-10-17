/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Every OpenAI-compatible-mode piece of the CLI, in one place.
 *
 * The backend itself lives in the core package under `src/core/openai/`; this
 * directory holds the parts that only exist in the TUI — the endpoint picker in
 * the auth dialog, the `.env` writer behind it, and the model list served by
 * the endpoint.
 *
 * Re-exported from a single entry point so the rest of the CLI depends on the
 * backend, not on which file inside this directory happens to define it.
 */

export {
  applyOpenAiEndpointEnv,
  defaultOpenAiEnvPath,
  type OpenAiEndpointEnv,
} from './openAiEndpointEnv.js';
export { OpenAiEndpointDialog } from './OpenAiEndpointDialog.js';
export {
  fetchRemoteModels,
  isOpenAiBackend,
  type RemoteModelListing,
} from './openAiModelList.js';
export { OpenAiModelDialog } from './OpenAiModelDialog.js';
export { ProviderDialog } from './ProviderDialog.js';
export {
  AddProviderDialog,
  type NewProviderValues,
} from './AddProviderDialog.js';
export { addOpenAiProvider, apiKeyEnvName } from './addProvider.js';
export {
  persistProviderId,
  providerHasDefaultModel,
  readPersistedProviderId,
  rememberModelForProvider,
  type ProviderPreferenceWriter,
} from './openAiProviderPreference.js';
