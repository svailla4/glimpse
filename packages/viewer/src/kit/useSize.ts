// packages/viewer/src/kit/useSize.ts  (first version by WP0; owned by WP4; exported signature is frozen)
import {useLayoutEffect, useState, type RefObject} from 'react';

/**
 * Content-box size of an element, kept current with a ResizeObserver. {0, 0} until it is measured: charts and
 * diagrams draw nothing at zero size, so they need no special first-render path.
 */
export function useSize(ref: RefObject<Element | null>): {width: number; height: number} {
  const [size, setSize] = useState({width: 0, height: 0});
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (width: number, height: number) =>
      setSize(prev => (prev.width === width && prev.height === height ? prev : {width, height}));
    const rect = element.getBoundingClientRect();
    update(rect.width, rect.height);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const box = entries.at(-1)?.contentRect;
      if (box) update(box.width, box.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
