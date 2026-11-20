// packages/viewer/src/kit/provider.tsx  (first version by WP0; owned by WP4; `host` and `children` are frozen)
import type {DataClient, LinkStatus} from '@glimpse/catalog';
import {useMemo, type JSX, type ReactNode} from 'react';
import {HostContext, LinkContext} from './hooks.ts';
import {ReportContext, type RenderReport, type ReportChannel} from './report.ts';
import {TooltipProvider} from './tooltip.tsx';

/**
 * Everything a view needs around an <A2uiSurface>: the DataClient (useHost), the tooltip layer (useTooltip), the
 * state of the link (useLinkStatus; 'live' when not given) and the channel on which the state of every component is
 * reported to the host (`report`; nothing is reported when not given). `watch` lets a component's cell hear that an
 * update named the component again, so it says its state again (decision D14); without it a state is sent when the
 * cell mounts and when it changes.
 * The shell mounts it once; the test harness mounts the same one, so providers added here reach tests too.
 */
export function KitProvider(p: {host: DataClient; link?: LinkStatus; report?: (report: RenderReport) => void; watch?: ReportChannel['watch']; children: ReactNode}): JSX.Element {
  const {report, watch} = p;
  const channel = useMemo<ReportChannel | null>(() => (report ? {report, ...(watch ? {watch} : {})} : null), [report, watch]);
  return (
    <HostContext.Provider value={p.host}>
      <LinkContext.Provider value={p.link ?? 'live'}>
        <ReportContext.Provider value={channel}>
          <TooltipProvider>{p.children}</TooltipProvider>
        </ReportContext.Provider>
      </LinkContext.Provider>
    </HostContext.Provider>
  );
}
