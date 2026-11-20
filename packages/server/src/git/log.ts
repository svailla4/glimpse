// packages/server/src/git/log.ts
// The shared history: one `git log --name-status -z` stream, parsed once per HEAD and reused by every git.* source.
// Paths are followed through renames, so a file's history is counted under the name it has today.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {SourceError, type RepoContext} from '../contracts.ts';
import {resolveCommit} from './range.ts';

/** Commits read per stream. Longer histories are reported as truncated. */
export const LOG_LIMIT = 5_000;
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

/** Parses the stream LOG_ARGS produce. Records start with \x01; the header and every name-status field end with NUL. */
export function parseLog(raw: string): LogCommit[] {
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
 * Pathspec that narrows history to the project when its root is a directory inside a larger repository
 * (['--', '.']); empty when the root is the top of the repository. Paths are then relative to the root everywhere.
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

async function readCommits(ctx: RepoContext, args: string[], signal?: AbortSignal): Promise<LogCommit[]> {
  const [raw, boundary] = await Promise.all([ctx.runGit(args, {signal}), shallowBoundary(ctx)]);
  const commits = parseLog(raw.toString('utf8'));
  for (const commit of commits) if (boundary.has(commit.sha)) commit.files = [];
  return commits;
}

async function readLog(ctx: RepoContext, head: string, extra: string[], pathspec: string | undefined): Promise<GitLog> {
  // No caller's signal here: the run is shared by every source that asks while it is in flight.
  const args = pathspec
    ? ['--literal-pathspecs', ...LOG_ARGS, '--full-diff', ...extra, head, '--', pathspec]
    : [...LOG_ARGS, ...extra, head, ...(await subtree(ctx))];
  const [commits, tree] = await Promise.all([readCommits(ctx, args), ctx.runGit(['ls-tree', '-r', '-z', '--name-only', head])]);
  return {commits, truncated: commits.length >= LOG_LIMIT, alive: new Set(tree.toString('utf8').split('\0').filter(Boolean))};
}

function entryFor(ctx: RepoContext, head: string): CacheEntry {
  const cached = cache.get(ctx.root);
  if (cached && cached.head === head) return cached;
  const entry: CacheEntry = {head, base: readLog(ctx, head, [], undefined), scoped: new Map()};
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
    const created = readLog(ctx, head, extra, path);
    scoped = created;
    created.catch(() => { if (entry.scoped.get(key) === created) entry.scoped.delete(key); });
    entry.scoped.set(key, scoped);
    trim(entry.scoped, SCOPES_CACHED);
  }
  const log = await scoped;
  signal?.throwIfAborted();
  return log;
}

/** The commits a resolved range adds (ResolvedRange.logArgs), newest first. Not cached: ranges are short. */
export async function rangeLog(ctx: RepoContext, logArgs: string[], signal?: AbortSignal): Promise<{commits: LogCommit[]; truncated: boolean}> {
  const commits = await readCommits(ctx, [...LOG_ARGS, ...logArgs, ...(await subtree(ctx))], signal);
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
