// Commit counts and last-touched times per file and directory, for the tree, the file list and the KPIs. One git log
// stream (the same command the git sources use, so the counts agree), parsed once per HEAD.
import type {RepoContext, RepoIndex} from '../../contracts.ts';

export interface History {
  /** Commits parsed (at most MAX_COMMITS, newest first, merges excluded). */
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

const MAX_COMMITS = 5000;
const CACHE = new WeakMap<RepoIndex, {head: string; history: Promise<History>}>();

export function parseLog(raw: string): History {
  const history: History = {commits: 0, times: [], authors: new Set(), fileCommits: new Map(), fileLast: new Map(), dirCommits: new Map(), dirLast: new Map()};
  // Newest first: a rename maps the old name to the name the file has now.
  const renamed = new Map<string, string>();
  const currentName = (path: string) => {
    let name = path;
    for (let hops = 0; hops < 50 && renamed.has(name); hops++) name = renamed.get(name)!;
    return name;
  };
  for (const record of raw.split('\x01')) {
    if (!record) continue;
    const tokens = record.split('\0');
    const [stamp = '', author = ''] = tokens[0]!.split('\x1f');
    const time = Number(stamp);
    if (!Number.isFinite(time)) continue;
    history.commits++;
    history.times.push(time);
    history.authors.add(author);
    const dirs = new Set<string>(['']);
    for (let i = 1; i < tokens.length; i++) {
      const status = tokens[i]!.replace(/^\n/, '');
      if (!status) continue;
      let path = tokens[++i];
      if (status[0] === 'R' || status[0] === 'C') {
        const to = tokens[++i];
        if (status[0] === 'R' && path !== undefined && to !== undefined) renamed.set(path, currentName(to));
        path = to;
      }
      if (path === undefined) continue;
      const name = currentName(path);
      history.fileCommits.set(name, (history.fileCommits.get(name) ?? 0) + 1);
      if (!history.fileLast.has(name)) history.fileLast.set(name, time);
      for (let cut = name.lastIndexOf('/'); cut !== -1; cut = name.lastIndexOf('/', cut - 1)) dirs.add(name.slice(0, cut));
    }
    for (const dir of dirs) {
      history.dirCommits.set(dir, (history.dirCommits.get(dir) ?? 0) + 1);
      if (!history.dirLast.has(dir)) history.dirLast.set(dir, time);
    }
  }
  return history;
}

/** History of the repository, or undefined when there is none to read (not a git repository, or no commits yet). */
export async function readHistory(ctx: RepoContext, signal: AbortSignal): Promise<History | undefined> {
  if (!ctx.git) return undefined;
  let head: string;
  try {
    head = (await ctx.runGit(['rev-parse', 'HEAD'], {signal})).toString('utf8').trim();
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
  const cached = CACHE.get(ctx.index);
  let history = cached?.head === head ? cached.history : undefined;
  if (!history) {
    // The shared run must not die with the first caller, so it is not tied to that caller's signal. --relative and
    // the pathspec keep paths and commits to the project root when it is a subdirectory of the repository.
    const started = ctx.runGit(['log', '--no-merges', '-M', '--name-status', '--relative', '-z', '--format=%x01%at%x1f%aN', '-n', String(MAX_COMMITS), '--', '.'])
      .then(out => parseLog(out.toString('utf8')));
    CACHE.set(ctx.index, {head, history: started});
    started.catch(() => {
      if (CACHE.get(ctx.index)?.history === started) CACHE.delete(ctx.index);
    });
    history = started;
  }
  try {
    return await history;
  } catch (error) {
    ctx.log(`glimpse: git log failed, history metrics omitted (${error instanceof Error ? (error.message.split('\n')[0] ?? '').slice(0, 120) : 'unknown error'})`);
    return undefined;
  }
}
