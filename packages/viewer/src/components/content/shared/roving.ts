// One tab stop per component with roving focus inside (design 5.1): the container handles the keys, items carry the
// tabindex. Items are found by `data-roving`, so they can sit at any depth inside the container.
import {useCallback, useRef, useState, type KeyboardEvent, type RefObject} from 'react';

export interface Roving<E extends HTMLElement> {
  ref: RefObject<E | null>;
  /** Index of the item that holds the tab stop. */
  current: number;
  /** Spread on each item. */
  item(index: number): {tabIndex: 0 | -1; 'data-roving': number; onFocus(): void};
  /** Call from the container's onKeyDown; returns true when the key moved focus. */
  onKeyDown(event: KeyboardEvent): boolean;
}

const PAGE = 10;

export function useRoving<E extends HTMLElement>(count: number, axis: 'vertical' | 'horizontal' = 'vertical'): Roving<E> {
  const ref = useRef<E>(null);
  const [active, setActive] = useState(0);
  const current = Math.min(active, Math.max(0, count - 1));

  const move = useCallback(
    (index: number) => {
      const next = Math.min(Math.max(0, index), Math.max(0, count - 1));
      setActive(next);
      ref.current?.querySelector<HTMLElement>(`[data-roving="${next}"]`)?.focus();
    },
    [count],
  );

  const onKeyDown = (event: KeyboardEvent): boolean => {
    if (event.altKey || event.metaKey || event.ctrlKey || count === 0) return false;
    const back = axis === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
    const forward = axis === 'vertical' ? 'ArrowDown' : 'ArrowRight';
    let target: number;
    if (event.key === forward) target = current + 1;
    else if (event.key === back) target = current - 1;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = count - 1;
    else if (event.key === 'PageDown') target = current + PAGE;
    else if (event.key === 'PageUp') target = current - PAGE;
    else return false;
    event.preventDefault();
    move(target);
    return true;
  };

  return {
    ref,
    current,
    item: index => ({tabIndex: index === current ? 0 : -1, 'data-roving': index, onFocus: () => setActive(index)}),
    onKeyDown,
  };
}
