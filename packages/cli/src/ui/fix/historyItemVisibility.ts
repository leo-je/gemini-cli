/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * ---------------------------------------------------------------------------
 * FORK-OWNED FILE — not present upstream.
 *
 * `MainContent.tsx` is a busy upstream file, so this module owns the whole
 * behaviour of dropping unrenderable history items. The upstream file only
 * imports `getVisibleHistoryEntries`, calls it once, and maps over the result.
 *
 * Merge guidance: if a conflict appears here, this file is the fork's copy —
 * keep it. If upstream changes the shape of `HistoryItem`, adapt this file
 * rather than adding the filtering inline to `MainContent.tsx`.
 * ---------------------------------------------------------------------------
 */

import type { InlineThinkingMode } from '../utils/inlineThinkingMode.js';
import type { HistoryItem } from '../types.js';

/**
 * A history item paired with its position in the unfiltered history.
 *
 * The index is preserved because callers compare it against indices computed
 * from the unfiltered history (for example "is this item after the last user
 * prompt"), which filtering would otherwise shift.
 */
export interface VisibleHistoryEntry {
  item: HistoryItem;
  index: number;
}

/**
 * Whether a history item can produce any visible output.
 *
 * Thinking items are the only item type that can render nothing at all:
 * `HistoryItemDisplay` skips them when inline thinking is off, and
 * `ThinkingMessage` skips them when the thought carries no text. In both
 * cases the item still becomes an Ink node, and because the static area is
 * append-only the node stays mounted for the life of the session. Resumed
 * sessions are the worst case, since they load their whole history at once.
 */
export function isVisibleHistoryItem(
  item: HistoryItem,
  inlineThinkingMode: InlineThinkingMode,
): boolean {
  if (item.type !== 'thinking') {
    return true;
  }
  if (inlineThinkingMode === 'off') {
    return false;
  }
  const subject = item.thought?.subject ?? '';
  const description = item.thought?.description ?? '';
  return subject.trim().length > 0 || description.trim().length > 0;
}

/**
 * Drops the history items that cannot render anything, keeping each surviving
 * item's original index.
 *
 * Keeping history length proportional to what is actually on screen is what
 * bounds the cost of resuming a long session, which mounts its whole history
 * in a single render.
 */
export function getVisibleHistoryEntries(
  history: readonly HistoryItem[],
  inlineThinkingMode: InlineThinkingMode,
): VisibleHistoryEntry[] {
  const entries: VisibleHistoryEntry[] = [];
  history.forEach((item, index) => {
    if (isVisibleHistoryItem(item, inlineThinkingMode)) {
      entries.push({ item, index });
    }
  });
  return entries;
}
