// One virtualized list with roving focus, shared by the four views: only the rows near the viewport are mounted,
// exactly one row is a tab stop, and arrows / Home / End / PgUp / PgDn move it.
import {defaultRangeExtractor, useVirtualizer, type Range, type VirtualItem} from '@tanstack/react-virtual';
import {useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject} from 'react';

export interface ListNavOptions {
  count: number;
  rowHeight: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Height of a sticky header that sits above the rows inside the scroll element. */
  offsetTop?: number;
}

export interface ListNav {
  /** Mounted rows: the viewport, a small overscan and the active row. */
  items: VirtualItem[];
  /** Height of all rows together. */
  totalSize: number;
  /** Offset to subtract from `item.start` when positioning a row inside the rows container. */
  offsetTop: number;
  active: number;
  /** Makes a row the tab stop; with `focus` it is also scrolled into view and focused. */
  setActive(index: number, focus?: boolean): void;
  /** Makes a row the tab stop and scrolls it into view without moving focus (following a selection made elsewhere). */
  reveal(index: number): void;
  /** Arrow keys, Home, End, PageUp, PageDown. Returns true when the key was handled. */
  handleKey(event: KeyboardEvent): boolean;
}

const FIRST_PAINT = {width: 0, height: 420};

export function useListNav({count, rowHeight, scrollRef, offsetTop = 0}: ListNavOptions): ListNav {
  const [activeState, setActiveState] = useState(0);
  const [focusTick, setFocusTick] = useState(0);
  const wantFocus = useRef(false);
  const active = Math.min(activeState, Math.max(0, count - 1));

  // The active row stays mounted while it is scrolled away, so focus is never lost to the document.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (active >= count || indexes.includes(active)) return indexes;
      indexes.push(active);
      return indexes.sort((a, b) => a - b);
    },
    [active, count],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
    scrollMargin: offsetTop,
    scrollPaddingStart: offsetTop,
    initialRect: FIRST_PAINT,
    rangeExtractor,
    useFlushSync: false,
  });

  const measured = useRef(rowHeight);
  useEffect(() => {
    if (measured.current === rowHeight) return;
    measured.current = rowHeight;
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const setActive = useCallback(
    (index: number, focus = false) => {
      const next = Math.min(Math.max(0, index), Math.max(0, count - 1));
      setActiveState(next);
      if (!focus) return;
      wantFocus.current = true;
      setFocusTick(tick => tick + 1);
      virtualizer.scrollToIndex(next, {align: 'auto'});
    },
    [count, virtualizer],
  );

  const reveal = useCallback(
    (index: number) => {
      const next = Math.min(Math.max(0, index), Math.max(0, count - 1));
      setActiveState(next);
      virtualizer.scrollToIndex(next, {align: 'auto'});
    },
    [count, virtualizer],
  );

  // focusTick re-runs the effect when the row that is already active is focused again.
  useLayoutEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    scrollRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus({preventScroll: true});
  }, [active, focusTick, scrollRef]);

  const handleKey = useCallback(
    (event: KeyboardEvent): boolean => {
      if (event.altKey || event.ctrlKey || event.metaKey || count === 0) return false;
      const page = Math.max(1, Math.floor(((scrollRef.current?.clientHeight ?? 0) - offsetTop) / rowHeight) - 1);
      let next: number;
      switch (event.key) {
        case 'ArrowDown': next = active + 1; break;
        case 'ArrowUp': next = active - 1; break;
        case 'Home': next = 0; break;
        case 'End': next = count - 1; break;
        case 'PageDown': next = active + page; break;
        case 'PageUp': next = active - page; break;
        default: return false;
      }
      event.preventDefault();
      setActive(next, true);
      return true;
    },
    [active, count, offsetTop, rowHeight, scrollRef, setActive],
  );

  return {items: virtualizer.getVirtualItems(), totalSize: virtualizer.getTotalSize(), offsetTop, active, setActive, reveal, handleKey};
}

/** First and last index on screen, leaving out the active row when it is only mounted to keep focus. */
export function visibleRange(items: readonly VirtualItem[], active: number): readonly [first: number, last: number] {
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  for (let i = 0; i < items.length; i++) {
    const index = items[i]!.index;
    const adjacent = items[i - 1]?.index === index - 1 || items[i + 1]?.index === index + 1;
    if (index === active && !adjacent && items.length > 1) continue;
    if (index < first) first = index;
    if (index > last) last = index;
  }
  return [Math.min(first, last), last];
}

// ---------------------------------------------------------------- density
// Row height follows the shell's density toggle (`--gl-row` on <html>: 28 px, 34 px comfortable). The virtualizer
// needs it as a number, so it is read from the computed style and re-read when the root's attributes change.
const DEFAULT_ROW = 28;
let cachedRow: number | undefined;
const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;

function readRow(): number {
  if (cachedRow === undefined) {
    const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gl-row'));
    cachedRow = Number.isFinite(value) && value >= 16 && value <= 80 ? value : DEFAULT_ROW;
  }
  return cachedRow;
}

function subscribeRow(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      cachedRow = undefined;
      for (const notify of listeners) notify();
    });
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-density', 'class', 'style']});
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = undefined;
      cachedRow = undefined;
    }
  };
}

/** Current height of a standard row in px. */
export function useRowHeight(): number {
  return useSyncExternalStore(subscribeRow, readRow, () => DEFAULT_ROW);
}
