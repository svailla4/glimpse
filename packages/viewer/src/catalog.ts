// packages/viewer/src/catalog.ts  (first version by WP0; owned by WP4)
// The React catalog, built generically from COMPONENTS and the six chunk modules: nobody edits a shared registry.
// Build a fresh catalog per MessageProcessor (A2uiSurface mutates the catalog it renders).
// test/harness.tsx builds the same catalog on its own, loading each chunk separately so one broken chunk cannot stop
// the tests of the others: keep the eager / lazy split below in step with the LAZY set there.
import type {ReactCatalogComponent} from '@a2ui/react';
import {Catalog} from '@a2ui/web_core/v1_0';
import {CATALOG_ID, COMPONENTS, PROTOCOL_VERSION} from '@glimpse/catalog';
import * as content from './components/content/index.ts';
import * as layout from './components/layout/index.ts';
import {implement, type ChunkLoaders, type KitSlots} from './kit/implement.tsx';

/** 'layout' and 'content' are in the first bundle; the other four load when a surface first uses them. */
const LOADERS: ChunkLoaders = {
  layout,
  content,
  table: () => import('./components/table/index.ts'),
  charts: () => import('./components/charts/index.ts'),
  diagrams: () => import('./components/diagrams/index.ts'),
  code: () => import('./components/code/index.ts'),
};

export function createGlimpseCatalog(slots: KitSlots): Catalog<ReactCatalogComponent> {
  return new Catalog<ReactCatalogComponent>(CATALOG_ID, PROTOCOL_VERSION, COMPONENTS.map(def => implement(def as never, LOADERS, slots)), []);
}
