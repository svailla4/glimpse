// packages/viewer/src/kit/provider.tsx  (first version by WP0; owned by WP4; KitProvider's props are frozen)
import type {DataClient} from '@glimpse/catalog';
import type {JSX, ReactNode} from 'react';
import {HostContext} from './hooks.ts';
import {TooltipProvider} from './tooltip.tsx';

/**
 * Everything a view needs around an <A2uiSurface>: the DataClient (useHost) and the tooltip layer (useTooltip).
 * The shell mounts it once; the test harness mounts the same one, so providers added here reach tests too.
 */
export function KitProvider(p: {host: DataClient; children: ReactNode}): JSX.Element {
  return (
    <HostContext.Provider value={p.host}>
      <TooltipProvider>{p.children}</TooltipProvider>
    </HostContext.Provider>
  );
}
