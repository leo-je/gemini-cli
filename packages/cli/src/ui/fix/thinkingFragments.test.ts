/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { ThoughtSummary } from '@google/gemini-cli-core';
import type { HistoryItemWithoutId } from '../types.js';
import { toThinkingHistoryItem } from './thinkingFragments.js';

function thought(subject: string, description: string): ThoughtSummary {
  return { subject, description };
}

/**
 * Narrows the returned union so tests can read `thought` without casts.
 */
function asThinkingItem(item: HistoryItemWithoutId | null): {
  subject: string;
  description: string;
} {
  expect(item?.type).toBe('thinking');
  if (item?.type !== 'thinking') {
    throw new Error('Expected a thinking history item');
  }
  return item.thought;
}

describe('toThinkingHistoryItem', () => {
  it('should return a single item for a single thought', () => {
    expect(
      toThinkingHistoryItem([thought('Thinking', 'about things')]),
    ).toEqual({
      type: 'thinking',
      thought: { subject: 'Thinking', description: 'about things' },
    });
  });

  it('should collapse many fragments into one item', () => {
    const item = toThinkingHistoryItem([
      thought('', 'First'),
      thought('', 'Second'),
      thought('', 'Third'),
    ]);

    expect(item).toEqual({
      type: 'thinking',
      thought: { subject: '', description: 'FirstSecondThird' },
    });
  });

  it('should concatenate fragments verbatim without separators', () => {
    // Fragments are split at token boundaries, so a separator would break
    // words apart.
    const item = toThinkingHistoryItem([
      thought('', 'src'),
      thought('', '/view/F'),
      thought('', 'tp.vue'),
    ]);

    expect(asThinkingItem(item).description).toBe('src/view/Ftp.vue');
  });

  it('should preserve newlines carried by the fragments', () => {
    const item = toThinkingHistoryItem([
      thought('', 'line one\n'),
      thought('', 'line two\n'),
    ]);

    expect(asThinkingItem(item).description).toBe('line one\nline two');
  });

  it('should accumulate subject and description independently', () => {
    const item = toThinkingHistoryItem([
      thought('Head', 'body '),
      thought('ing', 'text'),
    ]);

    expect(asThinkingItem(item).subject).toBe('Heading');
    expect(asThinkingItem(item).description).toBe('body text');
  });

  it('should return null when no fragment carries text', () => {
    expect(toThinkingHistoryItem([])).toBeNull();
    expect(
      toThinkingHistoryItem([thought('', ''), thought('   ', '\n')]),
    ).toBeNull();
  });

  it('should keep the item when only the subject carries text', () => {
    expect(toThinkingHistoryItem([thought('Subject only', '')])).toEqual({
      type: 'thinking',
      thought: { subject: 'Subject only', description: '' },
    });
  });
});
