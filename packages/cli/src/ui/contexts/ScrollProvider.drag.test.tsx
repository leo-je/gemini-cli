/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from '../../test-utils/render.js';
import {
  ScrollProvider,
  useScrollable,
  getScrollbarGeometry,
  type ScrollState,
} from './ScrollProvider.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useRef, useImperativeHandle, forwardRef, type RefObject } from 'react';
import { Box, type DOMElement } from 'ink';
import type { MouseEvent } from '../hooks/useMouse.js';

// Mock useMouse hook
const mockUseMouseCallbacks = new Set<(event: MouseEvent) => void>();
vi.mock('../hooks/useMouse.js', async () => {
  // We need to import React dynamically because this factory runs before top-level imports
  const React = await import('react');
  return {
    useMouse: (callback: (event: MouseEvent) => void) => {
      React.useEffect(() => {
        mockUseMouseCallbacks.add(callback);
        return () => {
          mockUseMouseCallbacks.delete(callback);
        };
      }, [callback]);
    },
  };
});

// Mock ink's getBoundingBox: a 10x10 box at the top left corner, so the
// scrollbar is painted on column 10 (mouse columns are 1-based).
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    getBoundingBox: vi.fn(() => ({ x: 0, y: 0, width: 10, height: 10 })),
  };
});

const TestScrollable = forwardRef(
  (
    props: {
      id: string;
      scrollBy: (delta: number) => void;
      scrollTo?: (offset: number, duration?: number) => void;
      getScrollState: () => ScrollState;
    },
    ref,
  ) => {
    const elementRef = useRef<DOMElement>(null);
    useImperativeHandle(ref, () => elementRef.current);

    useScrollable(
      {
        ref: elementRef as RefObject<DOMElement>,
        getScrollState: props.getScrollState,
        scrollBy: props.scrollBy,
        scrollTo: props.scrollTo,
        hasFocus: () => true,
        flashScrollbar: () => {},
      },
      true,
    );

    return <Box ref={elementRef} />;
  },
);
TestScrollable.displayName = 'TestScrollable';

const mouseEvent = (
  name: MouseEvent['name'],
  col: number,
  row: number,
  button: MouseEvent['button'] = 'left',
): MouseEvent => ({
  name,
  col,
  row,
  shift: false,
  ctrl: false,
  meta: false,
  button,
});

const broadcast = (event: MouseEvent) => {
  for (const callback of mockUseMouseCallbacks) {
    callback(event);
  }
};

const renderScrollable = async ({
  scrollTop = 0,
  scrollHeight = 100,
  innerHeight = 10,
  withScrollTo = false,
}: {
  scrollTop?: number;
  scrollHeight?: number;
  innerHeight?: number;
  withScrollTo?: boolean;
} = {}) => {
  const scrollBy = vi.fn();
  const scrollTo = vi.fn();
  const getScrollState = vi.fn(() => ({
    scrollTop,
    scrollHeight,
    innerHeight,
  }));

  await render(
    <ScrollProvider>
      <TestScrollable
        id="test-scrollable"
        scrollBy={scrollBy}
        scrollTo={withScrollTo ? scrollTo : undefined}
        getScrollState={getScrollState}
      />
    </ScrollProvider>,
  );

  return { scrollBy, scrollTo };
};

describe('getScrollbarGeometry', () => {
  it('matches the thumb ink draws for a long list', () => {
    // 100 rows of content in 10 rows of track: ink draws the shortest thumb,
    // one row, at the top.
    expect(getScrollbarGeometry(0, 100, 10, 10)).toEqual({
      thumbStart: 0,
      thumbHeight: 1,
      maxThumbStart: 9,
      maxScrollTop: 90,
    });
  });

  it('keeps the thumb a row high and inside the track at both ends', () => {
    const top = getScrollbarGeometry(0, 100, 10, 10)!;
    const bottom = getScrollbarGeometry(90, 100, 10, 10)!;
    expect(top.thumbStart).toBe(0);
    expect(bottom.thumbStart).toBe(bottom.maxThumbStart);
    expect(bottom.thumbStart + bottom.thumbHeight).toBe(10);
  });

  it('scales the thumb with the visible fraction', () => {
    const geometry = getScrollbarGeometry(100, 400, 10, 10)!;
    expect(geometry.thumbHeight).toBe(2);
    expect(geometry.maxThumbStart).toBe(8);
  });

  it('returns undefined when there is nothing to scroll', () => {
    expect(getScrollbarGeometry(0, 10, 10, 10)).toBeUndefined();
    expect(getScrollbarGeometry(0, 0, 0, 10)).toBeUndefined();
  });

  it('returns undefined instead of NaN for unknown measurements', () => {
    expect(getScrollbarGeometry(NaN, 100, 10, 10)).toBeUndefined();
    expect(getScrollbarGeometry(0, 100, 0, 0)).toBeUndefined();
  });
});

describe('ScrollProvider Drag', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockUseMouseCallbacks.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drags the scrollbar thumb', async () => {
    const { scrollBy } = await renderScrollable();

    // scrollHeight 100, innerHeight 10: the thumb is row 0 of the track, which
    // is mouse row 1. Grabbing it must not jump.
    broadcast(mouseEvent('left-press', 10, 1));
    expect(scrollBy).not.toHaveBeenCalled();

    // Move one row down: the thumb follows, one row of 9 maps to 10 rows.
    broadcast(mouseEvent('move', 10, 2));
    expect(scrollBy).toHaveBeenCalledWith(10);

    scrollBy.mockClear();
    broadcast(mouseEvent('move', 10, 3));
    expect(scrollBy).toHaveBeenCalledWith(20);

    // Release ends the drag.
    broadcast(mouseEvent('left-release', 10, 3));
    scrollBy.mockClear();
    broadcast(mouseEvent('move', 10, 4));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('jumps to position and starts drag when clicking track below thumb', async () => {
    const { scrollBy } = await renderScrollable();

    // Thumb at row 0, click row 6 -> target thumb row 5 -> scrollTop 50.
    broadcast(mouseEvent('left-press', 10, 6));
    expect(scrollBy).toHaveBeenCalledWith(50);

    scrollBy.mockClear();
    broadcast(mouseEvent('move', 10, 7));
    expect(scrollBy).toHaveBeenCalledWith(60);
  });

  it('jumps to position when clicking track above thumb', async () => {
    const { scrollBy } = await renderScrollable({ scrollTop: 50 });

    // Thumb at row 5, click row 3 -> target thumb row 2 -> scrollTop 20.
    broadcast(mouseEvent('left-press', 10, 3));
    expect(scrollBy).toHaveBeenCalledWith(-30);
  });

  it('jumps to top when clicking very top of track', async () => {
    const { scrollBy } = await renderScrollable({ scrollTop: 50 });

    broadcast(mouseEvent('left-press', 10, 1));
    expect(scrollBy).toHaveBeenCalledWith(-50);
  });

  it('jumps to bottom when clicking very bottom of track', async () => {
    const { scrollBy } = await renderScrollable();

    broadcast(mouseEvent('left-press', 10, 10));
    expect(scrollBy).toHaveBeenCalledWith(90);
  });

  it('uses scrollTo for absolute positioning when the scrollable supports it', async () => {
    const { scrollTo } = await renderScrollable({ withScrollTo: true });

    // Thumb at row 0, click row 6 -> target thumb row 5 -> scrollTop 50.
    broadcast(mouseEvent('left-press', 10, 6));
    expect(scrollTo).toHaveBeenCalledWith(50);

    // A drag drives scrollTo with no animation, so the thumb tracks the
    // pointer instead of easing towards it.
    broadcast(mouseEvent('left-release', 10, 6));
    scrollTo.mockClear();
    broadcast(mouseEvent('left-press', 10, 1));
    expect(scrollTo).not.toHaveBeenCalled();
    broadcast(mouseEvent('move', 10, 2));
    expect(scrollTo).toHaveBeenCalledWith(10, 0);
  });

  it('ignores a move that was never preceded by a press', async () => {
    const { scrollBy } = await renderScrollable();

    broadcast(mouseEvent('move', 10, 5));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('does not reuse a drag whose release was lost', async () => {
    const { scrollBy } = await renderScrollable();

    // Grab the thumb, then press somewhere else in the list. The press starts a
    // new gesture, so the following move must not steer the scrollbar.
    broadcast(mouseEvent('left-press', 10, 1));
    scrollBy.mockClear();
    broadcast(mouseEvent('left-press', 0, 5));
    broadcast(mouseEvent('move', 0, 1));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('cancels the drag when another button is pressed', async () => {
    const { scrollBy } = await renderScrollable();

    broadcast(mouseEvent('left-press', 10, 1));
    scrollBy.mockClear();
    broadcast(mouseEvent('right-press', 10, 5, 'right'));
    broadcast(mouseEvent('move', 10, 2));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('cancels the drag when the wheel is used', async () => {
    const { scrollBy } = await renderScrollable();

    broadcast(mouseEvent('left-press', 10, 1));
    broadcast(mouseEvent('scroll-up', 10, 5, 'none'));
    scrollBy.mockClear();
    broadcast(mouseEvent('move', 10, 2));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('ends the drag when a move arrives without the left button', async () => {
    const { scrollBy } = await renderScrollable();

    broadcast(mouseEvent('left-press', 10, 1));
    scrollBy.mockClear();
    broadcast(mouseEvent('move', 10, 2, 'none'));
    expect(scrollBy).not.toHaveBeenCalled();

    // The drag is gone, so a later move does nothing either.
    broadcast(mouseEvent('move', 10, 3));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('does not scroll or divide by zero when the geometry is unknown', async () => {
    const { scrollBy } = await renderScrollable({
      scrollHeight: 0,
      innerHeight: 0,
    });

    broadcast(mouseEvent('left-press', 10, 1));
    broadcast(mouseEvent('move', 10, 2));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('clamps the pointer above the list instead of leaving the scroll range', async () => {
    const { scrollBy } = await renderScrollable({ scrollTop: 50 });

    // Grab the thumb (row 5 -> mouse row 6), then drag above the top row.
    broadcast(mouseEvent('left-press', 10, 6));
    scrollBy.mockClear();
    broadcast(mouseEvent('move', 10, 0));
    expect(scrollBy).toHaveBeenCalledWith(-50);
  });
});
