/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renders the fork's provider dialogs from inside the upstream
 * `DialogManager`.
 *
 * `DialogManager` is a long chain of `if (uiState.x) return <Y/>`, and the fork
 * would otherwise add two more blocks plus three imports to it. Instead the
 * chain gains a single early call to this component, and all provider dialog
 * rendering lives here.
 */

import type React from 'react';
import {
  AddProviderDialog,
  type NewProviderValues,
} from './AddProviderDialog.js';
import { ProviderDialog } from './ProviderDialog.js';

export interface ProviderDialogsProps {
  isProviderDialogOpen: boolean;
  isAddProviderDialogOpen: boolean;
  onCloseProvider: () => void;
  onSelectProvider: (providerId: string) => void | Promise<void>;
  onCancelAddProvider: () => void;
  onSubmitAddProvider: (values: NewProviderValues) => void | Promise<void>;
}

/**
 * Returns the active provider dialog, or `null` when neither is open.
 *
 * `null` (rather than `undefined`) lets the caller use a single `??`-free
 * `if (node) return node;` without changing the upstream return type.
 */
export function ProviderDialogs({
  isProviderDialogOpen,
  isAddProviderDialogOpen,
  onCloseProvider,
  onSelectProvider,
  onCancelAddProvider,
  onSubmitAddProvider,
}: ProviderDialogsProps): React.JSX.Element | null {
  if (isProviderDialogOpen) {
    return (
      <ProviderDialog onClose={onCloseProvider} onSelect={onSelectProvider} />
    );
  }
  if (isAddProviderDialogOpen) {
    return (
      <AddProviderDialog
        onCancel={onCancelAddProvider}
        onSubmit={onSubmitAddProvider}
      />
    );
  }
  return null;
}
