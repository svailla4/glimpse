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

/** Sources running at once; the rest wait their turn. Sources share one repository index and one git. */
export const MAX_RUNNING = 8;
/** Runs waiting for a turn before new ones are refused. */
export const MAX_WAITING = 64;
/** A source that has not answered after this long is stopped and reported as failed. */
export const RUN_TIMEOUT_MS = 120_000;
const MAX_WARNINGS = 8;
const MAX_WARNING_CHARS = 300;

export interface DatasetStoreOptions {
  registry: SourceRegistry;
  context(): RepoContext;
  log(message: string): void;
  now?: () => number;
  maxRunning?: number;
  maxWaiting?: number;
  runTimeoutMs?: number;
}

function describeError(error: unknown): {code: string; message: string} {
  if (error instanceof SourceError) return {code: error.code, message: error.message};
  const message = error instanceof Error ? error.message : String(error);
  return {code: 'E_INTERNAL', message: message.replace(/\s+/g, ' ').slice(0, 300)};
}

/** At most eight distinct warnings of at most 300 characters each: one noisy source cannot flood a view or a result. */
export function boundWarnings(warnings: readonly unknown[]): string[] {
  const texts = warnings.filter((warning): warning is string => typeof warning === 'string').map(warning => warning.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .map(warning => (warning.length > MAX_WARNING_CHARS ? warning.slice(0, MAX_WARNING_CHARS - 1) + '…' : warning));
  const distinct = [...new Set(texts)];
  return distinct.length > MAX_WARNINGS ? [...distinct.slice(0, MAX_WARNINGS - 1), `(${distinct.length - MAX_WARNINGS + 1} more warnings)`] : distinct;
}

export class DatasetStore {
  private entries = new Map<string, Entry>();
  private options: DatasetStoreOptions;
  private closed = false;
  private running = 0;
  private waiting: Array<() => void> = [];

  constructor(options: DatasetStoreOptions) {
    this.options = options;
  }

  /** Runs in flight and runs waiting for a turn. */
  get load(): {running: number; waiting: number} {
    return {running: this.running, waiting: this.waiting.length};
  }

  /** Runs `work` now when a slot is free (it starts before this returns), else when one is handed over. */
  private whenFree<T>(work: () => Promise<T>): Promise<T> {
    if (this.running < (this.options.maxRunning ?? MAX_RUNNING)) {
      this.running++;
      return work();
    }
    return new Promise<void>(resolve => this.waiting.push(resolve)).then(work);
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
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
    if (this.waiting.length >= (this.options.maxWaiting ?? MAX_WAITING)) {
      return Promise.resolve({ok: false, meta, error: {code: 'E_INTERNAL', message: `${this.waiting.length} sources are already waiting to run; ask again in a moment`}});
    }
    const controller = new AbortController();
    const now = this.options.now ?? Date.now;
    const timeoutMs = this.options.runTimeoutMs ?? RUN_TIMEOUT_MS;
    const promise: Promise<Outcome> = this.whenFree(async (): Promise<Outcome> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        if (this.closed || controller.signal.aborted) return {ok: false, meta, error: {code: 'E_INTERNAL', message: 'the session has ended'}};
        const started = now();
        // A source is expected to honour the signal; the race makes sure a run that does not still ends.
        const overdue = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new SourceError('E_INTERNAL', `${formatRef(ref)} did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped`));
            controller.abort();
          }, timeoutMs);
          timer.unref();
        });
        const result = await Promise.race([source.run(this.options.context(), ref, controller.signal), overdue]);
        return {ok: true, meta, result, elapsedMs: Math.max(0, Math.round(now() - started)), cached: false};
      } catch (error) {
        const described = describeError(error);
        if (described.code === 'E_INTERNAL' && described.message !== 'not implemented') this.options.log(`glimpse: source ${formatRef(ref)} failed: ${described.message}`);
        return {ok: false, meta, error: described};
      } finally {
        clearTimeout(timer);
        this.release();
      }
    });
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

  /** Aborts every run in flight, lets the waiting ones answer "ended", and refuses new ones. */
  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) if (!entry.settled) entry.controller.abort();
    this.entries.clear();
    for (const wake of this.waiting.splice(0)) { this.running++; wake(); }
  }
}

// ---------------------------------------------------------------- envelopes
/** The scope a viewer drill put a dataset in (decision D1); undefined at the spec's own scope. */
export type Drill = NonNullable<Dataset['drill']>;

export function pendingEnvelope(key: string, ref: SourceRef, meta: SourceMeta | undefined, drill?: Drill): Dataset {
  const source = formatRef(ref);
  return {$ds: key, kind: meta?.kind ?? 'rows', status: 'pending', source, note: `running ${source}`, ...(meta?.wt ? {wt: true} : {}), ...(drill ? {drill} : {})};
}

/**
 * True when a ready result has nothing to draw: the same rule as the viewer kit's empty state (no value, an empty
 * list, an empty object), plus a graph without nodes and a tree without children.
 */
export function isEmptyData(kind: SourceMeta['kind'], data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data !== 'object') return false;
  if (Object.keys(data).length === 0) return true;
  if (kind === 'graph') return !Array.isArray((data as {nodes?: unknown}).nodes) || (data as {nodes: unknown[]}).nodes.length === 0;
  if (kind === 'tree') return !Array.isArray((data as {children?: unknown}).children) || (data as {children: unknown[]}).children.length === 0;
  return false;
}

/** A summary as one line of at most 300 characters, or undefined when it says nothing. */
const summaryLine = (summary: unknown): string | undefined => {
  if (typeof summary !== 'string') return undefined;
  const line = summary.replace(/\s+/g, ' ').trim();
  return line === '' ? undefined : line.length > 300 ? `${line.slice(0, 299)}…` : line;
};

/** The parts of a rows summary written for the model: the count ('0 rows') and the field list ('fields a b'). */
const MODEL_PART = /^(?:\d[\d,]*(?:\/\d[\d,]*)? (?:rows?|items?)|fields\b.*)$/;

/**
 * Why an empty result is empty, for the person and the render report: the summary without its count and field list
 * ('0 rows; fields a b shared degree; no pair shares 3 commits' -> 'no pair shares 3 commits'). The whole line when
 * nothing else is left.
 */
const emptyReason = (summary: unknown): string | undefined => {
  const line = summaryLine(summary);
  if (line === undefined) return undefined;
  const said = line.split('; ').filter(part => !MODEL_PART.test(part.trim()));
  return said.length > 0 ? said.join('; ') : line;
};

export function envelopeOf(key: string, ref: SourceRef, outcome: Outcome, drill?: Drill): Dataset {
  const source = formatRef(ref);
  if (!outcome.ok) {
    return {$ds: key, kind: outcome.meta?.kind ?? 'rows', status: 'error', source, error: outcome.error, ...(outcome.meta?.wt ? {wt: true} : {}), ...(drill ? {drill} : {})};
  }
  const {meta, result} = outcome;
  // An empty result says why in its summary ('wt: 0 files; no changes'); the viewer shows `note` as the empty
  // state's message and reports it (decision D3), instead of a generic 'no data from diff.files'.
  const note = isEmptyData(meta.kind, result.data) ? emptyReason(result.summary) : undefined;
  const fields = result.fields ?? meta.fields;
  const roles = result.roles ?? meta.roles;
  // Sources cut their own output; this is the backstop that keeps an oversized row set out of the data model.
  const over = meta.kind === 'rows' && Array.isArray(result.data) && result.data.length > meta.budget ? result.data.length : 0;
  const truncated = over > 0 ? {total: Math.max(over, result.total ?? 0), returned: meta.budget, strategy: 'topN' as const} : result.truncated;
  const warnings = boundWarnings([...(result.warnings ?? []), ...(over > 0 ? [`${meta.name}: showing the first ${meta.budget} of ${over} rows`] : [])]);
  return {
    $ds: key,
    kind: meta.kind,
    status: 'ready',
    source,
    ...(note !== undefined ? {note} : {}),
    data: over > 0 ? (result.data as unknown[]).slice(0, meta.budget) : result.data,
    ...(fields ? {fields} : {}),
    ...(roles ? {roles} : {}),
    ...(result.total !== undefined || over > 0 ? {total: Math.max(over, result.total ?? 0)} : {}),
    ...(truncated ? {truncated} : {}),
    ...(meta.kind === 'rows' && meta.pageable && result.allRows ? {pageable: true} : {}),
    ...(meta.wt ? {wt: true} : {}),
    ...(drill ? {drill} : {}),
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
