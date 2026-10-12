/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  paginateFooterColumns,
  type PaginatableColumn,
} from './paginateFooterColumns.js';

/** Compact assertion view: pages -> array of column-id arrays. */
const ids = (pages: PaginatableColumn[][]) =>
  pages.map((page) => page.map((c) => c.id));

describe('paginateFooterColumns', () => {
  it('returns a single empty page for empty input', () => {
    const pages = paginateFooterColumns([], { terminalWidth: 80, gap: 3 });
    expect(pages).toEqual([[]]);
  });

  it('keeps every column on one page when they all fit', () => {
    const columns: PaginatableColumn[] = [
      { id: 'a', width: 10 },
      { id: 'b', width: 10 },
    ];
    const pages = paginateFooterColumns(columns, {
      terminalWidth: 60,
      gap: 3,
    });
    expect(ids(pages)).toEqual([['a', 'b']]);
  });

  it('reports the exact single-page/multi-page threshold (accounts for the inter-column gap)', () => {
    const columns: PaginatableColumn[] = [
      { id: 'a', width: 10 },
      { id: 'b', width: 10 },
    ];

    // usable = terminalWidth - 2. Used for both = 2 + 10 (gap 3) + 10 = 25.
    // Fits when usable >= 25, i.e. terminalWidth >= 27.
    expect(
      ids(paginateFooterColumns(columns, { terminalWidth: 27, gap: 3 })),
    ).toEqual([['a', 'b']]);
    expect(
      ids(paginateFooterColumns(columns, { terminalWidth: 26, gap: 3 })),
    ).toEqual([['a'], ['b']]);
  });

  it('overflows extra columns onto additional pages instead of dropping them', () => {
    const columns: PaginatableColumn[] = [
      { id: 'a', width: 20 },
      { id: 'b', width: 20 },
      { id: 'c', width: 20 },
    ];
    const pages = paginateFooterColumns(columns, {
      terminalWidth: 50,
      gap: 3,
    });
    expect(ids(pages)).toEqual([['a', 'b'], ['c']]);
  });

  it('keeps a high-priority column on the page even when it overflows', () => {
    const columns: PaginatableColumn[] = [
      { id: 'a', width: 20 },
      { id: 'hp', width: 20, isHighPriority: true },
    ];
    // usable = 28. 'a' placed (used 22). 'hp' would not fit (22 + 3 + 20 = 45)
    // but is high priority, so it stays on the same page instead of wrapping.
    expect(
      ids(paginateFooterColumns(columns, { terminalWidth: 30, gap: 3 })),
    ).toEqual([['a', 'hp']]);
  });

  it('never loses columns: every input id appears exactly once across pages', () => {
    const columns: PaginatableColumn[] = [
      { id: 'a', width: 15 },
      { id: 'b', width: 15 },
      { id: 'c', width: 15 },
      { id: 'd', width: 15 },
    ];
    const pages = paginateFooterColumns(columns, { terminalWidth: 40, gap: 3 });
    const flat = pages.flat().map((c) => c.id);
    expect(flat.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(new Set(flat).size).toBe(4);
  });

  it('applies the reduced workspace budget instead of the full width', () => {
    const columns: PaginatableColumn[] = [
      { id: 'workspace', width: 100 },
      { id: 'm', width: 10 },
    ];
    // usable = 38. workspace uses budget 20 -> used 22; then +3 +10 = 35 <= 38.
    const pages = paginateFooterColumns(columns, {
      terminalWidth: 40,
      gap: 3,
    });
    expect(ids(pages)).toEqual([['workspace', 'm']]);
  });

  it('honours a custom workspaceId and workspaceBudget', () => {
    const columns: PaginatableColumn[] = [
      { id: 'cwd', width: 100 },
      { id: 'm', width: 10 },
    ];
    const pages = paginateFooterColumns(columns, {
      terminalWidth: 40,
      gap: 3,
      workspaceId: 'cwd',
      workspaceBudget: 20,
    });
    expect(ids(pages)).toEqual([['cwd', 'm']]);
  });

  it('keeps a single oversized column on its own page (no empty leading page)', () => {
    const columns: PaginatableColumn[] = [{ id: 'a', width: 500 }];
    const pages = paginateFooterColumns(columns, {
      terminalWidth: 20,
      gap: 3,
    });
    expect(ids(pages)).toEqual([['a']]);
  });

  describe('reserveWidth', () => {
    it('is ignored when everything already fits on a single page', () => {
      const columns: PaginatableColumn[] = [
        { id: 'a', width: 20 },
        { id: 'b', width: 20 },
      ];
      // usable (reserve 0) = 46 -> single page, so no indicator and no reserve.
      const pages = paginateFooterColumns(columns, {
        terminalWidth: 48,
        gap: 3,
        reserveWidth: 6,
      });
      expect(ids(pages)).toEqual([['a', 'b']]);
    });

    it('shrinks each page to leave room for the indicator once there are multiple pages', () => {
      const columns: PaginatableColumn[] = [
        { id: 'a', width: 20 },
        { id: 'b', width: 20 },
        { id: 'c', width: 20 },
      ];

      // Without reservation: usable 48 -> [a, b], [c].
      expect(
        ids(
          paginateFooterColumns(columns, {
            terminalWidth: 50,
            gap: 3,
            reserveWidth: 0,
          }),
        ),
      ).toEqual([['a', 'b'], ['c']]);

      // Reserving 6 shrinks usable to 42 -> page 1 holds only [a].
      expect(
        ids(
          paginateFooterColumns(columns, {
            terminalWidth: 50,
            gap: 3,
            reserveWidth: 6,
          }),
        ),
      ).toEqual([['a'], ['b'], ['c']]);
    });
  });
});
