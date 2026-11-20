// A file on disk, read through the host in windows of 400 lines (design 5.7). The view asks for the lines it is
// about to show; windows arrive on their own and are kept, so scrolling back costs nothing.
import type {FileSlice, TokenLine} from '@glimpse/catalog';
import {useCallback, useEffect, useReducer, useRef, useState} from 'react';
import {toNumber, useHost} from '../../../kit/index.ts';
import {coerceLines, maxCols} from './lines.tsx';
import {errorText} from './useFetched.ts';

export const WINDOW = 400;
const MAX_WINDOWS = 64;
const SKIPPED = new Set(['binary', 'too-large', 'missing', 'outside-root']);

export interface LoadedFile {
  path: string;
  total: number;
  lang: string;
  size: number;
  skipped?: FileSlice['skipped'];
}

interface Store {
  path: string;
  info?: LoadedFile;
  windows: Map<number, TokenLine[]>;
  /** Window -> the revision it was last asked for at: loaded, or on its way. */
  askedAt: Map<number, number>;
  controls: Set<AbortController>;
  cols: number;
}

export interface FileLines {
  /** The file on screen. While another path loads this is still the previous one. */
  file?: LoadedFile;
  loading: boolean;
  /** The current path could not be read at all. */
  error?: string;
  cols: number;
  /** Tokens of a 1-based line of `file`, or undefined while its window is on the way. */
  line(n: number): TokenLine | undefined;
  /** Asks for the windows that hold lines first..last (1-based) unless they are loaded at the current revision. */
  ensure(first: number, last: number): void;
}

const windowOf = (line: number) => Math.max(0, Math.floor((line - 1) / WINDOW));
const abortAll = (store: Store | undefined) => {
  for (const control of store?.controls ?? []) control.abort();
};

/**
 * `around` is the line the first window should hold (the range the view opens at). A change of `rev` reads the
 * windows in view again; lines stay on screen until their replacement arrives.
 */
export function useFileLines(path: string | undefined, rev: number, around: number): FileLines {
  const host = useHost();
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [error, setError] = useState<{path: string; message: string} | undefined>(undefined);
  const shown = useRef<Store | undefined>(undefined);
  const next = useRef<Store | undefined>(undefined);
  const inView = useRef<[number, number]>([0, 0]);
  const revRef = useRef(rev);
  revRef.current = rev;
  const aroundRef = useRef(around);
  aroundRef.current = around;

  const request = useCallback(
    (store: Store, index: number) => {
      const asked = revRef.current;
      if (store.askedAt.get(index) === asked) return;
      store.askedAt.set(index, asked);
      const control = new AbortController();
      store.controls.add(control);
      host.file({path: store.path, start: index * WINDOW + 1, end: (index + 1) * WINDOW}, control.signal).then(
        slice => {
          store.controls.delete(control);
          if (control.signal.aborted) return;
          const total = Math.max(0, Math.floor(toNumber(slice?.total) ?? 0));
          const skipped = SKIPPED.has(slice?.skipped as string) ? slice.skipped : undefined;
          store.info = {path: store.path, total, lang: typeof slice?.lang === 'string' ? slice.lang : '', size: toNumber(slice?.size) ?? 0, skipped};
          // Lines are placed by the numbers the host says it sent, whatever was asked for.
          const lines = skipped ? [] : coerceLines(slice?.lines);
          const start = Math.max(1, Math.floor(toNumber(slice?.start) ?? index * WINDOW + 1));
          const fresh = new Map<number, TokenLine[]>([[index, []]]);
          lines.forEach((line, i) => {
            const at = start - 1 + i;
            if (at >= total) return;
            const key = Math.floor(at / WINDOW);
            const bucket = fresh.get(key) ?? [];
            bucket[at % WINDOW] = line;
            fresh.set(key, bucket);
          });
          for (const [key, bucket] of fresh) {
            store.windows.set(key, bucket);
            store.askedAt.set(key, asked);
          }
          store.cols = Math.max(store.cols, maxCols(lines));
          for (const key of [...store.windows.keys()]) {
            if (key * WINDOW >= total && key !== 0) store.windows.delete(key);
          }
          if (store.windows.size > MAX_WINDOWS) {
            const far = [...store.windows.keys()].sort((a, b) => Math.abs(b - index) - Math.abs(a - index));
            for (const key of far.slice(0, store.windows.size - MAX_WINDOWS)) {
              store.windows.delete(key);
              store.askedAt.delete(key);
            }
          }
          if (next.current === store) {
            abortAll(shown.current);
            shown.current = store;
            next.current = undefined;
            inView.current = [index, index];
            setError(undefined);
          }
          redraw();
        },
        failure => {
          store.controls.delete(control);
          if (control.signal.aborted) return;
          // A window of a file that is already on screen keeps what it shows; it is asked for again at the next revision.
          if (!store.info) setError({path: store.path, message: errorText(failure)});
          redraw();
        },
      );
    },
    [host],
  );

  useEffect(() => {
    abortAll(next.current);
    next.current = undefined;
    if (!path) {
      abortAll(shown.current);
      shown.current = undefined;
      redraw();
      return;
    }
    if (shown.current?.path === path) {
      redraw();
      return;
    }
    const store: Store = {path, windows: new Map(), askedAt: new Map(), controls: new Set(), cols: 0};
    next.current = store;
    request(store, windowOf(aroundRef.current));
    redraw();
    return () => abortAll(store);
  }, [path, request]);

  // `rev` is the trigger: request() reads the revision from a ref.
  useEffect(() => {
    const store = shown.current;
    if (!store?.info) return;
    const [from, to] = inView.current;
    for (let index = from; index <= to; index++) request(store, index);
  }, [rev, request]);

  useEffect(() => () => abortAll(shown.current), []);

  const line = useCallback((n: number) => shown.current?.windows.get(windowOf(n))?.[(n - 1) % WINDOW], []);
  const ensure = useCallback(
    (first: number, last: number) => {
      const store = shown.current;
      if (!store?.info || store.info.skipped) return;
      const from = windowOf(first);
      const to = Math.max(from, windowOf(Math.min(last, Math.max(1, store.info.total))));
      inView.current = [from, to];
      for (let index = from; index <= to; index++) request(store, index);
    },
    [request],
  );

  const store = shown.current;
  return {
    file: store?.info,
    loading: next.current !== undefined,
    error: path && error?.path === path && store?.path !== path ? error.message : undefined,
    cols: store?.cols ?? 0,
    line,
    ensure,
  };
}
