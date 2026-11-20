// The one scrolling list of this chunk: code lines, diff rows, file lists and outlines are all rows of a known
// height, with the occasional row (a line carrying a note) that is measured. Only rows near the viewport are in the DOM.
import {useVirtualizer} from '@tanstack/react-virtual';
import {useEffect, useImperativeHandle, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode, type Ref} from 'react';
import {cx} from './lines.tsx';
import s from './lines.module.css';

export interface VirtualRowsHandle {
  readonly element: HTMLDivElement | null;
  /**
   * Brings row `index` into view; does nothing when it already is, unless `always`. By default the row lands `lead`
   * rows below the top; `near` moves the least distance instead (the way a moving cursor scrolls).
   */
  reveal(index: number, options?: {lead?: number; smooth?: boolean; always?: boolean; near?: boolean}): void;
  /** First and last row that are at least partly inside the viewport. */
  visible(): {first: number; last: number};
}

export interface VirtualRowsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  count: number;
  /** Height of a row in px, or the estimate for a measured row. */
  rowHeight: number | ((index: number) => number);
  /** Rows whose real height is read from the DOM (content that wraps). */
  measured?: (index: number) => boolean;
  /** Changes whenever `rowHeight` would answer differently for some row; row positions are then worked out again. */
  sizeKey?: string | number;
  children: (index: number) => ReactNode;
  /** Widest row in characters: keeps the horizontal scroll range stable while rows come and go. */
  cols?: number;
  /** Space the gutter takes on top of `cols`, as a CSS length. */
  colsPad?: string;
  /** Blank space above the first and below the last row, in px. */
  pad?: number;
  /** Scroll position the list opens at, in px (read once, when it mounts). */
  initialOffset?: number;
  /** Called with the rendered row range whenever it changes. */
  onRange?: (first: number, last: number) => void;
  handle?: Ref<VirtualRowsHandle>;
}

const SCROLL_MS = 280;
const ease = (t: number) => 1 - (1 - t) ** 3;

/**
 * Moves the scroll position, over 280 ms when `smooth`. A far target is approached from one viewport away, so the
 * animation never sweeps through thousands of rows (each of which would be rendered and fetched on the way).
 */
function scrollTopTo(element: HTMLElement, top: number, smooth: boolean): () => void {
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!smooth || reduced || typeof requestAnimationFrame !== 'function' || Math.abs(top - element.scrollTop) < 1) {
    element.scrollTop = top;
    return () => {};
  }
  const reach = Math.max(1, element.clientHeight);
  const from = Math.min(Math.max(element.scrollTop, top - reach), top + reach);
  let frame = 0;
  let started: number | undefined;
  const step = (now: number) => {
    started ??= now;
    const t = Math.min(1, (now - started) / SCROLL_MS);
    element.scrollTop = from + (top - from) * ease(t);
    if (t < 1) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}

export function VirtualRows(p: VirtualRowsProps): ReactNode {
  const {count, rowHeight, measured, sizeKey, children, cols, colsPad, pad = 0, initialOffset = 0, onRange, handle, className, ...rest} = p;
  const scroller = useRef<HTMLDivElement | null>(null);
  const cancel = useRef<() => void>(() => {});
  const virtual = useVirtualizer({
    count,
    getScrollElement: () => scroller.current,
    estimateSize: typeof rowHeight === 'number' ? () => rowHeight : rowHeight,
    overscan: 12,
    paddingStart: pad,
    paddingEnd: pad,
    initialOffset,
    // Enough rows for the first paint, before the scroller has been measured.
    initialRect: {width: 0, height: 640},
  });
  const items = virtual.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items.at(-1)?.index ?? -1;

  // The virtualizer opens at initialOffset and scrolls the element there; this keeps the element in step where
  // scrollTo() is not available.
  const opensAt = useRef(initialOffset);
  useLayoutEffect(() => {
    if (opensAt.current > 0 && scroller.current && scroller.current.scrollTop !== opensAt.current) scroller.current.scrollTop = opensAt.current;
  }, []);

  const sized = useRef(sizeKey);
  useEffect(() => {
    if (sized.current === sizeKey) return;
    sized.current = sizeKey;
    virtual.measure();
  }, [sizeKey, virtual]);

  const onRangeRef = useRef(onRange);
  onRangeRef.current = onRange;
  useEffect(() => {
    if (last >= first) onRangeRef.current?.(first, last);
  }, [first, last]);

  useEffect(() => () => cancel.current(), []);

  useImperativeHandle(handle, () => {
    const bounds = () => {
      const element = scroller.current;
      const top = element?.scrollTop ?? 0;
      return {top, bottom: top + (element?.clientHeight ?? 0)};
    };
    return {
      get element() { return scroller.current; },
      visible() {
        const {top, bottom} = bounds();
        const start = virtual.getVirtualItemForOffset(top)?.index ?? 0;
        const end = virtual.getVirtualItemForOffset(Math.max(top, bottom - 1))?.index ?? start;
        return {first: start, last: end};
      },
      reveal(index, options = {}) {
        const element = scroller.current;
        // Row positions come from the measurements, which unlike getOffsetForIndex() are not clamped to the scroll range.
        const row = virtual.measurementsCache[index];
        if (!element || !row) return;
        const {top, bottom} = bounds();
        if (!options.always && row.start >= top && row.end <= bottom) return;
        const lead = virtual.measurementsCache[Math.max(0, index - (options.lead ?? 0))]?.start ?? row.start;
        const target = options.near && row.start >= top ? row.end - (bottom - top) : lead;
        cancel.current();
        cancel.current = scrollTopTo(element, Math.max(0, target), options.smooth ?? false);
      },
    };
  }, [virtual]);

  return (
    // The reader's own scrolling takes over from a scroll that is still animating.
    <div {...rest} ref={scroller} className={cx(s.scroller, className)} onWheel={() => cancel.current()} onPointerDown={() => cancel.current()}>
      <div
        className={s.sizer}
        role="presentation"
        style={{height: virtual.getTotalSize(), minWidth: cols ? `calc(${cols}ch + ${colsPad ?? '0px'})` : undefined}}
      >
        {items.map(item => (
          <div
            key={item.key}
            className={s.vrow}
            role="presentation"
            data-index={item.index}
            ref={measured?.(item.index) ? virtual.measureElement : undefined}
            style={{transform: `translateY(${item.start}px)`}}
          >
            {children(item.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
