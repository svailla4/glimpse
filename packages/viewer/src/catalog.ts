// packages/viewer/src/catalog.ts  (owned by WP4)
// The React catalog, built generically from COMPONENTS and the six chunk modules: nobody edits a shared registry.
// Build a fresh catalog per MessageProcessor (A2uiSurface mutates the catalog it renders).
// test/harness.tsx builds the same catalog on its own, loading each chunk separately so one broken chunk cannot stop
// the tests of the others: keep the eager / lazy split below in step with the LAZY set there.
import type {ReactCatalogComponent} from '@a2ui/react';
import {Catalog} from '@a2ui/web_core/v1_0';
import {CATALOG_ID, COMPONENT_BY_NAME, COMPONENTS, PROTOCOL_VERSION, type Chunk} from '@glimpse/catalog';
import * as content from './components/content/index.ts';
import * as layout from './components/layout/index.ts';
import {implement, type ChunkLoaders, type KitSlots, type ViewModule} from './kit/implement.tsx';

/** 'layout' and 'content' are in the first bundle; these four load when a surface first uses them. */
const LAZY: Partial<Record<Chunk, () => Promise<ViewModule>>> = {
  table: () => import('./components/table/index.ts'),
  charts: () => import('./components/charts/index.ts'),
  diagrams: () => import('./components/diagrams/index.ts'),
  code: () => import('./components/code/index.ts'),
};
const LOADERS = {layout, content, ...LAZY} as ChunkLoaders;

export function createGlimpseCatalog(slots: KitSlots): Catalog<ReactCatalogComponent> {
  return new Catalog<ReactCatalogComponent>(CATALOG_ID, PROTOCOL_VERSION, COMPONENTS.map(def => implement(def as never, LOADERS, slots)), []);
}

const requested = new Set<Chunk>();

/**
 * Starts fetching the lazy chunks that hold the given component types, as soon as a message names them and before
 * React reaches them (design 2.6). implement()'s React.lazy later gets the same module promise. Unknown names and
 * eager chunks are ignored; a chunk that fails to load is retried the next time it is asked for.
 */
export function preloadChunks(types: Iterable<string>): void {
  for (const type of types) {
    const chunk = COMPONENT_BY_NAME.get(type)?.chunk;
    const load = chunk ? LAZY[chunk] : undefined;
    if (!chunk || !load || requested.has(chunk)) continue;
    requested.add(chunk);
    load().catch(() => void requested.delete(chunk));
  }
}
