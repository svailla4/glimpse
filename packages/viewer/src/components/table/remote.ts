// Remote paging for pageable datasets: the full row set stays in the server and is read through useRows in windows
// of 200 rows around the viewport. Loaded windows are kept, so scrolling back does not blank the rows.
import type {DataRow, Dataset, RowsPage} from '@glimpse/catalog';
import {useCallback, useRef, useState} from 'react';
import {useRev, useRows} from '../../kit/index.ts';

export const WINDOW = 200;
const MAX_WINDOWS = 64;

export interface RemoteRows {
  /** Rows matching the query in the server (falls back to the dataset total until the first page arrives). */
  total: number;
  /** The row at an index of the sorted, filtered set; undefined while its window is loading. */
  rowAt(index: number): DataRow | undefined;
  /** Tells the pager which rows are on screen. Call from an effect. */
  want(first: number, last: number): void;
  loading: boolean;
  error?: string;
}

interface Cache {
  /** The envelope the windows were read from: a re-run of the source (refresh, drill) puts a new one under the same key. */
  ds?: Dataset;
  /** Sort, search and working-tree revision the windows answer. */
  query: string;
  pages: Map<number, DataRow[]>;
  /** Windows of the query before this one: shown until the new query answers, so a sort or a refresh does not blank the rows. */
  previous?: Map<number, DataRow[]>;
  total?: number;
}

/**
 * `ds` undefined turns paging off (the hook then fetches nothing). `inline` is the dataset's own first rows: they
 * stand in for the first window while it loads, which is only correct in the server's own order, so not while a
 * sort or a search is active.
 */
export function useRemoteRows(ds: Dataset | undefined, query: {sort?: string; q?: string}, inline: readonly DataRow[]): RemoteRows {
  const rev = useRev();
  const [windows, setWindows] = useState<readonly [number, number]>([0, 0]);
  const {sort, q} = query;
  const cacheRef = useRef<Cache>({ds, query: '', pages: new Map()});
  const cache = cacheRef.current;

  // useRows fetches again on key, query, revision and envelope, and says `loading` until the answer to the CURRENT
  // request is in: what it returns meanwhile is the previous answer, which is never taken for this one (see accept).
  const first = useRows(ds, {offset: windows[0] * WINDOW, limit: WINDOW, sort, q});
  const second = useRows(windows[1] !== windows[0] ? ds : undefined, {offset: windows[1] * WINDOW, limit: WINDOW, sort, q});

  const asked = `${sort ?? ''}\u0001${q ?? ''}\u0001${rev}`;
  if (cache.ds !== ds || cache.query !== asked) {
    // A new query or a new run starts empty, but what the previous one showed (and its count) stays up until the new
    // one answers, as long as it is the same dataset.
    const sameDataset = ds !== undefined && cache.ds?.$ds === ds.$ds;
    cache.previous = sameDataset && cache.pages.size > 0 ? cache.pages : sameDataset ? cache.previous : undefined;
    if (!sameDataset) cache.total = undefined;
    cache.ds = ds;
    cache.query = asked;
    cache.pages = new Map();
  }
  const accept = (answer: {page?: RowsPage; loading: boolean; error?: string}, window: number, enabled: boolean) => {
    const {page} = answer;
    // Only a settled answer is the answer to this request: while loading (and after a failure) useRows still holds
    // the previous page of the dataset.
    if (!enabled || answer.loading || answer.error !== undefined || !page || !Array.isArray(page.rows) || page.offset !== window * WINDOW) return;
    if (cache.pages.get(window) === page.rows) return;
    cache.previous = undefined;
    cache.pages.set(window, page.rows);
    if (Number.isFinite(page.total)) cache.total = Math.max(0, page.total);
    if (cache.pages.size > MAX_WINDOWS) {
      for (const key of cache.pages.keys()) {
        if (key === windows[0] || key === windows[1]) continue;
        cache.pages.delete(key);
        break;
      }
    }
  };
  accept(first, windows[0], ds !== undefined);
  accept(second, windows[1], ds !== undefined && windows[1] !== windows[0]);

  const want = useCallback((from: number, to: number) => {
    const next = [Math.max(0, Math.floor(from / WINDOW)), Math.max(0, Math.floor(to / WINDOW))] as const;
    setWindows(prev => (prev[0] === next[0] && prev[1] === next[1] ? prev : next));
  }, []);

  const inOrder = !sort && !q;
  const isRow = (row: unknown): row is DataRow => typeof row === 'object' && row !== null && !Array.isArray(row);
  return {
    total: cache.total ?? ds?.total ?? inline.length,
    rowAt(index) {
      const window = Math.floor(index / WINDOW);
      const row: unknown = cache.pages.get(window)?.[index % WINDOW];
      if (isRow(row)) return row;
      const before: unknown = cache.pages.has(window) ? undefined : cache.previous?.get(window)?.[index % WINDOW];
      if (isRow(before)) return before;
      return inOrder && !cache.previous ? inline[index] : undefined;
    },
    want,
    loading: first.loading || second.loading,
    error: first.error ?? second.error,
  };
}
