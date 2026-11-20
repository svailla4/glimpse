// The session: all state of one server process (design 2.1, 2.6). It owns the stores, the repository context and
// the pipeline that turns a `show` call into pixels (design 2.2). Analyzer, git and code services arrive through
// ServerDeps, so everything here runs on fakes in tests; the HTTP host is started through `startHost` on first use.
import {basename} from 'node:path';
import {
  formatRef, parseFileLoc, PROTOCOL_VERSION, SOURCE_BY_NAME,
  type A2uiMessage, type Dataset, type EntityRef, type GraphData, type RowsPage, type SessionInfo, type SourceRef, type SurfaceInfo, type SurfaceMeta,
} from '@glimpse/catalog';
import type {CodeService, DiffService, GitInfo, RepoContext, RepoIndex, RunGit, TreeWatcher} from '../contracts.ts';
import {canOpen, detachedLauncher, editorCommand, type Launcher} from '../host/open.ts';
import {resolveSource, type SourceRegistry} from '../sources/registry.ts';
import {compileSpec, loadToolchain, type Toolchain} from '../spec/compile.ts';
import {problem, SpecError, type Problem} from '../spec/errors.ts';
import {checkRef, componentsOf, expandMessages, unboundPaths} from '../spec/expand.ts';
import {DatasetStore, envelopeOf, pageRows, pendingEnvelope, rowsOf, type Outcome, type PageQuery} from './datasets.ts';
import {EventQueue, selectLine} from './events.ts';
import {resolveInside} from './paths.ts';
import {createRunGit, type GitRunner} from './rungit.ts';
import {snapshotOf, SurfaceStore, type CommitMode, type Draft, type SurfaceRecord} from './surfaces.ts';

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
  url: string;
  /** With tab "none": the URL that carries the token, for the user to open. */
  openUrl: string;
  tab: TabState;
  fixes: string[];
  warnings: string[];
  /** Datasets this call asked for, in order of first use; `settled` never rejects. */
  datasets: Array<{key: string; ref: string; settled: Promise<void>}>;
  parts: string[];
  slots: string[];
  /** True for the first successful show of the session. */
  first: boolean;
}

export interface DatasetState { status: Dataset['status']; summary?: string; error?: {code: string; message: string}; warnings?: string[] }

const SLOT_COUNT = 8;
const TREE_DEBOUNCE_MS = 500;
type SlotKind = keyof SurfaceMeta['slots'];
const SLOT_SOURCES: Record<SlotKind, string> = {lang: 'files.langs', module: 'deps.modules', author: 'git.authors'};

const deleteSurface = (surfaceId: string): A2uiMessage => ({version: PROTOCOL_VERSION, deleteSurface: {surfaceId}});
const setData = (surfaceId: string, path: string, value: unknown): A2uiMessage => ({version: PROTOCOL_VERSION, updateDataModel: {surfaceId, path, value}});

/** Ids assigned at the start of a statement: the named parts of a spec. Callers keep those that are components. */
function namedParts(text: string): string[] {
  return [...text.matchAll(/(?:^|[;\n])[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(?!=)/g)].map(m => m[1]!).filter(name => name !== 'root');
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

export class Session {
  readonly surfaces = new SurfaceStore();
  readonly events = new EventQueue();
  readonly root: string;
  readonly version: string;
  readonly id: string;
  private options: SessionOptions;
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
  private shows = 0;
  private watching = false;
  private treeTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(options: SessionOptions) {
    this.options = options;
    this.root = options.root;
    this.version = options.version;
    this.now = options.now ?? Date.now;
    this.log = options.log;
    this.runner = createRunGit(options.root, options.env);
    const given = (options.env.CLAUDE_CODE_SESSION_ID ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
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
      this.datasets = new DatasetStore({registry: deps.registry, context: () => ctx, log: this.log, now: this.now});
      this.dirty = await this.readDirty(ctx);
      this.loaded = services;
      return services;
    })().catch(error => {
      this.servicesPromise = undefined;
      throw error;
    });
    return this.servicesPromise;
  }

  private async readDirty(ctx: RepoContext): Promise<boolean> {
    if (!ctx.git) return false;
    try {
      return (await ctx.runGit(['status', '--porcelain', '-z'])).length > 0;
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

  /** One snapshot frame per surface, for a tab that connects or reconnects. */
  replay(): Array<{surfaceId: string; messages: A2uiMessage[]}> {
    const meta = this.meta();
    return this.surfaces.all().map(record => ({surfaceId: record.id, messages: [snapshotOf(record, meta)]}));
  }

  surfaceList(): SurfaceInfo[] {
    return this.surfaces.list();
  }

  /** The watcher polls only while somebody is looking (design 2.4). */
  tabsChanged(count: number): void {
    const want = count > 0 && !this.disposed;
    if (want === this.watching || !this.loaded) return;
    this.watching = want;
    if (want) this.loaded.watcher.start(() => this.treeChanged());
    else this.loaded.watcher.stop();
  }

  // ---------------------------------------------------------------- show
  private prepare(request: ShowRequest, tools: Toolchain, registry: SourceRegistry): {draft: Draft; fixes: string[]; warnings: string[]} {
    const current = request.fresh ? undefined : this.surfaces.get(request.id);
    const compiled = compileSpec(tools, {
      surfaceId: request.id,
      ...(current ? {seed: {components: [...current.components.values()], data: current.data}} : {}),
      sources: request.sources,
      surfaces: this.surfaces.ids(),
    });
    const expansion = expandMessages(compiled.messages, registry);
    if (expansion.problems.length > 0) throw new SpecError(expansion.problems);
    const draft = this.surfaces.draft(request.id, compiled.messages, {
      fresh: request.fresh,
      ...(request.view ? {view: request.view} : {}),
      refs: expansion.refs,
      parts: compiled.texts.flatMap(namedParts),
      now: this.now(),
    });
    const unbound = [...unboundPaths(compiled.messages.flatMap(componentsOf), draft.record.data), ...draft.unknownKeys.map(key => `$/ds/${key}`)];
    return {draft, fixes: compiled.fixes, warnings: unbound.map(path => `unbound ${path}`)};
  }

  /**
   * Design 2.2, steps 2 to 9. Throws SpecError when the call is invalid; nothing has changed in that case.
   * Compile, expand and commit run without an await between them, so parallel calls cannot interleave.
   */
  async show(request: ShowRequest): Promise<ShowOutcome> {
    const [tools, services] = await Promise.all([loadToolchain(), this.services()]);
    const registry = services.deps.registry;
    // Validate first, so an invalid first call does not start the host; then again after the await, on current state.
    let prepared = this.prepare(request, tools, registry);
    if (!this.host) {
      await this.ensureHost();
      prepared = this.prepare(request, tools, registry);
    }
    const host = this.host;
    if (!host) throw new Error('the session has ended');
    const {draft, fixes, warnings} = prepared;
    const record = draft.record;
    const evicted = this.surfaces.commit(draft);

    const fresh = new Set(draft.newKeys);
    const requested = draft.mode === 'patch' ? draft.newKeys : [...record.bindings.keys()];
    const datasets = requested.map(key => this.track(record, key, fresh.has(key)));

    for (const id of evicted) host.publish(id, [deleteSurface(id)]);
    const snapshot = () => snapshotOf(record, this.meta());
    const messages = draft.mode === 'create' ? [snapshot()]
      : draft.mode === 'replace' ? [deleteSurface(record.id), snapshot()]
      : [...draft.delta, ...draft.newKeys.map(key => setData(record.id, `/ds/${key}`, record.ds[key]))];
    host.publish(record.id, messages, record.id);
    const tab = host.ensureTab();
    this.tabsChanged(host.tabs());
    void this.assignSlots();

    const first = this.shows++ === 0;
    return {
      id: record.id,
      mode: draft.mode,
      url: `${host.origin}/#/${record.id}`,
      openUrl: `${host.origin}/#t=${host.token}`,
      tab, fixes, warnings, datasets,
      parts: draft.mode === 'patch' ? [] : record.parts,
      slots: draft.mode === 'patch' ? [] : Object.keys(record.data).filter(key => key !== 'ui').map(key => `$/${key}`),
      first,
    };
  }

  // ---------------------------------------------------------------- datasets
  private effectiveRef(record: SurfaceRecord, key: string): SourceRef | undefined {
    const ref = record.bindings.get(key);
    if (!ref) return undefined;
    const drill = record.drills.get(key);
    return drill ? {...ref, target: drill} : ref;
  }

  private envelope(key: string, ref: SourceRef, outcome: Outcome): Dataset {
    const envelope = envelopeOf(key, ref, outcome);
    if (outcome.ok) this.summaries.set(envelope, outcome.result.summary.replace(/\s+/g, ' ').trim());
    return envelope;
  }

  /** Gives a dataset of a just-committed record its envelope (new keys) and returns when it will have settled. */
  private track(record: SurfaceRecord, key: string, isNew: boolean): {key: string; ref: string; settled: Promise<void>} {
    const ref = this.effectiveRef(record, key)!;
    const store = this.datasets!;
    let settled: Promise<void> = Promise.resolve();
    if (isNew) {
      const cached = store.peek(ref);
      if (cached) record.ds[key] = this.envelope(key, ref, {...cached, cached: true});
      else {
        record.ds[key] = pendingEnvelope(key, ref, resolveSource(ref.source, this.loaded!.deps.registry)?.meta);
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
    record.ds[key] = this.envelope(key, ref, outcome);
    this.host?.publish(surfaceId, [setData(surfaceId, `/ds/${key}`, record.ds[key])]);
  }

  /** Re-runs datasets of a surface. `showPending` replaces the visible data with a drafting frame while they run. */
  private rerun(record: SurfaceRecord, keys: Iterable<string>, showPending: boolean): void {
    const store = this.datasets;
    if (!store) return;
    for (const key of keys) {
      const ref = this.effectiveRef(record, key);
      if (!ref) continue;
      if (showPending) {
        record.ds[key] = pendingEnvelope(key, ref, resolveSource(ref.source, this.loaded!.deps.registry)?.meta);
        this.host?.publish(record.id, [setData(record.id, `/ds/${key}`, record.ds[key])]);
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
        const next: Record<string, number> = {};
        for (const key of slotKeys(kind, outcome.result.data)) {
          if (Object.keys(next).length >= SLOT_COUNT) break;
          if (!(key in next)) next[key] = Object.keys(next).length + 1;
        }
        this.slots = {...this.slots, [kind]: next};
        changed = changed || Object.keys(next).length > 0;
      }));
      if (changed) this.publishMeta();
    })().catch(error => this.log(`glimpse: colour slots failed: ${error instanceof Error ? error.message : String(error)}`)).finally(() => {
      this.slotsRun = undefined;
    });
    return this.slotsRun;
  }

  private publishMeta(): void {
    const meta = this.meta();
    for (const record of this.surfaces.all()) this.host?.publish(record.id, [setData(record.id, '/meta', meta)]);
  }

  // ---------------------------------------------------------------- working tree
  private treeChanged(): void {
    clearTimeout(this.treeTimer);
    this.treeTimer = setTimeout(() => void this.refreshTree(undefined), TREE_DEBOUNCE_MS);
    this.treeTimer.unref();
  }

  /**
   * The working tree or HEAD changed (or the user asked for a refresh of one surface): bump the revision, drop the
   * index, and re-run what depends on it. Visible data stays on screen until its replacement arrives.
   */
  private async refreshTree(only: string | undefined): Promise<void> {
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
    this.publishMeta();
    for (const record of this.surfaces.all()) {
      const all = record.id === only;
      const keys = [...record.bindings.keys()].filter(key => {
        const source = record.bindings.get(key)!.source;
        return all || headChanged || (resolveSource(source, deps.registry)?.meta ?? SOURCE_BY_NAME.get(source))?.wt === true;
      });
      this.rerun(record, keys, false);
    }
  }

  // ---------------------------------------------------------------- host actions (design 2.7)
  select(surfaceId: string, ref: EntityRef | null): void {
    this.events.select(ref ? selectLine(ref, surfaceId) : null);
  }

  /** gl_drill: one dataset of one surface gets a new positional target; "" restores the spec's own. */
  drill(surfaceId: string, key: string, target: string): void {
    const record = this.surfaces.get(surfaceId);
    if (!record || !record.bindings.has(key)) return;
    if (target) record.drills.set(key, target);
    else record.drills.delete(key);
    this.rerun(record, [key], true);
  }

  /**
   * gl_refresh: looks at HEAD and the working tree now and asks for every dataset of the surface again. The new
   * revision makes the working-tree sources recompute; the others are answered from memory unless HEAD moved.
   */
  refresh(surfaceId: string): void {
    if (this.surfaces.has(surfaceId)) void this.refreshTree(surfaceId);
  }

  /** gl_close, and eviction: forgets the surface and tells the tabs. */
  closeSurface(surfaceId: string): void {
    if (this.surfaces.delete(surfaceId)) this.host?.publish(surfaceId, [deleteSurface(surfaceId)]);
  }

  /** gl_open: the user's editor at a file of this repository. Returns what was refused, for the log. */
  async openFile(file: string): Promise<Problem | undefined> {
    const loc = parseFileLoc(file);
    const target = await resolveInside(this.root, loc.path);
    if (!target) return problem('E_PATH', `refused to open a path outside the project: ${JSON.stringify(loc.path.slice(0, 200))}`);
    if (!canOpen(this.options.env)) return undefined;
    const [command, args] = editorCommand(target, loc.line, this.options.env);
    (this.options.launcher ?? detachedLauncher)(command, args);
    return undefined;
  }

  // ---------------------------------------------------------------- shutdown
  /** Synchronous: stops polling, aborts running sources, kills git children, closes the host. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.treeTimer);
    if (this.watching) this.loaded?.watcher.stop();
    this.watching = false;
    this.datasets?.close();
    this.events.close();
    this.runner.killAll();
    this.host?.close();
  }
}
