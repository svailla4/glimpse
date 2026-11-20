// packages/viewer/src/kit/index.ts  (first version by WP0; owned by WP4; exported names are frozen)
// The one import site for views: `import {DataGate, EntityLink, useDataset, type GlView} from '../../kit/index.ts'`.
// Views never import @a2ui/*.
import {Frame} from './Frame.tsx';
import type {KitSlots} from './implement.tsx';
import {Drafting, Redline} from './states.tsx';

export * from './color.ts';
export * from './entity.tsx';
export * from './format.ts';
export * from './hooks.ts';
export * from './icons.tsx';
export {ArrangeContext, PlateAside, borrowView, implement} from './implement.tsx';
export type {ArrangeApi, ChunkLoaders, GlView, GlViewProps, KitSlots, ViewModule} from './implement.tsx';
export * from './marginal.tsx';
export * from './provider.tsx';
export * from './states.tsx';
export * from './tooltip.tsx';
export * from './useSize.ts';
export {Frame};

/** The looks implement() plugs into every component. The app catalog and the test harness both use this object. */
export const kitSlots: KitSlots = {Frame, Drafting, Redline};
