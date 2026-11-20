// DatasetStore (design 2.4): runs sources through the injected registry and memoizes their results per canonical
// ref, per HEAD, and per working-tree revision for sources flagged `wt`. It knows nothing about surfaces: the session
// binds results to data-model paths.
import {formatRef, type Dataset, type Rows, type RowsPage, type SourceMeta, type SourceRef} from '@glimpse/catalog';
import {SourceError, type RepoContext, type SourceResult} from '../contracts.ts';
import {resolveSource, type SourceRegistry} from '../sources/registry.ts';

export const MAX_RESULTS = 64;
export const MAX_PAGE = 500;
const DEFAULT_PAGE = 200;

export interface Ready { ok: true; meta: SourceMeta; result: SourceResult; elapsedMs: number; cached: boolean }
export interface Failed { ok: false; meta: SourceMeta | undefined; error: {code: string; message: string} }
export type Outcome = Ready | Failed;

interface Entry { promise: Promise<Outcome>; settled?: Ready; controller: AbortController }

export interface DatasetStoreOptions {
  registry: SourceRegistry;
  context(): RepoContext;
  log(message: string): void;
  now?: () => number;
}

function describeError(error: unknown): {code: string; message: string} {
  if (error instanceof SourceError) return {code: error.code, message: error.message};
  const message = error instanceof Error ? error.message : String(error);
  return {code: 'E_INTERNAL', message: message.replace(/\s+/g, ' ').slice(0, 300)};
}

export class DatasetStore {
  private entries = new Map<string, Entry>();
  private options: DatasetStoreOptions;
  private closed = false;

  constructor(options: DatasetStoreOptions) {
    this.options = options;
  }

  private cacheKey(ref: SourceRef, meta: SourceMeta): string {
    const ctx = this.options.context();
    return [formatRef(ref), ctx.git?.head ?? '', meta.wt ? ctx.rev() : ''].join('\u0000');
  }

  /** The memoized result for the ref at the current HEAD and revision, if there is one. */
  peek(ref: SourceRef): Ready | undefined {
    const source = resolveSource(ref.source, this.options.registry);
    return source ? this.entries.get(this.cacheKey(ref, source.meta))?.settled : undefined;
  }

  /**
   * Runs the ref's source, or joins the run in flight, or answers from memory. Never rejects: failures are outcomes.
   * Failures are not memoized, so the next request tries again.
   */
  run(ref: SourceRef): Promise<Outcome> {
    const source = resolveSource(ref.source, this.options.registry);
    if (!source) return Promise.resolve({ok: false, meta: undefined, error: {code: 'E_SOURCE', message: `unknown source "${ref.source}"`}});
    const meta = source.meta;
    if (this.closed) return Promise.resolve({ok: false, meta, error: {code: 'E_INTERNAL', message: 'the session has ended'}});
    const key = this.cacheKey(ref, meta);
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.settled ? Promise.resolve({...existing.settled, cached: true}) : existing.promise;
    }
    const controller = new AbortController();
    const now = this.options.now ?? Date.now;
    const started = now();
    const promise: Promise<Outcome> = (async () => {
      try {
        const result = await source.run(this.options.context(), ref, controller.signal);
        return {ok: true, meta, result, elapsedMs: Math.max(0, Math.round(now() - started)), cached: false};
      } catch (error) {
        const described = describeError(error);
        if (described.code === 'E_INTERNAL' && described.message !== 'not implemented') this.options.log(`glimpse: source ${formatRef(ref)} failed: ${described.message}`);
        return {ok: false, meta, error: described};
      }
    })();
    const entry: Entry = {promise, controller};
    this.entries.set(key, entry);
    void promise.then(outcome => {
      if (outcome.ok) entry.settled = outcome;
      else if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    this.trim();
    return promise;
  }

  private trim(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= MAX_RESULTS) break;
      if (entry.settled) this.entries.delete(key);
    }
  }

  /** Aborts every run in flight and refuses new ones. */
  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) if (!entry.settled) entry.controller.abort();
    this.entries.clear();
  }
}

// ---------------------------------------------------------------- envelopes
export function pendingEnvelope(key: string, ref: SourceRef, meta: SourceMeta | undefined): Dataset {
  const source = formatRef(ref);
  return {$ds: key, kind: meta?.kind ?? 'rows', status: 'pending', source, note: `running ${source}`, ...(meta?.wt ? {wt: true} : {})};
}

export function envelopeOf(key: string, ref: SourceRef, outcome: Outcome): Dataset {
  const source = formatRef(ref);
  if (!outcome.ok) {
    return {$ds: key, kind: outcome.meta?.kind ?? 'rows', status: 'error', source, error: outcome.error, ...(outcome.meta?.wt ? {wt: true} : {})};
  }
  const {meta, result} = outcome;
  const fields = result.fields ?? meta.fields;
  const roles = result.roles ?? meta.roles;
  // Sources cut their own output; this is the backstop that keeps an oversized row set out of the data model.
  const over = meta.kind === 'rows' && Array.isArray(result.data) && result.data.length > meta.budget ? result.data.length : 0;
  const truncated = over > 0 ? {total: Math.max(over, result.total ?? 0), returned: meta.budget, strategy: 'topN' as const} : result.truncated;
  const warnings = [...(result.warnings ?? []), ...(over > 0 ? [`${meta.name}: showing the first ${meta.budget} of ${over} rows`] : [])];
  return {
    $ds: key,
    kind: meta.kind,
    status: 'ready',
    source,
    data: over > 0 ? (result.data as unknown[]).slice(0, meta.budget) : result.data,
    ...(fields ? {fields} : {}),
    ...(roles ? {roles} : {}),
    ...(result.total !== undefined || over > 0 ? {total: Math.max(over, result.total ?? 0)} : {}),
    ...(truncated ? {truncated} : {}),
    ...(meta.kind === 'rows' && meta.pageable && result.allRows ? {pageable: true} : {}),
    ...(meta.wt ? {wt: true} : {}),
    cache: outcome.cached ? 'hit' : 'miss',
    elapsedMs: outcome.elapsedMs,
    ...(warnings.length > 0 ? {warnings} : {}),
  };
}

// ---------------------------------------------------------------- paging
export interface PageQuery { offset?: number; limit?: number; sort?: string; q?: string }

const cellText = (value: unknown): string =>
  value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);

function compareCells(a: unknown, b: unknown): number {
  const emptyA = a === null || a === undefined || (typeof a === 'number' && Number.isNaN(a));
  const emptyB = b === null || b === undefined || (typeof b === 'number' && Number.isNaN(b));
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const na = Number(a);
  const nb = Number(b);
  if (typeof a !== 'object' && typeof b !== 'object' && a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return cellText(a).localeCompare(cellText(b), undefined, {numeric: true, sensitivity: 'base'});
}

/** One page of a row set: substring search over all cells, then a stable sort, then the window. */
export function pageRows(rows: Rows, query: PageQuery): RowsPage {
  let out = rows;
  const needle = query.q?.trim().toLowerCase();
  if (needle) out = out.filter(row => Object.values(row).some(value => cellText(value).toLowerCase().includes(needle)));
  const sort = query.sort?.trim();
  if (sort) {
    const descending = sort.startsWith('-');
    const field = descending ? sort.slice(1) : sort;
    // Missing values sort last in both directions.
    out = out.map((row, index) => ({row, index}))
      .sort((x, y) => {
        const xv = x.row[field];
        const yv = y.row[field];
        const xe = xv === null || xv === undefined;
        const ye = yv === null || yv === undefined;
        if (xe || ye) return xe === ye ? x.index - y.index : xe ? 1 : -1;
        return (descending ? -1 : 1) * compareCells(xv, yv) || x.index - y.index;
      })
      .map(x => x.row);
  }
  const offset = Number.isFinite(query.offset) ? Math.max(0, Math.floor(query.offset!)) : 0;
  const limit = Number.isFinite(query.limit) ? Math.min(MAX_PAGE, Math.max(1, Math.floor(query.limit!))) : DEFAULT_PAGE;
  return {rows: out.slice(offset, offset + limit), total: out.length, offset};
}

/** The rows a ready outcome can page: the full set of a pageable source, else the rows it bound. */
export function rowsOf(outcome: Outcome): Rows | undefined {
  if (!outcome.ok || outcome.meta.kind !== 'rows') return undefined;
  const rows = outcome.result.allRows ?? outcome.result.data;
  return Array.isArray(rows) ? (rows.filter(row => typeof row === 'object' && row !== null) as Rows) : undefined;
}
