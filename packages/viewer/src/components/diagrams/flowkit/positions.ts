// Where the person dragged diagram nodes to (design 12.1.B). Kept in localStorage under `glimpse.pos.v1` as
//   {[repoName + '/' + surfaceId + '/' + componentId]: {[nodeId]: {x, y}}}      x, y: centre of the node
// and applied on top of the automatic layout. Nothing here is sent to the agent. When storage is missing, full or
// blocked the positions live in memory for the life of the page.
import {useCallback, useMemo, useRef, useState} from 'react';
import {useMeta, useSurfaceId} from '../../../kit/index.ts';
import type {Point} from './geometry.ts';

export const POSITIONS_KEY = 'glimpse.pos.v1';
export type Positions = Readonly<Record<string, Point>>;
type Store = Record<string, Record<string, Point>>;
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

let configured: StorageLike | null | undefined;
let memory: Store = {};

/** Replaces the storage positions are kept in: a fake in tests, `null` for memory only, `undefined` for localStorage. */
export function configurePositionStorage(storage: StorageLike | null | undefined): void {
  configured = storage;
  memory = {};
}

function storage(): StorageLike | null {
  if (configured !== undefined) return configured;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const isPoint = (v: unknown): v is Point =>
  typeof v === 'object' && v !== null && Number.isFinite((v as Point).x) && Number.isFinite((v as Point).y);

function parse(raw: string): Store {
  const value: unknown = JSON.parse(raw);
  const out: Store = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const positions: Record<string, Point> = {};
    for (const [id, point] of Object.entries(entry)) if (isPoint(point)) positions[id] = {x: point.x, y: point.y};
    out[key] = positions;
  }
  return out;
}

function readAll(): Store {
  try {
    const raw = storage()?.getItem(POSITIONS_KEY);
    if (typeof raw === 'string') return parse(raw);
  } catch {
    // unreadable or malformed: fall through to what this page remembers
  }
  return memory;
}

function writeAll(all: Store): void {
  memory = all;
  try {
    storage()?.setItem(POSITIONS_KEY, JSON.stringify(all));
  } catch {
    // quota or privacy mode: the in-memory copy still serves this page
  }
}

export function positionsKey(repoName: string | undefined, surfaceId: string, componentId: string): string {
  return `${repoName ?? ''}/${surfaceId}/${componentId}`;
}

export function readPositions(key: string): Positions {
  return readAll()[key] ?? {};
}

/** Stores the positions of one diagram; an empty record removes its entry. */
export function writePositions(key: string, positions: Positions): void {
  const all = {...readAll()};
  if (Object.keys(positions).length === 0) delete all[key];
  else all[key] = {...positions};
  writeAll(all);
}

export interface NodePositions {
  /** The storage key: which diagram (repo, surface, component) these positions belong to. */
  key: string;
  positions: Positions;
  /** Moves a node for now; nothing is stored until commit(). */
  move(id: string, centre: Point): void;
  /** Stores the current positions. */
  commit(): void;
  /** Forgets every position of this diagram. */
  clear(): void;
}

/** The dragged positions of one diagram, read from storage when the diagram (or its repo) changes. */
export function useNodePositions(componentId: string): NodePositions {
  const key = positionsKey(useMeta()?.repo?.name, useSurfaceId(), componentId);
  const [state, setState] = useState(() => ({key, positions: readPositions(key)}));
  // A different diagram under the same view instance (the repo name arrives, the surface is replaced): start from
  // what is stored for it, during render so no frame shows the old positions.
  const current = state.key === key ? state : {key, positions: readPositions(key)};
  if (current !== state) setState(current);
  const positions = current.positions;
  // Event handlers read the latest positions here: a drag moves and commits within one event turn.
  const latest = useRef(current);
  latest.current = current;

  const move = useCallback((id: string, centre: Point) => {
    const next = {key: latest.current.key, positions: {...latest.current.positions, [id]: centre}};
    latest.current = next;
    setState(next);
  }, []);
  const commit = useCallback(() => {
    const {key: at, positions: mine} = latest.current;
    // Positions of nodes that are not on screen right now (another focus, an earlier dataset) are kept.
    writePositions(at, {...readPositions(at), ...mine});
  }, []);
  const clear = useCallback(() => {
    const next = {key: latest.current.key, positions: {}};
    latest.current = next;
    writePositions(next.key, {});
    setState(next);
  }, []);
  const currentKey = current.key;
  return useMemo(() => ({key: currentKey, positions, move, commit, clear}), [currentKey, positions, move, commit, clear]);
}
