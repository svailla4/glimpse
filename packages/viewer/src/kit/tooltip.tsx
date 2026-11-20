// packages/viewer/src/kit/tooltip.tsx  (owned by WP4; exported signatures are frozen)
// One tooltip layer per KitProvider. Views call show() on pointer move and hide() on leave; x and y are viewport
// (client) coordinates. Outside a provider both calls do nothing, so a view never has to check.
import {createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode} from 'react';

export interface TooltipApi {
  show(content: ReactNode, x: number, y: number): void;
  hide(): void;
}

const NOOP: TooltipApi = {show: () => {}, hide: () => {}};
const TooltipContext = createContext<TooltipApi>(NOOP);

/** Distance from the pointer, and the margin kept to the viewport edge. */
const OFFSET = 12;
const MARGIN = 8;

/**
 * Below and right of the pointer; flipped to the other side where it would leave the viewport, then clamped.
 * A tooltip that cannot fit at all stays at the pointer.
 */
function place(pointer: number, size: number, viewport: number): number {
  const after = pointer + OFFSET;
  if (after + size + MARGIN <= viewport || size + 2 * MARGIN >= viewport) return after;
  const before = pointer - OFFSET - size;
  return before >= MARGIN ? before : Math.max(MARGIN, viewport - size - MARGIN);
}

/** Mounted once by KitProvider. */
export function TooltipProvider(p: {children: ReactNode}): JSX.Element {
  const [tip, setTip] = useState<{content: ReactNode; x: number; y: number} | null>(null);
  const element = useRef<HTMLDivElement>(null);
  const api = useMemo<TooltipApi>(() => ({show: (content, x, y) => setTip({content, x, y}), hide: () => setTip(null)}), []);

  // The size is only known once the content is in the DOM, so the final position is written before paint.
  useLayoutEffect(() => {
    const box = element.current;
    if (!box || !tip) return;
    const {width, height} = box.getBoundingClientRect();
    box.style.left = `${place(tip.x, width, document.documentElement.clientWidth)}px`;
    box.style.top = `${place(tip.y, height, document.documentElement.clientHeight)}px`;
  }, [tip]);

  return (
    <TooltipContext.Provider value={api}>
      {p.children}
      {tip ? (
        <div ref={element} className="gl-tooltip" role="tooltip" style={{position: 'fixed', left: tip.x + OFFSET, top: tip.y + OFFSET, pointerEvents: 'none'}}>
          {tip.content}
        </div>
      ) : null}
    </TooltipContext.Provider>
  );
}

export function useTooltip(): TooltipApi {
  return useContext(TooltipContext);
}
