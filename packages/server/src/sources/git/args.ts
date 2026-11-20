// packages/server/src/sources/git/args.ts
// What the git.* and diff.* sources share: reading `top=`, `since=` and a path target out of a ref, cutting rows to
// a budget, and writing the one-line summary the model sees.
import type {Rows, SourceMeta, SourceRef} from '@glimpse/catalog';
import {repoPath} from '../../code/file.ts';
import {SourceError, type GitInfo, type RepoContext, type SourceResult} from '../../contracts.ts';

export {SHALLOW_WARNING} from '../../git/log.ts';
const SUMMARY_MAX = 160;
const DAY = 86_400;
const UNIT_DAYS: Readonly<Record<string, number>> = {d: 1, w: 7, m: 30, y: 365};

const quoted = (value: string): string => JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);

export function requireGit(ctx: RepoContext): GitInfo {
  if (!ctx.git) throw new SourceError('E_NO_GIT', 'not a git repository');
  return ctx.git;
}

/** `top=N`: a positive whole number, or undefined when the ref has none. */
export function topOf(ref: SourceRef): number | undefined {
  const raw = ref.args.top;
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d{0,8}$/.test(raw)) throw new SourceError('E_ARGS', `top must be a positive whole number, got ${quoted(raw)}`);
  return Number(raw);
}

export interface Since {
  /** Start of the window, seconds since the epoch, aligned to midnight UTC so equal refs share cached history. */
  cutoff: number;
  /** As written: '90d'. */
  label: string;
}

/** `since=90d|12w|6m|2y` (a month is 30 days, a year 365), or the default window of the source, or undefined. */
export function sinceOf(ref: SourceRef, nowMs: number, defaultDays?: number): Since | undefined {
  const raw = ref.args.since;
  let days = defaultDays;
  if (raw !== undefined) {
    const match = /^([1-9]\d{0,4})([dwmy])$/.exec(raw);
    if (!match) throw new SourceError('E_ARGS', `since must look like 90d, 12w, 6m or 2y, got ${quoted(raw)}`);
    days = Number(match[1]) * UNIT_DAYS[match[2]!]!;
  }
  if (days === undefined) return undefined;
  const today = Math.floor(nowMs / 1000 / DAY) * DAY;
  return {cutoff: today - days * DAY, label: raw ?? `${days}d`};
}

/** A path target: '' for the whole repository. Throws E_TARGET for anything outside it. */
export function pathOf(target: string | undefined): string {
  const path = repoPath(target);
  if (path === null) throw new SourceError('E_TARGET', `path ${quoted(target ?? '')} is outside the repository`);
  return path;
}

/** 'YYYY-MM-DD' (UTC) of a time in seconds. */
export const dayOf = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);
/** ISO 8601 without milliseconds. */
export const isoOf = (seconds: number): string => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
export const round = (value: number, digits: number): number => Number(value.toFixed(digits));

export const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function summarize(text: string): string {
  // One line of printable text: subjects, names and paths from the repository cannot bring line breaks or control characters.
  const line = text.replace(/[\s\p{Cc}]+/gu, ' ').trim();
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

const fieldList = (meta: SourceMeta): string => (meta.fields ? `; fields ${meta.fields.map(field => field.key).join(' ')}` : '');

export interface CutOptions<T> {
  /** `top=` of the ref. */
  top?: number;
  /** What the rows are ranked by, for the marginal note ('commits'). */
  by?: string;
  /** 'topN' keeps the first rows (ranked sources); 'window' and 'bucket' keep the last (time series). */
  strategy?: 'topN' | 'window' | 'bucket';
  /** Rows there were before the source itself dropped any (default: all that are passed in). */
  of?: number;
  /** Detail appended to the summary, given the rows that are returned. */
  detail?: (shown: T[]) => string;
  warnings?: string[];
}

/**
 * Applies `top=` and the source's budget to a complete, ordered row set and builds the result.
 * `total` is the size of the set the viewer can reach (the page-able rows); when `top=` or the budget cut rows,
 * `truncated.total` says how many there were. Pageable sources keep the reachable set in `allRows`.
 */
export function cutRows<T extends object>(meta: SourceMeta, all: T[], options: CutOptions<T> = {}): SourceResult<T[]> {
  const strategy = options.strategy ?? 'topN';
  const take = (rows: T[], count: number): T[] => (strategy === 'topN' ? rows.slice(0, count) : rows.slice(Math.max(0, rows.length - count)));
  const reachable = options.top === undefined ? all : take(all, options.top);
  const data = take(reachable, meta.budget);
  const before = Math.max(options.of ?? 0, all.length);
  const detail = options.detail?.(data);
  const count = data.length === before ? `${before} ${before === 1 ? 'row' : 'rows'}` : `${data.length}/${before} rows`;
  return {
    data,
    total: reachable.length,
    ...(data.length < before ? {truncated: {total: before, returned: data.length, strategy, ...(options.by ? {by: options.by} : {})}} : {}),
    ...(meta.fields ? {fields: meta.fields} : {}),
    ...(meta.roles ? {roles: meta.roles} : {}),
    ...(options.warnings && options.warnings.length > 0 ? {warnings: options.warnings} : {}),
    ...(meta.pageable ? {allRows: reachable as Rows} : {}),
    summary: summarize(`${count}${fieldList(meta)}${detail ? `; ${detail}` : ''}`),
  };
}
