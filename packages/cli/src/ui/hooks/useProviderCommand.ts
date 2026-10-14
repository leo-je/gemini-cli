/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

export function useProviderCommand() {
  const [isProviderDialogOpen, setIsProviderDialogOpen] = useState(false);
  const [isAddProviderDialogOpen, setIsAddProviderDialogOpen] = useState(false);

  const openProviderDialog = useCallback(() => {
    setIsProviderDialogOpen(true);
  }, []);

  const closeProviderDialog = useCallback(() => {
    setIsProviderDialogOpen(false);
  }, []);

  const openAddProviderDialog = useCallback(() => {
    setIsAddProviderDialogOpen(true);
  }, []);

  const closeAddProviderDialog = useCallback(() => {
    setIsAddProviderDialogOpen(false);
  }, []);

  return {
    isProviderDialogOpen,
    openProviderDialog,
    closeProviderDialog,
    isAddProviderDialogOpen,
    openAddProviderDialog,
    closeAddProviderDialog,
  };
}
