/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { getBoundingBox, type DOMElement } from 'ink';
import { useMouse, type MouseEvent } from '../hooks/useMouse.js';
import { terminalCapabilityManager } from '../utils/terminalCapabilityManager.js';

export interface ScrollState {
  scrollTop: number;
  scrollHeight: number;
  innerHeight: number;
}

export interface ScrollableEntry {
  id: string;
  ref: React.RefObject<DOMElement>;
  getScrollState: () => ScrollState;
  scrollBy: (delta: number) => void;
  scrollTo?: (scrollTop: number, duration?: number) => void;
  hasFocus: () => boolean;
  flashScrollbar: () => void;
}

interface ScrollContextType {
  register: (entry: ScrollableEntry) => void;
  unregister: (id: string) => void;
}

const ScrollContext = createContext<ScrollContextType | null>(null);

/**
 * The minimum fractional scroll delta to track.
 */
const SCROLL_STATIC_FRICTION = 0.001;

/**
 * Calculates a scroll top value clamped between 0 and the maximum possible
 * scroll position for the given container dimensions.
 */
const getClampedScrollTop = (
  scrollTop: number,
  scrollHeight: number,
  innerHeight: number,
) => {
  const maxScroll = Math.max(0, scrollHeight - innerHeight);
  return Math.max(0, Math.min(scrollTop, maxScroll));
};

/** ink never draws a vertical scrollbar thumb shorter than a single row. */
const MIN_THUMB_HALVES = 2;

/**
 * Where the scrollbar thumb is drawn, and the scroll range it maps to.
 *
 * This mirrors `calculateScrollbarThumb()` in ink (`measure-element.js`), which
 * is what actually paints the thumb: it works in half rows and never draws a
 * thumb shorter than one row. Re-deriving the geometry with a different formula
 * makes a press land outside the thumb the user can see, which turns a "grab"
 * into a "jump to this position" click.
 */
export const getScrollbarGeometry = (
  scrollTop: number,
  scrollHeight: number,
  innerHeight: number,
  trackHeight: number,
):
  | {
      /** First row of the thumb, counted from the top of the track. */
      thumbStart: number;
      /** Height of the thumb in rows, at least 1. */
      thumbHeight: number;
      /** Largest value of `thumbStart`. */
      maxThumbStart: number;
      /** Largest scroll position a thumb row can map to. */
      maxScrollTop: number;
    }
  | undefined => {
  if (
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(scrollHeight) ||
    !Number.isFinite(innerHeight) ||
    !Number.isFinite(trackHeight) ||
    innerHeight <= 0 ||
    trackHeight <= 0 ||
    scrollHeight <= innerHeight
  ) {
    return undefined;
  }

  const maxScrollTop = scrollHeight - innerHeight;
  const trackHalves = trackHeight * 2;
  const thumbHalves = Math.max(
    MIN_THUMB_HALVES,
    Math.round((innerHeight / scrollHeight) * trackHalves),
  );
  const maxThumbHalves = trackHalves - thumbHalves;
  const clampedScrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));
  const thumbStartHalves =
    maxThumbHalves > 0
      ? Math.round((clampedScrollTop / maxScrollTop) * maxThumbHalves)
      : 0;
  const thumbStart = Math.floor(thumbStartHalves / 2);
  const thumbEnd = Math.min(
    trackHeight,
    Math.ceil((thumbStartHalves + thumbHalves) / 2),
  );
  const thumbHeight = Math.max(1, thumbEnd - thumbStart);

  return {
    thumbStart,
    thumbHeight,
    maxThumbStart: Math.max(0, trackHeight - thumbHeight),
    maxScrollTop,
  };
};

/**
 * Returns the scroll position that puts the top of the thumb at `thumbStart`,
 * clamped to the scroll range.
 */
const scrollTopForThumbStart = (
  thumbStart: number,
  geometry: { maxThumbStart: number; maxScrollTop: number },
): number => {
  if (geometry.maxThumbStart <= 0) {
    return 0;
  }
  const clampedThumbStart = Math.max(
    0,
    Math.min(geometry.maxThumbStart, thumbStart),
  );
  const scrollTop = Math.round(
    (clampedThumbStart / geometry.maxThumbStart) * geometry.maxScrollTop,
  );
  return Number.isFinite(scrollTop) ? scrollTop : 0;
};

const findScrollableCandidates = (
  mouseEvent: MouseEvent,
  scrollables: Map<string, ScrollableEntry>,
) => {
  const candidates: Array<ScrollableEntry & { area: number }> = [];

  for (const entry of scrollables.values()) {
    if (!entry.ref.current) {
      continue;
    }

    const boundingBox = getBoundingBox(entry.ref.current);
    if (!boundingBox) continue;

    const { x, y, width, height } = boundingBox;

    const isInside =
      mouseEvent.col >= x &&
      mouseEvent.col < x + width + 1 && // Intentionally add one to width to include scrollbar.
      mouseEvent.row >= y &&
      mouseEvent.row < y + height;

    if (isInside) {
      candidates.push({ ...entry, area: width * height });
    }
  }

  // Sort by smallest area first
  candidates.sort((a, b) => a.area - b.area);
  return candidates;
};

export const ScrollProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [scrollables, setScrollables] = useState(
    new Map<string, ScrollableEntry>(),
  );

  const register = useCallback((entry: ScrollableEntry) => {
    setScrollables((prev) => new Map(prev).set(entry.id, entry));
  }, []);

  const unregister = useCallback((id: string) => {
    setScrollables((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    trueScrollRef.current.delete(id);
    pendingFlushRef.current.delete(id);
  }, []);

  const scrollablesRef = useRef(scrollables);
  useEffect(() => {
    scrollablesRef.current = scrollables;
  }, [scrollables]);

  const trueScrollRef = useRef(
    new Map<string, { floatValue: number; expectedScrollTop: number }>(),
  );
  const pendingFlushRef = useRef(new Set<string>());
  const flushScheduledRef = useRef(false);

  const dragStateRef = useRef<{
    active: boolean;
    id: string | null;
    offset: number;
  }>({
    active: false,
    id: null,
    offset: 0,
  });

  const scheduleFlush = useCallback(() => {
    if (!flushScheduledRef.current) {
      flushScheduledRef.current = true;
      setTimeout(() => {
        flushScheduledRef.current = false;
        const ids = Array.from(pendingFlushRef.current);
        pendingFlushRef.current.clear();

        for (const id of ids) {
          const entry = scrollablesRef.current.get(id);
          const trueScroll = trueScrollRef.current.get(id);

          if (entry && trueScroll) {
            const { scrollTop, scrollHeight, innerHeight } =
              entry.getScrollState();

            // Re-verify it hasn't become stale before flushing
            if (trueScroll.expectedScrollTop !== scrollTop) {
              trueScrollRef.current.set(id, {
                floatValue: scrollTop,
                expectedScrollTop: scrollTop,
              });
              continue;
            }

            const clampedFloat = getClampedScrollTop(
              trueScroll.floatValue,
              scrollHeight,
              innerHeight,
            );
            const roundedTarget = Math.round(clampedFloat);

            const deltaToApply = roundedTarget - scrollTop;

            if (deltaToApply !== 0) {
              entry.scrollBy(deltaToApply);
              trueScroll.expectedScrollTop = roundedTarget;
            }

            trueScroll.floatValue = clampedFloat;
          } else {
            trueScrollRef.current.delete(id);
          }
        }
      }, 0);
    }
  }, []);

  const scrollMomentumRef = useRef({
    count: 0,
    lastTime: 0,
    lastDirection: null as 'up' | 'down' | null,
  });

  const handleScroll = (direction: 'up' | 'down', mouseEvent: MouseEvent) => {
    let multiplier = 1;
    const now = Date.now();

    if (!terminalCapabilityManager.isGhosttyTerminal()) {
      const timeSinceLastScroll = now - scrollMomentumRef.current.lastTime;
      const isSameDirection =
        scrollMomentumRef.current.lastDirection === direction;

      // 50ms threshold to consider scrolls consecutive
      if (timeSinceLastScroll < 50 && isSameDirection) {
        scrollMomentumRef.current.count += 1;
        // Accelerate up to 3x, starting after 5 consecutive scrolls.
        // Each consecutive scroll increases the multiplier by 0.1.
        multiplier = Math.min(
          3,
          1 + Math.max(0, scrollMomentumRef.current.count - 5) * 0.1,
        );
      } else {
        scrollMomentumRef.current.count = 0;
      }
    }
    scrollMomentumRef.current.lastTime = now;
    scrollMomentumRef.current.lastDirection = direction;

    const delta = (direction === 'up' ? -1 : 1) * multiplier;
    const candidates = findScrollableCandidates(
      mouseEvent,
      scrollablesRef.current,
    );

    for (const candidate of candidates) {
      const { scrollTop, scrollHeight, innerHeight } =
        candidate.getScrollState();

      let trueScroll = trueScrollRef.current.get(candidate.id);
      if (!trueScroll || trueScroll.expectedScrollTop !== scrollTop) {
        trueScroll = { floatValue: scrollTop, expectedScrollTop: scrollTop };
      }

      const maxScroll = Math.max(0, scrollHeight - innerHeight);
      const canScrollUp = trueScroll.floatValue > SCROLL_STATIC_FRICTION;
      const canScrollDown =
        trueScroll.floatValue < maxScroll - SCROLL_STATIC_FRICTION;

      if (
        (direction === 'up' && canScrollUp) ||
        (direction === 'down' && canScrollDown)
      ) {
        const clampedFloat = getClampedScrollTop(
          trueScroll.floatValue + delta,
          scrollHeight,
          innerHeight,
        );

        trueScrollRef.current.set(candidate.id, {
          floatValue: clampedFloat,
          expectedScrollTop: trueScroll.expectedScrollTop,
        });

        pendingFlushRef.current.add(candidate.id);
        scheduleFlush();
        return true;
      }
    }
    return false;
  };

  const cancelDrag = () => {
    if (dragStateRef.current.active) {
      dragStateRef.current = {
        active: false,
        id: null,
        offset: 0,
      };
      return true;
    }
    dragStateRef.current = { active: false, id: null, offset: 0 };
    return false;
  };

  const handleLeftPress = (mouseEvent: MouseEvent) => {
    // A press always starts a new gesture. Without this, a drag whose release
    // never arrived (a terminal may report it as `move`, or drop it when the
    // pointer left the window) would keep steering the scrollbar, so the next
    // unrelated drag would move the list.
    cancelDrag();

    for (const entry of scrollablesRef.current.values()) {
      if (!entry.ref.current || !entry.hasFocus()) {
        continue;
      }

      const boundingBox = getBoundingBox(entry.ref.current);
      if (!boundingBox) continue;

      const { x, y, width, height } = boundingBox;

      // Mouse columns and rows are 1-based, box coordinates are 0-based, so
      // the scrollbar painted on the last column of the box is at column
      // `x + width` and the pointer's row inside the box is `row - 1 - y`.
      const rowInBox = mouseEvent.row - 1 - y;
      if (mouseEvent.col !== x + width || rowInBox < 0 || rowInBox >= height) {
        continue;
      }

      const { scrollTop, scrollHeight, innerHeight } = entry.getScrollState();
      const geometry = getScrollbarGeometry(
        scrollTop,
        scrollHeight,
        innerHeight,
        height,
      );
      if (!geometry) continue;

      const isThumbClick =
        rowInBox >= geometry.thumbStart &&
        rowInBox < geometry.thumbStart + geometry.thumbHeight;

      let grabOffset = rowInBox - geometry.thumbStart;

      if (!isThumbClick) {
        // Track click: jump so the thumb is centred on the pointer, then keep
        // dragging. The grab offset is measured against the thumb's new
        // position so the first move does not repeat the jump.
        const targetThumbStart = Math.max(
          0,
          Math.min(
            geometry.maxThumbStart,
            rowInBox - Math.floor(geometry.thumbHeight / 2),
          ),
        );
        const newScrollTop = scrollTopForThumbStart(targetThumbStart, geometry);
        if (entry.scrollTo) {
          entry.scrollTo(newScrollTop);
        } else {
          entry.scrollBy(newScrollTop - scrollTop);
        }
        grabOffset = rowInBox - targetThumbStart;
      }

      // Start drag (for both thumb and track clicks). `offset` is the distance
      // in rows from the pointer to the top of the thumb, which stays valid for
      // the whole drag.
      dragStateRef.current = {
        active: true,
        id: entry.id,
        offset: grabOffset,
      };
      return true;
    }

    const candidates = findScrollableCandidates(
      mouseEvent,
      scrollablesRef.current,
    );

    if (candidates.length > 0) {
      // The first candidate is the innermost one.
      candidates[0].flashScrollbar();
      // We don't consider just flashing the scrollbar as handling the event
      // in a way that should prevent other handlers (like drag warning)
      // from checking it, although for left-press it doesn't matter much.
      // But returning false is safer.
      return false;
    }
    return false;
  };

  const handleMove = (mouseEvent: MouseEvent) => {
    const state = dragStateRef.current;
    if (!state.active || !state.id) return false;

    // Only the left button drags the scrollbar. Terminals report the moves of a
    // held left button with button `left`; anything else means the drag is over
    // and its release went missing.
    if (mouseEvent.button !== 'left') {
      cancelDrag();
      return false;
    }

    const entry = scrollablesRef.current.get(state.id);
    if (!entry || !entry.ref.current) {
      state.active = false;
      return false;
    }

    const boundingBox = getBoundingBox(entry.ref.current);
    if (!boundingBox) return false;

    const { y, height } = boundingBox;
    const { scrollTop, scrollHeight, innerHeight } = entry.getScrollState();
    const geometry = getScrollbarGeometry(
      scrollTop,
      scrollHeight,
      innerHeight,
      height,
    );
    if (!geometry) return false;

    // Keep the pointer inside the track instead of letting a row outside it
    // produce a scroll position outside the list.
    const rowInBox = Math.max(0, Math.min(height - 1, mouseEvent.row - 1 - y));
    const targetScrollTop = scrollTopForThumbStart(
      rowInBox - state.offset,
      geometry,
    );

    if (entry.scrollTo) {
      entry.scrollTo(targetScrollTop, 0);
    } else if (targetScrollTop !== scrollTop) {
      entry.scrollBy(targetScrollTop - scrollTop);
    }
    return true;
  };

  const handleLeftRelease = () => cancelDrag();

  useMouse(
    (event: MouseEvent) => {
      if (event.name === 'scroll-up') {
        // A wheel event means the gesture is no longer a scrollbar drag.
        cancelDrag();
        return handleScroll('up', event);
      } else if (event.name === 'scroll-down') {
        cancelDrag();
        return handleScroll('down', event);
      } else if (event.name === 'left-press') {
        return handleLeftPress(event);
      } else if (event.name === 'move') {
        return handleMove(event);
      } else if (event.name === 'left-release') {
        return handleLeftRelease();
      } else if (
        event.name === 'right-press' ||
        event.name === 'right-release' ||
        event.name === 'middle-press' ||
        event.name === 'middle-release' ||
        event.name === 'double-click'
      ) {
        // Any other button cancels a drag whose release went missing.
        cancelDrag();
      }
      return false;
    },
    { isActive: true },
  );

  const contextValue = useMemo(
    () => ({ register, unregister }),
    [register, unregister],
  );

  return (
    <ScrollContext.Provider value={contextValue}>
      {children}
    </ScrollContext.Provider>
  );
};

let nextId = 0;

export const useScrollable = (
  entry: Omit<ScrollableEntry, 'id'>,
  isActive: boolean,
) => {
  const context = useContext(ScrollContext);
  if (!context) {
    throw new Error('useScrollable must be used within a ScrollProvider');
  }

  const [id] = useState(() => `scrollable-${nextId++}`);

  useEffect(() => {
    if (isActive) {
      context.register({ ...entry, id });
      return () => {
        context.unregister(id);
      };
    }
    return;
  }, [context, entry, id, isActive]);
};
