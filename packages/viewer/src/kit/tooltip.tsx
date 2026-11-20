// packages/viewer/src/kit/tooltip.tsx  (owned by WP4; exported signatures are frozen)
// One tooltip layer per KitProvider. Views call show() on pointer move and hide() on leave; x and y are viewport
// (client) coordinates. Outside a provider both calls do nothing, so a view never has to check.
// A tooltip belongs to the view that showed it: it goes away when that view unmounts (its data was replaced, its
// surface closed), when the page scrolls under it and when the window loses focus, and one view's hide() never
// takes down a tooltip another view has put up since.
import {createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode} from 'react';

export interface TooltipApi {
  show(content: ReactNode, x: number, y: number): void;
  hide(): void;
}

/** The layer itself: every call names the view (`owner`) it is made for. */
interface TooltipLayer {
  show(owner: object, content: ReactNode, x: number, y: number): void;
  hide(owner: object): void;
}

const TooltipContext = createContext<TooltipLayer | null>(null);

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
  const [tip, setTip] = useState<{owner: object; content: ReactNode; x: number; y: number} | null>(null);
  const element = useRef<HTMLDivElement>(null);
  const layer = useMemo<TooltipLayer>(() => ({
    show: (owner, content, x, y) => setTip({owner, content, x, y}),
    hide: owner => setTip(current => (current && current.owner === owner ? null : current)),
  }), []);

  // The size is only known once the content is in the DOM, so the final position is written before paint.
  useLayoutEffect(() => {
    const box = element.current;
    if (!box || !tip) return;
    const {width, height} = box.getBoundingClientRect();
    box.style.left = `${place(tip.x, width, document.documentElement.clientWidth)}px`;
    box.style.top = `${place(tip.y, height, document.documentElement.clientHeight)}px`;
  }, [tip]);

  // What the pointer was over moves away under a scroll, and a window that lost focus gets no pointer-leave.
  const shown = tip !== null;
  useEffect(() => {
    if (!shown) return;
    const clear = () => setTip(null);
    window.addEventListener('scroll', clear, {capture: true, passive: true});
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('scroll', clear, {capture: true});
      window.removeEventListener('blur', clear);
    };
  }, [shown]);

  return (
    <TooltipContext.Provider value={layer}>
      {p.children}
      {tip ? (
        <div ref={element} className="gl-tooltip" role="tooltip" style={{position: 'fixed', left: tip.x + OFFSET, top: tip.y + OFFSET, pointerEvents: 'none'}}>
          {tip.content}
        </div>
      ) : null}
    </TooltipContext.Provider>
  );
}

const NOOP: TooltipApi = {show: () => {}, hide: () => {}};

/** The tooltip of the calling view. The object is stable for the life of the view; its tooltip is hidden when the view unmounts. */
export function useTooltip(): TooltipApi {
  const layer = useContext(TooltipContext);
  const api = useMemo<TooltipApi>(() => {
    if (!layer) return NOOP;
    const owner = {};
    return {show: (content, x, y) => layer.show(owner, content, x, y), hide: () => layer.hide(owner)};
  }, [layer]);
  useEffect(() => () => api.hide(), [api]);
  return api;
}
