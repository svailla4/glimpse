// packages/viewer/src/kit/provider.tsx  (first version by WP0; owned by WP4; `host` and `children` are frozen)
import type {DataClient, LinkStatus} from '@glimpse/catalog';
import type {JSX, ReactNode} from 'react';
import {HostContext, LinkContext, ReportContext, type RenderReport} from './hooks.ts';
import {TooltipProvider} from './tooltip.tsx';

/**
 * Everything a view needs around an <A2uiSurface>: the DataClient (useHost), the tooltip layer (useTooltip), the
 * state of the link (useLinkStatus; 'live' when not given) and the channel on which Empty and Redline states are
 * reported to the host (`report`; nothing is reported when not given).
 * The shell mounts it once; the test harness mounts the same one, so providers added here reach tests too.
 */
export function KitProvider(p: {host: DataClient; link?: LinkStatus; report?: (report: RenderReport) => void; children: ReactNode}): JSX.Element {
  return (
    <HostContext.Provider value={p.host}>
      <LinkContext.Provider value={p.link ?? 'live'}>
        <ReportContext.Provider value={p.report ?? null}>
          <TooltipProvider>{p.children}</TooltipProvider>
        </ReportContext.Provider>
      </LinkContext.Provider>
    </HostContext.Provider>
  );
}
