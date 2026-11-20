// packages/server/src/sources/git/git.ts
// The git.* sources. All of them read the one shared history parse (git/log.ts); none runs its own `git log`,
// except git.log for a change range, which is short by nature.
import {SOURCE_BY_NAME, type ChurnRow, type CommitRow, type HotspotRow, type SourceMeta, type SourceRef} from '@glimpse/catalog';
import {locate, repoPath} from '../../code/file.ts';
import {SourceError, type RepoContext, type Source} from '../../contracts.ts';
import {commitStats, getLog, inScope, LOG_LIMIT, rangeLog, refNames, type GitLog, type LogCommit} from '../../git/log.ts';
import {RANGE_PATTERN, resolveCommit, resolveRange} from '../../git/range.ts';
import {cutRows, dayOf, isoOf, pathOf, plural, requireGit, round, SHALLOW_WARNING, sinceOf, topOf, type Since} from './args.ts';

export interface GitSourceOptions {
  /** Clock for the default time windows, milliseconds since the epoch. Default Date.now. */
  now?: () => number;
}

const DAY = 86_400;
const DEFAULT_WINDOW_DAYS = 365;
const LIMIT_WARNING = `history limited to the latest ${LOG_LIMIT.toLocaleString('en-US')} commits`;
/** Commit lists up to this length also carry lines added and removed per commit. */
const STATS_LIMIT = 300;
const SHA_CHARS = 10;
const MAX_REFS_PER_COMMIT = 8;
// git.coupling
const MAX_FILES_PER_COMMIT = 30;
const MIN_SHARED = 3;
// git.timeline
const MAX_BUCKETS = 200;
const MAX_SERIES = 8;
const OTHER = 'other';

const meta = (name: string): SourceMeta => {
  const found = SOURCE_BY_NAME.get(name);
  if (!found) throw new Error(`source ${name} is not in the catalog`);
  return found;
};

interface History {
  log: GitLog;
  /** Path scope; '' for the whole repository. */
  scope: string;
  since?: Since;
  top?: number;
  warnings: string[];
}

async function pathExists(ctx: RepoContext, path: string, log: GitLog): Promise<boolean> {
  if (log.alive.has(path)) return true;
  for (const alive of log.alive) if (inScope(alive, path)) return true;
  return (await locate(ctx.root, path)).ok;
}

interface HistoryOptions {
  /** Window when the ref has no `since=`. */
  defaultDays?: number;
  /** false: read the whole history and leave `since=` and the path scope to the caller (git.coupling). */
  narrow?: boolean;
}

async function history(ctx: RepoContext, ref: SourceRef, signal: AbortSignal, nowMs: number, options: HistoryOptions = {}): Promise<History> {
  const git = requireGit(ctx);
  const narrow = options.narrow !== false;
  const scope = pathOf(ref.target);
  const top = topOf(ref);
  const since = narrow ? sinceOf(ref, nowMs, options.defaultDays) : undefined;
  const log = await getLog(ctx, narrow ? {path: scope, since: since?.cutoff} : {}, signal);
  if (scope && !log.commits.some(commit => commit.files.some(file => inScope(file, scope))) && !(await pathExists(ctx, scope, log))) {
    throw new SourceError('E_TARGET', `no such path: ${scope}`);
  }
  const warnings = [...(git.shallow ? [SHALLOW_WARNING] : []), ...(log.truncated ? [LIMIT_WARNING] : [])];
  return {log, scope, top, warnings, ...(since ? {since} : {})};
}

const windowNote = (h: Pick<History, 'scope' | 'since'>): string =>
  [h.scope ? `in ${h.scope}` : '', h.since ? `since ${dayOf(h.since.cutoff)}` : ''].filter(Boolean).join(' ');

// ---------------------------------------------------------------- git.log

/** git.log takes a path or a change range: an existing path wins, then the range forms, then a ref name. */
async function logTargetKind(ctx: RepoContext, target: string, signal: AbortSignal): Promise<'path' | 'range'> {
  const path = repoPath(target);
  if (path === '') return 'path';
  if (path !== null && (await locate(ctx.root, path)).ok) return 'path';
  if (target === 'wt' || target === 'staged' || target.includes('..')) return 'range';
  if (RANGE_PATTERN.test(target) && !target.startsWith('-') && (await resolveCommit(ctx, target, signal))) return 'range';
  return 'path';
}

function gitLog(nowMs: () => number): Source {
  const source = meta('git.log');
  return {
    meta: source,
    async run(ctx, ref, signal) {
      const git = requireGit(ctx);
      const target = (ref.target ?? '').trim();
      let commits: LogCommit[];
      let where: string;
      let warnings: string[];
      const top = topOf(ref);

      if ((await logTargetKind(ctx, target, signal)) === 'range') {
        const since = sinceOf(ref, nowMs());
        const range = await resolveRange(ctx, target, signal);
        const listed = range.logArgs ? await rangeLog(ctx, range.logArgs, signal) : {commits: [], truncated: false};
        commits = since ? listed.commits.filter(commit => commit.time >= since.cutoff) : listed.commits;
        where = `in ${range.label}`;
        warnings = [...(git.shallow ? [SHALLOW_WARNING] : []), ...(listed.truncated ? [LIMIT_WARNING] : [])];
      } else {
        const h = await history(ctx, ref, signal, nowMs());
        commits = h.log.commits;
        where = windowNote(h);
        warnings = h.warnings;
      }

      // Commits without files need no line counts: empty commits, and the commits a shallow clone was cut at
      // (their diff would be the whole repository).
      const counted = commits.length <= STATS_LIMIT ? commits.filter(commit => commit.files.length > 0).map(commit => commit.sha) : undefined;
      const [refs, head, stats] = await Promise.all([refNames(ctx, signal), resolveCommit(ctx, 'HEAD', signal), counted ? commitStats(ctx, counted, signal) : undefined]);
      const rows = commits.map((commit): CommitRow => {
        const names = [...(commit.sha === head ? ['HEAD'] : []), ...(refs.get(commit.sha) ?? [])].slice(0, MAX_REFS_PER_COMMIT);
        const lines = stats ? (stats.get(commit.sha) ?? {add: 0, del: 0}) : undefined;
        return {
          sha: commit.sha.slice(0, SHA_CHARS),
          subject: commit.subject,
          author: commit.author,
          date: isoOf(commit.time),
          files: commit.files.length,
          ...(lines ? {add: lines.add, del: lines.del} : {}),
          ...(names.length > 0 ? {refs: names} : {}),
        };
      });
      return cutRows(source, rows, {
        top,
        by: 'date',
        warnings,
        detail: shown => [where, shown[0] ? `latest ${shown[0].sha.slice(0, 7)} ${shown[0].subject}` : 'no commits'].filter(Boolean).join('; '),
      });
    },
  };
}

// ---------------------------------------------------------------- git.activity, git.timeline

function gitActivity(nowMs: () => number): Source {
  const source = meta('git.activity');
  return {
    meta: source,
    async run(ctx, ref, signal) {
      const h = await history(ctx, ref, signal, nowMs(), {defaultDays: DEFAULT_WINDOW_DAYS});
      const perDay = new Map<string, number>();
      for (const commit of h.log.commits) {
        const day = dayOf(commit.time);
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
      }
      const rows = [...perDay].map(([date, commits]) => ({date, commits})).sort((a, b) => (a.date < b.date ? -1 : 1));
      return cutRows(source, rows, {
        top: h.top,
        strategy: 'window',
        by: 'date',
        warnings: h.warnings,
        detail: shown => {
          const busiest = shown.reduce<(typeof shown)[number] | undefined>((best, row) => (!best || row.commits > best.commits ? row : best), undefined);
          return [`${plural(h.log.commits.length, 'commit')} ${windowNote(h)}`.trim(), busiest ? `busiest ${busiest.date} ${busiest.commits}` : ''].filter(Boolean).join('; ');
        },
      });
    },
  };
}

/** Monday 00:00 UTC of the week a time falls in, seconds. 1970-01-01 was a Thursday. */
const weekOf = (seconds: number): number => {
  const day = Math.floor(seconds / DAY);
  return (day - ((day + 3) % 7)) * DAY;
};
const monthOf = (seconds: number): number => {
  const date = new Date(seconds * 1000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
};
const nextMonth = (seconds: number): number => {
  const date = new Date(seconds * 1000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000;
};

function gitTimeline(nowMs: () => number): Source {
  const source = meta('git.timeline');
  return {
    meta: source,
    async run(ctx, ref, signal) {
      const h = await history(ctx, ref, signal, nowMs(), {defaultDays: DEFAULT_WINDOW_DAYS});
      const commits = h.log.commits;

      // Module of every touched file. The index is asked once per path; if it cannot answer, the top-level directory stands in.
      let indexFailed = false;
      const modules = new Map<string, string>();
      const moduleOf = async (path: string): Promise<string> => {
        let name = modules.get(path);
        if (name === undefined) {
          if (!indexFailed) {
            try {
              name = await ctx.index.moduleOf(path);
            } catch (error) {
              indexFailed = true;
              ctx.log(`glimpse: git.timeline groups by top-level directory: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          name ||= path.includes('/') ? path.slice(0, path.indexOf('/')) : '(root)';
          modules.set(path, name);
        }
        return name;
      };
      const touched: Array<{time: number; modules: Set<string>}> = [];
      const totals = new Map<string, number>();
      for (const commit of commits) {
        const set = new Set<string>();
        for (const file of commit.files) if (inScope(file, h.scope)) set.add(await moduleOf(file));
        signal.throwIfAborted();
        for (const name of set) totals.set(name, (totals.get(name) ?? 0) + 1);
        touched.push({time: commit.time, modules: set});
      }

      const ranked = [...totals].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name]) => name);
      const kept = new Set(ranked.length > MAX_SERIES ? ranked.slice(0, MAX_SERIES - 1) : ranked);
      // A real module may be called "other"; the fold bucket then takes a name no directory has.
      const rest = kept.has(OTHER) ? `(${OTHER})` : OTHER;
      const series = ranked.length > MAX_SERIES ? [...kept, rest] : ranked;

      const times = touched.filter(entry => entry.modules.size > 0).map(entry => entry.time);
      const first = Math.min(...times);
      const last = Math.max(...times);
      const warnings = [...h.warnings];
      let bucketOf = weekOf;
      let next = (bucket: number): number => bucket + 7 * DAY;
      let unit = 'weeks';
      if (times.length > 0 && (weekOf(last) - weekOf(first)) / (7 * DAY) + 1 > MAX_BUCKETS) {
        bucketOf = monthOf;
        next = nextMonth;
        unit = 'months';
        warnings.push(`more than ${MAX_BUCKETS} weeks of history: buckets are months`);
      }
      const counts = new Map<number, Map<string, number>>();
      for (const entry of touched) {
        const names = new Set([...entry.modules].map(name => (kept.has(name) ? name : rest)));
        if (names.size === 0) continue;
        const bucket = bucketOf(entry.time);
        let row = counts.get(bucket);
        if (!row) {
          row = new Map();
          counts.set(bucket, row);
        }
        for (const name of names) row.set(name, (row.get(name) ?? 0) + 1);
      }
      const rows: Array<{week: string; module: string; commits: number}> = [];
      let buckets = 0;
      if (times.length > 0) {
        for (let bucket = bucketOf(first); bucket <= bucketOf(last); bucket = next(bucket)) {
          buckets++;
          for (const name of series) rows.push({week: dayOf(bucket), module: name, commits: counts.get(bucket)?.get(name) ?? 0});
        }
      }

      // Cut whole buckets, never half a bucket: every x position keeps all of its series.
      const perBucket = Math.max(1, series.length);
      const limit = Math.min(h.top ?? Number.POSITIVE_INFINITY, source.budget);
      const keepBuckets = rows.length > limit ? Math.max(1, Math.floor(limit / perBucket)) : buckets;
      return cutRows(source, rows.slice(Math.max(0, rows.length - keepBuckets * perBucket)), {
        top: h.top,
        strategy: 'bucket',
        of: rows.length,
        by: 'week',
        warnings,
        detail: () =>
          [`${Math.min(buckets, keepBuckets)} ${unit} x ${series.length} modules`, `${plural(commits.length, 'commit')} ${windowNote(h)}`.trim(), ranked[0] ? `busiest ${ranked[0]} ${totals.get(ranked[0])}` : '']
            .filter(Boolean).join('; '),
      });
    },
  };
}

// ---------------------------------------------------------------- per-file statistics

interface FileStat {
  path: string;
  commits: number;
  authors: Map<string, number>;
  first: number;
  last: number;
}

/** Commits, authors and dates per file that still exists at HEAD and lies inside the scope. */
function fileStats(log: GitLog, scope: string): FileStat[] {
  const stats = new Map<string, FileStat>();
  for (const commit of log.commits) {
    for (const path of commit.files) {
      if (!log.alive.has(path) || !inScope(path, scope)) continue;
      let stat = stats.get(path);
      if (!stat) {
        stat = {path, commits: 0, authors: new Map(), first: commit.time, last: commit.time};
        stats.set(path, stat);
      }
      stat.commits++;
      stat.authors.set(commit.author, (stat.authors.get(commit.author) ?? 0) + 1);
      stat.first = Math.min(stat.first, commit.time);
      stat.last = Math.max(stat.last, commit.time);
    }
  }
  return [...stats.values()];
}

/** The author with the most commits to a file (ties: by name) and their share in percent. */
function ownerOf(stat: FileStat): {owner: string; ownership: number} {
  const [owner, commits] = [...stat.authors].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0] ?? ['', 0];
  return {owner, ownership: stat.commits > 0 ? round((commits / stat.commits) * 100, 1) : 0};
}

const byCommitsThenPath = (a: {commits: number; path: string}, b: {commits: number; path: string}): number =>
  b.commits - a.commits || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function gitChurn(nowMs: () => number): Source {
  const source = meta('git.churn');
  return {
    meta: source,
    async run(ctx, ref, signal) {
      const h = await history(ctx, ref, signal, nowMs());
      const rows = fileStats(h.log, h.scope).sort(byCommitsThenPath).map((stat): ChurnRow => ({
        path: stat.path, commits: stat.commits, authors: stat.authors.size, ...ownerOf(stat), first: dayOf(stat.first), last: dayOf(stat.last),
      }));
      return cutRows(source, rows, {
        top: h.top,
        by: 'commits',
        warnings: h.warnings,
        detail: shown => [windowNote(h), shown[0] ? `top ${shown[0].path} ${plural(shown[0].commits, 'commit')}` : 'no commits'].filter(Boolean).join('; '),
      });
    },
  };
}

function gitHotspots(nowMs: () => number): Source {
  const source = meta('git.hotspots');
  return {
    meta: source,
    async run(ctx, ref, signal) {
      const h = await history(ctx, ref, signal, nowMs());
      const [files, facts] = await Promise.all([ctx.index.files(), ctx.index.facts()]);
      signal.throwIfAborted();
      const entries = new Map(files.map(file => [file.path, file]));
      // Only analysed source files rank: a lockfile or a changelog changes often and says nothing about risk.
      const candidates = fileStats(h.log, h.scope).flatMap(stat => {
        const entry = entries.get(stat.path);
        const fact = facts.get(stat.path);
        if (!entry || !fact || entry.generated || entry.binary) return [];
        return [{stat, complexity: Number.isFinite(fact.complexity) ? Math.max(0, fact.complexity) : 0, sloc: entry.sloc, isTest: entry.isTest}];
      });
      const maxCommits = Math.max(1, ...candidates.map(c => c.stat.commits));
      const maxComplexity = Math.max(1, ...candidates.map(c => c.complexity));
      const rows = candidates
        .map((c): HotspotRow => ({
          path: c.stat.path,
          commits: c.stat.commits,
          complexity: c.complexity,
          sloc: c.sloc,
          score: round((c.stat.commits / maxCommits) * (c.complexity / maxComplexity), 2),
          owner: ownerOf(c.stat).owner,
          isTest: c.isTest,
        }))
        .sort((a, b) => b.score - a.score || byCommitsThenPath(a, b));
      return cutRows(source, rows, {
        top: h.top,
        by: 'score',
        warnings: h.warnings,
        detail: shown => [windowNote(h), shown[0] ? `top ${shown[0].path} ${plural(shown[0].commits, 'commit')}` : 'no analysed files with commits'].filter(Boolean).join('; '),
      });
    },
  };
}

function gitAuthors(nowMs: () => number): Source {
  const source = meta('git.authors');
  return {
    meta: source,
    async run(ctx, ref, signal) {
      const h = await history(ctx, ref, signal, nowMs());
      const authors = new Map<string, {commits: number; files: Set<string>; last: number}>();
      for (const commit of h.log.commits) {
        let author = authors.get(commit.author);
        if (!author) {
          author = {commits: 0, files: new Set(), last: commit.time};
          authors.set(commit.author, author);
        }
        author.commits++;
        author.last = Math.max(author.last, commit.time);
        for (const file of commit.files) if (inScope(file, h.scope)) author.files.add(file);
      }
      const rows = [...authors]
        .map(([author, stat]) => ({author, commits: stat.commits, files: stat.files.size, last: dayOf(stat.last)}))
        .sort((a, b) => b.commits - a.commits || (a.author < b.author ? -1 : 1));
      return cutRows(source, rows, {
        top: h.top,
        by: 'commits',
        warnings: h.warnings,
        detail: shown => [windowNote(h), shown[0] ? `top ${shown[0].author} ${plural(shown[0].commits, 'commit')}` : 'no commits'].filter(Boolean).join('; '),
      });
    },
  };
}

function gitCoupling(nowMs: () => number): Source {
  const source = meta('git.coupling');
  return {
    meta: source,
    async run(ctx, ref, signal) {
      // The whole history, not the scoped one: how often a file outside the scope changes decides the degree of a pair.
      const h = await history(ctx, ref, signal, nowMs(), {narrow: false});
      const {log, scope} = h;
      const perFile = new Map<string, number>();
      const shared = new Map<string, number>();
      for (const commit of log.commits) {
        for (const file of commit.files) perFile.set(file, (perFile.get(file) ?? 0) + 1);
        if (commit.files.length < 2 || commit.files.length > MAX_FILES_PER_COMMIT) continue;
        const files = commit.files.filter(file => log.alive.has(file)).sort();
        for (let i = 0; i < files.length; i++) {
          for (let j = i + 1; j < files.length; j++) {
            if (scope && !inScope(files[i]!, scope) && !inScope(files[j]!, scope)) continue;
            const key = `${files[i]}\0${files[j]}`;
            shared.set(key, (shared.get(key) ?? 0) + 1);
          }
        }
      }
      signal.throwIfAborted();
      const rows = [...shared]
        .filter(([, count]) => count >= MIN_SHARED)
        .map(([key, count]) => {
          const [first, second] = key.split('\0') as [string, string];
          // With a scope, the file inside it leads the pair.
          const [a, b] = scope && !inScope(first, scope) ? [second, first] : [first, second];
          return {a, b, shared: count, degree: round((count / Math.min(perFile.get(first) ?? count, perFile.get(second) ?? count)) * 100, 1)};
        })
        .sort((x, y) => y.shared * y.degree - x.shared * x.degree || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1));
      return cutRows(source, rows, {
        top: h.top,
        by: 'shared',
        warnings: h.warnings,
        detail: shown => [windowNote(h), shown[0] ? `strongest ${shown[0].a} + ${shown[0].b} ${shown[0].shared} commits` : `no pair shares ${MIN_SHARED} commits`].filter(Boolean).join('; '),
      });
    },
  };
}

/** The seven git.* sources. `now` is injectable so tests of the default time windows do not depend on today's date. */
export function createGitSources(options: GitSourceOptions = {}): Source[] {
  const now = options.now ?? Date.now;
  return [gitLog(now), gitActivity(now), gitTimeline(now), gitChurn(now), gitHotspots(now), gitAuthors(now), gitCoupling(now)];
}
