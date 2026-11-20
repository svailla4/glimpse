// packages/catalog/src/transport.ts
// Everything that crosses the loopback HTTP boundary between packages/server (host) and packages/viewer.
import type {EntityRef, FileLoc, Rows, SymbolRow} from './datasets.ts';

export const TRANSPORT_VERSION = 1;
export const A2UI_MIME = 'application/a2ui+json';

// ---- A2UI v1.0 messages Glimpse emits (a subset of the spec envelope; version is the string "1.0") ----
export interface WireComponent { id: string; component: string; [prop: string]: unknown }
export type A2uiMessage =
  | {version: '1.0'; createSurface: {surfaceId: string; catalogId: string; components: WireComponent[]; dataModel?: Record<string, unknown>}}
  | {version: '1.0'; updateComponents: {surfaceId: string; components: WireComponent[]}}
  | {version: '1.0'; updateDataModel: {surfaceId: string; path?: string; value: unknown}}
  | {version: '1.0'; deleteSurface: {surfaceId: string}};

/** Body of a v1.0 renderer->agent `action` message (what @a2ui/web_core hands to the action handler). */
export interface ActionPayload {
  name: string;
  surfaceId: string;
  sourceComponentId: string;
  timestamp: string;
  context: Record<string, unknown>;
  userMessage?: string;
}
export type RendererMessage =
  | {version: '1.0'; action: ActionPayload}
  | {version: '1.0'; error: {code: string; message: string; surfaceId?: string; path?: string}};

// ---- render reports: renderer `error` messages a Glimpse tab posts about one component ----
// message is `Name#id: text`. A report is the component's CURRENT state, not an event: the tab re-sends it whenever
// the component is (re)defined by an update, and withdraws it with REPORT_OK once the component draws normally.
//   I_*  a truthful empty or waiting state (no import cycles, no uncommitted changes, waiting for a selection):
//        never told to the model as a problem.
//   W_*  the component could not draw what the spec asked (W_EMPTY: bound or inline data is missing or empty,
//        W_FIELD: a named field is not in the data, W_SHAPE, W_FOCUS, ...): the model is told.
//   E_*  a redline: the model is told.
export const REPORT_OK = 'OK';
export type ReportCode = typeof REPORT_OK | `I_${string}` | `W_${string}` | `E_${string}`;
/** True for a report the model must hear about (W_* and E_*). */
export function isProblemReport(code: string): boolean {
  return code.startsWith('W_') || code.startsWith('E_');
}

// ---- host actions: names starting with gl_ are handled by the server and never reach the model ----
export const HOST_ACTION_PREFIX = 'gl_';
export interface HostActionContext {
  /** Selection changed (debounced 150 ms by the viewer). Stored as pending context for the agent. */
  gl_select: {ref: EntityRef | null};
  /** Open in the user's editor. */
  gl_open: {file: FileLoc};
  /** Re-run dataset `ds` of this surface with a new positional target ("" = back to the original). */
  gl_drill: {ds: string; target: string};
  /** Re-run every dataset of this surface. */
  gl_refresh: Record<string, never>;
  /** Close this surface (sent by the shell with sourceComponentId "root"). */
  gl_close: Record<string, never>;
}
export type HostActionName = keyof HostActionContext;

// ---- SSE: GET /api/events?t=<token> ; every frame is `event: glimpse` + `data: <ServerEvent JSON>` ----
export interface SessionInfo { id: string; project: string; repo: {name: string; branch?: string; head?: string}; version: string }
export interface SurfaceInfo { id: string; title: string; view?: string; createdAt: number; updatedAt: number }
export type ServerEvent =
  /** First frame on every connection. A new `epoch` means: dispose all processors, then apply the replay that follows. */
  | {type: 'hello'; v: 1; epoch: string; session: SessionInfo; surfaces: SurfaceInfo[]; focus?: string}
  /** A2UI messages for one surface, applied in order with processMessagesWithErrors. `focus` asks the shell to show that surface. */
  | {type: 'a2ui'; seq: number; surfaceId: string; messages: A2uiMessage[]; surfaces: SurfaceInfo[]; focus?: string}
  | {type: 'bye'; reason: 'shutdown'};

// ---- POST /api/renderer  (content-type application/json, body RendererPost, answers 204) ----
export interface RendererPost { messages: RendererMessage[] }

// ---- data endpoints (GET unless noted; all require `Authorization: Bearer <token>`) ----
/** Index into TOKEN_CLASSES. The viewer renders <span class="gl-tok-kw"> etc.; class 0 is plain text. */
export type TokenClass = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const TOKEN_CLASSES = ['', 'kw', 'str', 'fn', 'type', 'num', 'const', 'com'] as const;
export type TokenLine = Array<[text: string, cls: TokenClass]>;

/** GET /api/ds/:surfaceId/:key/rows?offset=&limit=&sort=&q= */
export interface RowsQuery { surfaceId: string; key: string; offset?: number; limit?: number; sort?: string; q?: string }
export interface RowsPage { rows: Rows; total: number; offset: number }

/** GET /api/file?path=&start=&end=  (1-based inclusive lines; default the first 400) */
export interface FileQuery { path: string; start?: number; end?: number }
export interface FileSlice {
  path: string;
  lang: string;
  /** Total lines in the file. */
  total: number;
  start: number;
  end: number;
  lines: TokenLine[];
  size: number;
  /**
   * Set instead of lines when the file cannot be shown. 'outside-root' is said of every path that is not a file of
   * the project's inventory, whether or not it exists on disk: outside the root, ignored by git, under .git.
   */
  skipped?: 'binary' | 'too-large' | 'missing' | 'outside-root';
  /** /meta/rev the slice was read at. */
  rev: number;
}

/** POST /api/highlight  body {code, lang?} */
export interface HighlightResult { lang: string; lines: TokenLine[] }

/** GET /api/outline?path= */
export interface OutlineResult { path: string; symbols: SymbolRow[] }

/** GET /api/diff?range=&path=  (range: 'wt' | 'staged' | git range) */
export interface DiffQuery { range: string; path?: string }
export interface DiffLine {
  t: ' ' | '+' | '-';
  /** Old / new line numbers. */
  o?: number;
  n?: number;
  tokens: TokenLine;
  /** Word-level changed character ranges [from, to) within the line. */
  marks?: Array<[from: number, to: number]>;
}
export interface DiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; header: string; lines: DiffLine[] }
export interface DiffFile {
  path: string;
  from?: string;
  status: 'A' | 'M' | 'D' | 'R';
  add: number;
  del: number;
  lang?: string;
  binary?: boolean;
  /** Omitted when the payload budget (30 files / 3,000 changed lines) is exhausted: refetch with ?path=. */
  hunks?: DiffHunk[];
}
export interface DiffPayload { range: string; base?: string; head?: string; files: DiffFile[]; totals: {files: number; add: number; del: number}; rev: number }

/** GET /api/health */
export interface Health { app: 'glimpse'; version: string; epoch: string; tabs: number }

/** Everything a view may fetch outside the data model. Views get it from useHost(); they never call fetch(). */
export interface DataClient {
  rows(q: RowsQuery, signal?: AbortSignal): Promise<RowsPage>;
  file(q: FileQuery, signal?: AbortSignal): Promise<FileSlice>;
  diff(q: DiffQuery, signal?: AbortSignal): Promise<DiffPayload>;
  highlight(code: string, lang?: string, signal?: AbortSignal): Promise<HighlightResult>;
  outline(path: string, signal?: AbortSignal): Promise<OutlineResult>;
}

export type LinkStatus = 'connecting' | 'live' | 'ended';
/** Viewer side of the link. HubTransport (SSE + fetch) today; FixtureTransport for tests; an MCP Apps transport later. */
export interface Transport extends DataClient {
  connect(onEvent: (e: ServerEvent) => void, onStatus: (s: LinkStatus) => void): () => void;
  send(messages: RendererMessage[]): void;
}
