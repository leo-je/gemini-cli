/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { HistoryItem } from '../types.js';
import {
  getVisibleHistoryEntries,
  isVisibleHistoryItem,
} from './historyItemVisibility.js';

const user = (id: number, text: string): HistoryItem => ({
  id,
  type: 'user',
  text,
});

const gemini = (id: number, text: string): HistoryItem => ({
  id,
  type: 'gemini',
  text,
});

const thinking = (id: number, subject: string, description: string) =>
  ({
    id,
    type: 'thinking',
    thought: { subject, description },
  }) as HistoryItem;

describe('isVisibleHistoryItem', () => {
  it('should keep non-thinking items regardless of mode', () => {
    expect(isVisibleHistoryItem(user(1, 'hi'), 'off')).toBe(true);
    expect(isVisibleHistoryItem(gemini(2, 'hi'), 'full')).toBe(true);
  });

  it('should drop thinking items when inline thinking is off', () => {
    expect(isVisibleHistoryItem(thinking(1, 'S', 'D'), 'off')).toBe(false);
  });

  it('should drop textless thinking items when inline thinking is on', () => {
    expect(isVisibleHistoryItem(thinking(1, '', ''), 'full')).toBe(false);
    expect(isVisibleHistoryItem(thinking(1, '   ', '\n'), 'full')).toBe(false);
  });

  it('should keep thinking items that carry text when inline thinking is on', () => {
    expect(isVisibleHistoryItem(thinking(1, 'S', ''), 'full')).toBe(true);
    expect(isVisibleHistoryItem(thinking(1, '', 'D'), 'full')).toBe(true);
  });
});

describe('getVisibleHistoryEntries', () => {
  it('should preserve the original index of every surviving item', () => {
    // The index is compared against indices derived from the unfiltered
    // history, so filtering must not renumber the survivors.
    const history = [
      user(1, 'prompt'),
      thinking(2, 'kept', 'kept'),
      gemini(3, 'answer'),
      thinking(4, '', ''),
      user(5, 'follow up'),
    ];

    const entries = getVisibleHistoryEntries(history, 'full');

    // The textless thinking item at index 3 is the only one dropped, and the
    // survivors keep indices 0, 1, 2 and 4 rather than being renumbered.
    expect(entries.map((entry) => entry.item.id)).toEqual([1, 2, 3, 5]);
    expect(entries.map((entry) => entry.index)).toEqual([0, 1, 2, 4]);
  });

  it('should keep only non-thinking items when inline thinking is off', () => {
    const history = [
      user(1, 'prompt'),
      thinking(2, 'subject', 'description'),
      thinking(3, 'subject', 'description'),
      gemini(4, 'answer'),
    ];

    const entries = getVisibleHistoryEntries(history, 'off');

    expect(entries.map((entry) => entry.item.id)).toEqual([1, 4]);
    expect(entries.map((entry) => entry.index)).toEqual([0, 3]);
  });

  it('should return an empty list for an empty history', () => {
    expect(getVisibleHistoryEntries([], 'full')).toEqual([]);
  });
});
