// SurfaceStore (design 2.2 step 5 and 2.6): the server's copy of every surface. A call is first turned into a Draft,
// a detached next version of one record; only commit() touches the store. A call that fails anywhere before commit
// therefore leaves every surface exactly as it was.
import {
  CATALOG_ID, COMPONENT_BY_NAME, PROTOCOL_VERSION,
  type A2uiMessage, type Dataset, type EntityRef, type Prop, type SourceRef, type SurfaceInfo, type SurfaceMeta, type WireComponent,
} from '@glimpse/catalog';
import {boundKeys} from '../spec/expand.ts';
import {UNSAFE_KEYS} from '../spec/guard.ts';

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
  /**
   * What the user last selected in a tab (gl_select), so a reload or a second tab starts on the same selection.
   * undefined: nothing selected through the viewer since the spec last wrote /ui.
   */
  sel?: EntityRef | null;
  /** The file that selection last pointed at (the value of /ui/file). */
  file?: string;
  /**
   * Ids of the components a preset defined and the model has not redefined since. What such a part draws when its
   * data is empty is the preset's state, not something the model wrote (decision D14).
   */
  preset: Set<string>;
  createdAt: number;
  updatedAt: number;
}

export interface Draft {
  record: SurfaceRecord;
  mode: CommitMode;
  /**
   * Replace mode only (finding F028): every component of the previous version is still in this one, so the tab can
   * be brought up to date with updateComponents and updateDataModel instead of deleteSurface + createSurface, and
   * keeps what lives in its components (tree expansion, scroll, filters). The server still treats the call as a
   * replace: drills are cleared and every dataset is listed. `changed`: the components the call defines (identical
   * or not) and any other whose definition differs; they are sent again and their reported state is forgotten.
   */
  inPlace?: {previous: SurfaceRecord; changed: ReadonlySet<string>};
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
  /** Components the call's preset text defines, and those its own spec defines (which are the model's from then on). */
  presetIds?: ReadonlySet<string>;
  modelIds?: ReadonlySet<string>;
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
const INDEX = /^(?:0|[1-9]\d*)$/;
const MAX_INDEX = 10_000;

/**
 * JSON-pointer assignment into plain data, the way the viewer's data model does it: missing containers are created
 * (an array when the next segment is an index), array indices are honoured. A path with a reserved segment
 * (__proto__, constructor, prototype) or an index out of range is ignored; own properties only are followed, so
 * nothing here can reach a prototype.
 */
export function setPath(data: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('/').filter(Boolean).map(decode);
  if (segments.length === 0 || segments.some(segment => UNSAFE_KEYS.has(segment))) return;
  let node: Record<string, unknown> | unknown[] = data;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    let key: string | number = segment;
    if (Array.isArray(node)) {
      if (!INDEX.test(segment) || Number(segment) > MAX_INDEX) return;
      key = Number(segment);
      while (node.length < key) node.push(null);
    }
    const holder = node as Record<string | number, unknown>;
    if (i === segments.length - 1) { holder[key] = value; return; }
    const next = Object.hasOwn(holder, key) ? holder[key] : undefined;
    if (typeof next !== 'object' || next === null) holder[key] = INDEX.test(segments[i + 1]!) ? [] : {};
    node = holder[key] as Record<string, unknown> | unknown[];
  }
}

const segmentsOf = (path: string | undefined): string[] => (path ?? '/').split('/').filter(Boolean).map(decode);

/**
 * Decision D4: a patch below a top-level slot (`$/plan/1/status='done'`) is published as the whole slot. The
 * viewer's data model changes a container in place, so a component bound to `/plan` would otherwise never see that
 * its value changed. /ui is the viewer's own and keeps its fine-grained writes.
 */
function wholeSlots(messages: readonly A2uiMessage[], data: Record<string, unknown>): A2uiMessage[] {
  const topOf = (message: A2uiMessage): string | undefined => {
    const top = 'updateDataModel' in message ? segmentsOf(message.updateDataModel.path)[0] : undefined;
    return top === 'ui' ? undefined : top;
  };
  // Slots with at least one write below the top level: every write to such a slot collapses into one final value.
  const nested = new Set(messages.filter(message => 'updateDataModel' in message && segmentsOf(message.updateDataModel.path).length >= 2).map(topOf).filter(top => top !== undefined));
  const out: A2uiMessage[] = [];
  const sent = new Set<string>();
  for (const message of messages) {
    const top = topOf(message);
    if ('updateDataModel' in message && top !== undefined && nested.has(top)) {
      if (sent.has(top)) continue;
      sent.add(top);
      out.push({version: PROTOCOL_VERSION, updateDataModel: {surfaceId: message.updateDataModel.surfaceId, path: `/${top.replace(/~/g, '~0').replace(/\//g, '~1')}`, value: structuredClone(data[top])}});
    } else {
      out.push(structuredClone(message) as A2uiMessage);
    }
  }
  return out;
}

/** Longest surface title kept; tab labels and the session list show it. */
const MAX_TITLE = 80;

/**
 * The Page title, at most MAX_TITLE characters. A long one loses its start, whole leading path segments first, so a
 * file's title keeps its file name (finding V044: 'packages/…/very/long/dir' instead of 'session.ts').
 */
export function titleOf(components: Map<string, WireComponent>, id: string): string {
  const root = components.get(ROOT_ID);
  const title = root?.component === 'Page' && typeof root.title === 'string' ? root.title.trim() : '';
  if (!title) return id;
  if (title.length <= MAX_TITLE) return title;
  const segments = title.split('/');
  while (segments.length > 1 && 2 + segments.join('/').length > MAX_TITLE) segments.shift();
  const tail = segments.join('/');
  return tail.length + 2 <= MAX_TITLE && segments.length < title.split('/').length ? `…/${tail}` : `…${title.slice(-(MAX_TITLE - 1))}`;
}

function losesProp(before: WireComponent, after: WireComponent): boolean {
  return before.component !== after.component || Object.keys(before).some(key => !(key in after));
}

/** Two JSON values with the same content (key order matters: the compiler writes keys in a fixed order). */
const sameJson = (a: unknown, b: unknown): boolean => a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));

const pointer = (key: string) => `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;

/**
 * Finding F028: the frame that brings a tab from `previous` to `record` without recreating the surface. Data slots,
 * envelopes and components that changed are sent; a slot or an envelope that is gone is removed (value null). /ui
 * goes when what the store holds for it changed, so it stays the tab's own otherwise. /meta always goes, so the frame
 * is never empty and carries the focus.
 */
export function inPlaceMessages(previous: SurfaceRecord, record: SurfaceRecord, meta: SurfaceMeta, changed: ReadonlySet<string>): A2uiMessage[] {
  const surfaceId = record.id;
  // A2UI v1.0 requires `value` on every updateDataModel: a key that is gone is removed with an explicit null.
  const set = (path: string, value: unknown): A2uiMessage =>
    ({version: PROTOCOL_VERSION, updateDataModel: {surfaceId, path, value: value === undefined ? null : structuredClone(value)}});
  const out: A2uiMessage[] = [];
  const keys = new Set([...Object.keys(previous.data), ...Object.keys(record.data)]);
  for (const key of keys) {
    if (key === 'ds' || key === 'meta' || key === 'ui' || UNSAFE_KEYS.has(key) || sameJson(previous.data[key], record.data[key])) continue;
    out.push(set(pointer(key), record.data[key]));
  }
  // /ui as the tab has it (the spec's, with the user's selection on top) against what the store holds now. They differ
  // when the spec wrote /ui, and when a preset shown again starts over from its own file (finding V053): the tab then
  // shows what a reload or a second tab would.
  const ui = dataModelOf(record, meta).ui;
  if (!sameJson(dataModelOf(previous, meta).ui, ui)) out.push(set('/ui', ui));
  for (const key of new Set([...Object.keys(previous.ds), ...Object.keys(record.ds)])) {
    if (previous.ds[key] !== record.ds[key] && !UNSAFE_KEYS.has(key)) out.push(set(`/ds/${pointer(key).slice(1)}`, record.ds[key]));
  }
  out.push(set('/meta', meta));
  const components = [...changed].map(compId => record.components.get(compId)).filter((comp): comp is WireComponent => comp !== undefined);
  if (components.length > 0) out.push({version: PROTOCOL_VERSION, updateComponents: {surfaceId, components: structuredClone(components)}});
  return out;
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
    let wroteUi = false;
    /** Every component the call's own text defines, whether or not its definition changed. */
    const defined = new Set<string>();

    for (const message of messages) {
      if ('createSurface' in message) {
        components.clear();
        for (const comp of message.createSurface.components) {
          components.set(comp.id, structuredClone(comp));
          defined.add(comp.id);
        }
        // Own keys only, one by one: Object.assign would run the __proto__ setter for a key of that name.
        for (const [key, value] of Object.entries(structuredClone(message.createSurface.dataModel ?? {}))) {
          if (UNSAFE_KEYS.has(key)) continue;
          data[key] = value;
          if (key === 'ui') wroteUi = true;
        }
      } else if ('updateComponents' in message) {
        for (const comp of message.updateComponents.components) {
          const before = components.get(comp.id);
          if (comp.id === ROOT_ID && before) rootRedefined = true;
          if (before && losesProp(before, comp)) lostProp = true;
          components.set(comp.id, structuredClone(comp));
          defined.add(comp.id);
        }
      } else if ('updateDataModel' in message) {
        setPath(data, message.updateDataModel.path ?? '/', structuredClone(message.updateDataModel.value));
        if (segmentsOf(message.updateDataModel.path)[0] === 'ui') wroteUi = true;
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
    const mode: CommitMode = !previous ? 'create' : !current || rootRedefined || lostProp || pruned > 0 ? 'replace' : 'patch';
    // The viewer replaces a component's props wholesale and recreates one whose type changed, so a replace only needs
    // a new surface when a component of the previous version would be left behind. Decision D14 (finding V051): every
    // component the call defines is sent and its state forgotten, also when the definition is the same as before, so
    // a fix that leaves it as broken as it was is reported again; components the call does not name are left alone.
    const inPlace = mode === 'replace' && previous !== undefined && [...previous.components.keys()].every(compId => components.has(compId))
      ? {previous, changed: new Set([...components].filter(([compId, comp]) => defined.has(compId) || !sameJson(previous.components.get(compId), comp)).map(([compId]) => compId))}
      : undefined;
    // Decision D1: a show that creates or replaces the surface starts every dataset at the spec's own scope again;
    // a patch keeps the scopes the user drilled to. A dataset that loses its drill needs a fresh run.
    const keep = mode === 'patch' ? current : undefined;
    const ds: Record<string, Dataset> = {};
    const drills = new Map<string, string>();
    const newKeys: string[] = [];
    for (const key of bindings.keys()) {
      const drill = keep?.drills.get(key);
      if (drill !== undefined) drills.set(key, drill);
      const envelope = current?.ds[key];
      if (envelope && (drill !== undefined || !current?.drills.has(key))) ds[key] = envelope;
      else newKeys.push(key);
    }

    const parts = [...(current?.parts ?? []), ...options.parts].filter((part, i, all) => components.has(part) && all.indexOf(part) === i);
    const record: SurfaceRecord = {
      id,
      title: titleOf(components, id),
      ...(options.view ?? current?.view ? {view: options.view ?? current?.view} : {}),
      components, data, bindings, drills, ds, parts,
      // The user's selection survives unless this call wrote /ui itself; viewer reports belong to one layout.
      ...(current && !wroteUi && current.sel !== undefined ? {sel: current.sel} : {}),
      ...(current && !wroteUi && current.file !== undefined ? {file: current.file} : {}),
      preset: new Set([...(current?.preset ?? []), ...(options.presetIds ?? [])].filter(compId => components.has(compId) && !options.modelIds?.has(compId))),
      createdAt: previous?.createdAt ?? options.now,
      updatedAt: options.now,
    };
    return {record, mode, ...(inPlace ? {inPlace} : {}), delta: mode === 'patch' ? wholeSlots(messages, data) : [], newKeys, unknownKeys};
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
  const selected = {...(record.sel !== undefined ? {sel: record.sel} : {}), ...(record.file !== undefined ? {file: record.file} : {})};
  return {...record.data, ds: record.ds, ui: {sel: null, file: null, ...ui, ...selected}, meta};
}

/** A snapshot: the single createSurface that rebuilds the surface in a viewer (design 2.2). */
export function snapshotOf(record: SurfaceRecord, meta: SurfaceMeta): A2uiMessage {
  return {
    version: PROTOCOL_VERSION,
    createSurface: {surfaceId: record.id, catalogId: CATALOG_ID, components: [...record.components.values()], dataModel: dataModelOf(record, meta)},
  };
}
