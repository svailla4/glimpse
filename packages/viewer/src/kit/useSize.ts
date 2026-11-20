// packages/viewer/src/kit/useSize.ts  (first version by WP0; owned by WP4; exported signature is frozen)
import {useLayoutEffect, useState, type RefObject} from 'react';

/**
 * Content-box size of an element, kept current with a ResizeObserver. {0, 0} until it is measured: charts and
 * diagrams draw nothing at zero size, so they need no special first-render path.
 * The element may mount later than the hook (a view that first returns an Empty or a Redline and only then the
 * element the ref is on) and may be replaced: the hook follows whatever `ref.current` is after each commit, and goes
 * back to {0, 0} while there is no element.
 */
export function useSize(ref: RefObject<Element | null>): {width: number; height: number} {
  const [size, setSize] = useState({width: 0, height: 0});
  const [element, setElement] = useState<Element | null>(null);
  // Runs after every commit on purpose: a ref object does not say when its element changes. Setting the same
  // element again is a no-op, so this costs one comparison per render.
  useLayoutEffect(() => {
    if (ref.current !== element) setElement(ref.current);
  });
  useLayoutEffect(() => {
    const update = (width: number, height: number) =>
      setSize(prev => (prev.width === width && prev.height === height ? prev : {width, height}));
    if (!element) {
      update(0, 0);
      return;
    }
    const rect = element.getBoundingClientRect();
    update(rect.width, rect.height);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const box = entries.at(-1)?.contentRect;
      if (box) update(box.width, box.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}
