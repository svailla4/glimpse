// packages/viewer/src/kit/index.ts  (owned by WP4; the names WP0 exported are frozen)
// The one import site for views: `import {DataGate, EntityLink, useDataset, type GlView} from '../../kit/index.ts'`.
// Views never import @a2ui/*.
import {Frame, PlateFrame} from './Frame.tsx';
import type {KitSlots} from './implement.tsx';
import {Drafting, Redline} from './states.tsx';

export * from './arrange.tsx';
export * from './color.ts';
export * from './entity.tsx';
export * from './format.ts';
export * from './hooks.ts';
export * from './icons.tsx';
export {ArrangeContext, PlateAside, borrowView, implement, isFrameable, loadChunk, useCell} from './implement.tsx';
export type {ArrangeApi, CellInfo, ChunkLoaders, GlView, GlViewProps, KitSlots, ViewModule} from './implement.tsx';
export * from './marginal.tsx';
export * from './provider.tsx';
export {REPORT_CODES, ReportContext, Subpart, createRedefinitions, reportCode, useReportState} from './report.ts';
export type {RenderReport, ReportChannel} from './report.ts';
export * from './select.ts';
export {DEFAULT_CAP, FAMILY_CAPS, FILL_MIN, FILL_OFFSET, SIZE_STEPS, sizeCap, useSizeCap} from './sizeCap.ts';
export type {SizeStep} from './sizeCap.ts';
export * from './states.tsx';
export * from './surface.ts';
export * from './tooltip.tsx';
export * from './useSize.ts';
export {Frame, PlateFrame};

/** The looks implement() plugs into every component. The app catalog and the test harness both use this object. */
export const kitSlots: KitSlots = {Frame, Drafting, Redline};
