// packages/viewer/src/kit/arrange.tsx
// Human arrangement of the cells of a container (design 12.1.A). The agent declares structure only; the person may
// reorder the plates of a Page, Section, Grid or Row and change their span, and the viewer remembers it. Nothing
// here is sent to the agent or changes the wire format.
//
//   container view     const arrangement = useArrangement(useSurfaceId(), id, useChildIds(id), {container: ref});
//                      <ArrangeContext.Provider value={arrangement}>{children}</ArrangeContext.Provider>
//   plate header       const handle = useArrangeHandle(id);  <header {...handle?.header}> ... {handle?.edge}
//   shell              const store = useArrangeStore();  store.has(key) / store.reset(key)   ("Reset layout")
//
// implement() reads ArrangeContext and applies `order` and the span override to each cell, so the DOM order stays the
// spec order: only the visual order changes.
import {
  createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type JSX, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject,
} from 'react';
import {useLatest, useMeta} from './hooks.ts';
import {ArrangeContext, type ArrangeApi} from './implement.tsx';

export const ARRANGE_STORAGE_KEY = 'glimpse.arrange.v1';
const MAX_SPAN = 12;
const DRAG_THRESHOLD = 6;
const MOVE_MS = 280;
const MOVE_EASING = 'cubic-bezier(.2, 0, 0, 1)';

/** What is remembered for one container: the visual order of its children and the spans the person changed. */
export interface ArrangeEntry {
  order: string[];
  span: Record<string, number>;
}
type ArrangeData = Record<string, Record<string, ArrangeEntry>>;
export type ArrangeStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface ArrangeStore {
  /** The entry of one container; the same object until that container changes. */
  entry(surfaceKey: string, containerId: string): ArrangeEntry | undefined;
  /** Replaces the entry of one container; undefined forgets it. */
  update(surfaceKey: string, containerId: string, entry: ArrangeEntry | undefined): void;
  /** Whether any container of the surface is arranged. */
  has(surfaceKey: string): boolean;
  /** Forgets every arrangement of the surface. */
  reset(surfaceKey: string): void;
  subscribe(listener: () => void): () => void;
}

/** `${repoName}/${surfaceId}`: arrangements belong to a view of a repository, not to a session. */
export function arrangeKey(repoName: string | undefined, surfaceId: string): string {
  return `${repoName ?? ''}/${surfaceId}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Keeps what has the stored shape and drops the rest, so a damaged or foreign value can never break a view. */
function sanitize(value: unknown): ArrangeData {
  const data: ArrangeData = {};
  if (!isRecord(value)) return data;
  for (const [surfaceKey, containers] of Object.entries(value)) {
    if (!isRecord(containers)) continue;
    const kept: Record<string, ArrangeEntry> = {};
    for (const [containerId, raw] of Object.entries(containers)) {
      if (!isRecord(raw)) continue;
      const order = Array.isArray(raw.order) ? raw.order.filter((id): id is string => typeof id === 'string') : [];
      const span: Record<string, number> = {};
      if (isRecord(raw.span)) {
        for (const [id, n] of Object.entries(raw.span)) if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_SPAN) span[id] = n;
      }
      if (order.length > 0 || Object.keys(span).length > 0) kept[containerId] = {order, span};
    }
    if (Object.keys(kept).length > 0) data[surfaceKey] = kept;
  }
  return data;
}

/**
 * A store over `storage` (localStorage in the app, a fake in tests). Every storage access is guarded: when storage is
 * missing, full or refuses access the arrangement still works for the life of the page.
 */
export function createArrangeStore(storage?: ArrangeStorage | null): ArrangeStore {
  const listeners = new Set<() => void>();
  let data: ArrangeData | undefined;
  const load = (): ArrangeData => {
    if (data) return data;
    data = {};
    try {
      const text = storage?.getItem(ARRANGE_STORAGE_KEY);
      if (text) data = sanitize(JSON.parse(text));
    } catch {
      // unreadable storage or damaged JSON: start empty
    }
    return data;
  };
  const commit = (next: ArrangeData) => {
    data = next;
    try {
      storage?.setItem(ARRANGE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // quota or privacy mode: keep the arrangement in memory
    }
    for (const listener of [...listeners]) listener();
  };
  return {
    entry: (surfaceKey, containerId) => load()[surfaceKey]?.[containerId],
    update(surfaceKey, containerId, entry) {
      const current = load();
      const {[containerId]: previous, ...others} = current[surfaceKey] ?? {};
      if (!entry && !previous) return;
      const containers = entry ? {...others, [containerId]: entry} : others;
      const {[surfaceKey]: _dropped, ...rest} = current;
      commit(Object.keys(containers).length > 0 ? {...rest, [surfaceKey]: containers} : rest);
    },
    has: surfaceKey => load()[surfaceKey] !== undefined,
    reset(surfaceKey) {
      const {[surfaceKey]: dropped, ...rest} = load();
      if (dropped) commit(rest);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

function browserStorage(): ArrangeStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

let shared: ArrangeStore | undefined;
/** Tests provide their own store over a fake storage; without a provider the app-wide localStorage store is used. */
export const ArrangeStoreContext = createContext<ArrangeStore | null>(null);
export function useArrangeStore(): ArrangeStore {
  const provided = useContext(ArrangeStoreContext);
  if (provided) return provided;
  shared ??= createArrangeStore(browserStorage());
  return shared;
}

export interface ArrangeOptions {
  /** The element whose grid or flex items the cells are. Without it only the keyboard can arrange. */
  container?: RefObject<HTMLElement | null>;
  /** 'grid': a span is a number of columns. 'row': a span is a flex share. Default 'grid'. */
  flow?: 'grid' | 'row';
  /** Largest span: 12 in the page grid, the track count in a Grid. Default 12. */
  tracks?: number;
  /** Span of a cell that names none: the full row (12) in the page grid, 1 in a Grid or a Row. Default `tracks`. */
  defaultSpan?: number;
  /**
   * The span each child has in the spec, in spec order (useChildSpans; undefined: `defaultSpan`). A move that brings
   * plates back to rows their spec spans fill gives them those spans again, and a span equal to the spec one is not
   * remembered. Ignored when it does not line up with the children.
   */
  spans?: readonly (number | undefined)[];
}

/** The spans of a container's children at one moment: the overrides the person set, and every child's span. */
export interface SpanSnapshot {
  readonly set: Readonly<Record<string, number>>;
  readonly shown: ReadonlyMap<string, number>;
}

/** The ArrangeContext value of a container: the overrides implement() applies, and the ways to change them. */
export interface Arrangement extends ArrangeApi {
  /** Child component ids in visual order. */
  readonly ids: readonly string[];
  /** Whether this container differs from its spec. */
  readonly arranged: boolean;
  readonly container: RefObject<HTMLElement | null> | undefined;
  readonly flow: 'grid' | 'row';
  readonly tracks: number;
  readonly defaultSpan: number;
  /** Position of a child in the visual order; -1 for anything that is not a child of this container. */
  indexOf(childId: string): number;
  /**
   * Moves a child to `toIndex` of the visual order. On a grid the rows stay full (relocate): `beside` is the plate
   * the drop slot was next to, which the child joins in its row; without it, the plate the move steps over.
   */
  move(childId: string, toIndex: number, beside?: string): void;
  /**
   * Sets the span of a child (clamped to 1..tracks). On a grid its row-mates give or take the difference, so the row
   * stays full (rebalance). `from` (a snapshot()) makes it relative to the spans of that moment rather than the
   * current ones, so a drag that goes out and comes back leaves everything as it was. Returns the span the child has
   * now; undefined for anything that is not a child.
   */
  resize(childId: string, span: number, from?: SpanSnapshot): number | undefined;
  /** The spans of the children now: what the person set and what the cells show. */
  snapshot(): SpanSnapshot;
  /** Back to the spec for this container. */
  reset(): void;
}

/** Stored order first (ids that no longer exist are ignored), then the children it does not name, in spec order. */
function arrangedIds(childIds: readonly string[], order: readonly string[] | undefined): readonly string[] {
  if (!order || order.length === 0) return childIds;
  const present = new Set(childIds);
  const placed = new Set<string>();
  for (const id of order) if (present.has(id)) placed.add(id);
  return [...placed, ...childIds.filter(id => !placed.has(id))];
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** Narrowest a plate gets when a row-mate widens and takes columns from it: a quarter of the page grid, one track elsewhere. */
const minShare = (tracks: number) => (tracks >= 12 ? 3 : 1);

/** The cells packed into rows the way the grid packs them (in order, a cell that does not fit starts the next row). */
function packRows(ids: readonly string[], span: (id: string) => number, tracks: number): string[][] {
  const rows: string[][] = [];
  let used = tracks;
  for (const id of ids) {
    const s = span(id);
    if (used + s > tracks) {
      rows.push([]);
      used = 0;
    }
    rows.at(-1)!.push(id);
    used += s;
  }
  return rows;
}

/**
 * New spans for a grid container after the person sets child `id` to `wanted` columns (decision layout-does-the-obvious: rows stay
 * full). `ids` are the children in visual order and `spanOf` their current spans. Returns only the spans that change.
 *   wider     the row's hole first, then columns from the row-mates (nearest after it first, then nearest before it,
 *             none below `minShare`); when they have none left, the last row-mates move down to a row of their own,
 *             which the last of them fills, and what they leave over goes to the nearest one that stays. A plate
 *             left alone in its row takes the whole row.
 *   narrower  the nearest row-mate (after it, else before it) takes the columns; a plate alone in its row pulls the
 *             next plate up beside it when that one is alone in its row too and gets at least `minShare`.
 */
export function rebalance(ids: readonly string[], spanOf: (id: string) => number, id: string, wanted: number, tracks: number): Record<string, number> {
  const span = (other: string) => Math.min(tracks, Math.max(1, spanOf(other)));
  const next = Math.min(tracks, Math.max(1, Math.round(wanted)));
  const old = span(id);
  const rows = packRows(ids, span, tracks);
  const r = rows.findIndex(cells => cells.includes(id));
  const row = rows[r];
  if (!row || next === old) return {};
  const out: Record<string, number> = {};
  const now = (other: string) => out[other] ?? span(other);
  const least = minShare(tracks);
  if (row.length === 1) {
    out[id] = next;
    const below = rows[r + 1];
    if (next < old && below?.length === 1 && tracks - next >= least) out[below[0]!] = tracks - next;
    return out;
  }
  const at = row.indexOf(id);
  const after = row.slice(at + 1);
  const before = row.slice(0, at).reverse();
  if (next < old) {
    const taker = after[0] ?? before[0]!;
    out[taker] = now(taker) + old - next;
    out[id] = next;
    return out;
  }
  const hole = Math.max(0, tracks - row.reduce((sum, other) => sum + span(other), 0));
  let need = next - old - Math.min(next - old, hole);
  for (const other of [...after, ...before]) {
    if (need <= 0) break;
    const give = Math.min(need, now(other) - least);
    if (give <= 0) continue;
    out[other] = now(other) - give;
    need -= give;
  }
  if (need <= 0) {
    out[id] = next;
    return out;
  }
  // Nobody can give more: the last row-mates move down, keeping their spans, into a row they fill.
  const moved: string[] = [];
  let freed = 0;
  for (const other of [...row].reverse()) {
    if (other === id) continue;
    moved.unshift(other);
    freed += now(other);
    if (freed >= need) break;
  }
  const staying = row.filter(other => other !== id && !moved.includes(other));
  const rest = moved.reduce((sum, other) => sum + span(other), 0);
  for (const other of moved) out[other] = span(other);
  if (rest < tracks) out[moved.at(-1)!] = span(moved.at(-1)!) + tracks - rest;
  if (staying.length === 0) {
    out[id] = tracks;
    return out;
  }
  out[id] = next;
  // What the plates that moved left over goes to the nearest one that stays, so this row is full too.
  const left = tracks - next - staying.reduce((sum, other) => sum + now(other), 0);
  if (left > 0) {
    const nearest = [...after, ...before].find(other => staying.includes(other))!;
    out[nearest] = now(nearest) + left;
  }
  return out;
}

/** How far a packing is from full rows: the rows short of the full width (the last row aside), and what the last row lacks. */
function shortfall(ids: readonly string[], span: (id: string) => number, tracks: number): [rows: number, tail: number] {
  const sums = packRows(ids, span, tracks).map(row => row.reduce((sum, id) => sum + span(id), 0));
  return [sums.slice(0, -1).filter(sum => sum < tracks).length, tracks - (sums.at(-1) ?? tracks)];
}

/**
 * Spans for the plates of one row that add up to `tracks`, in proportion to `weight` (largest remainder first, the
 * wider plate on a tie), none below `minShare` or its own weight when that is less. The caller keeps the floors
 * within `tracks`.
 */
function fitRow(row: readonly string[], weight: (id: string) => number, tracks: number): Record<string, number> {
  const least = minShare(tracks);
  const total = row.reduce((sum, id) => sum + weight(id), 0);
  const exact = row.map(id => (weight(id) * tracks) / total);
  const floor = row.map(id => Math.min(least, weight(id)));
  const out = exact.map((share, i) => Math.max(floor[i]!, Math.floor(share)));
  const pick = (score: (i: number) => number, allowed: (i: number) => boolean) => {
    let best = -1;
    for (let i = 0; i < row.length; i++) {
      if (!allowed(i)) continue;
      const delta = best < 0 ? 1 : score(i) - score(best);
      if (delta > 1e-9 || (Math.abs(delta) <= 1e-9 && exact[i]! > exact[best]!)) best = i;
    }
    return best;
  };
  for (let missing = tracks - out.reduce((sum, n) => sum + n, 0); missing !== 0;) {
    const i = missing > 0 ? pick(i => exact[i]! - out[i]!, () => true) : pick(i => out[i]! - exact[i]!, i => out[i]! > floor[i]!);
    if (i < 0) break;
    const step = Math.sign(missing);
    out[i] = out[i]! + step;
    missing -= step;
  }
  return Object.fromEntries(row.map((id, i) => [id, out[i]!]));
}

/**
 * A row cut into consecutive rows in which every plate can keep its floor (see fitRow), never between the plates
 * at `pair` and `pair + 1`.
 */
function splitRow(row: readonly string[], weight: (id: string) => number, tracks: number, pair: number): string[][] {
  const least = minShare(tracks);
  const rows: string[][] = [];
  let used = tracks;
  for (let i = 0; i < row.length; i++) {
    const unit = i === pair ? row.slice(i, i + 2) : [row[i]!];
    const need = unit.reduce((sum, id) => sum + Math.min(least, weight(id)), 0);
    if (used + need > tracks) {
      rows.push([]);
      used = 0;
    }
    rows.at(-1)!.push(...unit);
    used += need;
    if (i === pair) i++;
  }
  return rows;
}

/** The visual order after a move, and the spans that change with it. */
export interface Relocation {
  order: string[];
  span: Record<string, number>;
}

/**
 * The visual order and the spans of a grid container after the person moves child `id` to index `to` of the visual
 * order (decision layout-does-the-obvious: rearranging keeps rows full, V037). `ids` are the children in visual order, `spanOf` their
 * current spans, `beside` the plate the drop slot was next to (from the keyboard: the plate it stepped over) and
 * `natural` the span a child has in the spec. The first of these that leaves no row shorter than before wins:
 *   1. the spec spans for the plates of the two rows involved: a plate that goes back where it came from gets its
 *      spec span back, and so do its old row-mates;
 *   2. the spans as they are: a move inside a row, a whole row passing another;
 *   3. the plate joins the row of `beside` and that row shares the columns out in proportion to what its plates had
 *      (a row that cannot give each plate a quarter breaks in two, never between the plate and `beside`); next to a
 *      plate that has a row of its own at full width, the plate takes a full row of its own instead. The row it left
 *      spreads over the columns it gave up.
 *   4. whatever rows still come out short stretch to the full width.
 * Returns only the spans that change.
 */
export function relocate(
  ids: readonly string[], spanOf: (id: string) => number, id: string, to: number, tracks: number,
  beside?: string, natural?: (id: string) => number | undefined,
): Relocation {
  const clamp = (n: number) => Math.min(tracks, Math.max(1, Math.round(n)));
  const span = (other: string) => clamp(spanOf(other));
  const from = ids.indexOf(id);
  const at = Math.min(ids.length - 1, Math.max(0, Math.round(to)));
  if (from < 0 || at === from || !Number.isFinite(to)) return {order: [...ids], span: {}};
  const order = ids.filter(other => other !== id);
  order.splice(at, 0, id);
  const changes = (spans: Record<string, number>) => Object.fromEntries(Object.entries(spans).filter(([other, n]) => n !== span(other)));
  // The plate it lands next to: `beside` when that is its neighbour now (a drop), else the plate it stepped over.
  const dropped = beside !== undefined && beside !== id && (order[at - 1] === beside || order[at + 1] === beside);
  const near = dropped ? beside : ids[at]!;
  const rows = packRows(ids, span, tracks);
  const source = rows.find(row => row.includes(id))!;
  const target = rows.find(row => row.includes(near))!;
  if (source === target || tracks < 2) return {order, span: {}};
  const passes = target.length === 1 && span(near) === tracks;
  const [rowsBefore, tailBefore] = shortfall(ids, span, tracks);
  const fits = (spans: Record<string, number>) => {
    const spanNow = (other: string) => spans[other] ?? span(other);
    const [short, tail] = shortfall(order, spanNow, tracks);
    if (short > rowsBefore || (short === rowsBefore && tail > tailBefore)) return false;
    // A drop lands where its hairline showed: in the row of `beside`, or in a row of its own above or below it.
    return !dropped || packRows(order, spanNow, tracks).some(row => row.includes(id) && row.includes(near)) !== passes;
  };

  if (natural) {
    const spec = Object.fromEntries([...source, ...target].map(other => [other, clamp(natural(other) ?? span(other))]));
    if (fits(spec)) return {order, span: changes(spec)};
  }
  if (fits({})) return {order, span: {}};

  const out: Record<string, number> = {};
  const left = source.filter(other => other !== id);
  if (left.length > 0) Object.assign(out, fitRow(left, span, tracks));
  if (passes) {
    out[id] = tracks;
  } else {
    const i = target.indexOf(near);
    const joined = order[at + 1] === near ? [...target.slice(0, i), id, ...target.slice(i)] : [...target.slice(0, i + 1), id, ...target.slice(i + 1)];
    for (const row of splitRow(joined, span, tracks, i)) Object.assign(out, fitRow(row, span, tracks));
  }
  if (fits(out)) return {order, span: changes(out)};

  const stretched: Record<string, number> = {};
  const packed = packRows(order, span, tracks);
  packed.forEach((row, r) => {
    const lacks = tracks - row.reduce((sum, other) => sum + span(other), 0);
    if (lacks > 0 && (r < packed.length - 1 || lacks > tailBefore)) Object.assign(stretched, fitRow(row, span, tracks));
  });
  return {order, span: changes(stretched)};
}

/** The cells of the given children inside a container, found in one pass over the container. */
function cellsOf(container: HTMLElement | null | undefined, ids: readonly string[]): Map<string, HTMLElement> {
  const cells = new Map<string, HTMLElement>();
  if (!container) return cells;
  const wanted = new Set(ids);
  for (const cell of container.querySelectorAll<HTMLElement>('.gl-cell[data-id]')) {
    const id = cell.getAttribute('data-id');
    if (id !== null && wanted.has(id) && !cells.has(id)) cells.set(id, cell);
  }
  return cells;
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The arrangement of one container. `childIds` are the component ids of its children in spec order (useChildIds);
 * the result is the value for <ArrangeContext.Provider>. Persisted under `glimpse.arrange.v1` per repository and
 * surface; a reordered plate glides to its place (280 ms) instead of jumping.
 */
export function useArrangement(surfaceId: string, containerId: string, childIds: readonly string[], options: ArrangeOptions = {}): Arrangement {
  const store = useArrangeStore();
  const surfaceKey = arrangeKey(useMeta()?.repo?.name, surfaceId);
  const entry = useSyncExternalStore(store.subscribe, () => store.entry(surfaceKey, containerId));
  const {container, flow = 'grid'} = options;
  const tracks = Math.min(MAX_SPAN, Math.max(1, Math.round(options.tracks ?? MAX_SPAN)));
  const defaultSpan = Math.min(tracks, Math.max(1, Math.round(options.defaultSpan ?? tracks)));
  const ids = useMemo(() => arrangedIds(childIds, entry?.order), [childIds, entry]);
  const specSpans = options.spans;
  // The spec span of each child, when the container says (`spans` lines up with the children).
  const natural = useMemo(() => {
    if (!specSpans || specSpans.length !== childIds.length) return undefined;
    return new Map(childIds.map((id, i) => [id, Math.min(tracks, Math.max(1, Math.round(specSpans[i] ?? defaultSpan)))]));
  }, [specSpans, childIds, tracks, defaultSpan]);
  const before = useRef<Map<string, DOMRect> | null>(null);

  // First, Last, Invert, Play: move() measured the cells where they were; now that they are laid out again, each one
  // starts from its old place and glides to the new one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the visual order changes
  useLayoutEffect(() => {
    const first = before.current;
    before.current = null;
    if (!first || reducedMotion()) return;
    for (const [id, cell] of cellsOf(container?.current, [...first.keys()])) {
      const from = first.get(id);
      if (!from || typeof cell.animate !== 'function') continue;
      const to = cell.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (dx !== 0 || dy !== 0) cell.animate([{transform: `translate(${dx}px, ${dy}px)`}, {transform: 'none'}], {duration: MOVE_MS, easing: MOVE_EASING});
    }
  }, [ids]);

  return useMemo<Arrangement>(() => {
    const position = new Map(ids.map((id, i) => [id, i]));
    const ordered = ids !== childIds && !sameIds(ids, childIds);
    const spans = entry?.span ?? {};
    const write = (order: readonly string[], span: Record<string, number>) => {
      const keepOrder = !sameIds(order, childIds);
      // Only what differs from the spec is remembered: a span set back to the spec one is forgotten.
      const live = Object.fromEntries(Object.entries(span).filter(([id, n]) => position.has(id) && natural?.get(id) !== n));
      store.update(surfaceKey, containerId, keepOrder || Object.keys(live).length > 0 ? {order: keepOrder ? [...order] : [], span: live} : undefined);
    };
    /** Every child's span as it is now: what the person set, else what its cell shows (data-span), else the default. */
    const shownSpans = (): Map<string, number> => {
      const cells = cellsOf(container?.current, ids);
      return new Map(ids.map(id => [id, Math.min(tracks, spans[id] ?? cellSpan(cells.get(id), defaultSpan))]));
    };
    return {
      ids,
      arranged: entry !== undefined,
      container,
      flow,
      tracks,
      defaultSpan,
      indexOf: childId => position.get(childId) ?? -1,
      get(componentId) {
        const index = position.get(componentId);
        if (index === undefined) return undefined;
        const span = spans[componentId];
        if (!ordered && span === undefined) return undefined;
        return {order: ordered ? index : undefined, span: span === undefined ? undefined : Math.min(span, tracks)};
      },
      move(childId, toIndex, beside) {
        const from = position.get(childId);
        if (from === undefined || !Number.isFinite(toIndex)) return;
        const to = Math.min(ids.length - 1, Math.max(0, Math.round(toIndex)));
        if (to === from) return;
        // On a grid the spans that filled the old rows need not fill the new ones: the rows are refitted (layout-does-the-obvious).
        let order: readonly string[];
        let changed: Record<string, number> = {};
        if (flow === 'grid') {
          const shown = shownSpans();
          ({order, span: changed} = relocate(ids, id => shown.get(id) ?? defaultSpan, childId, to, tracks, beside, natural && (id => natural.get(id))));
        } else {
          const next = ids.filter(id => id !== childId);
          next.splice(to, 0, childId);
          order = next;
        }
        const cells = cellsOf(container?.current, ids);
        before.current = new Map([...cells].map(([id, cell]) => [id, cell.getBoundingClientRect()]));
        write(order, {...spans, ...changed});
      },
      resize(childId, span, from) {
        if (!position.has(childId) || !Number.isFinite(span)) return undefined;
        const next = Math.min(tracks, Math.max(1, Math.round(span)));
        const base = from?.set ?? spans;
        if (flow !== 'grid') {
          if (spans[childId] !== next || base !== spans) write(ids, {...base, [childId]: next});
          return next;
        }
        // On a grid the row keeps its width: what one plate gains or gives up, its row-mates give or take (layout-does-the-obvious).
        const shown = from?.shown ?? shownSpans();
        const spanOf = (id: string) => shown.get(id) ?? defaultSpan;
        const changed = rebalance(ids, spanOf, childId, next, tracks);
        const result = {...base, ...changed};
        const same = Object.keys(result).length === Object.keys(spans).length && Object.entries(result).every(([id, n]) => spans[id] === n);
        if (!same) write(ids, result);
        return Math.min(tracks, changed[childId] ?? spanOf(childId));
      },
      snapshot: () => ({set: spans, shown: shownSpans()}),
      reset: () => store.update(surfaceKey, containerId, undefined),
    };
  }, [ids, childIds, entry, store, surfaceKey, containerId, container, flow, tracks, defaultSpan, natural]);
}

const isArrangement = (api: ArrangeApi | null): api is Arrangement => api !== null && typeof (api as Partial<Arrangement>).move === 'function';

/**
 * The child tokens of a container in the visual order of its arrangement. A container renders them in this order, so
 * the DOM follows what the person sees: the focus order, and the plate numbers (a CSS counter counts in DOM order,
 * V049). Children are keyed by id, so a move is a move, not a new mount. `childIds[i]` is the id of `tokens[i]`;
 * when they do not line up (a template child list) the tokens stay in spec order.
 */
export function inVisualOrder<T>(arrangement: Pick<Arrangement, 'ids'>, childIds: readonly string[], tokens: readonly T[]): T[] {
  if (childIds.length !== tokens.length || sameIds(arrangement.ids, childIds)) return [...tokens];
  const byId = new Map(childIds.map((id, i) => [id, tokens[i]!]));
  return arrangement.ids.flatMap(id => (byId.has(id) ? [byId.get(id)!] : []));
}

const px = (value: string) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};
const cellSpan = (cell: Element | null | undefined, fallback: number) => {
  const n = Number(cell?.getAttribute('data-span'));
  return Number.isInteger(n) && n >= 1 ? n : fallback;
};

/** Where a dragged plate would land: an index of the visual order, the plate it lands next to, and the hairline that shows the slot. */
interface DropSlot { index: number; beside: string; left: number; top: number; width: number; height: number }

function dropSlot(arrangement: Arrangement, cells: Map<string, HTMLElement>, draggedId: string, x: number, y: number): DropSlot | null {
  const container = arrangement.container?.current;
  if (!container) return null;
  const bounds = container.getBoundingClientRect();
  const style = getComputedStyle(container);
  const gapX = px(style.columnGap);
  const gapY = px(style.rowGap);
  const others = arrangement.ids.filter(id => id !== draggedId);
  let best: {index: number; rect: DOMRect; distance: number} | undefined;
  for (let index = 0; index < others.length; index++) {
    const rect = cells.get(others[index]!)?.getBoundingClientRect();
    if (!rect) continue;
    const dx = Math.max(rect.left - x, 0, x - rect.right);
    const dy = Math.max(rect.top - y, 0, y - rect.bottom);
    const distance = Math.hypot(dx, dy);
    if (!best || distance < best.distance) best = {index, rect, distance};
  }
  if (!best) return null;
  const {rect} = best;
  const beside = others[best.index]!;
  // A cell that takes the whole row is passed above or below; one that shares its row, on its left or right (the
  // plate then joins that row: relocate).
  if (rect.width >= bounds.width - 1) {
    const after = y > rect.top + rect.height / 2;
    return {index: best.index + (after ? 1 : 0), beside, left: bounds.left, top: (after ? rect.bottom + gapY / 2 : rect.top - gapY / 2) - 0.5, width: bounds.width, height: 1};
  }
  const after = x > rect.left + rect.width / 2;
  return {index: best.index + (after ? 1 : 0), beside, left: (after ? rect.right + gapX / 2 : rect.left - gapX / 2) - 0.5, top: rect.top, width: 1, height: rect.height};
}

/** Span for a plate whose right edge is dragged to `x`, snapped to the container's columns (or flex shares). */
function spanAt(arrangement: Arrangement, cells: Map<string, HTMLElement>, id: string, x: number): number | undefined {
  const container = arrangement.container?.current;
  const cell = cells.get(id);
  if (!container || !cell) return undefined;
  const bounds = container.getBoundingClientRect();
  const wanted = x - cell.getBoundingClientRect().left;
  if (bounds.width <= 0) return undefined;
  const {tracks} = arrangement;
  if (arrangement.flow === 'grid') {
    const gap = px(getComputedStyle(container).columnGap);
    const column = (bounds.width - gap * (tracks - 1)) / tracks;
    return Math.min(tracks, Math.max(1, Math.round((wanted + gap) / (column + gap))));
  }
  // In a row the span is a share: with the others holding `rest` shares, a share s takes s / (s + rest) of the width.
  const fraction = Math.min(0.92, Math.max(0, wanted / bounds.width));
  let rest = 0;
  for (const [other, element] of cells) if (other !== id) rest += cellSpan(element, arrangement.defaultSpan);
  return Math.min(tracks, Math.max(1, Math.round((fraction * rest) / (1 - fraction))));
}

export interface ArrangeHandle {
  /** Spread on the plate header: makes it the drag handle and the keyboard target. */
  header: {
    role: 'group';
    tabIndex: 0;
    'data-arrange': '';
    'aria-roledescription': string;
    'aria-keyshortcuts': string;
    onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
    onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void;
  };
  /** The 6 px resize edge; render it inside the plate (a positioned box). */
  edge: JSX.Element;
  /** Announces keyboard moves to assistive technology; render it inside the header. */
  status: ReactNode;
}

/**
 * Makes the header of component `componentId` the handle of its cell: drag to reorder inside its container (6 px
 * threshold, a hairline marks the slot), drag the right edge to change the span, `Alt+Arrow` to move and
 * `Alt+Shift+Left/Right` to change the span from the keyboard. null when the enclosing container does not arrange
 * its children, so the header stays plain.
 */
export function useArrangeHandle(componentId: string): ArrangeHandle | null {
  const context = useContext(ArrangeContext);
  const arrangement = isArrangement(context) && context.indexOf(componentId) >= 0 ? context : null;
  const [resizing, setResizing] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const arrangementRef = useRef(arrangement);
  useLatest(arrangementRef, arrangement);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    if ((event.target as Element).closest('button, a, input, select, textarea, summary, [data-no-drag]')) return;
    const origin = {x: event.clientX, y: event.clientY};
    const root = document.documentElement;
    let drag: {cells: Map<string, HTMLElement>; marker: HTMLElement; slot: DropSlot | null} | undefined;
    const onMove = (move: PointerEvent) => {
      const current = arrangementRef.current;
      if (!current) return;
      if (!drag) {
        if (Math.hypot(move.clientX - origin.x, move.clientY - origin.y) < DRAG_THRESHOLD) return;
        const cells = cellsOf(current.container?.current, current.ids);
        if (!cells.has(componentId)) return;
        const marker = document.createElement('div');
        marker.className = 'gl-drop-marker';
        marker.hidden = true;
        document.body.append(marker);
        cells.get(componentId)?.setAttribute('data-dragging', '');
        root.style.userSelect = 'none';
        // Tooltips of the views the plate passes over stay down while it moves (kit.css, V049).
        root.setAttribute('data-gl-arranging', '');
        getSelection()?.removeAllRanges();
        drag = {cells, marker, slot: null};
      }
      const slot = dropSlot(current, drag.cells, componentId, move.clientX, move.clientY);
      drag.slot = slot;
      drag.marker.hidden = slot === null;
      if (slot) Object.assign(drag.marker.style, {left: `${slot.left}px`, top: `${slot.top}px`, width: `${slot.width}px`, height: `${slot.height}px`});
    };
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      if (!drag) return;
      drag.marker.remove();
      drag.cells.get(componentId)?.removeAttribute('data-dragging');
      root.style.userSelect = '';
      root.removeAttribute('data-gl-arranging');
      if (commit && drag.slot) arrangementRef.current?.move(componentId, drag.slot.index, drag.slot.beside);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== 'Escape') return;
      // Escape cancels the drag and nothing else: the shell must not also take it as "clear the selection".
      if (drag) {
        key.preventDefault();
        key.stopPropagation();
      }
      finish(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  }, [componentId]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const current = arrangementRef.current;
    if (!current || !event.altKey || event.metaKey || event.ctrlKey || event.target !== event.currentTarget) return;
    const index = current.indexOf(componentId);
    if (event.shiftKey) {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (step === 0) return;
      const span = Math.min(current.tracks, Math.max(1, (current.get(componentId)?.span ?? cellSpan(event.currentTarget.closest('.gl-cell'), current.defaultSpan)) + step));
      setStatus(`Span ${current.resize(componentId, span) ?? span} of ${current.tracks}`);
    } else {
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
      if (step === 0) return;
      const to = Math.min(current.ids.length - 1, Math.max(0, index + step));
      current.move(componentId, to);
      setStatus(`Position ${to + 1} of ${current.ids.length}`);
      // The container renders its cells in the new order, which moves this header in the DOM: a browser drops the
      // focus of an element that is moved, so it is given back once the move is done.
      const header = event.currentTarget;
      queueMicrotask(() => { if (header.isConnected && document.activeElement !== header) header.focus({preventScroll: true}); });
    }
    event.preventDefault();
    event.stopPropagation();
  }, [componentId]);

  const onEdgeDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const current = arrangementRef.current;
    if (!current || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const edge = event.currentTarget;
    const cells = cellsOf(current.container?.current, current.ids);
    const pointer = event.pointerId;
    try {
      // An if, not `?.()`: the React Compiler does not yet read an optional call inside try (decision compiled-viewer).
      if (edge.setPointerCapture) edge.setPointerCapture(pointer);
    } catch {
      // a pointer that is already gone cannot be captured; the window listeners below still end the drag
    }
    setResizing(current.get(componentId)?.span ?? cellSpan(cells.get(componentId), current.defaultSpan));
    document.documentElement.setAttribute('data-gl-arranging', '');
    // Every step of the drag starts from the spans the drag started with: going out and back leaves them as they were.
    const from = current.snapshot();
    const onMove = (move: PointerEvent) => {
      const now = arrangementRef.current;
      const span = now ? spanAt(now, cells, componentId, move.clientX) : undefined;
      if (!now || span === undefined) return;
      setResizing(now.resize(componentId, span, from) ?? span);
    };
    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.documentElement.removeAttribute('data-gl-arranging');
      setResizing(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }, [componentId]);

  if (!arrangement) return null;
  return {
    header: {
      role: 'group',
      tabIndex: 0,
      'data-arrange': '',
      'aria-roledescription': 'movable plate',
      'aria-keyshortcuts': 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown Alt+Shift+ArrowLeft Alt+Shift+ArrowRight',
      onPointerDown,
      onKeyDown,
    },
    edge: (
      <div className="gl-resize" aria-hidden="true" data-resizing={resizing === null ? undefined : ''} onPointerDown={onEdgeDown}>
        <span className="gl-resize-tag">{resizing ?? arrangement.defaultSpan} / {arrangement.tracks} COL</span>
      </div>
    ),
    status: <span className="gl-sr" role="status">{status}</span>,
  };
}
