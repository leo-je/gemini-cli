/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deliberately reuses the upstream `'model'` dialog action for the fork's
 * provider dialogs.
 *
 * Adding `'provider'` and `'addProvider'` to `OpenDialogActionReturn['dialog']`
 * would mean editing an upstream union type and its switch statement — both
 * high-traffic files where any added line is a future merge conflict. The union
 * already carries `props?: Record<string, unknown>` for exactly this kind of
 * parameterization, so the dialogs are selected by a prop discriminator and
 * dispatched from one hook inside the existing `'model'` branch.
 *
 * When upstream eventually adds a real dialog kind for providers, delete this
 * file and switch the two commands back to a dedicated kind.
 */

/** The prop that names which fork dialog to open, if any. */
export const PROVIDER_DIALOG_PROP = 'geminiCliDialog';

export type ProviderDialogKind = 'provider' | 'addProvider';

/** Actions the provider dialogs need, kept structural to avoid a hard import. */
export interface ProviderDialogActions {
  openProviderDialog: () => void;
  openAddProviderDialog: () => void;
}

/** Reads the fork dialog discriminator out of a dialog action's props. */
export function readProviderDialogKind(
  props: Record<string, unknown> | undefined,
): ProviderDialogKind | undefined {
  const value = props?.[PROVIDER_DIALOG_PROP];
  return value === 'provider' || value === 'addProvider' ? value : undefined;
}

/**
 * Opens the provider dialog named by the props, if any.
 *
 * Returns `true` when it handled the action, so the caller can return early and
 * leave the upstream model-dialog path untouched.
 */
export function handleProviderDialogProps(
  props: Record<string, unknown> | undefined,
  actions: ProviderDialogActions,
): boolean {
  const kind = readProviderDialogKind(props);
  if (!kind) {
    return false;
  }
  if (kind === 'provider') {
    actions.openProviderDialog();
  } else {
    actions.openAddProviderDialog();
  }
  return true;
}

/** Builds the dialog action a provider command returns. */
export function providerDialogAction(kind: ProviderDialogKind): {
  type: 'dialog';
  dialog: 'model';
  props: Record<string, unknown>;
} {
  return {
    type: 'dialog',
    dialog: 'model',
    props: { [PROVIDER_DIALOG_PROP]: kind },
  };
}
