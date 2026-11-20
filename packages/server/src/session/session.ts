// The session: all state of one server process (design 2.1, 2.6). It owns the stores, the repository context and
// the pipeline that turns a `show` call into pixels (design 2.2). Analyzer, git and code services arrive through
// ServerDeps, so everything here runs on fakes in tests; the HTTP host is started through `startHost` on first use.
import {createHash} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {
  COMPONENT_BY_NAME, formatFileLoc, formatRef, parseFileLoc, PROTOCOL_VERSION, SOURCE_BY_NAME,
  type A2uiMessage, type Dataset, type EntityRef, type GraphData, type Prop, type RowsPage, type SessionInfo, type SourceRef, type SurfaceInfo,
  type SurfaceMeta, type WireComponent,
} from '@glimpse/catalog';
import {canonicalPath, type CodeService, type DiffService, type GitInfo, type RepoContext, type RepoIndex, type RunGit, type TreeWatcher} from '../contracts.ts';
import {canOpen, detachedLauncher, editorCommand, launchOptions, NO_EDITOR, type Launcher} from '../host/open.ts';
import {inScope, scopeOf} from '../sources/files/shared.ts';
import {resolveSource, type SourceRegistry} from '../sources/registry.ts';
import {canonicalTarget, isCaseVariant} from '../sources/targets.ts';
import {compileSpec, loadToolchain, type Toolchain} from '../spec/compile.ts';
import {editDistance, nearest, oneLine, problem, SpecError, type Problem} from '../spec/errors.ts';
import {boundKeys, checkRef, componentsOf, expandMessages, unboundPaths, type Expansion, type PathNames} from '../spec/expand.ts';
import {DatasetStore, envelopeOf, pageRows, pendingEnvelope, readsRefs, rowsOf, type Drill, type Outcome, type PageQuery} from './datasets.ts';
import {ownEnv} from './env.ts';
import {EventQueue, selectLine} from './events.ts';
import {treeStamp} from './freshness.ts';
import {isSafeRange, repoRelative, resolveInside} from './paths.ts';
import {createRunGit, type GitRunner} from './rungit.ts';
import {inPlaceMessages, snapshotOf, SurfaceStore, type CommitMode, type Draft, type SurfaceRecord} from './surfaces.ts';

/** What the composition root (src/main.ts) injects: the real factories, or fakes in tests. */
export interface ServerDeps {
  registry: SourceRegistry;
  createRepoIndex(root: string, runGit: RunGit, log: (message: string) => void): RepoIndex;
  createCodeService(ctx: RepoContext): CodeService;
  createDiffService(ctx: RepoContext, code: CodeService): DiffService;
  createTreeWatcher(ctx: RepoContext): TreeWatcher;
  readGitInfo(root: string, runGit: RunGit): Promise<GitInfo | null>;
}

export type TabState = 'opened' | 'live' | 'none';

/** The running HTTP host, as the session sees it. */
export interface HostHandle {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  token: string;
  tabs(): number;
  /** Sends one a2ui frame to every connected tab; `focus` asks the shell to show that surface. */
  publish(surfaceId: string, messages: A2uiMessage[], focus?: string): void;
  /** Opens the tab unless one is connected or was opened a moment ago. */
  ensureTab(): TabState;
  close(): void;
}

export interface SessionOptions {
  /** Realpath of the project root. */
  root: string;
  version: string;
  env: NodeJS.ProcessEnv;
  log(message: string): void;
  /** Loads the analyzers and services; called on the first tool call, never at process start. */
  loadDeps(): Promise<ServerDeps>;
  startHost(session: Session): Promise<HostHandle>;
  launcher?: Launcher;
  now?: () => number;
}

export interface Services {
  deps: ServerDeps;
  ctx: RepoContext;
  code: CodeService;
  diff: DiffService;
  watcher: TreeWatcher;
}

export interface ShowRequest {
  id: string;
  /** Express sources as written: a spec, or a preset followed by a patch of it. */
  sources: string[];
  /** A preset call: the surface is rebuilt even when the id exists. */
  fresh: boolean;
  /** The preset call text, e.g. "diff main..HEAD". */
  view?: string;
}

export interface ShowOutcome {
  id: string;
  mode: CommitMode;
  /** The view's route in the tab, `#/<id>`: a label, not a link (it opens nothing without the token). */
  url: string;
  /** The URL that carries the token and opens the live session, for the user to open when no tab is connected. */
  openUrl: string;
  tab: TabState;
  fixes: string[];
  /** What the call got wrong without failing. `checks` adds to it as the repository answers. */
  warnings: string[];
  /** Datasets this call asked for, in order of first use; `settled` never rejects. */
  datasets: Array<{key: string; ref: string; settled: Promise<void>}>;
  /** Settles when the files and revisions the spec names have been looked up; never rejects. */
  checks: Promise<void>;
  /** Field names the spec asks of its datasets, compared with their fields once they have settled. */
  fields: Expansion['fields'];
  parts: string[];
  slots: string[];
  /** True for the first successful show of the session. */
  first: boolean;
}

export interface DatasetState { status: Dataset['status']; summary?: string; error?: {code: string; message: string}; warnings?: string[] }

/** What a path asked of /api/file, /api/outline or gl_open is: a file of the project, a path with no file, or neither. */
export type Servable = 'ok' | 'missing' | 'refused';

const SLOT_COUNT = 8;
const TREE_DEBOUNCE_MS = 500;
/** Without git, a connected tab is kept fresh by looking this often (for everything, or for a new .git only). */
const NO_GIT_POLL_MS = 3000;
const MAX_CHECK_WARNINGS = 6;
/** How long `show{view:"gallery"}` waits for the analysis to pick a file for its Code section. */
const GALLERY_PICK_MS = 3000;
const PROSE = /\.(?:md|mdx|markdown|txt|rst|adoc|ipynb)$/i;
type SlotKind = keyof SurfaceMeta['slots'];
const SLOT_SOURCES: Record<SlotKind, string> = {lang: 'files.langs', module: 'deps.modules', author: 'git.authors'};

/** `work`, or undefined once `ms` have passed (or it fails): a pick that improves a view must never hold it up. */
async function quickly<T>(work: Promise<T | undefined>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>(resolve => { timer = setTimeout(resolve, ms, undefined); });
  try {
    return await Promise.race([work.catch(() => undefined), late]);
  } finally {
    clearTimeout(timer);
  }
}

const deleteSurface = (surfaceId: string): A2uiMessage =>({version: PROTOCOL_VERSION, deleteSurface: {surfaceId}});
const setData = (surfaceId: string, path: string, value: unknown): A2uiMessage => ({version: PROTOCOL_VERSION, updateDataModel: {surfaceId, path, value}});
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Ids assigned at the start of a statement: the named parts of a spec. Callers keep those that are components. */
function namedParts(text: string): string[] {
  return [...text.matchAll(/(?:^|[;\n])[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(?!=)/g)].map(m => m[1]!).filter(name => name !== 'root');
}

/** Best-scored gallery candidates whose first lines are read to find one that opens on code. */
const GALLERY_CANDIDATES = 12;
const FIRST_SCREEN = 30;

/**
 * The share of code among the non-blank lines of the first screen of a file: lines that are not comments (line
 * comments in the usual spellings, and the inside of block comments and docstrings). 0 for an empty text.
 */
export function codeShare(text: string): number {
  let code = 0;
  let other = 0;
  for (const kind of lineKinds(text.split('\n').slice(0, FIRST_SCREEN))) {
    if (kind === 'code') code++;
    else if (kind === 'comment') other++;
  }
  return code + other === 0 ? 0 : code / (code + other);
}

/** Each line as code, comment (line comments, and the inside of block comments and docstrings) or blank. */
function lineKinds(lines: readonly string[]): Array<'code' | 'comment' | 'blank'> {
  const kinds: Array<'code' | 'comment' | 'blank'> = [];
  let block: string | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') { kinds.push('blank'); continue; }
    if (block !== undefined) {
      kinds.push('comment');
      if (line.includes(block)) block = undefined;
      continue;
    }
    const opener = ['/*', '"""', "'''", '<!--', '{-', '=begin'].find(open => line.startsWith(open));
    if (opener) {
      kinds.push('comment');
      const closer = {'/*': '*/', '"""': '"""', "'''": "'''", '<!--': '-->', '{-': '-}', '=begin': '=end'}[opener]!;
      if (!line.slice(opener.length).includes(closer)) block = closer;
      continue;
    }
    kinds.push(/^(?:\/\/|#(?!include|import|define|if|pragma|\[)|--|;|%|\*)/.test(line) ? 'comment' : 'code');
  }
  return kinds;
}

/**
 * The 1-based line the code of a file starts on, past a licence header or a long leading comment: the first code
 * line. 1 when the text starts with code or has none in its first 400 lines.
 */
export function firstCodeLine(text: string): number {
  const index = lineKinds(text.split('\n').slice(0, 400)).indexOf('code');
  return index < 0 ? 1 : index + 1;
}

/** Files of a directory listed whole in a "does not exist" hint, at most. */
const SMALL_DIR = 12;

/**
 * What a path that names no file most plausibly meant (finding V013), as ` Nearest: ...` or ` In <dir>: ...`, or ''.
 * Spelling alone sent the model from spec/parse.ts to spec/guard.ts, so it comes last: the same file name elsewhere,
 * then the whole directory when it exists and is small, then files whose name stem matches (parse, parser), then a
 * path a few edits away.
 */
export function missingFileHint(path: string, candidates: readonly string[]): string {
  const name = basename(path);
  const sameName = candidates.filter(candidate => basename(candidate) === name);
  if (sameName.length > 0) return ` Nearest: ${sameName.slice(0, 2).join(' ')}`;
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const siblings = candidates.filter(candidate => (candidate.includes('/') ? candidate.slice(0, candidate.lastIndexOf('/')) : '') === dir);
  if (dir !== '' && siblings.length > 0 && siblings.length <= SMALL_DIR) return ` In ${dir}: ${siblings.map(sibling => basename(sibling)).join(' ')}`;
  const stem = name.replace(/\.[^.]*$/, '').toLowerCase();
  if (stem.length >= 3) {
    const stems = candidates.filter(candidate => {
      const other = basename(candidate).replace(/\.[^.]*$/, '').toLowerCase();
      return other.length >= 3 && (other.startsWith(stem) || stem.startsWith(other));
    });
    if (stems.length > 0) return ` Nearest: ${nearest(path, stems, 2).join(' ')}`;
  }
  // A suggestion is offered only when it is plausibly what was meant: a path a few edits away.
  const close = (candidate: string) => editDistance(path.toLowerCase(), candidate.toLowerCase()) <= Math.max(3, Math.floor(path.length / 4));
  const near = nearest(path, candidates, 2).filter(close);
  return near.length > 0 ? ` Nearest: ${near.join(' ')}` : '';
}

/** Whether the root holds a .git entry (a directory, or the file of a linked worktree). */
const hasDotGit = (root: string): Promise<boolean> => lstat(join(root, '.git')).then(() => true, () => false);

/** `/plan/1/status` -> `plan` */
const topSegment = (path: string | undefined): string => (path ?? '').split('/').filter(Boolean)[0]?.replace(/~1/g, '/').replace(/~0/g, '~') ?? '';

/**
 * The data slots worth naming in a result: those this call wrote and those a component of the view reads. A slot
 * left behind by an earlier spec that nothing reads any more is not one of them.
 */
function liveSlots(record: SurfaceRecord, written: ReadonlySet<string>): string[] {
  const read = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (typeof value !== 'object' || value === null) return;
    const path = (value as {'@path'?: unknown})['@path'];
    if (typeof path === 'string') read.add(topSegment(path));
    for (const item of Object.values(value)) visit(item);
  };
  for (const comp of record.components.values()) visit(comp);
  return Object.keys(record.data).filter(key => key !== 'ui' && (written.has(key) || read.has(key)));
}

/** Keys of a slot kind, heaviest first, from the result of its source. Malformed data yields no keys. */
function slotKeys(kind: SlotKind, data: unknown): string[] {
  const byNumber = <T,>(items: T[], weight: (item: T) => unknown) => [...items].sort((a, b) => (Number(weight(b)) || 0) - (Number(weight(a)) || 0));
  if (kind === 'module') {
    const nodes = Array.isArray((data as GraphData | undefined)?.nodes) ? (data as GraphData).nodes : [];
    return byNumber(nodes.filter(node => typeof node === 'object' && node !== null), node => node.loc).map(node => node.slotKey ?? node.id).filter(key => typeof key === 'string');
  }
  const rows = Array.isArray(data) ? data.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null) : [];
  const [field, weight] = kind === 'lang' ? ['lang', 'loc'] : ['author', 'commits'];
  return byNumber(rows, row => row[weight!]).map(row => row[field!]).filter((key): key is string => typeof key === 'string');
}

/**
 * Decision D1: where a drilled dataset is, and the scope one level out. `up` is '' when the next step out is the
 * spec's own scope (or the target is not below it at all), which is also what "reset" sends.
 */
export function drillOf(own: string | undefined, target: string | undefined): Drill | undefined {
  if (!target) return undefined;
  const base = (own ?? '').replace(/\/+$/, '');
  const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
  const up = parent === '' || parent === base || (base !== '' && !parent.startsWith(`${base}/`)) ? '' : parent;
  return {target, up};
}

export class Session {
  readonly surfaces = new SurfaceStore();
  readonly events = new EventQueue();
  readonly root: string;
  readonly version: string;
  readonly id: string;
  private options: SessionOptions;
  private env: NodeJS.ProcessEnv;
  private now: () => number;
  private log: (message: string) => void;
  private runner: GitRunner;
  private servicesPromise: Promise<Services> | undefined;
  private loaded: Services | undefined;
  private datasets: DatasetStore | undefined;
  private host: HostHandle | undefined;
  private hostPromise: Promise<HostHandle> | undefined;
  private rev = 1;
  private dirty = false;
  private slots: SurfaceMeta['slots'] = {lang: {}, module: {}, author: {}};
  private slotsDone = new Set<SlotKind>();
  private slotsRun: Promise<void> | undefined;
  private summaries = new WeakMap<Dataset, string>();
  /** Per surface: the dataset lines the model has been given (ref -> summary), so a later result need not repeat them. */
  private told = new Map<string, Map<string, string>>();
  private shows = 0;
  private watching = false;
  private treeTimer: NodeJS.Timeout | undefined;
  /** A change is known (the watcher or a look reported it) and the refresh for it has not started yet. */
  private treePending = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> = Promise.resolve();
  /** The surfaces of a gl_refresh that is queued and has not started; later requests join it. */
  private refreshWaiting: Set<string> | undefined;
  private looking: Promise<void> | undefined;
  private lookNext: Promise<void> | undefined;
  private tabCount = 0;
  /** The tree as last seen by the fallback look (freshness.ts); unused when the watcher can check for itself. */
  private stamp: string | undefined;
  /** Whether the root held a .git entry at the last look. */
  private dotGit: boolean | undefined;
  /** Digest of every ref at the last look, and a counter that moves with it (part of the cache key of range sources). */
  private refsStamp: string | undefined;
  private refsRev = 0;
  /** refsRev when the last refresh ran, so a refresh knows the refs moved since. */
  private refsRefreshed = 0;
  private inventory: {rev: number; paths: Promise<Set<string>>} | undefined;
  private noEditorSaid = false;
  private disposed = false;

  constructor(options: SessionOptions) {
    this.options = options;
    this.root = options.root;
    this.version = options.version;
    this.env = ownEnv(options.env);
    this.now = options.now ?? Date.now;
    this.log = options.log;
    this.runner = createRunGit(options.root, this.env);
    const given = (this.env.CLAUDE_CODE_SESSION_ID ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
    this.id = given.length === 8 ? given : Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  }

  get name(): string {
    return basename(this.root) || 'project';
  }

  /** The source registry, once the services are loaded. */
  get registry(): SourceRegistry | undefined {
    return this.loaded?.deps.registry;
  }

  // ---------------------------------------------------------------- repository context
  /** Starts warming without waiting for it: the compiler, the services and the repository index. */
  warm(): void {
    void loadToolchain().catch(() => {});
    void this.services().then(services => services.ctx.index.files()).catch(() => {});
  }

  /** The repository context and services, built once. A failed load is retried by the next call. */
  services(): Promise<Services> {
    this.servicesPromise ??= (async () => {
      const deps = await this.options.loadDeps();
      const {runGit} = this.runner;
      const git = await deps.readGitInfo(this.root, runGit).catch(() => null);
      const ctx: RepoContext = {root: this.root, name: this.name, git, runGit, index: deps.createRepoIndex(this.root, runGit, this.log), rev: () => this.rev, log: this.log};
      const code = deps.createCodeService(ctx);
      const services: Services = {deps, ctx, code, diff: deps.createDiffService(ctx, code), watcher: deps.createTreeWatcher(ctx)};
      this.datasets = new DatasetStore({registry: deps.registry, context: () => ctx, log: this.log, now: this.now, refs: () => this.refsRev});
      // All before anything is served, so the first look after this compares against what the first answers saw.
      const [dirty, stamp, dotGit, refs] = await Promise.all([
        this.readDirty(ctx),
        services.watcher.check ? undefined : treeStamp(this.root, runGit, git !== null).catch(() => undefined),
        hasDotGit(this.root),
        this.readRefs(ctx),
      ]);
      this.dirty = dirty;
      this.stamp = stamp;
      this.dotGit = dotGit;
      this.refsStamp = refs;
      this.loaded = services;
      return services;
    })().catch(error => {
      this.servicesPromise = undefined;
      throw error;
    });
    return this.servicesPromise;
  }

  /** Uncommitted changes under the project root (which may be a subdirectory of the repository). */
  private async readDirty(ctx: RepoContext): Promise<boolean> {
    if (!ctx.git) return false;
    try {
      return (await ctx.runGit(['status', '--porcelain', '-z', '--', '.'])).length > 0;
    } catch {
      return false;
    }
  }

  info(): SessionInfo {
    const git = this.loaded?.ctx.git;
    return {
      id: this.id,
      project: this.root,
      repo: {name: this.name, ...(git?.branch ? {branch: git.branch} : {}), ...(git?.head ? {head: git.head} : {})},
      version: this.version,
    };
  }

  meta(): SurfaceMeta {
    const git = this.loaded?.ctx.git;
    return {
      repo: {
        name: this.name, root: this.root,
        ...(git?.branch ? {branch: git.branch} : {}), ...(git?.head ? {head: git.head} : {}),
        dirty: this.dirty, ...(git?.shallow ? {shallow: true} : {}),
      },
      rev: this.rev,
      slots: this.slots,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  /** True when the project is a git repository, with or without a first commit. */
  get isGit(): boolean {
    return this.loaded?.ctx.git != null;
  }

  /** Files and lines of the inventory, the same figures repo.kpis and files.tree report. Undefined before it is built. */
  async inventoryTotals(): Promise<{files: number; loc: number} | undefined> {
    const files = await this.loaded?.ctx.index.files().catch(() => undefined);
    if (!files) return undefined;
    return {files: files.length, loc: files.reduce((sum, file) => sum + (file.generated ? 0 : file.loc), 0)};
  }

  /**
   * A file for the gallery's Code section (finding F092): a source file of the inventory with an outline worth
   * reading and a few hundred lines, so SymbolOutline, CodeView and CodeTour all draw something. Undefined when
   * there is none or the analysis takes longer than a moment; the gallery then falls back to README.md.
   */
  async galleryFile(): Promise<string | undefined> {
    const {ctx} = await this.services();
    return quickly((async () => {
      const [files, facts] = await Promise.all([ctx.index.files(), ctx.index.facts()]);
      const ranked: Array<{path: string; score: number}> = [];
      for (const file of files) {
        // Prose has an outline too (its headings), but the Code section is there to show code.
        if (file.binary || file.generated || file.isTest || file.loc < 30 || PROSE.test(file.path)) continue;
        const symbols = facts.get(file.path)?.symbols.length ?? 0;
        if (symbols < 3) continue;
        // Many symbols (up to a dozen count), about 150 lines, near the root; ties go to the first path by name.
        ranked.push({path: file.path, score: Math.min(symbols, 12) * 4 - Math.abs(Math.log2(file.loc / 150)) * 3 - file.path.split('/').length});
      }
      ranked.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      // The first screen of the Code section should be code, not a licence or a long doc comment. Where every file
      // opens on a licence (common in large projects), the one with the most code on its first screen.
      let most: {path: string; share: number; start: number} | undefined;
      for (const {path} of ranked.slice(0, GALLERY_CANDIDATES)) {
        const head = await readFile(join(this.root, path), 'utf8').then(text => text.slice(0, 16_384), () => '');
        const share = codeShare(head);
        if (share >= 0.6) return path;
        if (!most || share > most.share) most = {path, share, start: firstCodeLine(head)};
      }
      // That file opens on its header: the gallery starts its line-reading plates where the code starts (`#L<n>`).
      return most ? (most.start > 1 ? `${most.path}#L${most.start}` : most.path) : ranked[0]?.path;
    })(), GALLERY_PICK_MS);
  }

  /**
   * Finding F008: the file a `tree` or `symbol` preset opens its CodeView on, so the largest plate of the view does
   * not start as "no file selected". tree <dir>: the README of that directory, else its largest source file.
   * symbol <name>: the first file by path that declares the name, at the declaration (`path#L12`), which is the
   * file code.refs reports as "defined in". Undefined when there is none or the analysis takes longer than a moment.
   */
  async presetFile(view: string, target: string | undefined): Promise<string | undefined> {
    if (view !== 'tree' && view !== 'symbol') return undefined;
    const {ctx} = await this.services();
    return quickly((async () => {
      const files = await ctx.index.files();
      if (view === 'symbol') {
        // `symbol <name> [path]`, as code.refs reads it: an identifier has no spaces, so what follows is a path scope
        // (final confirm s21: 'MessageProcessor typescript/renderers' was looked up as one name and opened nothing).
        const [name = '', ...rest] = (target ?? '').trim().split(/\s+/);
        if (!name) return undefined;
        let scope = '';
        try {
          scope = rest.length > 0 ? scopeOf({source: 'code.refs', target: rest.join(' '), args: {}}) : '';
        } catch {
          return undefined;
        }
        const facts = await ctx.index.facts();
        // Finding V035: a definition is in code, never in prose (a class quoted in a Markdown fence is not one), and
        // when several languages define the name, the repository's main language comes first.
        const weight = new Map<string, number>();
        const langOf = (file: (typeof files)[number]) => file.lang ?? '';
        for (const file of files) if (!file.generated && !file.binary) weight.set(langOf(file), (weight.get(langOf(file)) ?? 0) + file.loc);
        const declared = files
          .filter(file => !file.generated && !file.binary && !PROSE.test(file.path) && inScope(file.path, scope))
          .map(file => ({file, symbol: facts.get(file.path)?.symbols.find(symbol => symbol.name === name && symbol.kind !== 'heading')}))
          .filter(found => found.symbol !== undefined)
          // The order code.refs lists its definitions in (main language, then non-tests, then path), so the preset
          // opens the file its 'defined in' names first.
          .sort((a, b) => (weight.get(langOf(b.file)) ?? 0) - (weight.get(langOf(a.file)) ?? 0) || Number(a.file.isTest) - Number(b.file.isTest)
            || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0));
        const first = declared[0];
        return first ? formatFileLoc({path: first.file.path, line: first.symbol!.line}) : undefined;
      }
      const scope = (target ?? '').replace(/^\.\/?/, '').replace(/\/+$/, '');
      if (scope && files.some(file => file.path === scope)) return scope;
      const inside = files.filter(file => !scope || file.path.startsWith(`${scope}/`));
      const readme = inside.find(file => /^readme(?:\.(?:md|markdown|txt|rst))?$/i.test(file.path.slice(scope ? scope.length + 1 : 0)));
      if (readme) return readme.path;
      let best: (typeof files)[number] | undefined;
      for (const file of inside) {
        if (file.binary || file.generated || file.isTest || PROSE.test(file.path)) continue;
        if (!best || file.loc > best.loc || (file.loc === best.loc && file.path < best.path)) best = file;
      }
      return best?.path;
    })(), GALLERY_PICK_MS);
  }

  // ---------------------------------------------------------------- host
  /** The host, started on first use. */
  ensureHost(): Promise<HostHandle> {
    this.hostPromise ??= this.options.startHost(this).then(host => {
      if (this.disposed) host.close();
      else this.host = host;
      return host;
    }).catch(error => {
      this.hostPromise = undefined;
      throw error;
    });
    return this.hostPromise;
  }

  /** Connected viewer tabs; zero before the host has started. */
  tabs(): number {
    return this.host?.tabs() ?? 0;
  }

  /** Sends a frame from background work (a settled dataset, a refresh). A host that fails is logged, never thrown. */
  private push(surfaceId: string, messages: A2uiMessage[]): void {
    try {
      this.host?.publish(surfaceId, messages);
    } catch (error) {
      this.log(`glimpse: could not publish to the tab: ${describe(error)}`);
    }
  }

  /** One snapshot frame per surface, for a tab that connects or reconnects. */
  replay(): Array<{surfaceId: string; messages: A2uiMessage[]}> {
    const meta = this.meta();
    return this.surfaces.all().map(record => ({surfaceId: record.id, messages: [snapshotOf(record, meta)]}));
  }

  surfaceList(): SurfaceInfo[] {
    return this.surfaces.list();
  }

  /**
   * The watcher polls only while somebody is looking (design 2.4). A tab that connects gets the stored snapshots at
   * once and a fresh look right behind them, so what changed while nobody watched arrives within moments.
   */
  tabsChanged(count: number): void {
    const want = count > 0 && !this.disposed;
    if (want && count > this.tabCount) void this.revalidate();
    this.tabCount = count;
    if (want === this.watching || !this.loaded) return;
    this.watching = want;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (want) {
      const {watcher, ctx} = this.loaded;
      watcher.start(() => this.treeChanged());
      if (!ctx.git) {
        // Without git a connected tab is kept fresh by looking: in full when the watcher cannot look for itself, else
        // only for a .git appearing (`git init`), which no file the watcher lists shows.
        this.pollTimer = setInterval(() => {
          if (!watcher.check) void this.revalidate();
          else void hasDotGit(this.root).then(found => { if (found !== this.dotGit) void this.revalidate(); });
        }, NO_GIT_POLL_MS);
        this.pollTimer.unref();
      }
    } else {
      this.loaded.watcher.stop();
    }
  }

  // ---------------------------------------------------------------- show
  private prepare(request: ShowRequest, tools: Toolchain, registry: SourceRegistry, names?: PathNames): {draft: Draft; fixes: string[]; warnings: string[]; expansion: Expansion; compiledData: Set<string>} {
    const current = request.fresh ? undefined : this.surfaces.get(request.id);
    const compiled = compileSpec(tools, {
      surfaceId: request.id,
      ...(current ? {seed: {components: [...current.components.values()], data: current.data}} : {}),
      sources: request.sources,
      surfaces: this.surfaces.ids(),
      log: this.log,
    });
    const expansion = expandMessages(compiled.messages, registry, names);
    if (expansion.problems.length > 0) throw new SpecError(expansion.problems);
    // Which components the preset's own text defined (the first source of a preset call) and which the model wrote.
    const idsOf = (from: (step: number) => boolean) =>
      new Set(compiled.messages.flatMap((message, i) => (from(compiled.steps[i] ?? 0) ? componentsOf(message).map(comp => comp.id) : [])));
    const draft = this.surfaces.draft(request.id, compiled.messages, {
      fresh: request.fresh,
      ...(request.view ? {view: request.view} : {}),
      refs: expansion.refs,
      parts: compiled.texts.flatMap(namedParts),
      presetIds: request.fresh ? idsOf(step => step === 0) : new Set(),
      modelIds: idsOf(step => !request.fresh || step > 0),
      now: this.now(),
    });
    const unbound = [...unboundPaths(compiled.messages.flatMap(componentsOf), draft.record.data), ...draft.unknownKeys.map(key => `$/ds/${key}`)];
    const compiledData = new Set(compiled.messages.flatMap(message => ('updateDataModel' in message ? [topSegment(message.updateDataModel.path)]
      : 'createSurface' in message ? Object.keys(message.createSurface.dataModel ?? {}) : [])));
    return {draft, fixes: [...compiled.fixes, ...expansion.fixes], warnings: [...compiled.warnings, ...expansion.warnings, ...unbound.map(path => `unbound ${path}`)], expansion, compiledData};
  }

  /**
   * Design 2.2, steps 2 to 9. Throws SpecError when the call is invalid; nothing has changed in that case.
   * Compile, expand and commit run without an await between them, so parallel calls cannot interleave. Once the
   * draft is committed the call has succeeded: nothing after that point may throw, or the model would be told that
   * nothing was rendered while the tab shows the new view.
   */
  async show(request: ShowRequest): Promise<ShowOutcome> {
    const [tools, services] = await Promise.all([loadToolchain(), this.services()]);
    const registry = services.deps.registry;
    // Validate first, so an invalid first call does not start the host; then again after the await, on current state.
    let prepared = this.prepare(request, tools, registry);
    // Finding V071: a path the spec wrote in another case than the one on disk ('readme.md') is shown, bound and
    // checked under the inventory's name (README.md), said as a fix. The file system tells synchronously which paths
    // are such variants; only then is the index asked, and the call expanded again with the names it gave.
    const variants = prepared.expansion.paths.filter(path => isCaseVariant(this.root, path));
    let names: Map<string, string> | undefined;
    if (variants.length > 0) {
      names = new Map();
      for (const path of variants) names.set(path, await canonicalTarget(services.ctx, path));
    }
    const starting = !this.host;
    if (starting) await this.ensureHost();
    if (starting || names) prepared = this.prepare(request, tools, registry, names);
    const host = this.host;
    if (!host) throw new Error('the session has ended');
    const {draft, fixes, warnings, expansion} = prepared;
    const record = draft.record;
    const evicted = this.surfaces.commit(draft);

    let datasets: ShowOutcome['datasets'] = [];
    let tab: TabState = 'none';
    try {
      // Decision D14: the state of every component this call defines again is forgotten, and the tab reports it afresh
      // while this call waits: a fix that leaves a component as broken as before is told as such. A patch redefines
      // the components it sends, a replace in place those its text defines (identical or not) and any whose
      // definition changed, any other replace all of them.
      if (draft.mode === 'patch') this.events.reports.forget(record.id, draft.delta.flatMap(componentsOf).map(comp => comp.id));
      else if (draft.inPlace) this.events.reports.forget(record.id, draft.inPlace.changed);
      else this.events.reports.forget(record.id);
      for (const id of evicted) this.forget(id);

      const fresh = new Set(draft.newKeys);
      const requested = draft.mode === 'patch' ? draft.newKeys : [...record.bindings.keys()];
      datasets = requested.map(key => this.track(record, key, fresh.has(key)));

      for (const id of evicted) host.publish(id, [deleteSurface(id)]);
      const snapshot = () => snapshotOf(record, this.meta());
      const messages = draft.mode === 'create' ? [snapshot()]
        : draft.inPlace ? inPlaceMessages(draft.inPlace.previous, record, this.meta(), draft.inPlace.changed)
        : draft.mode === 'replace' ? [deleteSurface(record.id), snapshot()]
        : [...draft.delta, ...draft.newKeys.map(key => setData(record.id, `/ds/${key}`, record.ds[key]))];
      host.publish(record.id, messages, record.id);
      tab = host.ensureTab();
      this.tabsChanged(host.tabs());
      void this.assignSlots();
    } catch (error) {
      this.log(`glimpse: show ${record.id} was committed, then failed to publish: ${describe(error)}`);
      warnings.push(`the view is stored but could not be sent to the tab (${describe(error).slice(0, 120)}); reload the tab`);
    }

    const first = this.shows++ === 0;
    const outcome: ShowOutcome = {
      id: record.id,
      mode: draft.mode,
      url: `#/${encodeURIComponent(record.id)}`,
      openUrl: `${host.origin}/#t=${host.token}`,
      tab, fixes, warnings, datasets,
      checks: Promise.resolve(),
      fields: expansion.fields,
      parts: draft.mode === 'patch' ? [] : record.parts,
      slots: draft.mode === 'patch' ? [] : liveSlots(record, prepared.compiledData).map(key => `$/${key}`),
      first,
    };
    outcome.checks = this.checkNamed(services, expansion).then(found => void outcome.warnings.push(...found), error => this.log(`glimpse: checking the files a view names failed: ${describe(error)}`));
    return outcome;
  }

  /**
   * Decision D3, the static half: what the server can know without a tab. A literal file that is not a file of the
   * project and a revision git does not know each give one `Name#id: ...` warning.
   */
  private async checkNamed(services: Services, expansion: Expansion): Promise<string[]> {
    const {ctx} = services;
    const out: string[] = [];
    let candidates: string[] | undefined;
    for (const {where, file} of expansion.files) {
      if (out.length >= MAX_CHECK_WARNINGS) break;
      const path = parseFileLoc(file).path;
      const state = await this.servable(path);
      if (state === 'ok') continue;
      if (state === 'refused') { out.push(`${where}: "${path.slice(0, 120)}" is not a file of this project (outside it, ignored, or not a regular file).`); continue; }
      candidates ??= (await ctx.index.files().catch(() => [])).map(entry => entry.path);
      out.push(`${where}: file "${path.slice(0, 120)}" does not exist.${missingFileHint(path, candidates)}`);
    }
    for (const {where, range} of expansion.ranges) {
      if (out.length >= MAX_CHECK_WARNINGS) break;
      if (!isSafeRange(range)) { out.push(`${where}: "${range.slice(0, 60)}" is not a range. Use wt, staged, a ref such as main, or a range such as main..HEAD.`); continue; }
      if (!ctx.git) { out.push(`${where}: this project is not a git repository, so there is no diff to show.`); continue; }
      for (const revision of range.split(/\.{2,3}/).filter(Boolean)) {
        const known = await ctx.runGit(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]).then(() => true, () => false);
        if (!known) { out.push(`${where}: unknown revision "${revision.slice(0, 60)}".`); break; }
      }
    }
    return out;
  }

  /**
   * What became known while a `show` waited (decisions D3 and D5): field names the spec asks for that the settled
   * dataset does not have, and what the tab reported drawing instead of a component. Reports taken here are not
   * delivered again as `viewer:` lines.
   */
  lateWarnings(outcome: Pick<ShowOutcome, 'id' | 'fields'> & {warnings?: readonly string[]}): string[] {
    const record = this.surfaces.get(outcome.id);
    if (!record) return [];
    const out: string[] = [];
    for (const check of outcome.fields) {
      const envelope = record.ds[check.key];
      if (envelope?.status !== 'ready' || envelope.kind !== 'rows' || !Array.isArray(envelope.data)) continue;
      const rows = envelope.data.slice(0, 20).filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && !Array.isArray(row));
      const known = new Set([...(envelope.fields ?? []).map(field => field.key), ...rows.flatMap(row => Object.keys(row))]);
      const missing = check.names.filter(name => !known.has(name));
      if (known.size > 0 && missing.length > 0) out.push(`${check.where}: no field ${missing.slice(0, 4).map(name => `"${name.slice(0, 40)}"`).join(', ')} in ${envelope.source}. Fields: ${[...known].join(' ')}`);
    }
    // A component the call already has a warning about (a missing file, a wrong kind, a missing field) is not
    // reported twice: what the tab drew there is the same problem in other words, and it is not delivered later.
    const said = new Set([...(outcome.warnings ?? []), ...out].map(warning => /^([A-Za-z][A-Za-z0-9]*#[^\s:]+):/.exec(warning)?.[1]).filter(name => name !== undefined));
    // Finding V006: a component bound to a dataset that failed draws that failure; the result's dataset line says it,
    // so the tab's report of the same thing is not a second warning.
    const failed = new Set(Object.entries(record.ds).filter(([, envelope]) => envelope?.status === 'error').map(([key]) => key));
    if (failed.size > 0) {
      for (const comp of record.components.values()) {
        if ([...boundKeys([comp])].some(key => failed.has(key))) said.add(`${comp.component}#${comp.id}`);
      }
    }
    return [...out, ...this.events.reports.take(outcome.id, said)];
  }

  /**
   * Decision D14, the viewer half: a tab reports the current state of component `name#id`: OK, a truthful empty or
   * waiting state (I_*), or a problem (W_*, E_*). The store keeps the latest one; the model hears of a problem once.
   * Returns false for a surface or component that does not exist.
   */
  viewerReport(surfaceId: string, name: string, id: string, code: string, message: string): boolean {
    const record = this.surfaces.get(surfaceId);
    const comp = record?.components.get(id);
    if (!record || comp?.component !== name) return false;
    // An empty part of a preset is the preset's state, not something the model wrote; a code view that follows the
    // selection is empty until the user selects a file. Both are kept as told: neither is the model's to fix.
    const quiet = code === 'W_EMPTY' && (record.preset.has(id) || this.waitsForSelection(record, comp));
    this.events.reports.set(surfaceId, `${name}#${id}`, code, oneLine(message, 300), quiet);
    return true;
  }

  private waitsForSelection(record: SurfaceRecord, comp: WireComponent): boolean {
    const prop = (COMPONENT_BY_NAME.get(comp.component)?.props as Record<string, Prop> | undefined)?.file;
    if (!prop || !/follow the selected file/i.test(prop.doc)) return false;
    const bound = comp.file === undefined || (typeof comp.file === 'object' && comp.file !== null && (comp.file as {'@path'?: unknown})['@path'] === '/ui/file');
    const ui = record.data.ui;
    const chosen = record.file ?? (typeof ui === 'object' && ui !== null ? (ui as {file?: unknown}).file : undefined);
    return bound && (chosen === undefined || chosen === null || chosen === '');
  }

  /** True when the dataset line `ref | summary` of this surface was already given to the model; remembers it either way. */
  alreadyTold(surfaceId: string, ref: string, summary: string): boolean {
    const lines = this.told.get(surfaceId) ?? new Map<string, string>();
    this.told.set(surfaceId, lines);
    const same = lines.get(ref) === summary;
    lines.set(ref, summary);
    return same;
  }

  // ---------------------------------------------------------------- datasets
  private effectiveRef(record: SurfaceRecord, key: string): SourceRef | undefined {
    const ref = record.bindings.get(key);
    if (!ref) return undefined;
    const drill = record.drills.get(key);
    return drill ? {...ref, target: drill} : ref;
  }

  private drill(record: SurfaceRecord, key: string): Drill | undefined {
    return drillOf(record.bindings.get(key)?.target, record.drills.get(key));
  }

  private envelope(record: SurfaceRecord, key: string, ref: SourceRef, outcome: Outcome): Dataset {
    const envelope = envelopeOf(key, ref, outcome, this.drill(record, key));
    if (outcome.ok) this.summaries.set(envelope, outcome.result.summary.replace(/\s+/g, ' ').trim());
    return envelope;
  }

  private pending(record: SurfaceRecord, key: string, ref: SourceRef): Dataset {
    return pendingEnvelope(key, ref, resolveSource(ref.source, this.loaded!.deps.registry)?.meta, this.drill(record, key));
  }

  /** Gives a dataset of a just-committed record its envelope (new keys) and returns when it will have settled. */
  private track(record: SurfaceRecord, key: string, isNew: boolean): {key: string; ref: string; settled: Promise<void>} {
    const ref = this.effectiveRef(record, key)!;
    const store = this.datasets!;
    let settled: Promise<void> = Promise.resolve();
    if (isNew) {
      const cached = store.peek(ref);
      if (cached) record.ds[key] = this.envelope(record, key, ref, {...cached, cached: true});
      else {
        record.ds[key] = this.pending(record, key, ref);
        settled = store.run(ref).then(outcome => this.deliver(record.id, key, ref, outcome));
      }
    } else if (record.ds[key]?.status === 'pending') {
      settled = store.run(ref).then(() => {});
    }
    return {key, ref: formatRef(ref), settled};
  }

  /** Stores a settled result and pushes it to the tabs, unless the surface has moved on from this ref meanwhile. */
  private deliver(surfaceId: string, key: string, ref: SourceRef, outcome: Outcome): void {
    const record = this.surfaces.get(surfaceId);
    if (this.disposed || !record) return;
    const current = this.effectiveRef(record, key);
    if (!current || formatRef(current) !== formatRef(ref)) return;
    record.ds[key] = this.envelope(record, key, ref, outcome);
    this.push(surfaceId, [setData(surfaceId, `/ds/${key}`, record.ds[key])]);
  }

  /** Re-runs datasets of a surface. `showPending` replaces the visible data with a drafting frame while they run. */
  private rerun(record: SurfaceRecord, keys: Iterable<string>, showPending: boolean): void {
    const store = this.datasets;
    if (!store) return;
    for (const key of keys) {
      const ref = this.effectiveRef(record, key);
      if (!ref) continue;
      if (showPending) {
        record.ds[key] = this.pending(record, key, ref);
        this.push(record.id, [setData(record.id, `/ds/${key}`, record.ds[key])]);
      }
      void store.run(ref).then(outcome => this.deliver(record.id, key, ref, outcome));
    }
  }

  /** What the tool result says about a dataset of a surface right now. */
  datasetState(surfaceId: string, key: string): DatasetState | undefined {
    const envelope = this.surfaces.get(surfaceId)?.ds[key];
    if (!envelope) return undefined;
    const summary = this.summaries.get(envelope);
    return {
      status: envelope.status,
      ...(summary !== undefined ? {summary} : {}),
      ...(envelope.error ? {error: envelope.error} : {}),
      ...(envelope.warnings ? {warnings: envelope.warnings} : {}),
    };
  }

  /** Runs a ref outside any surface (the query tool, the repo line). Throws SpecError for a ref that cannot run. */
  async runRef(text: string): Promise<{ref: SourceRef; outcome: Outcome}> {
    const services = await this.services();
    const checked = checkRef(text, services.deps.registry);
    if ('problem' in checked) throw new SpecError([checked.problem]);
    return {ref: checked.ref, outcome: await this.datasets!.run(checked.ref)};
  }

  /** GET /api/ds/:surfaceId/:key/rows. Undefined when the surface or the dataset does not exist. */
  async rows(surfaceId: string, key: string, query: PageQuery): Promise<RowsPage | {error: {code: string; message: string}} | undefined> {
    const record = this.surfaces.get(surfaceId);
    const ref = record ? this.effectiveRef(record, key) : undefined;
    if (!ref || !this.datasets) return undefined;
    const outcome = await this.datasets.run(ref);
    if (!outcome.ok) return {error: outcome.error};
    const rows = rowsOf(outcome);
    return rows ? pageRows(rows, query) : {error: {code: 'E_ARGS', message: `${ref.source} is not a rows dataset`}};
  }

  // ---------------------------------------------------------------- colour slots
  /** Assigns categorical slots 1 to 8 per kind, once, heaviest first; later entities keep `other` (design 2.4). */
  private assignSlots(): Promise<void> {
    this.slotsRun ??= (async () => {
      let changed = false;
      const kinds = (Object.keys(SLOT_SOURCES) as SlotKind[]).filter(kind => !this.slotsDone.has(kind));
      await Promise.all(kinds.map(async kind => {
        const outcome = await this.datasets!.run({source: SLOT_SOURCES[kind], args: {}});
        if (!outcome.ok) return;
        this.slotsDone.add(kind);
        const next: Record<string, number> = Object.create(null) as Record<string, number>;
        for (const key of slotKeys(kind, outcome.result.data)) {
          if (Object.keys(next).length >= SLOT_COUNT) break;
          if (!(key in next)) next[key] = Object.keys(next).length + 1;
        }
        this.slots = {...this.slots, [kind]: {...next}};
        changed = changed || Object.keys(next).length > 0;
      }));
      if (changed) this.publishMeta();
    })().catch(error => this.log(`glimpse: colour slots failed: ${describe(error)}`)).finally(() => {
      this.slotsRun = undefined;
    });
    return this.slotsRun;
  }

  private publishMeta(): void {
    const meta = this.meta();
    for (const record of this.surfaces.all()) this.push(record.id, [setData(record.id, '/meta', meta)]);
  }

  // ---------------------------------------------------------------- working tree
  /** The watcher saw a change: refresh once the tree has been quiet for a moment, or as soon as a tool call needs it. */
  private treeChanged(): void {
    this.treePending = true;
    clearTimeout(this.treeTimer);
    this.treeTimer = setTimeout(() => void this.flushTree(), TREE_DEBOUNCE_MS);
    this.treeTimer.unref();
  }

  /** Applies a change the watcher reported, if one is waiting for its quiet moment. */
  private flushTree(): Promise<void> {
    clearTimeout(this.treeTimer);
    if (!this.treePending) return this.refreshing;
    this.treePending = false;
    return this.refreshTree(undefined);
  }

  /** Every ref of the repository with its commit, as one digest: a base ref can move while HEAD stays (finding V052). */
  private async readRefs(ctx: RepoContext): Promise<string> {
    if (!ctx.git) return '';
    const out = await ctx.runGit(['for-each-ref', '--format=%(objectname) %(refname)']).catch(() => Buffer.alloc(0));
    // No refs at all (no commit yet, or git failed) reads the same as no git, so neither is a change on its own.
    return out.length === 0 ? '' : createHash('sha1').update(out).digest('hex');
  }

  /**
   * True when HEAD, the working tree, a ref, or the presence of the repository itself is not what it was at the last
   * look; that state then becomes the reference. `git init` in a plain directory changes no file the watcher lists,
   * so the .git entry is looked at here, whatever the watcher does (findings V055, V068).
   */
  private async moved(services: Services): Promise<boolean> {
    const tree = async () => {
      if (services.watcher.check) return services.watcher.check();
      const stamp = await treeStamp(this.root, services.ctx.runGit, services.ctx.git !== null);
      const changed = this.stamp !== undefined && stamp !== this.stamp;
      this.stamp = stamp;
      return changed;
    };
    const [changed, dotGit, refs] = await Promise.all([tree(), hasDotGit(this.root), this.readRefs(services.ctx)]);
    const repository = this.dotGit !== undefined && dotGit !== this.dotGit;
    const refsMoved = this.refsStamp !== undefined && refs !== this.refsStamp;
    this.dotGit = dotGit;
    this.refsStamp = refs;
    if (refsMoved) this.refsRev++;
    return changed || repository || refsMoved;
  }

  /**
   * Decision D8: looks at HEAD and the working tree before a tool call is served, tab or no tab, and refreshes when
   * they moved, so no answer is computed on a HEAD, a revision or a file index that is out of date. Cheap when
   * nothing changed (two git calls). There is deliberately no "looked a moment ago" shortcut: an agent edits a file
   * and asks in the same breath. Does nothing before the services are loaded: nothing can be stale yet. Never rejects.
   */
  revalidate(): Promise<void> {
    const services = this.loaded;
    if (!services || this.disposed) return Promise.resolve();
    if (this.looking) {
      // The look in flight began before this call and may have missed a change made since: wait for the next one,
      // which every call that arrives meanwhile shares.
      this.lookNext ??= this.looking.then(() => {
        this.lookNext = undefined;
        return this.look(services);
      });
      return this.lookNext;
    }
    return this.look(services);
  }

  private look(services: Services): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.looking = (async () => {
      if (await this.moved(services)) this.treePending = true;
      await this.flushTree();
    })().catch(error => this.log(`glimpse: looking at the working tree failed: ${describe(error)}`)).finally(() => {
      this.looking = undefined;
    });
    return this.looking;
  }

  /**
   * The working tree or HEAD changed (or the user asked for a refresh of one surface): bump the revision, drop the
   * index, and re-run what depends on it. Visible data stays on screen until its replacement arrives. Refreshes
   * run one after another, so a second one cannot read git while the first is half way through.
   */
  private refreshTree(only: ReadonlySet<string> | undefined, starting?: () => void): Promise<void> {
    const run = this.refreshing.then(async () => {
      starting?.();
      const services = this.loaded;
      if (!services || this.disposed) return;
      const {ctx, deps} = services;
      this.rev++;
      ctx.index.invalidate();
      const before = ctx.git?.head;
      ctx.git = await deps.readGitInfo(this.root, ctx.runGit).catch(() => ctx.git);
      this.dirty = await this.readDirty(ctx);
      if (this.disposed) return;
      const headChanged = before !== ctx.git?.head;
      // The refs as they are now, with the repository as it is now (it may have just appeared), so the next look
      // compares against what this refresh served.
      const refs = await this.readRefs(ctx);
      if (this.refsStamp !== undefined && refs !== this.refsStamp) this.refsRev++;
      this.refsStamp = refs;
      if (this.disposed) return;
      const refsChanged = this.refsRev !== this.refsRefreshed;
      this.refsRefreshed = this.refsRev;
      this.publishMeta();
      for (const record of this.surfaces.all()) {
        const all = only?.has(record.id) === true;
        const keys = [...record.bindings.keys()].filter(key => {
          const ref = this.effectiveRef(record, key)!;
          const meta = resolveSource(ref.source, deps.registry)?.meta ?? SOURCE_BY_NAME.get(ref.source);
          return all || headChanged || meta?.wt === true || (refsChanged && meta !== undefined && readsRefs(meta, ref));
        });
        this.rerun(record, keys, false);
      }
    }).catch(error => this.log(`glimpse: refreshing after a change failed: ${describe(error)}`));
    this.refreshing = run;
    return run;
  }

  /**
   * Finding V071: a path the model wrote ('path' or 'path#L10'), under the inventory's spelling: 'readme.md' is
   * README.md on a case-insensitive file system. As written when it already is that name or names nothing.
   */
  async canonicalName(text: string): Promise<string> {
    const {ctx} = await this.services();
    return canonicalTarget(ctx, text);
  }

  // ---------------------------------------------------------------- files the viewer may ask for
  /**
   * Decision D10: whether a repo-relative path names a file of the inventory (tracked, or untracked and not
   * ignored). Everything under .git, ignored files, symbolic links and anything outside the root are `refused`,
   * whether or not they exist; a path with no file at all is `missing`, so a typo still reads "does not exist".
   */
  async servable(path: string): Promise<Servable> {
    const target = await resolveInside(this.root, path);
    if (!target) return 'refused';
    const {ctx} = await this.services();
    const relative = repoRelative(this.root, target);
    if (relative === '') return 'missing';
    if (await this.inInventory(ctx, relative)) return 'ok';
    const info = await lstat(target).catch(() => undefined);
    return info === undefined || info.isDirectory() ? 'missing' : 'refused';
  }

  private async inInventory(ctx: RepoContext, relative: string): Promise<boolean> {
    if (ctx.index.has) return ctx.index.has(relative).catch(() => false);
    if (this.inventory?.rev !== this.rev) {
      this.inventory = {rev: this.rev, paths: ctx.index.files().then(files => new Set(files.map(file => file.path)))};
    }
    return (await this.inventory.paths.catch(() => new Set<string>())).has(relative);
  }

  // ---------------------------------------------------------------- host actions (design 2.7)
  /** gl_select: queued for the model, and kept on the surface so a reload or a second tab opens on it. */
  select(surfaceId: string, ref: EntityRef | null): void {
    this.events.select(ref ? selectLine(ref, surfaceId) : null);
    const record = this.surfaces.get(surfaceId);
    if (!record) return;
    record.sel = ref;
    // The same rule as the viewer kit: the file follows a selection that has a path, and stays otherwise.
    if (ref?.path && ref.type !== 'dir') {
      record.file = formatFileLoc({path: ref.path, ...(ref.line !== undefined ? {line: ref.line} : {}), ...(ref.endLine !== undefined ? {endLine: ref.endLine} : {})});
    }
  }

  /**
   * gl_drill: one dataset of one surface gets a new positional target; "" (or the spec's own target) restores the
   * spec's scope. The envelope says where it is and what is one level out (decision D1), pending or settled, so
   * the viewer's way back survives a reload.
   */
  drillTo(surfaceId: string, key: string, target: string): void {
    const record = this.surfaces.get(surfaceId);
    const own = record?.bindings.get(key);
    if (!record || !own) return;
    if (target && target !== (own.target ?? '')) record.drills.set(key, target);
    else record.drills.delete(key);
    this.rerun(record, [key], true);
  }

  /**
   * gl_refresh: looks at HEAD and the working tree now and asks for every dataset of the surface again. The new
   * revision makes the working-tree sources recompute; the others are answered from memory unless HEAD moved.
   */
  refresh(surfaceId: string): void {
    if (!this.surfaces.has(surfaceId)) return;
    // Finding V023: requests that arrive while one is waiting for its turn join it, so a burst re-reads the tree once.
    if (this.refreshWaiting) { this.refreshWaiting.add(surfaceId); return; }
    const waiting = new Set([surfaceId]);
    this.refreshWaiting = waiting;
    void this.refreshTree(waiting, () => {
      if (this.refreshWaiting === waiting) this.refreshWaiting = undefined;
    });
  }

  private forget(surfaceId: string): void {
    this.events.reports.forget(surfaceId);
    this.told.delete(surfaceId);
  }

  /** gl_close, and eviction: forgets the surface and tells the tabs. */
  closeSurface(surfaceId: string): void {
    if (!this.surfaces.delete(surfaceId)) return;
    this.forget(surfaceId);
    this.push(surfaceId, [deleteSurface(surfaceId)]);
  }

  /**
   * gl_open: the user's editor at a file of this project. Only an existing file of the inventory is opened, and
   * only with GLIMPSE_EDITOR or a known editor found on PATH: there is no fallback to the OS opener, which would
   * run what the repository says the file is. Returns what was refused, for the log.
   */
  async openFile(file: string): Promise<Problem | undefined> {
    const loc = parseFileLoc(file);
    const state = await this.servable(loc.path);
    if (state !== 'ok') {
      return problem('E_PATH', `refused to open ${state === 'missing' ? 'a path that does not exist' : 'a path that is not a file of the project'}: ${JSON.stringify(loc.path.slice(0, 200))}`);
    }
    if (!canOpen(this.env)) return undefined;
    // Finding V071: the editor opens the file under the inventory's spelling ('readme.md' opens README.md), so its
    // tab, its recent-files list and any later save agree with what every view of the project shows.
    const resolved = await resolveInside(this.root, loc.path);
    const {ctx} = await this.services();
    const named = resolved ? await canonicalPath(ctx.index, repoRelative(this.root, resolved)) : undefined;
    const target = named ? await resolveInside(this.root, named) : undefined;
    const command = target ? editorCommand(target, loc.line, this.env, {root: this.root}) : undefined;
    if (!command) {
      if (this.noEditorSaid) return undefined;
      this.noEditorSaid = true;
      return problem('E_PATH', NO_EDITOR);
    }
    (this.options.launcher ?? detachedLauncher)(command[0], command[1], launchOptions(this.env, this.root));
    return undefined;
  }

  // ---------------------------------------------------------------- shutdown
  /** Synchronous: stops polling, aborts running sources, kills git children, closes the host. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.treeTimer);
    clearInterval(this.pollTimer);
    if (this.watching) this.loaded?.watcher.stop();
    this.watching = false;
    this.datasets?.close();
    this.events.close();
    this.runner.killAll();
    this.host?.close();
  }
}
