// Test doubles for the server core: two fake sources in an injectable registry, stub services, and helpers to build
// a Session on a recording host. Nothing here loads analyzer, git or code-service code.
import {lstat, mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SOURCE_BY_NAME, type A2uiMessage, type FileSlice, type Rows, type SourceMeta} from '@glimpse/catalog';
import {SourceError, type FileEntry, type GitInfo, type RepoIndex, type Source} from '../../src/contracts.ts';
import {Session, type HostHandle, type ServerDeps, type SessionOptions, type TabState} from '../../src/session/session.ts';
import {createRegistry} from '../../src/sources/registry.ts';

export const TOKEN = 'test-token-0123456789';

export const FAKE_ROWS: Rows = Array.from({length: 25}, (_, i) => ({path: `src/file${String(i).padStart(2, '0')}.ts`, n: 25 - i, owner: i % 2 ? 'Mira' : 'Jon'}));

const rowsMeta: SourceMeta = {
  name: 'fake.rows', kind: 'rows', doc: 'Twenty-five test rows.', shape: 'Rows', budget: 10, pageable: true, target: 'path',
  args: {top: 'row limit'}, fields: [{key: 'path', kind: 'path'}, {key: 'n', kind: 'num'}, {key: 'owner', kind: 'author'}], roles: {label: 'path', value: 'n'},
};

export interface FakeSources {
  rows: Source;
  slow: Source;
  /** How often each ref ran, by canonical text. */
  runs: Map<string, number>;
  /** Lets every pending fake.slow run finish. */
  release(): void;
}

/**
 * fake.rows answers at once (target `boom` fails with E_TARGET); fake.slow answers after `slowMs`, or when
 * release() is called if `slowMs` is Infinity.
 */
export function fakeSources(slowMs = Infinity): FakeSources {
  const runs = new Map<string, number>();
  const count = (text: string) => runs.set(text, (runs.get(text) ?? 0) + 1);
  const waiting = new Set<() => void>();
  const rows: Source = {
    meta: rowsMeta,
    run: async (_ctx, ref) => {
      count(['fake.rows', ref.target ?? '', JSON.stringify(ref.args)].join(' '));
      if (ref.target === 'boom') throw new SourceError('E_TARGET', 'no such path: boom');
      const all = ref.target ? FAKE_ROWS.filter(row => String(row.path).startsWith(ref.target!)) : FAKE_ROWS;
      const top = Math.min(rowsMeta.budget, Number(ref.args.top) || rowsMeta.budget);
      const data = all.slice(0, top);
      return {
        data, total: all.length, allRows: all,
        ...(data.length < all.length ? {truncated: {total: all.length, returned: data.length, strategy: 'topN' as const}} : {}),
        summary: `${data.length}/${all.length} rows; fields path n owner; top ${data[0]?.path ?? '-'} ${data[0]?.n ?? 0}`,
      };
    },
  };
  const slow: Source = {
    meta: {name: 'fake.slow', kind: 'rows', doc: 'Rows that take a while.', shape: 'Rows', budget: 10, wt: true},
    run: (_ctx, ref, signal) => {
      count(['fake.slow', ref.target ?? ''].join(' '));
      return new Promise((resolve, reject) => {
        const done = () => {
          waiting.delete(done);
          resolve({data: [{k: 'slow', v: 1}], summary: '1 row; fields k v'});
        };
        waiting.add(done);
        if (Number.isFinite(slowMs)) setTimeout(done, slowMs);
        signal.addEventListener('abort', () => reject(new SourceError('E_INTERNAL', 'aborted')), {once: true});
      });
    },
  };
  return {rows, slow, runs, release: () => { for (const done of [...waiting]) done(); }};
}

/** A catalog source answered by a fixed result (shadows the not-implemented stand-in). */
export function fixedSource(name: string, data: unknown, summary = 'fixed'): Source {
  return {meta: SOURCE_BY_NAME.get(name)!, run: async () => ({data, summary})};
}

/** A file of a fake inventory: a path (ten lines of TypeScript), or a path with its line count. */
export type FakeFile = string | {path: string; loc: number};

const entry = (file: FakeFile): FileEntry => {
  const {path, loc} = typeof file === 'string' ? {path: file, loc: 10} : file;
  return {path, lang: 'TypeScript', loc, sloc: Math.round(loc * 0.8), bytes: loc * 10, binary: false, tracked: true, isTest: /\.(test|spec)\./.test(path), generated: false};
};

/**
 * The inventory of a fake repository. 'disk' (the default) answers `has` from the files really under the root, the
 * way the production index does for a path its scan has not seen: a regular file, not under .git. A list of paths is
 * a fixed inventory without `has`, which exercises the session's own lookup.
 */
const stubIndex = (root: string, calls: {invalidated: number}, inventory: 'disk' | FakeFile[]): RepoIndex => ({
  files: () => Promise.resolve(inventory === 'disk' ? [] : inventory.map(entry)),
  facts: () => Promise.resolve(new Map()), edges: () => Promise.resolve([]), moduleOf: () => Promise.resolve(''),
  ...(inventory === 'disk'
    ? {has: async (path: string) => !path.split('/').includes('.git') && !path.split('/').some(part => part.startsWith('.env')) && (await lstat(join(root, path)).then(info => info.isFile(), () => false))}
    : {}),
  invalidate: () => { calls.invalidated++; },
});

export interface FakeDeps extends ServerDeps {
  sources: FakeSources;
  calls: {invalidated: number; files: string[]; diffs: string[]; outlines: string[]; highlights: number; checks: number};
  /** What readGitInfo answers next; null means "not a repository". */
  git: {info: GitInfo | null};
  /** Fires the tree watcher, if it is running. */
  touchTree(): void;
  /** Makes the next look at the working tree (TreeWatcher.check) report a change, whether or not anybody watches. */
  moveTree(): void;
  watching(): boolean;
}

export interface FakeDepsOptions {
  slowMs?: number;
  extra?: Source[];
  git?: GitInfo | null;
  /** See stubIndex. Default 'disk'. */
  inventory?: 'disk' | FakeFile[];
  /** false: the watcher has no check(), so the session looks at the tree itself (session/freshness.ts). */
  check?: boolean;
}

export function fakeDeps(options: FakeDepsOptions = {}): FakeDeps {
  const sources = fakeSources(options.slowMs);
  const calls = {invalidated: 0, files: [] as string[], diffs: [] as string[], outlines: [] as string[], highlights: 0, checks: 0};
  const git = {info: options.git === undefined ? {branch: 'main', head: '4f2a91c0ffee4f2a91c0ffee4f2a91c0ffee4f2a', shallow: false} as GitInfo | null : options.git};
  let onChange: (() => void) | undefined;
  let moved = false;
  return {
    sources, calls, git,
    registry: createRegistry([sources.rows, sources.slow, ...(options.extra ?? [])]),
    createRepoIndex: root => stubIndex(root, calls, options.inventory ?? 'disk'),
    createCodeService: ctx => ({
      file: async q => {
        calls.files.push(q.path);
        const slice: FileSlice = {path: q.path, lang: 'typescript', total: 1, start: 1, end: 1, lines: [[['const a = 1', 0]]], size: 11, rev: ctx.rev()};
        return slice;
      },
      highlight: async (code, lang) => {
        calls.highlights++;
        return {lang: lang ?? 'text', lines: code.split('\n').map(line => [[line, 0]])};
      },
      outline: async path => {
        calls.outlines.push(path);
        return {path, symbols: []};
      },
    }),
    createDiffService: ctx => ({
      diff: async q => {
        calls.diffs.push(q.range);
        if (q.range === 'unknown-ref') throw new SourceError('E_TARGET', 'unknown revision');
        return {range: q.range, files: [], totals: {files: 0, add: 0, del: 0}, rev: ctx.rev()};
      },
    }),
    createTreeWatcher: () => ({
      start: fire => { onChange = fire; },
      stop: () => { onChange = undefined; },
      ...(options.check === false ? {} : {
        check: async () => {
          calls.checks++;
          const was = moved;
          moved = false;
          return was;
        },
      }),
    }),
    readGitInfo: () => Promise.resolve(git.info),
    touchTree: () => onChange?.(),
    moveTree: () => { moved = true; },
    watching: () => onChange !== undefined,
  };
}

export interface Frame { surfaceId: string; messages: A2uiMessage[]; focus?: string }

export interface RecordingHost extends HostHandle {
  frames: Frame[];
  connected: number;
  opened: number;
}

/** A host that binds nothing: it records the frames the session publishes. */
export function recordingHost(tab: TabState = 'none'): RecordingHost {
  const host: RecordingHost = {
    frames: [], connected: 0, opened: 0,
    origin: 'http://127.0.0.1:4517', token: TOKEN,
    tabs: () => host.connected,
    publish: (surfaceId, messages, focus) => void host.frames.push({surfaceId, messages: structuredClone(messages), ...(focus !== undefined ? {focus} : {})}),
    ensureTab: () => { host.opened++; return host.connected > 0 ? 'live' : tab; },
    close: () => {},
  };
  return host;
}

export async function tempRoot(): Promise<{root: string; cleanup(): Promise<void>}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-core-')));
  return {root, cleanup: () => rm(root, {recursive: true, force: true})};
}

export interface TestSession { session: Session; deps: FakeDeps; host: RecordingHost; launched: Array<[string, string[]]>; hostStarts: number }

/** A Session on fakes. `startHost` replaces the recording host (for tests of the real HTTP host). */
export function testSession(root: string, options: Partial<SessionOptions> & {deps?: FakeDeps; tab?: TabState} = {}): TestSession {
  const deps = options.deps ?? fakeDeps();
  const host = recordingHost(options.tab);
  const launched: Array<[string, string[]]> = [];
  const out: TestSession = {deps, host, launched, hostStarts: 0, session: undefined as unknown as Session};
  out.session = new Session({
    root, version: '0.0.0-test', env: {GLIMPSE_NO_OPEN: '1'}, log: () => {},
    loadDeps: async () => deps,
    startHost: async () => { out.hostStarts++; return host; },
    launcher: (command, args) => void launched.push([command, args]),
    ...options,
  });
  return out;
}

/** The names of the message kinds in a frame, e.g. ['deleteSurface', 'createSurface']. */
export const kinds = (frame: Frame): string[] => frame.messages.map(message => Object.keys(message).find(key => key !== 'version')!);

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Polls until `check` passes (returns its value) or the time is up. */
export async function until<T>(check: () => T | undefined | false, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(5);
  }
}
