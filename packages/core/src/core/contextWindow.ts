/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Token-window overrides for models whose real number is not compiled in.
 *
 * `tokenLimits.ts` can only describe the models the CLI itself names. An
 * OpenAI-compatible endpoint serves models the CLI has never heard of, and its
 * `/v1/models` response does not carry a context window in any standard field.
 * The provider file is where the user records the real number, and this module
 * is how that number reaches the call sites that ask `tokenLimit()` — without
 * any of those call sites having to know about providers.
 *
 * The map is keyed by model id rather than being a single value so two sessions
 * in one process cannot clobber each other's limit: each `Config` declares its
 * own models. The active model is remembered only as the fallback for
 * `tokenLimit(model)` calls that pass an empty model.
 *
 * This is deliberately not part of the public package API: the only writer is
 * `Config.setModel`, and everything else just keeps calling `tokenLimit()`.
 */

const declared = new Map<string, number>();

let activeModelId: string | undefined;

/** Records the context window a provider profile assigns to `modelId`. */
export function declareContextWindow(modelId: string, size: number): void {
  if (!modelId || !Number.isFinite(size) || size <= 0) {
    return;
  }
  declared.set(modelId, Math.floor(size));
}

/**
 * Selects the model whose declared limit is used when `tokenLimit()` is called
 * without a model.
 */
export function activateContextWindow(modelId: string | undefined): void {
  activeModelId = modelId && modelId.trim().length > 0 ? modelId : undefined;
}

/** The declared limit for `model`, falling back to the active model. */
export function resolveContextWindowSize(
  model: string | undefined,
): number | undefined {
  const key = model && model.length > 0 ? model : activeModelId;
  return key ? declared.get(key) : undefined;
}

/** Clears every declaration. Test seam. */
export function clearDeclaredContextWindows(): void {
  declared.clear();
  activeModelId = undefined;
}
