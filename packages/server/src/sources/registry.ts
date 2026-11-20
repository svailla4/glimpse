// packages/server/src/sources/registry.ts  (WP0, final)
// The registry helpers. This module is PURE: it imports only the catalog and the contracts, never a source
// implementation, so the server core and its tests can use it with fake sources without loading any analyzer or git
// code. The production registry (every real source) is REGISTRY in ./all.ts, and only the composition root
// (src/main.ts) imports that module; everything else takes a SourceRegistry as a parameter.
import {SOURCE_BY_NAME, SOURCES, type SourceMeta} from '@glimpse/catalog';
import {SourceError, type Source} from '../contracts.ts';

export type SourceRegistry = ReadonlyMap<string, Source>;

/** Builds a registry. Later entries win, so tests can inject fakes: createRegistry([...real.values(), fakeRows]). */
export function createRegistry(sources: readonly Source[]): SourceRegistry {
  return new Map(sources.map(source => [source.meta.name, source]));
}

/**
 * Stand-in for a source that is declared in the catalog but has no implementation yet. Running it rejects with
 * SourceError('E_INTERNAL', 'not implemented'), which the dataset store turns into an error envelope: the component
 * bound to it shows a redline and the rest of the view still renders.
 */
export function notImplemented(meta: SourceMeta): Source {
  return {
    meta,
    run: () => Promise.reject(new SourceError('E_INTERNAL', 'not implemented')),
  };
}

/**
 * The source to run for a name: the registered implementation, the not-implemented stand-in for a catalog source
 * without one, or undefined for a name that is not a source at all (the caller reports E_SOURCE).
 * A registry may also hold sources the catalog does not list (test fakes); they resolve like any other.
 */
export function resolveSource(name: string, registry: SourceRegistry): Source | undefined {
  const registered = registry.get(name);
  if (registered) return registered;
  const meta = SOURCE_BY_NAME.get(name);
  return meta ? notImplemented(meta) : undefined;
}

/** Catalog sources without an implementation, in catalog order. Empty once every source has landed. */
export function missingSources(registry: SourceRegistry): string[] {
  return SOURCES.filter(source => !registry.has(source.name)).map(source => source.name);
}

/**
 * Startup check: logs one line naming the catalog sources that have no implementation and returns them.
 * It never throws, so a partly built server still starts and serves what it has.
 */
export function checkRegistry(log: (message: string) => void, registry: SourceRegistry): string[] {
  const missing = missingSources(registry);
  if (missing.length > 0) log(`glimpse: ${missing.length} of ${SOURCES.length} sources are not implemented: ${missing.join(' ')}`);
  return missing;
}
