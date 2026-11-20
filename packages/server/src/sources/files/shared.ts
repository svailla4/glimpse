// Helpers shared by the files.*, repo.*, deps.* and code.* sources: argument rules, budgets and summaries.
import {SOURCE_BY_NAME, parseFileLoc, type Field, type Rows, type SourceMeta, type SourceRef, type Truncation} from '@glimpse/catalog';
import {SourceError, type RepoContext, type Source, type SourceResult} from '../../contracts.ts';

export interface SourceOptions {
  /** Clock for everything relative to today (ages, the 30-day window). Tests pin it. */
  now: () => number;
}

const MAX_SUMMARY = 160;

/** Builds a Source whose metadata is the catalog's own entry, so names and budgets cannot drift. */
export function define(name: string, run: (ctx: RepoContext, ref: SourceRef, signal: AbortSignal, meta: SourceMeta) => Promise<SourceResult>): Source {
  const meta = SOURCE_BY_NAME.get(name);
  if (!meta) throw new Error(`glimpse: ${name} is not a catalog source`);
  return {
    meta,
    // async, so an aborted signal is a rejection like every other failure, never a synchronous throw
    run: async (ctx, ref, signal) => {
      signal.throwIfAborted();
      return run(ctx, ref, signal, meta);
    },
  };
}

function positiveInt(ref: SourceRef, name: string, max: number): number | undefined {
  const raw = ref.args[name];
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d{0,8}$/.test(raw) || Number(raw) > max) throw new SourceError('E_ARGS', `${ref.source}: ${name} must be an integer from 1 to ${max}, got "${raw}"`);
  return Number(raw);
}

/** `top=N`: a positive integer, or undefined when absent. Anything else is E_ARGS. */
export function topOf(ref: SourceRef): number | undefined {
  return positiveInt(ref, 'top', 999_999_999);
}
/** `depth=N` (hops): 1 to 5. */
export function depthOf(ref: SourceRef): number | undefined {
  return positiveInt(ref, 'depth', 5);
}

/**
 * A positional path target as a repo-relative path: '' for the root, no leading './', no trailing '/', no '#L' suffix.
 * Absolute paths and paths that climb out of the repository are E_TARGET.
 */
export function scopeOf(ref: SourceRef): string {
  const raw = (ref.target ?? '').trim();
  if (raw === '' || raw === '.' || raw === './') return '';
  const path = parseFileLoc(raw.replace(/\\/g, '/')).path.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) {
    throw new SourceError('E_TARGET', `${ref.source}: "${raw}" is not a path inside the repository`);
  }
  return path;
}

export function inScope(path: string, scope: string): boolean {
  return scope === '' || path === scope || path.startsWith(scope + '/');
}

/**
 * 'in web' for a path scope, '' for the repository: every source that honours a path says so in its summary, so a
 * result that leaves it out is one that read the whole repository (and a test can tell).
 */
export function scopeNote(scope: string, before = ''): string {
  return scope === '' ? '' : `${before}in ${scope}`;
}

/** The lead of a summary: the scope first, then what the source says ('in web; top react 12 importers'). */
export function leadOf(scope: string, text: string): string {
  return [scopeNote(scope), text].filter(Boolean).join('; ');
}

/** 1234 -> '1.2k', 48200 -> '48.2k', 3400000 -> '3.4M'. */
export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  const [scaled, unit] = abs < 999_950 ? [value / 1000, 'k'] : [value / 1_000_000, 'M'];
  return `${scaled.toFixed(Math.abs(scaled) < 100 ? 1 : 0).replace(/\.0$/, '')}${unit}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Clamps a summary to the 160 characters the tool result allows, on a word boundary where possible. */
export function clampSummary(text: string): string {
  // One line of printable text: paths and names from the repository cannot bring line breaks or control characters.
  const flat = text.replace(/[\s\p{Cc}]+/gu, ' ').trim();
  if (flat.length <= MAX_SUMMARY) return flat;
  const cut = flat.slice(0, MAX_SUMMARY - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_SUMMARY - 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface RowsOptions {
  /** Field the rows are ordered by: named in the truncation note. */
  by?: string;
  /** What follows the field list in the summary, e.g. "top src/a.ts 41 commits". */
  lead?: string;
  /** Columns, when they differ from the catalog's defaults for the source. */
  fields?: Field[];
  warnings?: string[];
}

/**
 * Result of a rows source from the complete, ordered row set: cut to min(top, budget), with the truncation note, the
 * field list in the summary and, for pageable sources, the full set kept for paging.
 */
export function rowsResult(meta: SourceMeta, ref: SourceRef, all: Rows, options: RowsOptions = {}): SourceResult<Rows> {
  const top = topOf(ref);
  const cap = Math.min(top ?? meta.budget, meta.budget);
  const data = all.length > cap ? all.slice(0, cap) : all;
  const fields = options.fields ?? meta.fields;
  const fieldKeys = fields ? fields.map(field => field.key) : [...new Set(data.slice(0, 20).flatMap(row => Object.keys(row)))];
  const counted = data.length < all.length ? `${data.length}/${all.length} rows` : plural(all.length, 'row');
  const result: SourceResult<Rows> = {
    data,
    total: all.length,
    summary: clampSummary(`${counted}; fields ${fieldKeys.join(' ')}${options.lead ? `; ${options.lead}` : ''}`),
  };
  if (fields) result.fields = fields;
  if (meta.roles) result.roles = meta.roles;
  if (data.length < all.length) {
    const truncated: Truncation = {total: all.length, returned: data.length, strategy: 'topN'};
    if (options.by) truncated.by = options.by;
    result.truncated = truncated;
  }
  if (options.warnings && options.warnings.length > 0) result.warnings = options.warnings;
  // An explicit top is a cap on the whole dataset, paging included.
  if (meta.pageable) result.allRows = top === undefined ? all : all.slice(0, top);
  return result;
}

/**
 * Result of a rows source whose rows are small display items (StatItem, ChipItem) rather than records with columns:
 * the same cut and truncation note as rowsResult, with `shape` naming the keys in place of a field list.
 */
export function itemsResult<T>(meta: SourceMeta, ref: SourceRef, all: T[], shape: string, lead: (items: T[]) => string, warnings: string[] = []): SourceResult<T[]> {
  const cap = Math.min(topOf(ref) ?? meta.budget, meta.budget);
  const data = all.length > cap ? all.slice(0, cap) : all;
  const counted = data.length < all.length ? `${data.length}/${all.length} rows` : plural(all.length, 'row');
  const text = lead(data);
  return {
    data,
    total: all.length,
    ...(data.length < all.length ? {truncated: {total: all.length, returned: data.length, strategy: 'topN' as const}} : {}),
    ...(warnings.length > 0 ? {warnings} : {}),
    summary: clampSummary(`${counted}; fields ${shape}${text ? `; ${text}` : ''}`),
  };
}

export const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
