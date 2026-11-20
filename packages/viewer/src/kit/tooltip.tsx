// packages/viewer/src/kit/tooltip.tsx  (first version by WP0; owned by WP4; exported signatures are frozen)
// One tooltip layer per KitProvider. Views call show() on pointer move and hide() on leave; x and y are viewport
// (client) coordinates. Outside a provider both calls do nothing, so a view never has to check.
import {createContext, useContext, useMemo, useState, type JSX, type ReactNode} from 'react';

export interface TooltipApi {
  show(content: ReactNode, x: number, y: number): void;
  hide(): void;
}

const NOOP: TooltipApi = {show: () => {}, hide: () => {}};
const TooltipContext = createContext<TooltipApi>(NOOP);

/** Mounted once by KitProvider. */
export function TooltipProvider(p: {children: ReactNode}): JSX.Element {
  const [tip, setTip] = useState<{content: ReactNode; x: number; y: number} | null>(null);
  const api = useMemo<TooltipApi>(() => ({show: (content, x, y) => setTip({content, x, y}), hide: () => setTip(null)}), []);
  return (
    <TooltipContext.Provider value={api}>
      {p.children}
      {tip ? (
        <div className="gl-tooltip" role="tooltip" style={{position: 'fixed', left: tip.x + 12, top: tip.y + 12, pointerEvents: 'none'}}>
          {tip.content}
        </div>
      ) : null}
    </TooltipContext.Provider>
  );
}

export function useTooltip(): TooltipApi {
  return useContext(TooltipContext);
}
