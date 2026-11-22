// packages/viewer/src/kit/hooks.ts
// Data, selection and host access for views. No view imports @a2ui/* directly.
import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {useA2uiSurface, useSignalValue} from '@a2ui/react';
import {
  PATHS, formatFileLoc, isDataset,
  type Dataset, type EntityRef, type Field, type LinkStatus, type Roles, type SurfaceMeta, type Truncation,
} from '@glimpse/catalog';
import type {DataInput} from '@glimpse/catalog';
import type {DataClient, RowsPage} from '@glimpse/catalog';
import {assignSlots, catVar} from './color.ts';
import {matchSelection, type SelectionMatch} from './select.ts';

/** Provided once by the shell: <HostContext.Provider value={transport}>. */
export const HostContext = createContext<DataClient | null>(null);
export function useHost(): DataClient {
  const host = useContext(HostContext);
  if (!host) throw new Error('HostContext is missing');
  return host;
}

/** State of the link to the host; 'live' where nobody says otherwise (tests, fixtures). KitProvider provides it. */
export const LinkContext = createContext<LinkStatus>('live');
/**
 * 'connecting' | 'live' | 'ended'. A control that sends something to the agent (Button, Ask) reads it: once the
 * session has ended nothing can be queued, so it disables itself or says so instead of "queued for the agent".
 */
export function useLinkStatus(): LinkStatus {
  return useContext(LinkContext);
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
  /** Second, dimmer line of an empty state: the source, when `message` is the reason the dataset gave. */
  detail?: string;
  /**
   * The report code (decision reports-are-component-state): the redline code of an error; for an empty state I_EMPTY when the dataset says
   * why it is empty (a truthful answer of the source), W_EMPTY when nothing is bound, the inline data is empty or the
   * source gave no reason.
   */
  code?: string;
}

/**
 * A string that is a source ref the server should have expanded: its first word is `<namespace>.<name>` in one of
 * the source namespaces. Spelled out here so the eager bundle does not carry the source table; test/kit.test.tsx
 * checks it against SOURCES.
 */
const SOURCE_REF = /^(?:files|repo|deps|git|diff|code)\.[a-z]+(?:\s|$)/;

function firstLine(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const line = (text.split('\n', 1)[0] ?? '').trim();
  return line === '' ? undefined : line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** Why a ready dataset has nothing in it, when the dataset says: its one-line note (the source's summary), else its first warning. */
function emptyReason(ds: Dataset): string | undefined {
  return firstLine(ds.note) ?? (Array.isArray(ds.warnings) ? ds.warnings.map(firstLine).find(line => line !== undefined) : undefined);
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
      if (isEmpty(ds.data)) {
        const reason = emptyReason(ds);
        return reason === undefined
          ? {status: 'empty', ds, code: 'W_EMPTY', message: `no data from ${ds.source}`}
          : {status: 'empty', ds, code: 'I_EMPTY', message: reason, detail: ds.source};
      }
      return {status: 'ready', ds, data: ds.data as T, fields: ds.fields, roles: ds.roles, total: ds.total, truncated: ds.truncated};
    }
    if (typeof input === 'string' && SOURCE_REF.test(input.trim())) {
      return {status: 'error', code: 'E_UNEXPANDED_REF', message: `source ref "${input}" was not expanded by the server`};
    }
    // 'nothing bound' only when nothing is: an empty list the spec wrote is data, and the agent reads this message.
    if (isEmpty(input)) return {status: 'empty', code: 'W_EMPTY', message: input == null ? 'nothing bound' : Array.isArray(input) ? 'no items' : 'no entries'};
    return {status: 'ready', data: input as T};
  }, [input]);
}

/**
 * The report code for an empty state a view draws itself from data that came through useDataset (a graph with no
 * nodes, a diff with no files): I_EMPTY when the data is a server dataset that says why it is what it is (its note or
 * first warning), else W_EMPTY. Pass it to <Empty code=...>. Not for a state the spec caused (a missing field: W_FIELD).
 */
export function emptyCodeOf(state: Pick<DataState<unknown>, 'ds'>): 'I_EMPTY' | 'W_EMPTY' {
  return state.ds && emptyReason(state.ds) !== undefined ? 'I_EMPTY' : 'W_EMPTY';
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

/**
 * The `span` each child of `componentId` names in the spec (undefined where it names none), in spec order: what a
 * container needs to read spans written for the 12-column grid (Grid, decision layout-does-the-obvious). Follows updateComponents of
 * the container and of its children.
 */
export function useChildSpans(componentId: string): Array<number | undefined> {
  const surface = useSurface();
  const subscribe = useCallback(
    (notify: () => void) => {
      const components = surface.componentsModel;
      let watched: Array<{unsubscribe(): void}> = [];
      let closed = false;
      let queued = false;
      const rewatch = () => {
        queued = false;
        for (const subscription of watched) subscription.unsubscribe();
        watched = [];
        if (closed) return;
        const container = components.get(componentId);
        const value: unknown = container?.properties.children;
        const ids = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
        watched = [container, ...ids.map(id => components.get(id))].flatMap(model => (model ? [model.onUpdated.subscribe(changed)] : []));
      };
      // Never subscribe to an emitter while it emits (it would call the new listener in the same pass): the list of
      // models to watch is renewed once the update is over.
      function changed() {
        notify();
        if (queued) return;
        queued = true;
        queueMicrotask(rewatch);
      }
      rewatch();
      const created = components.onCreated.subscribe(changed);
      const deleted = components.onDeleted.subscribe(changed);
      return () => {
        closed = true;
        for (const subscription of watched) subscription.unsubscribe();
        created.unsubscribe();
        deleted.unsubscribe();
      };
    },
    [surface, componentId],
  );
  const snapshot = useSyncExternalStore(subscribe, () => {
    const components = surface.componentsModel;
    const value: unknown = components.get(componentId)?.properties.children;
    const ids = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    return ids.map(id => {
      const span: unknown = components.get(id)?.properties.span;
      return typeof span === 'number' && Number.isInteger(span) && span >= 1 && span <= 12 ? String(span) : '';
    }).join(',');
  });
  return useMemo(() => (snapshot === '' ? [] : snapshot.split(',').map(text => (text === '' ? undefined : Number(text)))), [snapshot]);
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

/**
 * One page of a pageable dataset (tables beyond the inline budget). Fetches again when the query, the working-tree
 * revision or the envelope itself changes: a re-run of the source (refresh, drill) replaces the envelope under the
 * same key. While a newer page of the SAME dataset is on its way the previous one stays (`loading: true`), so a
 * sort or a refresh does not blank the rows; a page of another dataset is never returned. The answer to a request
 * that was superseded is dropped, whether or not the host honoured the AbortSignal.
 */
export function useRows(ds: Dataset | undefined, query: {offset?: number; limit?: number; sort?: string; q?: string}): {page?: RowsPage; loading: boolean; error?: string} {
  const host = useHost();
  const surface = useSurface();
  const rev = useRev();
  const pageable = ds?.pageable ? ds : undefined;
  const key = pageable?.$ds;
  const {offset, limit, sort, q} = query;
  // One object per request: what the state holds is known to answer it, or not, by identity.
  // `pageable` (the envelope object) and `rev` are refetch triggers, not inputs of the request.
  const request = useMemo(
    () => (key === undefined ? undefined : {host, query: {surfaceId: surface.id, key, offset, limit, sort, q}}),
    [host, surface, key, pageable, offset, limit, sort, q, rev],
  );
  type Request = NonNullable<typeof request>;
  const [state, setState] = useState<{answers?: Request; key?: string; page?: RowsPage; error?: string}>({});
  useEffect(() => {
    if (!request) {
      // No dataset: forget the page, so coming back to a key starts from nothing rather than from an old answer.
      setState(s => (s.key === undefined ? s : {}));
      return;
    }
    const ctl = new AbortController();
    const {key: asked} = request.query;
    request.host.rows(request.query, ctl.signal).then(
      page => { if (!ctl.signal.aborted) setState({answers: request, key: asked, page}); },
      e => { if (!ctl.signal.aborted) setState(s => ({answers: request, key: asked, page: s.key === asked ? s.page : undefined, error: String(e?.message ?? e)})); },
    );
    return () => ctl.abort();
  }, [request]);
  return useMemo(() => {
    if (!request) return {loading: false};
    const settled = state.answers === request;
    const page = state.key === request.query.key ? state.page : undefined;
    return {...(page === undefined ? {} : {page}), loading: !settled, ...(settled && state.error !== undefined ? {error: state.error} : {})};
  }, [request, state]);
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
  /**
   * How an entity relates to the selection (design 5.1), one rule for every component: 'exact' for the selected
   * entity itself (same type and id, or the same file or directory under another type, such as a table row whose
   * path is the selected file), 'within' for a file or directory inside a selected directory, 'contains' for a
   * directory that holds the selection; undefined when it is not selected. See matchSelection (select.ts).
   */
  const match = useCallback((ref: Pick<EntityRef, 'type' | 'id' | 'path'>): SelectionMatch | undefined => matchSelection(selected, ref), [selected]);
  return {selected, select, isSelected, match};
}

export type SlotKind = 'lang' | 'module' | 'author';

/**
 * Colours for the categories one component shows (design rule stable-category-colours). `keys` are the categories in order of first
 * appearance; `kind` names the /meta/slots table that knows them (several are tried in order; undefined for
 * categories the session has no slots for, such as package ecosystems). A category with a session slot wears it; the
 * others take the lowest inks still free in this component, in order of first appearance, and keep them for the life
 * of the component; only a ninth category is the "other" grey. A view never greys a category out itself:
 *   const cat = useCatSlots('lang', rows.map(row => row.lang));
 *   <i style={{background: cat.color(row.lang)}} />
 */
export function useCatSlots(kind: SlotKind | readonly SlotKind[] | undefined, keys: readonly string[]): {slot(key: string | undefined): number; color(key: string | undefined): string} {
  const tables = usePath<SurfaceMeta['slots']>(PATHS.metaSlots);
  const held = useRef<Map<string, number>>(new Map());
  const kinds = kind === undefined ? '' : typeof kind === 'string' ? kind : kind.join(',');
  const list = keys.join('\u0001');
  return useMemo(() => {
    const known: Record<string, number> = {};
    // The first kind wins: apply the tables last to first.
    for (const name of kinds === '' ? [] : kinds.split(',').reverse()) Object.assign(known, tables?.[name as SlotKind]);
    const slots = assignSlots(list === '' ? [] : list.split('\u0001'), known, held.current);
    // What was handed out stays handed out: a key that scrolls away and comes back wears the same ink.
    for (const [key, slot] of slots) if (slot !== 0 && !Object.hasOwn(known, key)) held.current.set(key, slot);
    const slot = (key: string | undefined) => (key === undefined ? 0 : (slots.get(key) ?? 0));
    return {slot, color: (key: string | undefined) => catVar(slot(key))};
  }, [tables, kinds, list]);
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
