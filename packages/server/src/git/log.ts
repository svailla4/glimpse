// packages/server/src/git/log.ts
// The shared history: one `git log --name-status -z` stream, parsed once per HEAD and reused by every source that
// counts commits: git.* and, through sources/files/history.ts, files.* and repo.kpis. There is no second parser, so
// "a commit", "an author" and "a commit of this file" mean the same thing in every number the product shows.
// Paths are followed through renames, so a file's history is counted under the name it has today.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {SourceError, type RepoContext} from '../contracts.ts';
import {resolveCommit} from './range.ts';

/** Commits read per stream. Longer histories are reported as truncated. */
export const LOG_LIMIT = 5_000;
/** The warning every result carries whose per-file numbers come from a history longer than LOG_LIMIT. */
export const LIMIT_WARNING = `history limited to the latest ${LOG_LIMIT.toLocaleString('en-US')} commits`;
export const SHALLOW_WARNING = 'shallow clone: history is incomplete';
/** Commits read without their files (author and time only) when the history is longer than LOG_LIMIT. */
export const HEADER_LIMIT = 200_000;
const FORMAT = '--format=%x01%H%x1f%aN%x1f%at%x1f%s';
const LOG_ARGS = ['log', '--no-merges', '-M', '--name-status', '-z', '--relative', '--no-show-signature', FORMAT, '-n', String(LOG_LIMIT)];
const ROOTS_CACHED = 4;
const SCOPES_CACHED = 16;

export interface LogCommit {
  sha: string;
  /** Author name after .mailmap. Addresses are never read. */
  author: string;
  /** Author date, seconds since the epoch. */
  time: number;
  subject: string;
  /** Paths the commit touches, under their current names, without duplicates. */
  files: string[];
}

export interface GitLog {
  /** Newest first. */
  commits: LogCommit[];
  /** True when the stream stopped at LOG_LIMIT. */
  truncated: boolean;
  /** Paths that exist at HEAD. */
  alive: ReadonlySet<string>;
  /** Renames the stream saw: an earlier name to the name the file has at HEAD (or last had). */
  renames?: ReadonlyMap<string, string>;
}

/** Who and when, without the files: what counting commits and contributors needs. */
export interface LogHeader {
  author: string;
  time: number;
}

export interface LogHeaders {
  /** Every commit of HEAD (merges excluded), newest first. */
  headers: readonly LogHeader[];
  /** True when even this stream stopped (at HEADER_LIMIT commits). */
  truncated: boolean;
}

export interface LogScope {
  /** Keep commits that touch this file or directory ('' or undefined: all). */
  path?: string;
  /** Keep commits authored at or after this time (seconds since the epoch). */
  since?: number;
}

const EMPTY: GitLog = {commits: [], truncated: false, alive: new Set()};

export function inScope(path: string, scope: string | undefined): boolean {
  return !scope || path === scope || path.startsWith(`${scope}/`);
}

/**
 * Parses the stream LOG_ARGS produce. Records start with \x01; the header and every name-status field end with NUL.
 * `renames`, when given, receives every earlier name the stream saw, mapped to the file's current name.
 */
export function parseLog(raw: string, renames?: Map<string, string>): LogCommit[] {
  const commits: LogCommit[] = [];
  // The stream is newest first, so a rename seen here names the file's future: older entries of `from` belong to `to`.
  const renamed = new Map<string, string>();
  const current = (path: string): string => {
    let name = path;
    for (let hops = 0; hops < 32; hops++) {
      const next = renamed.get(name);
      if (next === undefined || next === name) break;
      name = next;
    }
    return name;
  };

  for (const record of raw.split('\x01')) {
    if (record === '') continue;
    const fields = record.split('\0');
    const [sha, author, at, ...subject] = fields[0]!.replace(/\n+$/, '').split('\x1f');
    if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) continue;
    const files = new Set<string>();
    for (let i = 1; i < fields.length; i++) {
      const status = fields[i]!.replace(/^\n+/, '');
      if (status === '') continue;
      const first = fields[++i];
      if (!first) break;
      if (status.startsWith('R') || status.startsWith('C')) {
        const to = fields[++i];
        if (!to) break;
        const name = current(to);
        if (status.startsWith('R') && first !== name) renamed.set(first, name);
        files.add(name);
      } else {
        files.add(current(first));
      }
    }
    commits.push({sha, author: author ?? '', time: Number(at) || 0, subject: subject.join('\x1f'), files: [...files]});
  }
  if (renames) for (const old of renamed.keys()) renames.set(old, current(old));
  return commits;
}

/** Drops the oldest entries of a Map that serves as a small cache. */
function trim(map: Map<string, unknown>, max: number): void {
  for (const key of map.keys()) {
    if (map.size <= max) break;
    map.delete(key);
  }
}

const subtrees = new Map<string, Promise<string[]>>();

/**
 * With a pathspec git simplifies history: it follows one parent of a merge and drops commits whose changes did not
 * survive to HEAD, which loses real commits and their authors. Every pathspec here is therefore paired with this
 * flag, so a commit counts whenever it touched the path. (Without a pathspec there is nothing to simplify.)
 */
export const FULL_HISTORY = '--full-history';

/**
 * Pathspec that narrows history to the project when its root is a directory inside a larger repository
 * (['--', '.']); empty when the root is the top of the repository. Paths are then relative to the root everywhere.
 * A caller that passes it to `git log` or `git rev-list` also passes FULL_HISTORY when it is not empty.
 */
export function subtree(ctx: RepoContext): Promise<string[]> {
  let args = subtrees.get(ctx.root);
  if (!args) {
    const created = ctx.runGit(['rev-parse', '--show-prefix']).then(out => (out.toString('utf8').trim() === '' ? [] : ['--', '.']));
    args = created;
    created.catch(() => { if (subtrees.get(ctx.root) === created) subtrees.delete(ctx.root); });
    subtrees.set(ctx.root, args);
    trim(subtrees, ROOTS_CACHED);
  }
  return args;
}

interface CacheEntry {
  head: string;
  base: Promise<GitLog>;
  scoped: Map<string, Promise<GitLog>>;
  /** Read only for histories longer than LOG_LIMIT. */
  headers?: Promise<LogHeaders>;
}
const cache = new Map<string, CacheEntry>();

/**
 * Commits a shallow clone was cut at. Git shows each as if it had added every file of the repository; counting that
 * would make its author the owner of everything, so their file lists are dropped (the commits themselves stay).
 */
async function shallowBoundary(ctx: RepoContext): Promise<ReadonlySet<string>> {
  if (!ctx.git?.shallow) return new Set();
  try {
    const path = (await ctx.runGit(['rev-parse', '--git-path', 'shallow'])).toString('utf8').trim();
    return new Set((await readFile(resolve(ctx.root, path), 'utf8')).split('\n').map(line => line.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function readCommits(ctx: RepoContext, args: string[], signal?: AbortSignal, renames?: Map<string, string>): Promise<LogCommit[]> {
  const [raw, boundary] = await Promise.all([ctx.runGit(args, {signal}), shallowBoundary(ctx)]);
  const commits = parseLog(raw.toString('utf8'), renames);
  for (const commit of commits) if (boundary.has(commit.sha)) commit.files = [];
  return commits;
}

/** Earlier names given to a path scope at most: past this many, the scope is read under its current names only. */
const MAX_EARLIER_NAMES = 500;

/**
 * The names a path scope had before: the renames the shared parse saw into the scope, and for one file every name
 * `git log --follow` finds, however old. A pathspec matches names, not files, so a scope read without them stops at
 * the last rename and drops every commit before it (V067).
 */
async function earlierNames(ctx: RepoContext, head: string, path: string, base: GitLog): Promise<string[]> {
  const names = new Set<string>();
  for (const [old, now] of base.renames ?? []) if (inScope(now, path) && !inScope(old, path)) names.add(old);
  if (base.alive.has(path)) {
    try {
      const raw = await ctx.runGit(['--literal-pathspecs', 'log', '--no-merges', '-M', '--follow', '--name-only', '-z', '--relative', '--no-show-signature', '--format=', head, '--', path]);
      for (const name of raw.toString('utf8').split('\0')) {
        const clean = name.trim();
        if (clean && clean !== path) names.add(clean);
      }
    } catch {
      // the renames of the shared parse still apply
    }
  }
  return [...names].sort().slice(0, MAX_EARLIER_NAMES);
}

async function readLog(ctx: RepoContext, head: string, extra: string[], pathspecs: readonly string[]): Promise<GitLog> {
  // No caller's signal here: the run is shared by every source that asks while it is in flight.
  const within = await subtree(ctx);
  const args = pathspecs.length > 0
    ? ['--literal-pathspecs', ...LOG_ARGS, FULL_HISTORY, '--full-diff', ...extra, head, '--', ...pathspecs]
    : [...LOG_ARGS, ...(within.length > 0 ? [FULL_HISTORY] : []), ...extra, head, ...within];
  const renames = new Map<string, string>();
  const [commits, tree] = await Promise.all([readCommits(ctx, args, undefined, renames), ctx.runGit(['ls-tree', '-r', '-z', head])]);
  return {commits, truncated: commits.length >= LOG_LIMIT, alive: aliveFiles(tree.toString('utf8')), renames};
}

/**
 * Files of a `git ls-tree -r -z` listing: regular and executable blobs. A symbolic link (mode 120000) and a submodule
 * (160000) are paths, not files: the inventory lists neither, so no per-file row counts them (V031).
 */
export function aliveFiles(listing: string): Set<string> {
  const alive = new Set<string>();
  for (const record of listing.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1 || record.startsWith('120000 ') || record.startsWith('160000 ')) continue;
    alive.add(record.slice(tab + 1));
  }
  return alive;
}

function entryFor(ctx: RepoContext, head: string): CacheEntry {
  const cached = cache.get(ctx.root);
  if (cached && cached.head === head) return cached;
  const entry: CacheEntry = {head, base: readLog(ctx, head, [], []), scoped: new Map()};
  // A failed read must not be remembered, or every later call would fail the same way.
  entry.base.catch(() => { if (cache.get(ctx.root) === entry) cache.delete(ctx.root); });
  cache.delete(ctx.root);
  cache.set(ctx.root, entry);
  trim(cache, ROOTS_CACHED);
  return entry;
}

/**
 * The history of HEAD, narrowed to a scope. Matching commits keep all their files, so callers can relate files
 * inside the scope to files outside it. Served from the shared parse whenever that parse reaches far enough back;
 * a narrower stream is read (and remembered) only for histories longer than LOG_LIMIT.
 */
export async function getLog(ctx: RepoContext, scope: LogScope = {}, signal?: AbortSignal): Promise<GitLog> {
  if (!ctx.git) throw new SourceError('E_NO_GIT', 'not a git repository');
  const head = await resolveCommit(ctx, 'HEAD', signal);
  if (!head) return EMPTY;
  const entry = entryFor(ctx, head);
  const base = await entry.base;
  signal?.throwIfAborted();

  const path = scope.path || undefined;
  const since = scope.since;
  if (!path && since === undefined) return base;
  const oldest = base.commits.at(-1)?.time ?? 0;
  if (!base.truncated || (!path && since !== undefined && oldest <= since)) {
    const commits = base.commits.filter(c => (since === undefined || c.time >= since) && (!path || c.files.some(f => inScope(f, path))));
    return {commits, truncated: false, alive: base.alive};
  }

  const key = `${path ?? ''}\0${since ?? ''}`;
  let scoped = entry.scoped.get(key);
  if (!scoped) {
    const extra = since === undefined ? [] : [`--since=${new Date(since * 1000).toISOString()}`];
    // A pathspec matches a name, not a file: an earlier name may since have been given to another file, whose commits
    // the stream then holds too. After the parse has carried every commit over to the names its files have today,
    // only those that touch the scope belong to it, the same rule the shared parse applies above (V067).
    const created = path === undefined
      ? readLog(ctx, head, extra, [])
      : earlierNames(ctx, head, path, base).then(async names => {
        const log = await readLog(ctx, head, extra, [path, ...names]);
        return {...log, commits: log.commits.filter(c => c.files.some(f => inScope(f, path)))};
      });
    scoped = created;
    created.catch(() => { if (entry.scoped.get(key) === created) entry.scoped.delete(key); });
    entry.scoped.set(key, scoped);
    trim(entry.scoped, SCOPES_CACHED);
  }
  const log = await scoped;
  signal?.throwIfAborted();
  return log;
}

async function readHeaders(ctx: RepoContext, head: string): Promise<LogHeaders> {
  const within = await subtree(ctx);
  const raw = await ctx.runGit([
    'log', '--no-merges', '--no-show-signature', '--format=%at%x1f%aN', '-n', String(HEADER_LIMIT), ...(within.length > 0 ? [FULL_HISTORY] : []), head, ...within,
  ]);
  const headers: LogHeader[] = [];
  for (const line of raw.toString('utf8').split('\n')) {
    const cut = line.indexOf('\x1f');
    if (cut <= 0) continue;
    headers.push({time: Number(line.slice(0, cut)) || 0, author: line.slice(cut + 1)});
  }
  return {headers, truncated: headers.length >= HEADER_LIMIT};
}

/**
 * Author and time of every commit of HEAD. For a history the shared parse holds completely this is that parse; for
 * a longer one it is a second, cheap stream without file lists, so counts of commits and contributors stay exact
 * where the per-file numbers are limited to the latest LOG_LIMIT commits.
 */
export async function getHeaders(ctx: RepoContext, signal?: AbortSignal): Promise<LogHeaders> {
  if (!ctx.git) throw new SourceError('E_NO_GIT', 'not a git repository');
  const head = await resolveCommit(ctx, 'HEAD', signal);
  if (!head) return {headers: [], truncated: false};
  const entry = entryFor(ctx, head);
  const base = await entry.base;
  signal?.throwIfAborted();
  if (!base.truncated) return {headers: base.commits, truncated: false};
  if (!entry.headers) {
    const created = readHeaders(ctx, head);
    entry.headers = created;
    created.catch(() => { if (entry.headers === created) entry.headers = undefined; });
  }
  const headers = await entry.headers;
  signal?.throwIfAborted();
  return headers;
}

/** The commits a resolved range adds (ResolvedRange.logArgs), newest first. Not cached: ranges are short. */
export async function rangeLog(ctx: RepoContext, logArgs: string[], signal?: AbortSignal): Promise<{commits: LogCommit[]; truncated: boolean}> {
  const within = await subtree(ctx);
  const commits = await readCommits(ctx, [...LOG_ARGS, ...(within.length > 0 ? [FULL_HISTORY] : []), ...logArgs, ...within], signal);
  return {commits, truncated: commits.length >= LOG_LIMIT};
}

/** Lines added and removed per commit, for a list of commit ids that came from git. */
export async function commitStats(ctx: RepoContext, shas: readonly string[], signal?: AbortSignal): Promise<Map<string, {add: number; del: number}>> {
  const stats = new Map<string, {add: number; del: number}>();
  if (shas.length === 0) return stats;
  const raw = await ctx.runGit(['log', '--no-walk=unsorted', '--no-show-signature', '-M', '--numstat', '--format=%x01%H', ...shas], {signal});
  for (const record of raw.toString('utf8').split('\x01')) {
    const lines = record.split('\n');
    const sha = lines[0]?.trim();
    if (!sha) continue;
    const sum = {add: 0, del: 0};
    for (const line of lines.slice(1)) {
      const counts = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (!counts) continue;
      sum.add += Number(counts[1]) || 0;
      sum.del += Number(counts[2]) || 0;
    }
    stats.set(sha, sum);
  }
  return stats;
}

/** Branch and tag names per commit id, for the ref chips of a commit list. */
export async function refNames(ctx: RepoContext, signal?: AbortSignal): Promise<Map<string, string[]>> {
  const names = new Map<string, string[]>();
  const raw = await ctx.runGit(['for-each-ref', '--format=%(objectname)%00%(*objectname)%00%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'], {signal});
  for (const line of raw.toString('utf8').split('\n')) {
    const [object, peeled, ref] = line.split('\0');
    if (!object || !ref) continue;
    const name = ref.replace(/^refs\/(heads|remotes|tags)\//, '');
    if (ref.startsWith('refs/remotes/') && name.endsWith('/HEAD')) continue;
    const sha = peeled || object;
    const list = names.get(sha);
    if (list) list.push(name);
    else names.set(sha, [name]);
  }
  return names;
}
