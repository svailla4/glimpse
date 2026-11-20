// SurfaceStore (design 2.2 step 5 and 2.6): the server's copy of every surface. A call is first turned into a Draft,
// a detached next version of one record; only commit() touches the store. A call that fails anywhere before commit
// therefore leaves every surface exactly as it was.
import {
  CATALOG_ID, COMPONENT_BY_NAME, PROTOCOL_VERSION,
  type A2uiMessage, type Dataset, type Prop, type SourceRef, type SurfaceInfo, type SurfaceMeta, type WireComponent,
} from '@glimpse/catalog';
import {boundKeys} from '../spec/expand.ts';

export const MAX_SURFACES = 12;
export const ROOT_ID = 'root';

export type CommitMode = 'create' | 'replace' | 'patch';

export interface SurfaceRecord {
  id: string;
  title: string;
  /** The preset call that built the surface, e.g. "diff main..HEAD". */
  view?: string;
  components: Map<string, WireComponent>;
  /** The agent's data: everything in the data model except /ds and /meta. */
  data: Record<string, unknown>;
  /** Source ref per dataset key, as the spec wrote it. */
  bindings: Map<string, SourceRef>;
  /** Positional targets set by gl_drill, per dataset key. */
  drills: Map<string, string>;
  /** Current envelope per dataset key (the value of /ds). */
  ds: Record<string, Dataset>;
  /** Named components, in the order they were first defined. */
  parts: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Draft {
  record: SurfaceRecord;
  mode: CommitMode;
  /** Patch mode: the compiled messages, to publish as they are. */
  delta: A2uiMessage[];
  /** Dataset keys this call binds for the first time; they need an envelope before publishing. */
  newKeys: string[];
  /** /ds bindings that name no dataset of this surface. */
  unknownKeys: string[];
}

export interface DraftOptions {
  /** A preset call: the surface is rebuilt from nothing even when the id exists. */
  fresh: boolean;
  view?: string;
  /** Refs found by expansion, by dataset key. */
  refs: ReadonlyMap<string, SourceRef>;
  /** Named parts the call defines. */
  parts: readonly string[];
  now: number;
}

function childIds(comp: WireComponent): string[] {
  const def = COMPONENT_BY_NAME.get(comp.component);
  if (!def) return [];
  const ids: string[] = [];
  for (const [key, prop] of Object.entries(def.props) as Array<[string, Prop]>) {
    const value = comp[key];
    if (prop.kind === 'child' && typeof value === 'string') ids.push(value);
    else if (prop.kind === 'children') {
      if (Array.isArray(value)) ids.push(...value.filter((id): id is string => typeof id === 'string'));
      else if (typeof value === 'object' && value !== null && typeof (value as {componentId?: unknown}).componentId === 'string') ids.push((value as {componentId: string}).componentId);
    }
  }
  return ids;
}

/** Removes components unreachable from root; returns how many were dropped. A surface without a root is left alone. */
function prune(components: Map<string, WireComponent>): number {
  if (!components.has(ROOT_ID)) return 0;
  const reachable = new Set<string>();
  const queue = [ROOT_ID];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (reachable.has(id)) continue;
    const comp = components.get(id);
    if (!comp) continue;
    reachable.add(id);
    queue.push(...childIds(comp));
  }
  let dropped = 0;
  for (const id of [...components.keys()]) if (!reachable.has(id)) { components.delete(id); dropped++; }
  return dropped;
}

const decode = (segment: string) => segment.replace(/~1/g, '/').replace(/~0/g, '~');
/** Keys that would reach Object.prototype through a plain assignment. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** JSON-pointer assignment into plain data: missing containers are created, array indices are honoured. */
export function setPath(data: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('/').filter(Boolean).map(decode);
  if (segments.length === 0 || segments.some(segment => UNSAFE_KEYS.has(segment))) return;
  let node: Record<string, unknown> | unknown[] = data;
  segments.forEach((segment, i) => {
    const key = Array.isArray(node) && /^\d+$/.test(segment) ? Number(segment) : segment;
    const holder = node as Record<string | number, unknown>;
    if (i === segments.length - 1) { holder[key] = value; return; }
    const next = holder[key];
    if (typeof next !== 'object' || next === null) holder[key] = {};
    node = holder[key] as Record<string, unknown> | unknown[];
  });
}

function titleOf(components: Map<string, WireComponent>, id: string): string {
  const root = components.get(ROOT_ID);
  const title = root?.component === 'Page' ? root.title : undefined;
  return typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : id;
}

function losesProp(before: WireComponent, after: WireComponent): boolean {
  return before.component !== after.component || Object.keys(before).some(key => !(key in after));
}

export class SurfaceStore {
  private records = new Map<string, SurfaceRecord>();

  get(id: string): SurfaceRecord | undefined {
    return this.records.get(id);
  }
  has(id: string): boolean {
    return this.records.has(id);
  }
  ids(): string[] {
    return [...this.records.keys()];
  }
  all(): SurfaceRecord[] {
    return [...this.records.values()];
  }
  list(): SurfaceInfo[] {
    return this.all().map(r => ({id: r.id, title: r.title, ...(r.view ? {view: r.view} : {}), createdAt: r.createdAt, updatedAt: r.updatedAt}));
  }

  /**
   * The next version of surface `id` after applying compiled, expanded messages. Pure: the store and the current
   * record are not touched, and the messages are copied where they are kept.
   */
  draft(id: string, messages: readonly A2uiMessage[], options: DraftOptions): Draft {
    const current = options.fresh ? undefined : this.records.get(id);
    const previous = this.records.get(id);
    const components = new Map(current?.components);
    const data: Record<string, unknown> = current ? structuredClone(current.data) : {};
    let rootRedefined = false;
    let lostProp = false;

    for (const message of messages) {
      if ('createSurface' in message) {
        components.clear();
        for (const comp of message.createSurface.components) components.set(comp.id, structuredClone(comp));
        Object.assign(data, structuredClone(message.createSurface.dataModel ?? {}));
      } else if ('updateComponents' in message) {
        for (const comp of message.updateComponents.components) {
          const before = components.get(comp.id);
          if (comp.id === ROOT_ID && before) rootRedefined = true;
          if (before && losesProp(before, comp)) lostProp = true;
          components.set(comp.id, structuredClone(comp));
        }
      } else if ('updateDataModel' in message) {
        setPath(data, message.updateDataModel.path ?? '/', structuredClone(message.updateDataModel.value));
      }
    }
    const pruned = prune(components);

    const known = new Map<string, SourceRef>([...(current?.bindings ?? []), ...options.refs]);
    const bound = boundKeys(components.values());
    const bindings = new Map<string, SourceRef>();
    const unknownKeys: string[] = [];
    for (const key of bound) {
      const ref = known.get(key);
      if (ref) bindings.set(key, ref);
      else unknownKeys.push(key);
    }
    const ds: Record<string, Dataset> = {};
    const drills = new Map<string, string>();
    const newKeys: string[] = [];
    for (const key of bindings.keys()) {
      const envelope = current?.ds[key];
      if (envelope) ds[key] = envelope;
      else newKeys.push(key);
      const drill = current?.drills.get(key);
      if (drill !== undefined) drills.set(key, drill);
    }

    const parts = [...(current?.parts ?? []), ...options.parts].filter((part, i, all) => components.has(part) && all.indexOf(part) === i);
    const mode: CommitMode = !previous ? 'create' : !current || rootRedefined || lostProp || pruned > 0 ? 'replace' : 'patch';
    const record: SurfaceRecord = {
      id,
      title: titleOf(components, id),
      ...(options.view ?? current?.view ? {view: options.view ?? current?.view} : {}),
      components, data, bindings, drills, ds, parts,
      createdAt: previous?.createdAt ?? options.now,
      updatedAt: options.now,
    };
    return {record, mode, delta: mode === 'patch' ? structuredClone(messages) as A2uiMessage[] : [], newKeys, unknownKeys};
  }

  /** Stores the draft. Returns the ids evicted to keep at most MAX_SURFACES (least recently updated first). */
  commit(draft: Draft): string[] {
    this.records.set(draft.record.id, draft.record);
    const evicted: string[] = [];
    while (this.records.size > MAX_SURFACES) {
      const oldest = this.all().filter(r => r.id !== draft.record.id).sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!oldest) break;
      this.records.delete(oldest.id);
      evicted.push(oldest.id);
    }
    return evicted;
  }

  delete(id: string): boolean {
    return this.records.delete(id);
  }
}

/** The data model a viewer receives for a record: the agent's data plus /ds, /ui and /meta. */
export function dataModelOf(record: SurfaceRecord, meta: SurfaceMeta): Record<string, unknown> {
  const ui = typeof record.data.ui === 'object' && record.data.ui !== null ? record.data.ui as Record<string, unknown> : {};
  return {...record.data, ds: record.ds, ui: {sel: null, file: null, ...ui}, meta};
}

/** A snapshot: the single createSurface that rebuilds the surface in a viewer (design 2.2). */
export function snapshotOf(record: SurfaceRecord, meta: SurfaceMeta): A2uiMessage {
  return {
    version: PROTOCOL_VERSION,
    createSurface: {surfaceId: record.id, catalogId: CATALOG_ID, components: [...record.components.values()], dataModel: dataModelOf(record, meta)},
  };
}
