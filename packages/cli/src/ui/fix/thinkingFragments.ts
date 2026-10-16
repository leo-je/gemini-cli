/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * ---------------------------------------------------------------------------
 * FORK-OWNED FILE — not present upstream.
 *
 * Upstream applies a three-way merge on `sessionUtils.ts` when it syncs. Every
 * line this fork owns inside an upstream file is a line that can conflict.
 * This module therefore owns the whole thought-collapsing behaviour, so the
 * upstream file only has to import this function and call it.
 *
 * Merge guidance: if a conflict appears here, this file is the fork's copy —
 * keep it. If upstream changes how thoughts are recorded, adapt this file
 * rather than re-inlining the loop into `sessionUtils.ts`.
 * ---------------------------------------------------------------------------
 */

import type { ThoughtSummary } from '@google/gemini-cli-core';
import type { HistoryItemWithoutId } from '../types.js';

/**
 * Builds the UI item for a single recorded message's thoughts.
 *
 * `msg.thoughts` is not a list of independent summaries: it is the raw stream
 * of thinking fragments, accumulated one entry per streamed chunk. A recorded
 * thought therefore often holds a single token (`"src"`, `"/view/F"`,
 * `"tp.vue"`), and a message's fragments only read as coherent text once
 * concatenated.
 *
 * Emitting one history item per fragment made long sessions enormous on
 * resume — a real 15-message session carried 1544 fragments — and rendered
 * each fragment as its own line, because `ThinkingMessage` splits the
 * rendered text on newlines.
 *
 * Concatenating the fragments reproduces the original thinking text and
 * collapses the message to a single item, so resuming mounts one Ink node per
 * message instead of one per token.
 *
 * Fragments are joined verbatim: they are already split at token boundaries,
 * so inserting a separator would break words apart (`src/view/Ftp.vue`).
 *
 * @returns the single thinking item, or `null` when the thoughts carry no
 *   text at all, so the caller does not append an empty item.
 */
export function toThinkingHistoryItem(
  thoughts: readonly ThoughtSummary[],
): HistoryItemWithoutId | null {
  let subject = '';
  let description = '';

  for (const thought of thoughts) {
    subject += thought.subject ?? '';
    description += thought.description ?? '';
  }

  if (!subject.trim() && !description.trim()) {
    return null;
  }

  return {
    type: 'thinking',
    thought: {
      subject: subject.trim(),
      description: description.trim(),
    },
  };
}
