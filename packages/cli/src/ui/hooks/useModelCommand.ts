/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

interface UseModelCommandReturn {
  isModelDialogOpen: boolean;
  /** Set by `/model list`; undefined for `/model`. */
  openAiModelEndpoint: string | undefined;
  openModelDialog: (openAiEndpoint?: string) => void;
  closeModelDialog: () => void;
}

export const useModelCommand = (): UseModelCommandReturn => {
  const [isModelDialogOpen, setIsModelDialogOpen] = useState(false);
  const [openAiModelEndpoint, setOpenAiModelEndpoint] = useState<
    string | undefined
  >(undefined);

  const openModelDialog = useCallback((endpoint?: string) => {
    // Cleared when absent so `/model` after `/model list` shows Gemini models.
    setOpenAiModelEndpoint(endpoint);
    setIsModelDialogOpen(true);
  }, []);

  const closeModelDialog = useCallback(() => {
    setIsModelDialogOpen(false);
  }, []);

  return {
    isModelDialogOpen,
    openAiModelEndpoint,
    openModelDialog,
    closeModelDialog,
  };
};
