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
import {useMeta} from './hooks.ts';
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
  /** Moves a child to `toIndex` of the visual order. */
  move(childId: string, toIndex: number): void;
  /** Sets the span of a child (clamped to 1..tracks). */
  resize(childId: string, span: number): void;
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
      const live = Object.fromEntries(Object.entries(span).filter(([id]) => position.has(id)));
      store.update(surfaceKey, containerId, keepOrder || Object.keys(live).length > 0 ? {order: keepOrder ? [...order] : [], span: live} : undefined);
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
      move(childId, toIndex) {
        const from = position.get(childId);
        if (from === undefined) return;
        const to = Math.min(ids.length - 1, Math.max(0, Math.round(toIndex)));
        if (to === from) return;
        const next = ids.filter(id => id !== childId);
        next.splice(to, 0, childId);
        const cells = cellsOf(container?.current, ids);
        before.current = new Map([...cells].map(([id, cell]) => [id, cell.getBoundingClientRect()]));
        write(next, spans);
      },
      resize(childId, span) {
        if (!position.has(childId) || !Number.isFinite(span)) return;
        const next = Math.min(tracks, Math.max(1, Math.round(span)));
        if (spans[childId] !== next) write(ids, {...spans, [childId]: next});
      },
      reset: () => store.update(surfaceKey, containerId, undefined),
    };
  }, [ids, childIds, entry, store, surfaceKey, containerId, container, flow, tracks, defaultSpan]);
}

const isArrangement = (api: ArrangeApi | null): api is Arrangement => api !== null && typeof (api as Partial<Arrangement>).move === 'function';

const px = (value: string) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};
const cellSpan = (cell: Element | null | undefined, fallback: number) => {
  const n = Number(cell?.getAttribute('data-span'));
  return Number.isInteger(n) && n >= 1 ? n : fallback;
};

/** Where a dragged plate would land: an index of the visual order, and the hairline that shows the slot. */
interface DropSlot { index: number; left: number; top: number; width: number; height: number }

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
  // A cell that takes the whole row is passed above or below; one that shares its row, on its left or right.
  if (rect.width >= bounds.width - 1) {
    const after = y > rect.top + rect.height / 2;
    return {index: best.index + (after ? 1 : 0), left: bounds.left, top: (after ? rect.bottom + gapY / 2 : rect.top - gapY / 2) - 0.5, width: bounds.width, height: 1};
  }
  const after = x > rect.left + rect.width / 2;
  return {index: best.index + (after ? 1 : 0), left: (after ? rect.right + gapX / 2 : rect.left - gapX / 2) - 0.5, top: rect.top, width: 1, height: rect.height};
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
  const latest = useRef(arrangement);
  latest.current = arrangement;

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    if ((event.target as Element).closest('button, a, input, select, textarea, summary, [data-no-drag]')) return;
    const origin = {x: event.clientX, y: event.clientY};
    const root = document.documentElement;
    let drag: {cells: Map<string, HTMLElement>; marker: HTMLElement; slot: DropSlot | null} | undefined;
    const onMove = (move: PointerEvent) => {
      const current = latest.current;
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
      if (commit && drag.slot) latest.current?.move(componentId, drag.slot.index);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (key: KeyboardEvent) => {
      if (key.key === 'Escape') finish(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  }, [componentId]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const current = latest.current;
    if (!current || !event.altKey || event.metaKey || event.ctrlKey || event.target !== event.currentTarget) return;
    const index = current.indexOf(componentId);
    if (event.shiftKey) {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (step === 0) return;
      const span = Math.min(current.tracks, Math.max(1, (current.get(componentId)?.span ?? cellSpan(event.currentTarget.closest('.gl-cell'), current.defaultSpan)) + step));
      current.resize(componentId, span);
      setStatus(`Span ${span} of ${current.tracks}`);
    } else {
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
      if (step === 0) return;
      const to = Math.min(current.ids.length - 1, Math.max(0, index + step));
      current.move(componentId, to);
      setStatus(`Position ${to + 1} of ${current.ids.length}`);
    }
    event.preventDefault();
    event.stopPropagation();
  }, [componentId]);

  const onEdgeDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const current = latest.current;
    if (!current || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const edge = event.currentTarget;
    const cells = cellsOf(current.container?.current, current.ids);
    const pointer = event.pointerId;
    try {
      edge.setPointerCapture?.(pointer);
    } catch {
      // a pointer that is already gone cannot be captured; the window listeners below still end the drag
    }
    setResizing(current.get(componentId)?.span ?? cellSpan(cells.get(componentId), current.defaultSpan));
    const onMove = (move: PointerEvent) => {
      const now = latest.current;
      const span = now ? spanAt(now, cells, componentId, move.clientX) : undefined;
      if (!now || span === undefined) return;
      now.resize(componentId, span);
      setResizing(span);
    };
    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
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
