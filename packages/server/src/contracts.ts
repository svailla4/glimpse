// packages/server/src/contracts.ts
// Seams between the server work packages. WP0 writes this file and stub factories; WP1-WP3 implement behind it.
import type {Field, Roles, Rows, SymbolRow, Truncation} from '@glimpse/catalog';
import type {SourceMeta, SourceRef} from '@glimpse/catalog';
import type {DiffPayload, DiffQuery, FileQuery, FileSlice, HighlightResult, OutlineResult} from '@glimpse/catalog';

export interface GitInfo { branch?: string; head?: string; shallow: boolean; defaultBranch?: string }
export type RunGit = (args: string[], opts?: {signal?: AbortSignal; maxBuffer?: number}) => Promise<Buffer>;

export interface FileEntry {
  path: string;
  lang?: string;
  loc: number;
  sloc: number;
  bytes: number;
  binary: boolean;
  tracked: boolean;
  isTest: boolean;
  generated: boolean;
}
export interface FileFacts {
  imports: Array<{spec: string; kind: string; line: number}>;
  symbols: SymbolRow[];
  /** Declarations found, when `symbols` holds only the first of them (the outline of one file stops at 2,000). */
  symbolsFound?: number;
  /** Sum of indentation levels over code lines (the "complexity" used by hotspots). */
  complexity: number;
  maxIndent: number;
  /** `owner`: the parenthetical after the tag ('TODO(ana):', 'TODO(https://…/issues/12):'), when there is one. */
  todos: Array<{tag: string; line: number; text: string; owner?: string}>;
}
/** `to` is a repo-relative path, or 'ext:<package>' for an external dependency. */
export interface ImportEdge { from: string; to: string; kind: string }

/** Shared, memoized per working-tree revision. Implemented by WP2 (analyze/), consumed by every source. */
export interface RepoIndex {
  files(): Promise<FileEntry[]>;
  facts(): Promise<ReadonlyMap<string, FileFacts>>;
  edges(): Promise<ImportEdge[]>;
  /** Module (cluster id) of a path after the adaptive tree cut (about 20 modules; never more than 40). */
  moduleOf(path: string): Promise<string>;
  /**
   * True when `path` (repo-relative, forward slashes) is a file of the inventory: tracked, or untracked and not
   * ignored. Everything under .git, ignored files, dependency directories, directories and symbolic links are not.
   * It is the one rule for "may this file be served or opened" (/api/file, /api/outline, gl_open, literal files in a
   * spec). Cheap: a set lookup on the current scan, plus one git call for a path the scan has not seen (a file
   * created since). Optional only so hand-written fakes stay small; the index from createRepoIndex always has it.
   */
  has?(path: string): Promise<boolean>;
  /**
   * The name `path` (repo-relative, forward slashes; './' and a trailing '/' are dropped) has in the inventory: the
   * path itself when it is a file or a directory of the inventory as written ('' for the root), the spelling on disk
   * when it is a case variant of one on a case-insensitive file system ('readme.md' -> 'README.md', 'SRC' -> 'src'),
   * and undefined when it names nothing of the project, by the same rule as has(). Whoever serves, opens, shows or
   * queries a path the model wrote uses this name, so every source and every label agree on one spelling (V071).
   * Optional only so hand-written fakes stay small; the index from createRepoIndex always has it.
   */
  canonical?(path: string): Promise<string | undefined>;
  /** Drop memoized results (called when the working tree changes). */
  invalidate(): void;
}

/**
 * The one rule for "is this path a file of the project that may be read, served or opened": it is in the inventory.
 * `path` is repo-relative with forward slashes. An index without has() (a hand-written fake) answers from files().
 */
export async function inInventory(index: RepoIndex, path: string): Promise<boolean> {
  if (index.has) return index.has(path);
  return (await index.files()).some(file => file.path === path);
}

/**
 * The inventory's spelling of a repo-relative path (RepoIndex.canonical): the on-disk name of a case variant, the path
 * itself otherwise. An index without canonical() (a hand-written fake) answers with the path as written; so does one
 * that fails. Use it before showing, opening or querying a path the model wrote.
 */
export async function canonicalPath(index: RepoIndex, path: string): Promise<string> {
  if (!index.canonical) return path;
  return (await index.canonical(path).catch(() => undefined)) ?? path;
}

export interface RepoContext {
  /** Absolute realpath of the project root. Nothing outside it is ever read or opened. */
  root: string;
  name: string;
  /** null when the project is not a git repository: git.* and diff.* sources then fail with E_NO_GIT. */
  git: GitInfo | null;
  /** git with cwd=root, stdio ['ignore','pipe','pipe'], core.quotepath=off, 64 MB cap. */
  runGit: RunGit;
  index: RepoIndex;
  /** Current working-tree revision (the value mirrored at /meta/rev). */
  rev(): number;
  /** stderr logger. Never write to stdout: it is the JSON-RPC channel. */
  log(message: string): void;
}

export interface SourceResult<T = unknown> {
  /** Already cut to meta.budget. */
  data: T;
  total?: number;
  truncated?: Truncation;
  fields?: Field[];
  roles?: Roles;
  warnings?: string[];
  /** Pageable rows sources: the complete row set, kept server-side for /api/ds/.../rows. */
  allRows?: Rows;
  /** One line for the model, at most 160 chars, e.g. "15/212 top src/hub/hub.ts 41 commits". */
  summary: string;
}
export interface Source {
  meta: SourceMeta;
  run(ctx: RepoContext, ref: SourceRef, signal: AbortSignal): Promise<SourceResult>;
}
export class SourceError extends Error {
  code: string;
  constructor(code: 'E_NO_GIT' | 'E_ARGS' | 'E_TARGET' | 'E_SHALLOW' | 'E_INTERNAL', message: string) {
    super(message);
    this.code = code;
  }
}

export interface CodeService {
  file(q: FileQuery): Promise<FileSlice>;
  highlight(code: string, lang?: string): Promise<HighlightResult>;
  outline(path: string): Promise<OutlineResult>;
}
export interface DiffService { diff(q: DiffQuery): Promise<DiffPayload> }
export interface TreeWatcher {
  /**
   * Polls while started; calls onChange after HEAD, the index or any dirty/untracked file changes. The watcher
   * remembers the last state it saw across stop() and start() (its first reference is taken when it is created),
   * so a change made while nobody was watching is reported by the first poll after start().
   */
  start(onChange: () => void): void;
  stop(): void;
  /**
   * Looks at HEAD and the working tree now, whether or not the watcher is started: true when they differ from the
   * last state this watcher saw (through a poll or an earlier check), which then becomes the reference. The
   * session calls it before serving a tool call and refreshes when it answers true, so results never depend on a
   * tab being connected. Works without git (a walk of file sizes and times). Never rejects: a failed look is false.
   * Optional only so hand-written fakes stay small; the watcher from createTreeWatcher always has it.
   */
  check?(): Promise<boolean>;
}

// Factories. WP0 ships inert stubs; the owning package replaces the file and keeps the signature.
//   analyze/index.ts        createRepoIndex(root: string, runGit: RunGit, log: (m: string) => void): RepoIndex     (WP2)
//   sources/files/index.ts  export const sources: Source[]   files.* repo.* deps.* code.*                          (WP2)
//   git/index.ts            readGitInfo(root: string, runGit: RunGit): Promise<GitInfo | null>;
//                           createDiffService(ctx: RepoContext, code: CodeService): DiffService;
//                           createTreeWatcher(ctx: RepoContext): TreeWatcher                                       (WP3)
//   code/index.ts           createCodeService(ctx: RepoContext): CodeService                                       (WP3)
//   sources/git/index.ts    export const sources: Source[]   git.* diff.*                                          (WP3)
//
// Who builds what is not a factory above:
// - The production RunGit belongs to the server core (WP1, under src/session/ or src/host/): it spawns git as
//   described on RepoContext.runGit, tracks its children and kills them on shutdown. The analyzers and the git
//   package only ever call ctx.runGit (or the runGit they are handed); they never spawn git themselves. Tests use
//   createRunGit(root) from test/fixtures/repo.ts.
// - The colour slots at /meta/slots (design 2.4) are computed by the server core from the results of three sources
//   run through the registry: files.langs (languages by LOC), deps.modules (clusters by LOC) and git.authors
//   (authors by commits). No source and no analyzer writes /meta.
// - Composition: src/main.ts is the only module that imports the real factories and REGISTRY (sources/all.ts). The
//   rest of the server core takes them as parameters ({registry, createRepoIndex, createCodeService,
//   createDiffService, createTreeWatcher, readGitInfo}), so its tests run on fakes without loading analyzer or git code.
