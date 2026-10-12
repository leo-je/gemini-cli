/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal structural shape required for pagination.
 *
 * Kept deliberately generic (no dependency on Footer's component types) so this
 * utility rarely needs to change when upstream edits `Footer.tsx`.
 */
export interface PaginatableColumn {
  id: string;
  /** Content width used for the fit calculation. */
  width: number;
  /** Columns flagged high priority are never dropped from a page. */
  isHighPriority?: boolean;
}

export interface PaginateColumnsOptions {
  /** Total width available to the footer row. */
  terminalWidth: number;
  /** Gap inserted between adjacent columns on the same page. */
  gap: number;
  /** Leading padding already consumed on each page. Defaults to 2. */
  initialPadding?: number;
  /** Fixed width budget applied to the workspace column. Defaults to 20. */
  workspaceBudget?: number;
  /** Column id that uses the reduced workspace budget. Defaults to 'workspace'. */
  workspaceId?: string;
  /**
   * Width to reserve at the end of every page for an overflow indicator (e.g. a
   * `1/3` page counter). Only applied when pagination actually produces more
   * than one page, so single-page layouts are byte-for-byte unchanged.
   * Defaults to 0.
   */
  reserveWidth?: number;
}

/** Greedy per-page packing of columns. `reserve` shrinks each page's budget. */
function packPages<T extends PaginatableColumn>(
  columns: T[],
  terminalWidth: number,
  gap: number,
  initialPadding: number,
  workspaceBudget: number,
  workspaceId: string,
  reserve: number,
): T[][] {
  const usableWidth = terminalWidth - 2 - reserve;
  const budgetOf = (col: T): number =>
    col.id === workspaceId ? workspaceBudget : col.width;

  const pages: T[][] = [];
  let page: T[] = [];
  let used = initialPadding;

  for (const col of columns) {
    const colBudget = budgetOf(col);
    const gapWidth = page.length > 0 ? gap : 0;
    const fits = used + gapWidth + colBudget <= usableWidth;

    // Always place at least one column per page (even an oversized one) and
    // never drop a high-priority column.
    if (page.length === 0 || col.isHighPriority || fits) {
      page.push(col);
      used += gapWidth + colBudget;
      continue;
    }

    // Overflow: close the current page and start a new one with this column.
    pages.push(page);
    page = [col];
    used = initialPadding + colBudget;
  }

  if (page.length > 0) {
    pages.push(page);
  }

  return pages;
}

/**
 * Greedily packs footer columns into as many pages as required, so that nothing
 * has to be dropped when the terminal is too narrow.
 *
 * When every column fits, the result is a single page identical to the previous
 * fit-and-keep behaviour (same budget/gap rules). Overflowing columns become
 * additional pages instead of being dropped. Every returned page contains at
 * least one column.
 */
export function paginateFooterColumns<T extends PaginatableColumn>(
  columns: T[],
  {
    terminalWidth,
    gap,
    initialPadding = 2,
    workspaceBudget = 20,
    workspaceId = 'workspace',
    reserveWidth = 0,
  }: PaginateColumnsOptions,
): T[][] {
  const pack = (reserve: number) =>
    packPages(
      columns,
      terminalWidth,
      gap,
      initialPadding,
      workspaceBudget,
      workspaceId,
      reserve,
    );

  const withoutReserve = pack(0);

  // Single page (or no reservation requested): nothing to refine.
  if (withoutReserve.length <= 1 || reserveWidth <= 0) {
    return withoutReserve.length > 0 ? withoutReserve : [[]];
  }

  // Re-pack reserving space for the overflow indicator. If reserving somehow
  // collapses back to a single page, prefer the un-reserved result so we never
  // reserve space for an indicator that wouldn't be shown.
  const withReserve = pack(reserveWidth);
  const result = withReserve.length > 1 ? withReserve : withoutReserve;

  return result.length > 0 ? result : [[]];
}
