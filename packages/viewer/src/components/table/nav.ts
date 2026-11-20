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
const OVERSCAN = 8;
/** Height of the faded bottom edge of a scroller (useScrollFade): a row under it is not in full view. */
const EDGE = 16;
/**
 * A list this short mounts every row (finding V047): nothing it shows can depend on the virtual window being in step
 * with the scroller, and 64 rows cost nothing to keep mounted.
 */
export const SMALL_LIST = 64;

/**
 * The virtual window follows the scroller's live position (V047). A position that changed without a scroll event
 * (the browser clamping it after the plate grew, the scroller moved in the document) would leave the rows on screen
 * unmounted until the next scroll. Whenever focus enters the list or the scroller changes size, a drift between the
 * two is put right by replaying the scroll event the virtualizer listens to.
 */
function useFollowScroll(scrollRef: RefObject<HTMLDivElement | null>, offsetOf: () => number | null): void {
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const sync = () => {
      const offset = offsetOf();
      if (offset !== null && Math.abs(offset - element.scrollTop) > 1) element.dispatchEvent(new Event('scroll'));
    };
    element.addEventListener('focusin', sync);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : undefined;
    observer?.observe(element);
    return () => {
      element.removeEventListener('focusin', sync);
      observer?.disconnect();
    };
  }, [scrollRef, offsetOf]);
}

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
    overscan: count <= SMALL_LIST ? count : OVERSCAN,
    scrollMargin: offsetTop,
    scrollPaddingStart: offsetTop,
    initialRect: FIRST_PAINT,
    rangeExtractor,
    useFlushSync: false,
  });

  const offsetOf = useCallback(() => virtualizer.scrollOffset, [virtualizer]);
  useFollowScroll(scrollRef, offsetOf);

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
      // A row already in full view stays where it is; any other is brought to the middle, clear of the faded edges.
      const element = scrollRef.current;
      if (!element) {
        virtualizer.scrollToIndex(next, {align: 'center'});
        return;
      }
      const pad = Number.parseFloat(getComputedStyle(element).paddingTop) || 0;
      const top = pad + offsetTop + next * rowHeight;
      const inView = top >= element.scrollTop + offsetTop && top + rowHeight <= element.scrollTop + element.clientHeight - EDGE;
      if (!inView) virtualizer.scrollToOffset(revealOffset(next, {rowHeight, offsetTop, pad, viewport: element.clientHeight, max: element.scrollHeight - element.clientHeight}));
    },
    [count, virtualizer, scrollRef, offsetTop, rowHeight],
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

/**
 * The scroll offset that brings row `index` to the middle of a list with whole rows only: the row at the top edge
 * (under a sticky header `offsetTop` high, below the scroller's top padding `pad`) is never cut in half, so a tree
 * that opens on a selected file starts with a row a reader can read (round 4: the tree preset opened with its top row
 * sliced under the caption). At the very end of the list the last row is whole instead.
 */
export function revealOffset(index: number, box: {rowHeight: number; offsetTop: number; pad: number; viewport: number; max: number}): number {
  const {rowHeight, offsetTop, pad, viewport, max} = box;
  const centred = pad + index * rowHeight - (viewport - offsetTop - rowHeight) / 2;
  const whole = pad + Math.round((centred - pad) / rowHeight) * rowHeight;
  return Math.max(0, Math.min(Math.max(0, max), whole));
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

// ---------------------------------------------------------------- scroll edges
const mark = (element: HTMLElement, name: string, on: boolean) => {
  if (on) element.setAttribute(name, '');
  else element.removeAttribute(name);
};

/**
 * Says where a scroller has more to show: `data-more-y` while it is not at its bottom end, `data-more-x` while it
 * is not at its right end. The stylesheet fades that edge, so a row cut by the plate reads as "scroll", not as a
 * layout fault. `key` is anything that changes when the content changes size (row count, column widths).
 */
export function useScrollFade(scrollRef: RefObject<HTMLElement | null>, key?: unknown): void {
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => {
      mark(element, 'data-more-y', element.scrollHeight - element.clientHeight - element.scrollTop > 1);
      mark(element, 'data-more-x', element.scrollWidth - element.clientWidth - element.scrollLeft > 1);
    };
    update();
    element.addEventListener('scroll', update, {passive: true});
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : undefined;
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [scrollRef, key]);
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
