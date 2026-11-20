// packages/catalog/testing/index.ts  (import as '@glimpse/catalog/testing')
// Test and tooling support, NOT the product pipeline: a reference Express compiler and source-ref expander used by
// the catalog conformance tests, scripts/generate.ts and the viewer test harness. The server's own pipeline lives in
// packages/server/src/spec/ and must agree with this file on everything asserted in packages/catalog/test.
// Node and jsdom only (it imports @a2ui/agent); never import it from src/.
// This file imports nothing outside packages/catalog and node_modules: no other package can break the catalog tests,
// `npm run generate` or the viewer harness.
import {A2uiGenerator, CatalogConfig, RendererState} from '@a2ui/agent';
import {MessageProcessor, STRICT_VALIDATION} from '@a2ui/web_core/v1_0';
import {datasetFixture, pendingDataset} from '../fixtures/index.ts';
import {CATALOG_ID, createApiCatalog} from '../src/catalog.ts';
import {COMPONENT_BY_NAME} from '../src/components.ts';
import type {Dataset, SurfaceMeta} from '../src/datasets.ts';
import {normalizeSpec} from '../src/normalize.ts';
import {datasetKey, formatRef, looksLikeRef, parseRef, SOURCE_BY_NAME, type SourceRef} from '../src/sources.ts';
import type {A2uiMessage, WireComponent} from '../src/transport.ts';

export {normalizeSpec};

/** `/meta` used by every fixture surface. `root` is a placeholder: nothing reads the disk. */
export const FIXTURE_META: SurfaceMeta = {
  repo: {name: 'demo', root: '/repo', branch: 'main', head: '4f2a91c', dirty: false},
  rev: 1,
  slots: {
    lang: {TypeScript: 1, CSS: 2, Go: 3, SQL: 4, Markdown: 5, JSON: 6},
    module: {auth: 1, api: 2, ui: 3},
    author: {Mira: 1, Jon: 2, Ade: 3},
  },
  generatedAt: '2026-11-19T00:00:00Z',
};

type Catalog = ReturnType<typeof createApiCatalog>;
let shared: {catalog: Catalog; processor: any} | undefined;
function toolchain() {
  if (!shared) {
    const catalog = createApiCatalog();
    const processor = new A2uiGenerator([new CatalogConfig(catalog as never)]).createProcessor({'1.0': {supportedCatalogIds: [CATALOG_ID]}});
    shared = {catalog, processor};
  }
  return shared;
}

/**
 * Compiles Express (single or double quotes) into v1.0 messages, exactly as the compiler emits them: source refs are
 * still strings and omitted data props are still omitted. Throws the compiler's error on an invalid spec.
 * With `base` (the messages that built the surface so far) the spec is compiled as a patch of that surface.
 */
export function compileExpress(surfaceId: string, spec: string, base?: readonly A2uiMessage[]): A2uiMessage[] {
  const {catalog, processor} = toolchain();
  const twin = new MessageProcessor([catalog as never]);
  if (base) twin.processMessages(structuredClone(base) as never);
  const header = base ? `surface("${surfaceId}", update=true)` : `surface("${surfaceId}")`;
  const parts = processor.parseResponse(`${header}\n${normalizeSpec(spec)}`, {wrapped: false, state: RendererState.of(twin as never)});
  return parts.flatMap((part: any) => part.a2ui ?? []) as A2uiMessage[];
}

export type DatasetMode = 'pending' | 'ready';

function componentsOf(message: A2uiMessage): WireComponent[] {
  if ('createSurface' in message) return message.createSurface.components;
  if ('updateComponents' in message) return message.updateComponents.components;
  return [];
}

/**
 * Reference expansion (design 2.2 step 4), in place: an omitted data prop with a default source, or a string that is
 * a source ref, becomes {"@path": "/ds/<key>"}. Returns the refs by dataset key. Throws on an unknown source.
 */
export function expandRefs(messages: A2uiMessage[]): Map<string, SourceRef> {
  const refs = new Map<string, SourceRef>();
  for (const message of messages) {
    for (const comp of componentsOf(message)) {
      const def = COMPONENT_BY_NAME.get(comp.component);
      if (!def) continue;
      for (const [key, prop] of Object.entries(def.props)) {
        if (prop.kind !== 'data') continue;
        const value = comp[key];
        const text = value === undefined ? prop.source : looksLikeRef(value) ? value : undefined;
        if (!text) continue;
        const ref = parseRef(text);
        if (!SOURCE_BY_NAME.has(ref.source)) throw new Error(`E_SOURCE ${def.name}#${comp.id}.${key}: unknown source "${ref.source}"`);
        const dsKey = datasetKey(ref);
        refs.set(dsKey, ref);
        comp[key] = {'@path': `/ds/${dsKey}`};
      }
    }
  }
  return refs;
}

/** The envelope a surface holds for `ref`: a pending one, or the ready fixture dataset re-keyed for this ref. */
export function datasetFor(ref: SourceRef, mode: DatasetMode): Dataset {
  return mode === 'ready' ? datasetFixture(formatRef(ref)) : pendingDataset(formatRef(ref));
}

export interface BuildSurfaceOptions {
  /** How source refs are filled: 'pending' envelopes (what the first frame of a real `show` carries; the default) or 'ready' fixture datasets. */
  datasets?: DatasetMode;
  /** Merged over FIXTURE_META. */
  meta?: Partial<SurfaceMeta>;
  /** Initial /ui. Default {sel: null, file: null}. */
  ui?: {sel?: unknown; file?: string | null};
  /** Extra top-level data-model values, merged over what the spec assigns. */
  data?: Record<string, unknown>;
}

/**
 * Express -> the snapshot the server sends for a new surface: one createSurface whose data props are /ds bindings
 * and whose dataModel carries the spec's own data plus /ds, /ui and /meta (design 2.2, "A snapshot is ...").
 */
export function buildSurface(surfaceId: string, spec: string, options: BuildSurfaceOptions = {}): A2uiMessage[] {
  const messages = compileExpress(surfaceId, spec);
  const refs = expandRefs(messages);
  const create = messages.find(m => 'createSurface' in m);
  if (!create || !('createSurface' in create)) throw new Error(`spec for "${surfaceId}" defines no root, so it does not create a surface`);
  const ds: Record<string, Dataset> = {};
  for (const [key, ref] of refs) ds[key] = datasetFor(ref, options.datasets ?? 'pending');
  create.createSurface.dataModel = {
    ...(create.createSurface.dataModel ?? {}),
    ...(options.data ?? {}),
    ds,
    ui: {sel: null, file: null, ...(options.ui ?? {})},
    meta: {...structuredClone(FIXTURE_META), ...(options.meta ?? {})},
  };
  return messages;
}

/**
 * Express patch of an existing surface -> the delta the server publishes in mode `patch`: the compiled
 * updateComponents / updateDataModel with refs expanded, plus one updateDataModel per dataset the patch introduces.
 */
export function buildPatch(surfaceId: string, base: readonly A2uiMessage[], spec: string, options: Pick<BuildSurfaceOptions, 'datasets'> = {}): A2uiMessage[] {
  const messages = compileExpress(surfaceId, spec, base);
  const refs = expandRefs(messages);
  const known = new Set<string>();
  for (const message of base) {
    if ('createSurface' in message) for (const key of Object.keys((message.createSurface.dataModel?.ds as object | undefined) ?? {})) known.add(key);
    if ('updateDataModel' in message && message.updateDataModel.path?.startsWith('/ds/')) known.add(message.updateDataModel.path.slice(4));
  }
  for (const [key, ref] of refs) {
    if (known.has(key)) continue;
    messages.push({version: '1.0', updateDataModel: {surfaceId, path: `/ds/${key}`, value: datasetFor(ref, options.datasets ?? 'pending')}});
  }
  return messages;
}

/** Errors a strict v1.0 renderer reports for these messages (empty when they are valid). Never throws. */
export function strictErrors(messages: readonly A2uiMessage[]): unknown[] {
  const strict = new MessageProcessor([toolchain().catalog as never], undefined, {validationConfig: STRICT_VALIDATION});
  return strict.processMessagesWithErrors(structuredClone(messages) as never);
}
