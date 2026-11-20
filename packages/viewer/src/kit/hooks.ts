// packages/viewer/src/kit/hooks.ts
// Data, selection and host access for views. No view imports @a2ui/* directly.
import {createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import {useA2uiSurface, useSignalValue} from '@a2ui/react';
import {
  PATHS, formatFileLoc, isDataset,
  type Dataset, type EntityRef, type Field, type Roles, type SurfaceMeta, type Truncation,
} from '@glimpse/catalog';
import type {DataInput} from '@glimpse/catalog';
import type {DataClient, RowsPage} from '@glimpse/catalog';
import {SOURCE_BY_NAME, parseRef} from '@glimpse/catalog';

/** Provided once by the shell: <HostContext.Provider value={transport}>. */
export const HostContext = createContext<DataClient | null>(null);
export function useHost(): DataClient {
  const host = useContext(HostContext);
  if (!host) throw new Error('HostContext is missing');
  return host;
}

export type DataStatus = 'pending' | 'ready' | 'empty' | 'error';
export interface DataState<T> {
  status: DataStatus;
  /** Present when status is 'ready'. */
  data?: T;
  /** The envelope, when the value came from a server dataset. */
  ds?: Dataset<T>;
  fields?: Field[];
  roles?: Roles;
  total?: number;
  truncated?: Truncation;
  /** Human text for pending / empty / error. */
  message?: string;
  code?: string;
}

const isEmpty = (v: unknown) =>
  v == null || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** Normalizes a data prop: Dataset envelope | bare value | undefined -> one state object. */
export function useDataset<T>(input: DataInput<T>): DataState<T> {
  return useMemo<DataState<T>>(() => {
    if (isDataset(input)) {
      const ds = input as Dataset<T>;
      if (ds.status === 'pending') return {status: 'pending', ds, message: ds.note ?? `running ${ds.source}`};
      if (ds.status === 'error') return {status: 'error', ds, code: ds.error?.code ?? 'E_SOURCE', message: ds.error?.message ?? 'source failed'};
      if (isEmpty(ds.data)) return {status: 'empty', ds, message: `no data from ${ds.source}`};
      return {status: 'ready', ds, data: ds.data as T, fields: ds.fields, roles: ds.roles, total: ds.total, truncated: ds.truncated};
    }
    if (typeof input === 'string' && SOURCE_BY_NAME.has(parseRef(input).source)) {
      return {status: 'error', code: 'E_UNEXPANDED_REF', message: `source ref "${input}" was not expanded by the server`};
    }
    if (isEmpty(input)) return {status: 'empty', message: 'nothing bound'};
    return {status: 'ready', data: input as T};
  }, [input]);
}

function useSurface() {
  const surface = useA2uiSurface();
  if (!surface) throw new Error('Glimpse views must render inside an A2uiSurface');
  return surface;
}

/**
 * Id of the surface this view renders in. Together with useMeta()?.repo.name it forms the persistence keys of
 * design 12.1: `${repoName}/${surfaceId}` for cell arrangement, `${repoName}/${surfaceId}/${componentId}` for
 * diagram node positions.
 */
export function useSurfaceId(): string {
  return useSurface().id;
}

/**
 * The component ids a child prop of `componentId` names, in spec order: the ids for a `children` prop (the default),
 * one id for a `child` prop such as Split's 'start'. The tokens in `props.children` are opaque render handles, not
 * ids; use this wherever ids are needed (ArrangeApi.get(componentId), `useArrangement(surfaceId, containerId, childIds)`,
 * persistence keys). The i-th id belongs to the i-th token. Follows updateComponents. A template child list
 * ({componentId, path}) has no fixed ids and gives [].
 */
export function useChildIds(componentId: string, prop = 'children'): string[] {
  const surface = useSurface();
  const subscribe = useCallback(
    (notify: () => void) => {
      const components = surface.componentsModel;
      let own = components.get(componentId)?.onUpdated.subscribe(notify);
      // The component may not exist yet, or may be deleted and created again under the same id.
      const created = components.onCreated.subscribe(model => {
        if (model.id !== componentId) return;
        own?.unsubscribe();
        own = model.onUpdated.subscribe(notify);
        notify();
      });
      const deleted = components.onDeleted.subscribe(id => { if (id === componentId) notify(); });
      return () => {
        own?.unsubscribe();
        created.unsubscribe();
        deleted.unsubscribe();
      };
    },
    [surface, componentId],
  );
  // The snapshot is a string so it is stable between renders; ids are parsed back out below.
  const snapshot = useSyncExternalStore(subscribe, () => {
    const value: unknown = surface.componentsModel.get(componentId)?.properties[prop];
    const ids = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
    return JSON.stringify(ids);
  });
  return useMemo(() => JSON.parse(snapshot) as string[], [snapshot]);
}

/** Subscribes to an absolute data-model path. */
export function usePath<T>(path: string): T | undefined {
  const surface = useSurface();
  const signal = useMemo(() => surface.dataModel.getSignal<T>(path), [surface, path]);
  return useSignalValue(signal);
}

export function useMeta(): SurfaceMeta | undefined {
  return usePath<SurfaceMeta>(PATHS.meta);
}

/** Working-tree revision; include it in effect deps of anything fetched from disk so it refetches on change. */
export function useRev(): number {
  return usePath<number>(PATHS.metaRev) ?? 0;
}

/** Stable categorical colour slot (1..8, 0 = other) for an entity key, assigned by the server. */
export function useSlot(kind: 'lang' | 'module' | 'author', key: string | undefined): number {
  const slots = usePath<SurfaceMeta['slots']>(PATHS.metaSlots);
  return (key != null && slots?.[kind]?.[key]) || 0;
}

/** One page of a pageable dataset (tables beyond the inline budget). */
export function useRows(ds: Dataset | undefined, query: {offset?: number; limit?: number; sort?: string; q?: string}): {page?: RowsPage; loading: boolean; error?: string} {
  const host = useHost();
  const surface = useSurface();
  const rev = useRev();
  const [state, setState] = useState<{page?: RowsPage; loading: boolean; error?: string}>({loading: false});
  const key = ds?.pageable ? ds.$ds : undefined;
  const {offset, limit, sort, q} = query;
  useEffect(() => {
    if (!key) return;
    const ctl = new AbortController();
    setState(s => ({...s, loading: true}));
    host.rows({surfaceId: surface.id, key, offset, limit, sort, q}, ctl.signal).then(
      page => setState({page, loading: false}),
      e => { if (!ctl.signal.aborted) setState({loading: false, error: String(e?.message ?? e)}); },
    );
    return () => ctl.abort();
  }, [host, surface, key, offset, limit, sort, q, rev]);
  return state;
}

/** The surface selection ("red pencil"). select() also updates /ui/file for file-like entities and tells the server. */
export function useSelection(componentId: string) {
  const surface = useSurface();
  const selected = usePath<EntityRef | null>(PATHS.uiSel) ?? null;
  const select = useCallback(
    (ref: EntityRef | null) => {
      surface.dataModel.set(PATHS.uiSel, ref);
      if (ref?.path && ref.type !== 'dir') {
        surface.dataModel.set(PATHS.uiFile, formatFileLoc({path: ref.path, line: ref.line, endLine: ref.endLine}));
      }
      void surface.dispatchAction({event: {name: 'gl_select', context: {ref}}} as never, componentId);
    },
    [surface, componentId],
  );
  const isSelected = useCallback(
    (ref: Pick<EntityRef, 'type' | 'id'>) => selected != null && selected.type === ref.type && selected.id === ref.id,
    [selected],
  );
  return {selected, select, isSelected};
}

/** File the component should show when its own `file` prop is omitted. */
export function useFollowedFile(explicit: string | undefined): string | undefined {
  const followed = usePath<string | null>(PATHS.uiFile);
  return explicit ?? followed ?? undefined;
}

/** Built-in host actions handled by the server with zero model tokens. */
export function useHostActions(componentId: string) {
  const surface = useSurface();
  return useMemo(() => {
    const send = (name: string, context: Record<string, unknown>) =>
      void surface.dispatchAction({event: {name, context}} as never, componentId);
    return {
      /** Open a file in the user's editor. */
      open: (file: string) => send('gl_open', {file}),
      /** Re-run a dataset scoped to an entity (cluster drill-down, "(N more)" rollups). */
      drill: (ds: string, target: string) => send('gl_drill', {ds, target}),
      /** Re-run every dataset of this surface. */
      refresh: () => send('gl_refresh', {}),
      /** Queue an agent event (Ask). */
      emit: (name: string, context: Record<string, unknown>) => send(name, context),
    };
  }, [surface, componentId]);
}
