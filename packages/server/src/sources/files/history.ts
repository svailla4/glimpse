// Commit counts and last-touched times per file and directory, for the tree, the file list and the KPIs. This is a
// view of the one shared history (git/log.ts): it runs no git log of its own and parses nothing, so a commit count
// here is the count the git.* sources give for the same file, and the contributors are the rows of git.authors.
import type {RepoContext} from '../../contracts.ts';
import {getHeaders, getLog, HEADER_LIMIT, LIMIT_WARNING, SHALLOW_WARNING, type GitLog, type LogHeaders} from '../../git/log.ts';

export interface HistoryCounts {
  /** Commits of HEAD, merges excluded: the whole history, also when the per-file numbers are limited. */
  commits: number;
  /** Author timestamps (seconds), newest first. */
  times: number[];
  authors: Set<string>;
  /** Per current path, renames followed: commits touching it and the newest of them. Directories include ''. */
  fileCommits: Map<string, number>;
  fileLast: Map<string, number>;
  dirCommits: Map<string, number>;
  dirLast: Map<string, number>;
}

export interface History extends HistoryCounts {
  /** What a reader of the per-file numbers must know: a shallow clone, or a history longer than the parsed window. */
  warnings: string[];
  /** What a reader of the totals (commits, contributors) must know. */
  totalWarnings: string[];
  /** The totals are lower bounds: a shallow clone, or more commits than even the header stream reads. */
  partial: boolean;
}

/** One set of counts per parsed log, so the tree, the list and the KPIs of one HEAD share it. */
const COUNTS = new WeakMap<GitLog, WeakMap<LogHeaders['headers'], HistoryCounts>>();

/**
 * Counts from the shared history. `log` holds the commits with their files (the latest LOG_LIMIT of them);
 * `headers` holds author and time of every commit, so totals stay exact where the per-file numbers are limited.
 */
export function historyOf(log: Pick<GitLog, 'commits'>, headers: LogHeaders['headers']): HistoryCounts {
  const history: HistoryCounts = {commits: headers.length, times: [], authors: new Set(), fileCommits: new Map(), fileLast: new Map(), dirCommits: new Map(), dirLast: new Map()};
  for (const header of headers) {
    history.times.push(header.time);
    history.authors.add(header.author);
  }
  // Newest first, so the first commit seen for a path is its latest.
  for (const commit of log.commits) {
    const dirs = new Set<string>();
    for (const name of commit.files) {
      history.fileCommits.set(name, (history.fileCommits.get(name) ?? 0) + 1);
      if (!history.fileLast.has(name)) history.fileLast.set(name, commit.time);
      for (let cut = name.lastIndexOf('/'); cut !== -1; cut = name.lastIndexOf('/', cut - 1)) dirs.add(name.slice(0, cut));
    }
    for (const dir of dirs) {
      history.dirCommits.set(dir, (history.dirCommits.get(dir) ?? 0) + 1);
      if (!history.dirLast.has(dir)) history.dirLast.set(dir, commit.time);
    }
  }
  // The root is touched by every commit, including the ones older than the parsed window and the empty ones.
  history.dirCommits.set('', history.commits);
  const newest = headers[0]?.time;
  if (newest !== undefined) history.dirLast.set('', newest);
  return history;
}

/** What repo.kpis counts of history: commit times (seconds, newest first), authors, and whether they are lower bounds. */
export interface Totals {
  times: number[];
  authors: ReadonlySet<string>;
  partial: boolean;
  warnings: string[];
}

/**
 * The totals of the commits that touch a path: the commits git.log and git.authors list for the same path, read from
 * the same shared history (renames followed). `dir` is the path git reads, `has` what lies in the scope: they differ
 * for a module id of a graph ('src/*', the files of src/ outside its sub-modules), whose commits are those of its
 * directory that touch one of its files. Called once readHistory has found a history to read.
 */
export async function scopedTotals(ctx: RepoContext, scope: {dir: string; has(path: string): boolean}, signal: AbortSignal): Promise<Totals> {
  const log = await getLog(ctx, {path: scope.dir}, signal);
  signal.throwIfAborted();
  const shallow = ctx.git?.shallow === true;
  const commits = log.commits.filter(commit => commit.files.some(file => scope.has(file)));
  return {
    times: commits.map(commit => commit.time),
    authors: new Set(commits.map(commit => commit.author)),
    partial: shallow || log.truncated,
    warnings: [...(shallow ? [SHALLOW_WARNING] : []), ...(log.truncated ? [LIMIT_WARNING] : [])],
  };
}

/** History of the repository, or undefined when there is none to read (not a git repository, or no commits yet). */
export async function readHistory(ctx: RepoContext, signal: AbortSignal): Promise<History | undefined> {
  if (!ctx.git) return undefined;
  try {
    const [log, all] = await Promise.all([getLog(ctx, {}, signal), getHeaders(ctx, signal)]);
    signal.throwIfAborted();
    if (all.headers.length === 0) return undefined;
    let perHeaders = COUNTS.get(log);
    if (!perHeaders) {
      perHeaders = new WeakMap();
      COUNTS.set(log, perHeaders);
    }
    let counts = perHeaders.get(all.headers);
    if (!counts) {
      counts = historyOf(log, all.headers);
      perHeaders.set(all.headers, counts);
    }
    const shallow = ctx.git.shallow ? [SHALLOW_WARNING] : [];
    return {
      ...counts,
      warnings: [...shallow, ...(log.truncated ? [LIMIT_WARNING] : [])],
      totalWarnings: [...shallow, ...(all.truncated ? [`history limited to the latest ${HEADER_LIMIT.toLocaleString('en-US')} commits`] : [])],
      partial: ctx.git.shallow || all.truncated,
    };
  } catch (error) {
    signal.throwIfAborted();
    ctx.log(`glimpse: git log failed, history metrics omitted (${error instanceof Error ? (error.message.split('\n')[0] ?? '').slice(0, 120) : 'unknown error'})`);
    return undefined;
  }
}
