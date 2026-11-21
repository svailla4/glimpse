// packages/catalog/src/notation.ts
// Text notations, pure functions, no Mermaid dependency, never throw on input.
// - Flowchart.src and SequenceDiagram.src (Mermaid-style arrows): parsed by the server (validates literal src at show
//   time) and by the viewer (parses, lays out, paints).
// - Data written as text (a Mermaid graph or erDiagram, a Markdown table, a task list, 'Key: value' and 'Tier: items'
//   lines): parsed by the server only, which puts the data shapes of datasets.ts where the text was. The viewer never
//   imports these parsers (tree-shaken), so the wire format and the tab do not change.
import {COMPONENT_BY_NAME} from './components.ts';
import type {
  ErColumn, ErData, ErRelation, ErTable, Field, FieldKind, GraphData, GraphEdge, GraphGroup, GraphNode, LayerItem, Rows,
  StatItem, StepItem, StepStatus,
} from './datasets.ts';

/** `statement` is the 1-based statement number for parseFlow/parseSequence; the data parsers set it to `line`. */
export interface NotationError { statement: number; message: string; line?: number; col?: number; example?: string }
/** A slip the parser corrected: `message` without the where/line prefix, at most 80 characters. */
export interface NotationFix { line: number; message: string }
export type ParseResult<T> =
  | {ok: true; ast: T; fixes?: NotationFix[]; dir?: 'LR' | 'TB'}
  | {ok: false; errors: NotationError[]};

export type FlowShape = 'box' | 'diamond' | 'pill' | 'store' | 'circle';
export interface FlowNode { id: string; label: string; shape: FlowShape }
export interface FlowEdge { from: string; to: string; label?: string; dashed?: boolean }
export interface FlowAst { nodes: FlowNode[]; edges: FlowEdge[] }

export type SeqArrow = 'sync' | 'reply' | 'async';
/** The Mermaid blocks drawn as a labelled frame round their steps. */
export type SeqFrameOp = 'loop' | 'alt' | 'opt' | 'par' | 'critical' | 'break';
export type SeqStep =
  | {kind: 'message'; from: string; to: string; label: string; arrow: SeqArrow}
  | {kind: 'note'; over: string[]; text: string}
  /** A block: `open` (alt, loop ...), `else` (a divider: else, and, option) and `end`, always balanced. */
  | {kind: 'frame'; edge: 'open'; op: SeqFrameOp; label: string}
  | {kind: 'frame'; edge: 'else'; label: string}
  | {kind: 'frame'; edge: 'end'};
export interface SeqAst { actors: Array<{id: string; label: string}>; steps: SeqStep[] }

// ---------------------------------------------------------------- statements
const clip = (text: string, max = 40) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
/** Line breaks of the data notations: \r\n, \r and \n. */
const LINE_BREAK = /\r\n|\r|\n/;

interface Part { text: string; start: number }
interface Statement { text: string; line: number; col: number }
/** How a line is cut into statements: on ';' outside brackets, pipes and quotes; outside quotes; anywhere. */
type SplitMode = 'brackets' | 'quotes' | 'plain';

/** Splits a line on ';' (see SplitMode); each part keeps its offset in the line. */
function splitLine(line: string, mode: SplitMode): Part[] {
  const out: Part[] = [];
  let depth = 0;
  let pipe = false;
  let quote = false;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (mode !== 'plain') {
      if (quote) { if (c === '"') quote = false; continue; }
      if (c === '"') { quote = true; continue; }
    }
    if (mode === 'brackets') {
      if (c === '|' && depth === 0) { pipe = !pipe; continue; }
      if (pipe) continue;
      if (c === '[' || c === '(' || c === '{') { depth++; continue; }
      if (c === ']' || c === ')' || c === '}') { depth = Math.max(0, depth - 1); continue; }
    }
    if (c === ';' && depth === 0) { out.push({text: line.slice(start, i), start}); start = i + 1; }
  }
  out.push({text: line.slice(start), start});
  return out;
}

/**
 * Statements after dropping blanks, `%%` comments and a leading header, each with its line and the 1-based column of
 * its first character. parseFlow/parseSequence number them in order (index + 1).
 */
function positionedStatements(src: string, header: RegExp | undefined, mode: SplitMode, breaks: RegExp = /\r?\n/): Statement[] {
  const out: Statement[] = [];
  src.split(breaks).forEach((line, i) => {
    if (line.trim().startsWith('%%')) return;
    for (const part of splitLine(line, mode)) {
      const text = part.text.trim();
      if (!text || text.startsWith('%%')) continue;
      out.push({text, line: i + 1, col: part.start + (part.text.length - part.text.trimStart().length) + 1});
    }
  });
  if (header && out.length > 0 && header.test(out[0]!.text)) out.shift();
  return out;
}

function statements(src: string, header: RegExp, bracketAware: boolean): string[] {
  return positionedStatements(src, header, bracketAware ? 'brackets' : 'plain').map(s => s.text);
}

// ---------------------------------------------------------------- flow
const FLOW_HEADER = /^(?:flowchart|graph)(?:\s+(?:TD|TB|BT|LR|RL))?$/i;
/** Mermaid statements that carry no nodes or edges; accepted and skipped so pasted Mermaid still renders. */
const FLOW_IGNORED = /^(?:classDef|class|style|linkStyle|click|direction|subgraph)\b|^end$/;
const ID = /^[A-Za-z_][A-Za-z0-9_]*/;
/** [open, close, shape], longest opener first. */
const SHAPES: ReadonlyArray<readonly [string, string, FlowShape]> = [
  ['([', '])', 'pill'], ['[(', ')]', 'store'], ['((', '))', 'circle'], ['{{', '}}', 'diamond'],
  ['[', ']', 'box'], ['{', '}', 'diamond'], ['(', ')', 'box'],
];
const ARROW = /^(-\.+->|-\.+-(?!>)|-{2,}>|={2,}>|-{3,})\s*(?:\|([^|]*)\|)?/;
const ARROW_TEXT: ReadonlyArray<readonly [RegExp, boolean]> = [
  [/^--\s+(.+?)\s+-{2,}>/, false],      // -- label -->
  [/^-\.\s*(.+?)\s*\.+->/, true],       // -. label .->
  [/^==\s+(.+?)\s+={2,}>/, false],      // == label ==>
];
const CLASS_SUFFIX = /^:::([A-Za-z_][\w-]*)/;

/**
 * `message` is what parseFlow reports (pinned by tests); `column` (1-based within the statement), `bare` (the message
 * without the column) and `example` (a corrected statement) are what parseGraph reports.
 */
class FlowSyntaxError extends Error {
  readonly column: number;
  readonly bare: string;
  readonly example: string | undefined;
  constructor(message: string, column: number, bare: string, example?: string) {
    super(message);
    this.column = column;
    this.bare = bare;
    this.example = example;
  }
}

function unquote(label: string): string {
  const t = label.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

interface FlowBuilder {
  nodes: Map<string, FlowNode & {explicit: boolean}>;
  edges: FlowEdge[];
  /** `:::name` written after a node, in order (parseGraph reads them; parseFlow ignores them). */
  classes: Array<{id: string; name: string}>;
  /** parseGraph: the innermost open subgraph, and each node's group at its first mention inside one. */
  group?: string;
  groupOf: Map<string, string>;
  /** parseGraph: repairs made in the current statement. */
  repaired: string[];
}

const newBuilder = (): FlowBuilder => ({nodes: new Map(), edges: [], classes: [], groupOf: new Map(), repaired: []});

/** The free-text slug: every run of characters that are not letters or digits becomes '_'; a leading digit gets 'n_'. */
function slug(label: string): string {
  const s = label.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  if (s === '') return '';
  return /^[\p{L}_]/u.test(s) ? s : `n_${s}`;
}

/**
 * A node written as plain words instead of `id[label]`: "Enter credentials --> Valid?". The words up to the next
 * arrow (or `&`, `:::`, or the end) are the label, the id is the label with every other character run turned into `_`
 * ("Enter_credentials", so the same words name the same node and "Valid?" is also reachable as `Valid`), and a
 * trailing `?` makes it a diamond. Text that is a plain id, or that contains brackets, pipes or `>`, is not free
 * text: the id[label] grammar reads it and reports what is wrong with it. With `repairs`, a single-dash `->` also
 * ends the words (parseGraph reads it as `-->`).
 */
function freeNode(rest: string, repairs: boolean): {id: string; label: string; length: number} | undefined {
  const stop = rest.search(repairs ? /--|-\.|==|&|:::|->/ : /--|-\.|==|&|:::/);
  const raw = stop < 0 ? rest : rest.slice(0, stop);
  const text = raw.trim();
  const label = /^"[^"]+"$/.test(text) ? text.slice(1, -1).trim() : text;
  if (label === '' || /[[\]{}()|<>"]/.test(label) || /^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) return undefined;
  const id = slug(label);
  if (id === '') return undefined;
  return {id, label, length: raw.length};
}

/** The author's node with its closer appended: 'C[open --> B' -> 'C[open]'. */
function closedNode(nodeText: string, close: string): string {
  const cut = nodeText.search(/\s+(?:--|-\.|==|&)/);
  return (cut < 0 ? nodeText : nodeText.slice(0, cut)).trimEnd() + close;
}

function parseFlowStatement(text: string, b: FlowBuilder, opts: {repairs?: boolean} = {}): void {
  const repairs = opts.repairs === true;
  let pos = 0;
  /** The last node read as a bare id (no shape): where it started and ended, for the 'web-app[Web]' message. */
  let bareId: {id: string; start: number; end: number} | undefined;
  let lastNode = '';
  const rest = () => text.slice(pos);
  const skip = () => { while (pos < text.length && /\s/.test(text[pos]!)) pos++; };
  const found = () => (pos >= text.length ? 'end of statement' : `"${clip(rest(), 16)}"`);
  const mention = (id: string) => {
    if (b.group !== undefined && !b.groupOf.has(id)) b.groupOf.set(id, b.group);
    const c = CLASS_SUFFIX.exec(rest());
    if (c) { pos += c[0].length; b.classes.push({id, name: c[1]!}); }
    lastNode = id;
    return id;
  };

  const node = (): string => {
    skip();
    bareId = undefined;
    const start = pos;
    const free = freeNode(rest(), repairs);
    if (free) {
      pos += free.length;
      if (!b.nodes.has(free.id)) b.nodes.set(free.id, {id: free.id, label: free.label, shape: free.label.endsWith('?') ? 'diamond' : 'box', explicit: true});
      return mention(free.id);
    }
    const m = ID.exec(rest());
    if (!m) throw new FlowSyntaxError(`expected a node id at column ${pos + 1}, found ${found()}`, pos + 1, `expected a node id, found ${found()}`, 'a[Label] --> b[Label]');
    const id = m[0];
    pos += id.length;
    let shape: FlowShape | undefined;
    let label = id;
    for (const [open, close, kind] of SHAPES) {
      if (!text.startsWith(open, pos)) continue;
      const from = pos + open.length;
      // A quoted label may contain the closing bracket.
      const quoted = /^\s*"/.test(text.slice(from)) ? text.indexOf('"', text.indexOf('"', from) + 1) : -1;
      const end = text.indexOf(close, quoted >= 0 ? quoted + 1 : from);
      if (end < 0) throw new FlowSyntaxError(`unclosed "${open}" in node ${id} (column ${pos + 1})`, pos + 1, `unclosed "${open}" in node ${id}`, closedNode(text.slice(start), close));
      label = unquote(text.slice(from, end)) || id;
      shape = kind;
      pos = end + close.length;
      break;
    }
    if (shape === undefined) bareId = {id, start, end: pos};
    const known = b.nodes.get(id);
    if (!known) b.nodes.set(id, {id, label, shape: shape ?? 'box', explicit: shape !== undefined});
    else if (!known.explicit && shape !== undefined) Object.assign(known, {label, shape, explicit: true});
    return mention(id);
  };
  const group = (): string[] => {
    const ids = [node()];
    for (skip(); text[pos] === '&'; skip()) { pos++; ids.push(node()); }
    return ids;
  };
  const edge = (): {label?: string; dashed: boolean} => {
    const m = ARROW.exec(rest());
    if (m) {
      pos += m[0].length;
      const label = m[2]?.trim();
      return {dashed: m[1]!.includes('.'), ...(label ? {label: unquote(label)} : {})};
    }
    for (const [re, dashed] of ARROW_TEXT) {
      const t = re.exec(rest());
      if (!t) continue;
      pos += t[0].length;
      return {dashed, label: unquote(t[1]!)};
    }
    const single = repairs ? /^->(?!>)\s*(?:\|([^|]*)\|)?/.exec(rest()) : null;
    if (single) {
      pos += single[0].length;
      b.repaired.push('->');
      const label = single[1]?.trim();
      return {dashed: false, ...(label ? {label: unquote(label)} : {})};
    }
    const message = `expected an arrow (-->, -->|label|, -- label -->, -.->) at column ${pos + 1}, found ${found()}`;
    let bare = `expected an arrow (-->, -->|label|, -- label -->, -.->), found ${found()}`;
    let column = pos + 1;
    let example = 'a -->|label| b';
    const dashed = bareId && bareId.end === pos ? /^(?:-[A-Za-z0-9_]+)+/.exec(rest()) : null;
    const both = /^<[-=.]+>/.exec(rest());
    const wrong = /^(?:=>|->>|~>)/.exec(rest());
    if (dashed && bareId) {
      const written = bareId.id + dashed[0];
      const fixed = written.replace(/-/g, '_');
      bare = `node ids are letters, digits and _: write ${fixed}`;
      column = bareId.start + 1;
      example = text.split(written).join(fixed);
    } else if (both) {
      const to = ID.exec(text.slice(pos + both[0].length).trimStart())?.[0];
      bare = `"${both[0]}" is not an edge: write two, a --> b and b --> a`;
      example = to ? `${lastNode} --> ${to}; ${to} --> ${lastNode}` : 'a --> b; b --> a';
    } else if (wrong) {
      example = text.slice(0, pos) + '-->' + text.slice(pos + wrong[0].length);
    }
    throw new FlowSyntaxError(message, column, bare, example);
  };

  let from = group();
  for (skip(); pos < text.length; skip()) {
    const e = edge();
    const to = group();
    for (const a of from) {
      for (const z of to) b.edges.push({from: a, to: z, ...(e.label ? {label: e.label} : {}), ...(e.dashed ? {dashed: true} : {})});
    }
    from = to;
  }
}

/**
 * Flowchart notation. `statement := node (edge node)*`; shapes `[box]`, `{diamond}`, `([pill])`, `[(store)]`,
 * `((circle))`; edges `-->`, `-->|label|`, `-- label -->`, `-.->`, `-.->|label|`, `-.-`. Also accepted from Mermaid:
 * `A & B --> C`, `==>`, `---`, `-. label .->`, quoted labels, `A[x]:::cls` (class ignored), and styling / subgraph
 * lines (skipped).
 */
export function parseFlow(src: string): ParseResult<FlowAst> {
  const b = newBuilder();
  const errors: NotationError[] = [];
  statements(src, FLOW_HEADER, true).forEach((text, i) => {
    if (FLOW_IGNORED.test(text)) return;
    try {
      parseFlowStatement(text, b);
    } catch (e) {
      if (!(e instanceof FlowSyntaxError)) throw e;
      errors.push({statement: i + 1, message: e.message});
    }
  });
  if (errors.length === 0 && b.nodes.size === 0) errors.push({statement: 1, message: 'no statements: expected something like "A[Start] --> B{Decision}"'});
  if (errors.length > 0) return {ok: false, errors};
  return {ok: true, ast: {nodes: [...b.nodes.values()].map(({id, label, shape}) => ({id, label, shape})), edges: b.edges}};
}

// ---------------------------------------------------------------- sequence
const SEQ_HEADER = /^sequenceDiagram$/i;
/** Mermaid bookkeeping lines; accepted and skipped. */
const SEQ_IGNORED = /^(?:autonumber|activate|deactivate|title)\b/i;
/** Blocks drawn as frames, their dividers, and the blocks that only group or colour (rect, box): balanced, not drawn. */
const SEQ_OPEN = /^(loop|alt|opt|par|critical|break)(?:\s+(.*))?$/i;
const SEQ_DIVIDER = /^(else|and|option)(?:\s+(.*))?$/i;
const SEQ_GROUP = /^(?:rect|box)\b/i;
const SEQ_PARTICIPANT = /^(?:participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/i;
const SEQ_NOTE = /^note\s+(?:over|left\s+of|right\s+of)\s+([^:]+?)\s*:\s*(.*)$/i;
// A message is `sender arrow receiver [: text]`. The sender cannot contain ':' (the text may contain arrows), and the
// receiver may be empty here so that a missing one is reported instead of being guessed from the arrow's own characters.
const seqMessage = (arrows: string) => new RegExp(`^([^:]+?)\\s*(${arrows})\\s*[+-]?\\s*([^:]*?)\\s*(?::\\s*(.*))?$`);
/** Tried in order: the `x` (lost message) arrows last, so the hyphen in "auth-xml->>db" is not read as an arrow. */
const SEQ_MESSAGES = [seqMessage('-->>|->>|--\\)|-\\)|-->|->'), seqMessage('--x|-x')];
const SEQ_ARROWS: Record<string, SeqArrow> = {
  '->>': 'sync', '->': 'sync', '-x': 'sync', '-->>': 'reply', '-->': 'reply', '--x': 'reply', '-)': 'async', '--)': 'async',
};
/** An actor id starts with a letter, a digit or '_' and contains no arrow ("auth-service" and "API v2" are fine). */
const isActorId = (id: string) => /^[\p{L}\p{N}_]/u.test(id) && !/--?>|--?\)/.test(id);

/**
 * Sequence notation. `A->>B: text` sync, `A-->>B: text` reply, `A-)B: text` async, `Note over A[,B]: text`,
 * `participant A [as Label]`. Actors appear in order of first mention; `A->>A: text` is a self-message. Mermaid
 * blocks `alt|opt|loop|par|critical|break label` … `else|and|option label` … `end` become balanced frame steps; a
 * block left open is closed at the end and an `end` or `else` outside one is skipped, both said as fixes.
 */
export function parseSequence(src: string): ParseResult<SeqAst> {
  const actors = new Map<string, {id: string; label: string}>();
  const steps: SeqStep[] = [];
  const errors: NotationError[] = [];
  const fixes = fixList();
  /** Open blocks, innermost last: a frame (alt ...) or a group that is not drawn (rect, box). */
  const open: Array<{op: SeqFrameOp | 'group'; line: number}> = [];
  const actor = (id: string, label?: string) => {
    const known = actors.get(id);
    if (!known) actors.set(id, {id, label: label ?? id});
    else if (label) known.label = label;
    return id;
  };
  const block = (text: string, line: number): boolean => {
    const opened = SEQ_OPEN.exec(text);
    if (opened) {
      const op = opened[1]!.toLowerCase() as SeqFrameOp;
      open.push({op, line});
      steps.push({kind: 'frame', edge: 'open', op, label: (opened[2] ?? '').trim()});
      return true;
    }
    if (SEQ_GROUP.test(text)) { open.push({op: 'group', line}); return true; }
    const divider = SEQ_DIVIDER.exec(text);
    if (divider) {
      const top = open.at(-1);
      if (top && top.op !== 'group') steps.push({kind: 'frame', edge: 'else', label: (divider[2] ?? '').trim()});
      else fixes.add('QF2', line, `'${divider[1]!.toLowerCase()}' outside alt/par/critical skipped`);
      return true;
    }
    if (/^end$/i.test(text)) {
      const top = open.pop();
      if (!top) fixes.add('QF3', line, `'end' closes no block: skipped`);
      else if (top.op !== 'group') steps.push({kind: 'frame', edge: 'end'});
      return true;
    }
    return false;
  };
  positionedStatements(src, SEQ_HEADER, 'plain').forEach(({text, line}, i) => {
    const fail = (message: string) => { errors.push({statement: i + 1, message}); };
    let m = SEQ_PARTICIPANT.exec(text);
    if (m) {
      const id = m[1]!.trim();
      if (isActorId(id)) actor(id, m[2]?.trim());
      else fail(`"${clip(id)}" is not an actor name: expected "participant A" or "participant A as Label"`);
      return;
    }
    m = SEQ_NOTE.exec(text);
    if (m) {
      const over = m[1]!.split(',').map(a => a.trim()).filter(Boolean);
      const bad = over.find(a => !isActorId(a));
      if (over.length === 0 || bad !== undefined) fail(`a note needs actor names${bad === undefined ? '' : `, found "${clip(bad)}"`}: "Note over A,B: text"`);
      else steps.push({kind: 'note', over: over.map(a => actor(a)), text: m[2]!.trim()});
      return;
    }
    for (const pattern of SEQ_MESSAGES) {
      m = pattern.exec(text);
      if (!m) continue;
      const from = m[1]!.trim();
      const to = m[3]!.trim();
      if (!isActorId(from) || !isActorId(to)) fail(`a message needs an actor on both sides of the arrow: "A${m[2]}B: text", found "${clip(text)}"`);
      else steps.push({kind: 'message', from: actor(from), to: actor(to), label: (m[4] ?? '').trim(), arrow: SEQ_ARROWS[m[2]!]!});
      return;
    }
    if (SEQ_IGNORED.test(text) || block(text, line)) return;
    fail(`expected "A->>B: text", "A-->>B: text", "A-)B: text", "Note over A: text" or "participant A", found "${clip(text)}"`);
  });
  for (const left of open.reverse()) {
    if (left.op === 'group') continue;
    steps.push({kind: 'frame', edge: 'end'});
    fixes.add('QF1', left.line, `${left.op} closed at the end (no 'end')`);
  }
  if (errors.length === 0 && !steps.some(step => step.kind !== 'frame')) errors.push({statement: 1, message: 'no messages: expected something like "User->>API: POST /login"'});
  if (errors.length > 0) return {ok: false, errors};
  const list = fixes.list();
  return {ok: true, ast: {actors: [...actors.values()], steps}, ...(list.length > 0 ? {fixes: list} : {})};
}

// ---------------------------------------------------------------- shared by the data notations
/** Repairs, at most one per kind per string: the first line, then " (+N more lines)" for the other lines it applied to. */
function fixList() {
  const byKind = new Map<string, {line: number; message: string; lines: Set<number>}>();
  return {
    add(kind: string, line: number, message: string) {
      const known = byKind.get(kind);
      if (known) known.lines.add(line);
      else byKind.set(kind, {line, message, lines: new Set([line])});
    },
    list(): NotationFix[] {
      return [...byKind.values()].sort((a, b) => a.line - b.line).map(f => {
        const more = f.lines.size > 1 ? ` (+${f.lines.size - 1} more lines)` : '';
        return {line: f.line, message: clip(f.message, 80 - more.length) + more};
      });
    },
  };
}
type Fixes = ReturnType<typeof fixList>;

/** The result of a data parser: errors (sorted by line and column) win; fixes and dir only on success. */
function finish<T>(ast: T, errors: NotationError[], fixes: Fixes, dir?: 'LR' | 'TB'): ParseResult<T> {
  if (errors.length > 0) {
    return {ok: false, errors: errors.map((e, i) => ({e, i})).sort((a, b) => (a.e.line ?? 0) - (b.e.line ?? 0) || (a.e.col ?? 0) - (b.e.col ?? 0) || a.i - b.i).map(x => x.e)};
  }
  const list = fixes.list();
  return {ok: true, ast, ...(list.length > 0 ? {fixes: list} : {}), ...(dir ? {dir} : {})};
}

const error = (line: number, col: number, message: string, example?: string): NotationError =>
  ({statement: line, line, col, message, ...(example !== undefined ? {example} : {})});

/** Outer `**x**`, `__x__` or `` `x` `` around the whole text. */
function stripEmphasis(text: string): string {
  let t = text.trim();
  for (let i = 0; i < 3; i++) {
    const m = /^\*\*(.+)\*\*$/s.exec(t) ?? /^__(.+)__$/s.exec(t) ?? /^`(.+)`$/s.exec(t);
    if (!m) break;
    t = m[1]!.trim();
  }
  return t;
}

/**
 * A number written the way JavaScript prints it, after dropping one leading '+', reading a leading U+2212 as '-' and
 * removing thousands commas: '12', '-3', '0.5', '1,866', '+12'. '007', '1.10', '2.0', '1e3', '12%' are not numbers.
 */
function canonicalNumber(raw: string): number | undefined {
  let t = raw.trim();
  if (t.startsWith('+')) t = t.slice(1);
  else if (t.startsWith('−')) t = '-' + t.slice(1);
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(t)) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || String(Math.abs(n)) !== t.replace(/^-/, '')) return undefined;
  return n === 0 ? 0 : n;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const indentOf = (line: string) => line.length - line.trimStart().length;

/** The first `[[path]]` that is a repository path (not a URL), removed from the text; whitespace around it becomes one space. */
function takeFile(text: string): {text: string; file?: string} {
  for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const file = m[1]!.trim();
    if (file === '' || URL_SCHEME.test(file)) continue;
    const before = text.slice(0, m.index).replace(/\s+$/, '');
    const after = text.slice(m.index + m[0].length).replace(/^\s+/, '');
    return {text: (before && after ? `${before} ${after}` : before + after).trim(), file};
  }
  return {text: text.trim()};
}

/** Splits off a note at the first ' — ', ' – ' or ' -- ' (whitespace on both sides; ' - ' is never one). */
function splitNote(text: string): {head: string; note?: string} {
  const m = /(?:^|\s+)(?:—|–|--)\s+/.exec(text);
  if (!m) return {head: text.trim()};
  const note = text.slice(m.index + m[0].length).trim();
  return {head: text.slice(0, m.index).trim(), ...(note ? {note} : {})};
}

const MERMAID_DIR: Readonly<Record<string, 'LR' | 'TB'>> = {TD: 'TB', TB: 'TB', BT: 'TB', LR: 'LR', RL: 'LR'};
const dirOf = (word: string): 'LR' | 'TB' | undefined => (Object.hasOwn(MERMAID_DIR, word.toUpperCase()) ? MERMAID_DIR[word.toUpperCase()] : undefined);

/** `click <id> ["href"] ("path" | token) ["tooltip"] [target]`, shared by graph and erDiagram. */
type Click = {id: string; file: string} | {id: string; error: string; example: string} | {id: string; ignored: string};
function readClick(text: string): Click | undefined {
  const m = /^click\s+("[^"]+"|\S+)\s*(.*)$/.exec(text);
  if (!m) return undefined;
  const id = unquote(m[1]!);
  let rest = m[2]!.trim().replace(/^href\s+/, '');
  let file: string | undefined;
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    file = (end < 0 ? rest.slice(1) : rest.slice(1, end)).trim();
  } else {
    const token = rest.split(/\s+/)[0] ?? '';
    rest = token;
    if (token !== '' && !/[/.]/.test(token)) return {id, ignored: `click ${id} ${clip(token, 20)} ignored: give a file, click ${id} "path"`};
    file = token;
  }
  if (!file) return {id, error: `click ${id} needs a file in quotes`, example: `click ${id} "src/a.ts#L10-20"`};
  if (URL_SCHEME.test(file)) return {id, error: `click ${id} links a URL: a node opens a file of this repository`, example: `click ${id} "src/a.ts"`};
  return {id, file};
}

// ---------------------------------------------------------------- graph (Graph.data)
const GRAPH_HEADER = /^(?:graph|flowchart)(?:\s+(\S+))?$/i;
const GRAPH_STATUS: ReadonlyMap<string, NonNullable<GraphNode['status']>> = new Map([
  ['new', 'added'], ['added', 'added'], ['changed', 'modified'], ['modified', 'modified'],
  ['gone', 'deleted'], ['deleted', 'deleted'], ['removed', 'deleted'], ['affected', 'affected'],
]);
const BR = /<br\s*\/?>/i;

/** 'API<br>express routes' -> label 'API', sub 'express routes'; further <br>s become spaces. */
function labelAndSub(text: string, id: string): {label: string; sub?: string} {
  const [head, ...tail] = text.split(new RegExp(BR.source, 'gi'));
  const sub = tail.map(t => t.trim()).filter(Boolean).join(' ');
  return {label: head!.trim() || id, ...(sub ? {sub} : {})};
}

/** `subgraph` argument: `id`, `id[Title]`, `id ["Title"]`, `"Title"` or plain words. */
function subgraphHead(arg: string): {id: string; label: string} | undefined {
  const titled = /^([A-Za-z_][\w-]*)\s*\[(.*)\]$/.exec(arg);
  if (titled) return {id: titled[1]!, label: unquote(titled[2]!).trim() || titled[1]!};
  if (/^[A-Za-z_][\w-]*$/.test(arg)) return {id: arg, label: arg};
  const label = unquote(arg).trim();
  const id = slug(label);
  return id ? {id, label} : undefined;
}

/**
 * Graph data as a Mermaid graph: `graph LR`, nodes `id[Label<br>sub]` (any shape), edges `-->`, `-->|label|`,
 * `-- label -->`, dashed `-.->` / `-.-`, chains and `&`, `subgraph id[Title] … end` groups, `:::new|changed|gone`
 * (and added/modified/deleted/removed/affected) or `class a,b new` for the status, `click a "path#L10-20"` for the
 * file. Styling lines are ignored. `dir` comes from the header (the server puts it in the data as GraphData.dir).
 */
export function parseGraph(src: string): ParseResult<GraphData> {
  const b = newBuilder();
  const errors: NotationError[] = [];
  const fixes = fixList();
  const groups = new Map<string, GraphGroup & {line: number; col: number}>();
  const open: Array<{id: string; line: number}> = [];
  const classes: Array<{id: string; name: string; line: number; col: number; statement: boolean}> = [];
  const clicks: Array<{id: string; file: string; line: number; col: number}> = [];
  let dir: 'LR' | 'TB' | undefined;
  let styling: {line: number; count: number} | undefined;

  positionedStatements(src, undefined, 'brackets', LINE_BREAK).forEach((s, i) => {
    const {text, line, col} = s;
    if (i === 0) {
      const h = GRAPH_HEADER.exec(text);
      if (h) {
        if (h[1] !== undefined) {
          dir = dirOf(h[1]);
          if (!dir) fixes.add('GF5', line, `direction '${clip(h[1], 12)}' ignored (TD TB BT LR RL)`);
        }
        return;
      }
    }
    const sub = /^subgraph(?:\s+(.*))?$/.exec(text);
    if (sub) {
      const head = subgraphHead((sub[1] ?? '').trim());
      if (!head) { errors.push(error(line, col, 'subgraph needs an id or a title', 'subgraph g[Group]')); return; }
      if (!groups.has(head.id)) groups.set(head.id, {id: head.id, label: head.label, ...(open.length > 0 ? {parent: open.at(-1)!.id} : {}), line, col: col + 9});
      open.push({id: head.id, line});
      b.group = head.id;
      return;
    }
    if (text === 'end') {
      if (open.length === 0) errors.push(error(line, col, '"end" closes no subgraph', 'subgraph g[Group]'));
      open.pop();
      b.group = open.at(-1)?.id;
      return;
    }
    if (/^direction\s+\S+$/.test(text)) return;
    if (/^(?:style|classDef|linkStyle)\s/.test(text)) {
      if (styling) styling.count++;
      else styling = {line, count: 1};
      return;
    }
    const cls = /^class\s+(.+?)\s+([A-Za-z_][\w-]*)$/.exec(text);
    if (cls) {
      for (const id of cls[1]!.split(',').map(x => x.trim()).filter(Boolean)) classes.push({id, name: cls[2]!, line, col: col + text.indexOf(id), statement: true});
      return;
    }
    if (/^click\s/.test(text)) {
      const click = readClick(text);
      if (!click) errors.push(error(line, col, `click needs a node and a file`, 'click a "src/a.ts#L10-20"'));
      else if ('error' in click) errors.push(error(line, col, click.error, click.example));
      else if ('ignored' in click) fixes.add('GF6', line, click.ignored);
      else clicks.push({...click, line, col: col + 6});
      return;
    }
    const before = b.classes.length;
    b.repaired = [];
    try {
      parseFlowStatement(text, b, {repairs: true});
    } catch (e) {
      if (!(e instanceof FlowSyntaxError)) throw e;
      errors.push(error(line, col + e.column - 1, e.bare, e.example));
    }
    for (const c of b.classes.slice(before)) classes.push({...c, line, col, statement: false});
    if (b.repaired.length > 0) fixes.add('GF4', line, `'->' read as '-->'`);
  });

  for (const g of open) fixes.add('GF3', g.line, `subgraph ${g.id} closed at the end`);
  if (styling) fixes.add('GF2', styling.line, `${styling.count} style/classDef/linkStyle lines ignored (status: :::new :::changed :::gone)`);
  for (const g of groups.values()) {
    if (b.nodes.has(g.id)) errors.push(error(g.line, g.col, `"${g.id}" is a subgraph and a node: rename one`, `subgraph ${g.id}_group[${g.label}]`));
  }
  const ids = [...b.nodes.keys()];
  const nodeList = ids.slice(0, 12).join(' ') || 'none';
  const status = new Map<string, NonNullable<GraphNode['status']>>();
  for (const c of classes) {
    if (!b.nodes.has(c.id)) {
      errors.push(error(c.line, c.col, `class names no node "${clip(c.id, 30)}". Nodes: ${nodeList}`, `class ${ids[0] ?? 'a'} new`));
      continue;
    }
    const value = GRAPH_STATUS.get(c.name.toLowerCase());
    if (value) status.set(c.id, value);
    else fixes.add('GF1', c.line, `':::${clip(c.name, 20)}' dropped (status: new changed gone affected)`);
  }
  const files = new Map<string, string>();
  for (const c of clicks) {
    if (b.nodes.has(c.id)) files.set(c.id, c.file);
    else errors.push(error(c.line, c.col, `click names no node "${clip(c.id, 30)}". Nodes: ${nodeList}`, `click ${ids[0] ?? 'a'} "src/a.ts#L10-20"`));
  }
  if (errors.length === 0 && b.nodes.size === 0) errors.push(error(1, 1, 'no nodes', 'a[API] --> b[DB]'));

  const nodes: GraphNode[] = [...b.nodes.values()].map(n => {
    const group = b.groupOf.get(n.id);
    const st = status.get(n.id);
    const file = files.get(n.id);
    return {id: n.id, ...labelAndSub(n.label, n.id), ...(group ? {group} : {}), ...(st ? {status: st} : {}), ...(file ? {file} : {})};
  });
  const edges: GraphEdge[] = b.edges.map(e => ({from: e.from, to: e.to, ...(e.label ? {label: e.label} : {}), ...(e.dashed ? {kind: 'dashed' as const} : {})}));
  const groupList: GraphGroup[] = [...groups.values()].map(g => ({id: g.id, label: g.label, ...(g.parent ? {parent: g.parent} : {})}));
  return finish({nodes, edges, ...(groupList.length > 0 ? {groups: groupList} : {})}, errors, fixes, dir);
}

// ---------------------------------------------------------------- erDiagram (ERDiagram.data)
const ER_NAME = String.raw`"[^"]+"|[A-Za-z_][\w-]*`;
const ER_OPEN = new RegExp(`^(${ER_NAME})\\s*\\{(.*)$`);
const ER_REL = new RegExp(`^(${ER_NAME})\\s+(\\S+)\\s+(${ER_NAME})\\s*(?::\\s*(.*))?$`);
const ER_CARD = /^(\|o|\|\||\}o|\}\|)(--|\.\.)(o\||\|\||o\{|\|\{)$/;
const ER_TYPE = /^[A-Za-z0-9_()[\],.~-]+$/;
const ER_COLUMN = /^[A-Za-z_][\w-]*$/;
const ER_KEY = /^(?:PK|FK|UK)$/i;

/**
 * Entity-relationship data as a Mermaid erDiagram: `NAME { type column PK|FK|UK "comment" }` (a column per line),
 * `A ||--o{ B : label` relationships (`||` one, `o{` many), `direction LR`, and `click NAME "path"` for the table's
 * file. Always the object form {tables, relations?}.
 */
export function parseEr(src: string): ParseResult<ErData> {
  const errors: NotationError[] = [];
  const fixes = fixList();
  const tables = new Map<string, ErTable>();
  const relations: ErRelation[] = [];
  const clicks: Array<{id: string; file: string; line: number; col: number}> = [];
  let dir: 'LR' | 'TB' | undefined;
  let block: {table: ErTable; line: number} | undefined;
  const entity = (written: string): ErTable => {
    const name = unquote(written);
    let table = tables.get(name);
    if (!table) { table = {name, columns: []}; tables.set(name, table); }
    return table;
  };
  const column = (table: ErTable, text: string, s: Statement) => {
    const comment = /\s+"[^"]*"\s*$/.exec(text);
    const body = comment ? text.slice(0, comment.index) : text;
    const tokens = body.trim().split(/\s+/);
    const keyWords = (from: number) => tokens.slice(from).flatMap(w => w.split(',')).filter(Boolean);
    let type: string | undefined;
    let name: string;
    let words: string[];
    if (tokens.length === 1 || keyWords(1).every(w => ER_KEY.test(w))) {
      name = tokens[0]!;
      words = keyWords(1);
      if (ER_COLUMN.test(name)) fixes.add('EF2', s.line, `'${clip(text.trim(), 30)}' read as column ${name} with no type`);
    } else {
      type = tokens[0]!;
      name = tokens[1]!;
      words = keyWords(2);
    }
    if (!ER_COLUMN.test(name) || (type !== undefined && !ER_TYPE.test(type))) {
      errors.push(error(s.line, s.col, `expected a column "type name [PK|FK|UK]", found "${clip(text.trim())}"`, 'uuid id PK'));
      return;
    }
    const keys = new Set(words.filter(w => ER_KEY.test(w)).map(w => w.toUpperCase()));
    const unknown = words.filter(w => !ER_KEY.test(w));
    if (unknown.length > 0) fixes.add('EF3', s.line, `'${clip(unknown.join(' '), 30)}' dropped (keys: PK FK UK)`);
    const col: ErColumn = {name, ...(type !== undefined ? {type} : {}), ...(keys.has('PK') ? {pk: true} : {}), ...(keys.has('FK') ? {fk: true} : {})};
    table.columns.push(col);
  };

  positionedStatements(src, undefined, 'quotes', LINE_BREAK).forEach((s, i) => {
    const {text, line, col} = s;
    if (i === 0 && /^erDiagram$/i.test(text)) return;
    if (/^(?:title|accTitle|accDescr)\b/.test(text)) return;
    const direction = /^direction\s+(\S+)$/.exec(text);
    if (direction) { dir = dirOf(direction[1]!) ?? dir; return; }
    if (/^click\s/.test(text)) {
      const click = readClick(text);
      if (!click) errors.push(error(line, col, 'click needs an entity and a file', 'click users "db/schema.sql"'));
      else if ('error' in click) errors.push(error(line, col, click.error, click.example));
      else if ('ignored' in click) fixes.add('EF4', line, click.ignored);
      else clicks.push({...click, line, col: col + 6});
      return;
    }
    if (block) {
      let body = text;
      let close = false;
      if (body.endsWith('}')) { body = body.slice(0, -1).trim(); close = true; }
      if (body) column(block.table, body, s);
      if (close) block = undefined;
      return;
    }
    if (text === '}') { errors.push(error(line, col, '"}" closes no entity', 'users {')); return; }
    const opened = ER_OPEN.exec(text);
    if (opened) {
      const table = entity(opened[1]!);
      const rest = opened[2]!.trim();
      if (rest.endsWith('}')) {
        const inner = rest.slice(0, -1).trim();
        if (inner) column(table, inner, s);
      } else {
        block = {table, line};
        if (rest) column(table, rest, s);
      }
      return;
    }
    const rel = ER_REL.exec(text);
    const card = rel ? ER_CARD.exec(rel[2]!) : null;
    if (rel && card) {
      const from = entity(rel[1]!).name;
      const to = entity(rel[3]!).name;
      const label = unquote((rel[4] ?? '').trim()).trim();
      const many = (card[1]!.startsWith('}') ? 'n' : '1') + '-' + (card[3]!.endsWith('{') ? 'n' : '1');
      relations.push({from, to, card: many as NonNullable<ErRelation['card']>, ...(label ? {label} : {})});
      return;
    }
    if (rel && /^[|}o{.<>-]{3,}$/.test(rel[2]!) && /[-.]/.test(rel[2]!)) {
      const at = text.indexOf(rel[2]!, rel[1]!.length);
      errors.push(error(line, col + at, `unknown cardinality "${clip(rel[2]!, 12)}": left |o || }o }|, right o| || o{ |{`,
        text.slice(0, at) + '||--o{' + text.slice(at + rel[2]!.length)));
      return;
    }
    errors.push(error(line, col, `expected an entity "NAME {", a relationship "A ||--o{ B : label" or "}", found "${clip(text)}"`, 'users ||--o{ orders : places'));
  });

  if (block) fixes.add('EF1', block.line, `${clip(block.table.name, 30)} { closed at the end`);
  const names = [...tables.keys()];
  for (const c of clicks) {
    const table = tables.get(c.id);
    if (table) table.file = c.file;
    else errors.push(error(c.line, c.col, `click names no entity "${clip(c.id, 30)}". Entities: ${names.slice(0, 12).join(' ') || 'none'}`, `click ${names[0] ?? 'users'} "db/schema.sql"`));
  }
  if (errors.length === 0 && tables.size === 0) errors.push(error(1, 1, 'no entities', 'users ||--o{ orders : places'));
  const list = [...tables.values()].map(t => ({name: t.name, ...(t.file ? {file: t.file} : {}), columns: t.columns}));
  return finish({tables: list, ...(relations.length > 0 ? {relations} : {})}, errors, fixes, dir);
}

// ---------------------------------------------------------------- Markdown table (DataTable, List, the Rows charts)
interface Cell { text: string; col: number }
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isDelimiterRow = (line: string) => /-/.test(line) && /^[\s|:-]+$/.test(line);

/** The cells of a row ('\|' is a literal pipe; outer pipes are optional), or undefined when the line has no pipe. */
function rowCells(line: string): Cell[] | undefined {
  const cells: Cell[] = [];
  let text = '';
  let start = 0;
  let pipes = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '\\' && line[i + 1] === '|') { text += '|'; i++; continue; }
    if (c === '|') { cells.push({text, col: start + 1}); text = ''; start = i + 1; pipes++; continue; }
    text += c;
  }
  cells.push({text, col: start + 1});
  if (pipes === 0) return undefined;
  if (cells[0]!.text.trim() === '' && line.trimStart().startsWith('|')) cells.shift();
  const trimmed = line.trimEnd();
  if (cells.length > 0 && cells.at(-1)!.text.trim() === '' && trimmed.endsWith('|') && !trimmed.endsWith('\\|')) cells.pop();
  return cells;
}

const cellText = (text: string) => stripEmphasis(text.replace(new RegExp(BR.source, 'gi'), ' ').trim());

/**
 * Rows as a Markdown table: a header row, a `|---|` row, a row per line (outer pipes optional, `\|` for a pipe in a
 * cell). A column whose every non-empty cell is a number holds numbers. `keys` gives canonical spellings for headers
 * equal to them ignoring case (List: title, sub, value, file, path, tone).
 */
export function parseMdTable(src: string, opts: {keys?: readonly string[]} = {}): ParseResult<Rows> {
  const errors: NotationError[] = [];
  const fixes = fixList();
  const lines = src.split(LINE_BREAK);
  const filled = lines.map((text, i) => ({text, line: i + 1})).filter(l => l.text.trim() !== '');
  if (filled.length === 0) return finish([], errors, fixes);
  const head = filled[0]!;
  const headCells = rowCells(head.text) ?? [{text: head.text.trim(), col: indentOf(head.text) + 1}];
  let body = filled.slice(1);
  if (body.length > 0 && isDelimiterRow(body[0]!.text)) body = body.slice(1);
  else fixes.add('TF1', head.line, `no |---| row under the header: line ${head.line} read as the header`);

  const keys: string[] = [];
  headCells.forEach((cell, i) => {
    // '__proto__' is also Markdown emphasis: test the name as written and as read.
    const written = cell.text.trim();
    let name = RESERVED_KEYS.has(written) ? written : cellText(cell.text);
    if (name === '') {
      name = `col${i + 1}`;
      fixes.add('TF2', head.line, `empty header ${i + 1} named ${name}`);
    }
    if (RESERVED_KEYS.has(name)) errors.push(error(head.line, cell.col + indentOf(cell.text), `header "${name}" is a reserved name: rename the column`, `| ${name}_ |`));
    const canonical = opts.keys?.find(k => k.toLowerCase() === name.toLowerCase());
    if (canonical) name = canonical;
    const base = name;
    for (let n = 2; keys.includes(name); n++) name = `${base} ${n}`;
    if (name !== base) fixes.add('TF3', head.line, `header '${clip(base, 30)}' twice: the second is '${clip(name, 30)}'`);
    keys.push(name);
  });

  const rows: Array<Array<string | undefined>> = [];
  for (const {text, line} of body) {
    if (isDelimiterRow(text)) continue;
    let cells = rowCells(text);
    if (!cells) {
      if (keys.length > 1) {
        errors.push(error(line, indentOf(text) + 1, `expected a table row "| a | b |", found "${clip(text.trim())}"`, `| ${text.trim()} |`));
        continue;
      }
      cells = [{text, col: 1}];
    }
    if (cells.length > keys.length) {
      const m = keys.length;
      const kept = cells.slice(0, m - 1).map(c => c.text.trim());
      const joined = cells.slice(m - 1).map(c => c.text.trim()).join(' \\| ');
      errors.push(error(line, cells[m]!.col, `row has ${cells.length} cells, the header ${m}: write \\| for a | inside a cell`, `| ${[...kept, joined].join(' | ')} |`));
      continue;
    }
    rows.push(cells.map(c => cellText(c.text) || undefined));
  }
  const numeric = keys.map((_, j) => {
    const values = rows.map(r => r[j]).filter((v): v is string => v !== undefined);
    return values.length > 0 && values.every(v => canonicalNumber(v) !== undefined);
  });
  const ast: Rows = rows.map(r => Object.fromEntries(keys.flatMap((key, j) => {
    const v = r[j];
    return v === undefined ? [] : [[key, numeric[j] ? canonicalNumber(v)! : v]];
  })));
  return finish(ast, errors, fixes);
}

// ---------------------------------------------------------------- task list (Steps.data)
const TASK_MARKS: Readonly<Record<string, StepStatus>> = {
  '': 'todo', ' ': 'todo', x: 'done', X: 'done', '✓': 'done', '✔': 'done', '~': 'doing', '/': 'doing', '>': 'doing', '!': 'blocked', '-': 'skipped',
};

/** Notes that only name a status. */
const NOTE_STATUS: ReadonlyMap<string, StepStatus> = new Map([
  ['done', 'done'], ['complete', 'done'], ['completed', 'done'], ['finished', 'done'],
  ['doing', 'doing'], ['in progress', 'doing'], ['wip', 'doing'], ['ongoing', 'doing'], ['started', 'doing'],
  ['todo', 'todo'], ['to do', 'todo'], ['pending', 'todo'], ['not started', 'todo'],
  ['blocked', 'blocked'], ['skipped', 'skipped'],
]);
const STATUS_MARK: Readonly<Record<StepStatus, string>> = {done: 'x', doing: '~', todo: ' ', blocked: '!', skipped: '-'};

/** A list marker and a `[ ]` box at the start of a line, if any. */
function taskHead(line: string): {marker: boolean; box?: string; rest: string} {
  let rest = line.trimStart();
  const marker = /^(?:[-*+]|\d{1,9}[.)])(?:\s+|$)/.exec(rest);
  if (marker) rest = rest.slice(marker[0].length);
  const box = /^\[(.?)\]/.exec(rest);
  if (box) rest = rest.slice(box[0].length);
  return {marker: marker !== null, ...(box ? {box: box[1]!} : {}), rest};
}

/**
 * Steps as a task list: `- [x] done`, `- [~] doing`, `- [ ] todo`, `- [!] blocked`, `- [-] skipped`, then
 * ` — note` and `[[path#L10]]` for the file. A line indented under a step continues its note. No box, no status.
 */
export function parseTaskList(src: string): ParseResult<StepItem[]> {
  const errors: NotationError[] = [];
  const fixes = fixList();
  const steps: StepItem[] = [];
  let base: number | undefined;
  let current: StepItem | undefined;
  src.split(LINE_BREAK).forEach((text, i) => {
    const line = i + 1;
    if (text.trim() === '') return;
    const indent = indentOf(text);
    base ??= indent;
    const head = taskHead(text);
    const isItem = head.marker || head.box !== undefined;
    if (!isItem) {
      if (current && indent > base) {
        let note = text.trim();
        if (current.file === undefined) {
          const more = takeFile(note);
          if (more.file) { current.file = more.file; note = more.text; }
        }
        if (note) current.note = current.note ? `${current.note} ${note}` : note;
        return;
      }
      errors.push(error(line, indent + 1, `expected a step "- [ ] title", found "${clip(text.trim())}"`, `- [ ] ${text.trim()}`));
      current = undefined;
      return;
    }
    if (indent > base && current) fixes.add('SF2', line, 'nested step flattened');
    let status: StepStatus | undefined;
    if (head.box !== undefined) {
      status = Object.hasOwn(TASK_MARKS, head.box) ? TASK_MARKS[head.box] : undefined;
      if (!status) {
        fixes.add('SF1', line, `'[${head.box}]' read as '[ ]' (marks: x ~ space ! -)`);
        status = 'todo';
      }
    }
    const {text: rest, file} = takeFile(head.rest);
    const split = splitNote(rest);
    const {head: title} = split;
    let {note} = split;
    // A note that only names a status ('— done') repeats the box, or stands for one: the box says it, once.
    const said = note === undefined ? undefined : NOTE_STATUS.get(note.toLowerCase().replace(/[.!]+$/, '').trim());
    if (said !== undefined && note !== undefined) {
      if (status === undefined) {
        status = said;
        fixes.add('SF3', line, `'— ${clip(note, 16)}' read as the box [${STATUS_MARK[said]}]`);
      } else fixes.add('SF4', line, `note '${clip(note, 16)}' dropped: the box [${head.box}] gives the status`);
      note = undefined;
    }
    const clean = stripEmphasis(title);
    if (clean === '') {
      errors.push(error(line, indent + 1, 'step has no title', '- [x] Ship the map'));
      current = undefined;
      return;
    }
    current = {title: clean, ...(note ? {note} : {}), ...(status ? {status} : {}), ...(file ? {file} : {})};
    steps.push(current);
  });
  return finish(steps, errors, fixes);
}

// ---------------------------------------------------------------- 'Key: value' lines (KeyValue, Stats, Layers)
interface Pair { label: string; raw: string; line: number; indent: number }

/** `Key: value` per line (bullets and emphasis around the key removed); deeper-indented lines continue the value. */
function readPairs(src: string, errors: NotationError[], fixes: Fixes, lineError: (text: string) => [string, string], emptyKey: (value: string) => [string, string], tight: boolean): Pair[] {
  const pairs: Pair[] = [];
  src.split(LINE_BREAK).forEach((text, i) => {
    const line = i + 1;
    if (text.trim() === '') return;
    const indent = indentOf(text);
    const body = text.trim().replace(/^[-*+]\s+/, '');
    const bold = /^(\*\*|__)(.+?):\1(?:\s+(.*))?$/.exec(body);
    const at = bold ? -1 : body.search(/:(?:\s|$)/);
    if (bold || at >= 0) {
      const label = stripEmphasis(bold ? bold[2]! : body.slice(0, at));
      const raw = (bold ? bold[3] ?? '' : body.slice(at + 1)).trim();
      if (label === '') {
        const [message, example] = emptyKey(raw);
        errors.push(error(line, indent + 1, message, example));
        return;
      }
      pairs.push({label, raw, line, indent});
      return;
    }
    const last = pairs.at(-1);
    if (last && indent > last.indent) {
      last.raw = last.raw ? `${last.raw} ${text.trim()}` : text.trim();
      return;
    }
    const squeezed = tight ? /^([A-Za-z0-9_][\w -]*):(\S.*)$/.exec(body) : null;
    if (squeezed) {
      const label = squeezed[1]!.trim();
      fixes.add('PF1', line, `'${clip(`${label}:${squeezed[2]!}`, 30)}' read as '${clip(`${label}: ${squeezed[2]!}`, 31)}'`);
      pairs.push({label, raw: squeezed[2]!.trim(), line, indent});
      return;
    }
    const [message, example] = lineError(text.trim());
    errors.push(error(line, indent + 1, message, example));
  });
  return pairs;
}

const pairError = (text: string): [string, string] => [`expected "Key: value", found "${clip(text)}"`, `Key: ${text}`];
const pairEmpty = (value: string): [string, string] => ['empty key before ":"', `Key: ${value}`];

/** A text value as KeyValue shows it: a number, true / false, or the text. */
function typedValue(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return canonicalNumber(raw) ?? raw;
}

/** KeyValue data as `Key: value` lines: [{label, value}] in line order; numbers and true/false keep their type. */
export function parseKeyValue(src: string): ParseResult<Array<{label: string; value: string | number | boolean}>> {
  const errors: NotationError[] = [];
  const fixes = fixList();
  const pairs = readPairs(src, errors, fixes, pairError, pairEmpty, true);
  return finish(pairs.map(p => ({label: p.label, value: typedValue(p.raw)})), errors, fixes);
}

const STAT_VALUE = /^([+−-]?\d[\d,]*(?:\.\d+)?)([kKMBG](?![A-Za-z]))?(?:\s*(%|[A-Za-z]{1,12}))?(?:\s*\(([+−-])(\d[\d,]*(?:\.\d+)?)%?\))?$/;
const STAT_SUFFIX: Readonly<Record<string, number>> = {k: 1e3, K: 1e3, M: 1e6, B: 1e9, G: 1e9};

/** '87% (+2)' -> {value: 87, unit: '%', delta: 2}; '3.1k LOC' -> {value: 3100, unit: 'LOC'}; else the text. */
function statItem(label: string, raw: string): StatItem {
  const m = STAT_VALUE.exec(raw);
  const n = m ? canonicalNumber(m[1]!) : undefined;
  const d = m && m[5] !== undefined ? canonicalNumber(m[5]) : undefined;
  if (!m || n === undefined || (m[5] !== undefined && d === undefined)) return {label, value: raw};
  const value = m[2] ? Number((n * STAT_SUFFIX[m[2]]!).toPrecision(12)) : n;
  return {label, value, ...(m[3] ? {unit: m[3]} : {}), ...(d !== undefined ? {delta: m[4] === '+' ? d : d === 0 ? 0 : -d} : {})};
}

/** Stats data as `Label: value` lines: '87% (+2)' is value 87, unit %, delta 2; a value that is not a number stays text. */
export function parseStats(src: string): ParseResult<StatItem[]> {
  const errors: NotationError[] = [];
  const fixes = fixList();
  const pairs = readPairs(src, errors, fixes, pairError, pairEmpty, true);
  return finish(pairs.map(p => statItem(p.label, p.raw)), errors, fixes);
}

/** Splits on ',' outside `[[...]]`. */
function splitItems(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('[[', i)) { depth++; i++; continue; }
    if (text.startsWith(']]', i) && depth > 0) { depth--; i++; continue; }
    if (text[i] === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
}

/** Words that bind a phrase into a sentence; a name of a module or a box rarely holds one. */
const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'and', 'or', 'per', 'before', 'after', 'into', 'than', 'when', 'if', 'is', 'are', 'back']);

/**
 * Whether the items of a Layers line read as a sentence rather than names: one runs past five words, or the line runs
 * to seven words or more and an item of three words or more has a word like 'with', 'on' or 'per' in it.
 */
function isProse(parts: readonly string[]): boolean {
  const words = parts.map(part => part.replace(/\[\[[^\]]*\]\]/g, ' ').trim().split(/\s+/).filter(Boolean));
  if (words.some(list => list.length > 5)) return true;
  const total = words.reduce((sum, list) => sum + list.length, 0);
  return total >= 7 && words.some(list => list.length >= 3 && list.some(word => FUNCTION_WORDS.has(word.toLowerCase())));
}

/** Layers data as `Tier: item, item — note` lines, top tier first; `[[path]]` after an item links its file. */
export function parseLayers(src: string): ParseResult<LayerItem[]> {
  const errors: NotationError[] = [];
  const fixes = fixList();
  const pairs = readPairs(
    src, errors, fixes,
    text => [`expected "Layer: item, item — note", found "${clip(text)}"`, `Layer: ${text}`],
    value => ['empty layer name before ":"', `Layer: ${value}`],
    false,
  );
  const layers = pairs.map((p): LayerItem => {
    const {head, note} = splitNote(p.raw);
    const items: LayerItem['items'] = [];
    // A sentence is not a list of names: 'Store: .cache/<key>.json on disk, one file per result' was cut into two chips
    // at its comma. Without a note, prose is the tier's note.
    if (note === undefined && isProse(splitItems(head))) {
      fixes.add('LF1', p.line, `prose read as the tier's note (items are names)`);
      return {name: p.label, items, ...(head ? {note: head} : {})};
    }
    for (const part of splitItems(head)) {
      if (part.trim() === '') continue;
      const {text, file} = takeFile(part);
      items.push(file ? {label: text || file, file} : text);
    }
    return {name: p.label, items, ...(note ? {note} : {})};
  });
  return finish(layers, errors, fixes);
}

// ---------------------------------------------------------------- which notation a data prop takes
export type NotationKind = 'graph' | 'er' | 'table' | 'tasks' | 'keyValue' | 'stats' | 'layers';

/**
 * name: how messages call it; sig: one line, printed as the `notation` line of an error and in componentDoc; example:
 * a complete Express string literal (quotes and \n escapes); short: a two-line Express literal for the E_SOURCE hint.
 */
export const NOTATIONS: Readonly<Record<NotationKind, {name: string; sig: string; example: string; short: string}>> = {
  graph: {
    name: 'a Mermaid graph',
    sig: 'Mermaid graph: a[Label<br>sub] -->|label| b, -.-> dashed, subgraph g[Title] … end, :::new|changed|gone, click a "path#L10"',
    example: `'graph LR\\nsubgraph api[API]\\nr[routes<br>express]:::changed -->|calls| s[service]\\nend\\nclick s "src/s.ts#L12"'`,
    short: `'graph LR\\na[API] --> b[DB]'`,
  },
  er: {
    name: 'a Mermaid erDiagram',
    sig: 'Mermaid erDiagram: NAME { type column PK|FK|UK } a column per line; A ||--o{ B : label (|| one, o{ many)',
    example: `'erDiagram\\nusers ||--o{ orders : places\\nusers {\\nuuid id PK\\ntext email\\n}\\norders {\\nuuid user_id FK\\n}'`,
    short: `'erDiagram\\nusers ||--o{ orders : places'`,
  },
  table: {
    name: 'a Markdown table',
    sig: 'Markdown table: header row, |---| row, a row per line; number cells become numbers',
    example: `'| path | loc |\\n|---|---|\\n| src/a.ts | 120 |\\n| src/b.ts | 80 |'`,
    short: `'| a | b |\\n|---|---|\\n| x | 1 |'`,
  },
  tasks: {
    name: 'a task list',
    sig: 'a step per line: - [x] done, - [~] doing, - [ ] todo, - [!] blocked, - [-] skipped; then — note; [[path#L10]] links a file',
    example: `'- [x] Add the middleware\\n- [~] Wire the router — behind a flag [[src/api/routes.ts#L12]]\\n- [ ] Tests'`,
    short: `'- [x] done\\n- [ ] todo'`,
  },
  keyValue: {
    name: "'Key: value' lines",
    sig: "a 'Key: value' per line; numbers and true/false keep their type",
    example: `'Language: TypeScript\\nEntry: src/main.ts\\nTests: true'`,
    short: `'Key: value'`,
  },
  stats: {
    name: "'Label: value' lines",
    sig: "a 'Label: value' per line; '87% (+2)' is value 87, unit %, delta 2",
    example: `'Files: 412\\nCoverage: 87% (+2)\\nTests: 1866'`,
    short: `'Files: 412'`,
  },
  layers: {
    name: "'Tier: items' lines",
    sig: "a tier per line, top first: 'Name: item, item — note' (items are names); [[path]] after an item links a file",
    example: `'API: routes, middleware\\nDomain: ledger, payouts [[src/payouts.ts]] — no I/O'`,
    short: `'API: routes, auth'`,
  },
};

/** Documented shape name (a SHAPES key, as shapesOf() returns it) -> the notation a prop of that shape takes as text. */
export const NOTATION_BY_SHAPE: Readonly<Record<string, NotationKind>> = {
  GraphData: 'graph', ErData: 'er', Rows: 'table', ListItem: 'table', StepItem: 'tasks', KeyValueData: 'keyValue', StatItem: 'stats', LayerItem: 'layers',
};

/** List reads these keys of its items; a Markdown table header equal to one of them (any case) takes this spelling. */
const LIST_KEYS = ['title', 'sub', 'value', 'file', 'path', 'tone'] as const;

/** The notation a component's data prop takes as text, or undefined (the prop's shape, first part: 'Rows|number[]' -> Rows). */
export function notationKind(component: string, prop: string): NotationKind | undefined {
  const def = COMPONENT_BY_NAME.get(component);
  if (!def || !Object.hasOwn(def.props, prop)) return undefined;
  const p = (def.props as Record<string, {kind: string; shape?: string}>)[prop]!;
  if (p.kind !== 'data') return undefined;
  const shape = (p.shape ?? '').split('|')[0]!.replace(/\[\]$/, '').trim();
  return Object.hasOwn(NOTATION_BY_SHAPE, shape) ? NOTATION_BY_SHAPE[shape] : undefined;
}

/** The first line that is not blank (and, for the Mermaid notations, not a %% comment). */
function firstLines(text: string, skipComments: boolean): string[] {
  return text.split(LINE_BREAK).filter(l => l.trim() !== '' && !(skipComments && l.trim().startsWith('%%')));
}

/** Whether a string is written in a notation (looks at its first significant line). A blank string never is. */
export function looksLikeNotation(kind: NotationKind, text: string): boolean {
  const lines = firstLines(text, kind === 'graph' || kind === 'er');
  const first = lines[0];
  if (first === undefined) return false;
  switch (kind) {
    case 'graph':
      return /^\s*(?:graph|flowchart)(?:\s|;|$)/i.test(first) || /-->|---|-\.-|==>/.test(text) || lines.some(l => /^\s*subgraph\s/.test(l));
    case 'er':
      return /^\s*erDiagram(?:\s|$)/i.test(first) || /^\s*(?:"[^"]+"|[A-Za-z_][\w-]*)\s*\{/.test(first) || /^\s*\S+\s+[|}][|o](?:--|\.\.)[|o][|{]\s+\S+/.test(first);
    case 'table': {
      const second = lines[1];
      return first.trimStart().startsWith('|') || (second !== undefined && /\|/.test(second) && /-/.test(second) && /^[\s|:-]+$/.test(second));
    }
    case 'tasks':
      return /^\s*(?:[-*+]|\d{1,3}[.)])\s+\S/.test(first) || /^\s*\[.?\]/.test(first);
    default:
      return /^\s*(?:[-*+]\s+)?[^\s:][^:]{0,79}:(?:\*\*|__)?(?:\s|$)/.test(first);
  }
}

export interface NotationMatch { kind: NotationKind; result: ParseResult<unknown> }

/** Parses text in a notation. Never throws: an unexpected failure is reported as an error of the first line. */
export function parseNotation(kind: NotationKind, text: string, opts: {keys?: readonly string[]} = {}): ParseResult<unknown> {
  try {
    switch (kind) {
      case 'graph': return parseGraph(text);
      case 'er': return parseEr(text);
      case 'table': return parseMdTable(text, opts);
      case 'tasks': return parseTaskList(text);
      case 'keyValue': return parseKeyValue(text);
      case 'stats': return parseStats(text);
      case 'layers': return parseLayers(text);
    }
  } catch (e) {
    return {ok: false, errors: [error(1, 1, `could not read ${NOTATIONS[kind].name}: ${clip(e instanceof Error ? e.message : String(e), 60)}`)]};
  }
}

/**
 * notationKind + looksLikeNotation + the parser (List passes its item keys). undefined when the prop takes no notation
 * or the text is not written in it. Never throws.
 */
export function notationFor(component: string, prop: string, text: string): NotationMatch | undefined {
  const kind = notationKind(component, prop);
  if (!kind || typeof text !== 'string' || !looksLikeNotation(kind, text)) return undefined;
  return {kind, result: parseNotation(kind, text, component === 'List' ? {keys: LIST_KEYS} : {})};
}

// ---------------------------------------------------------------- columns
/** Every FieldKind, in the order the docs list them. */
export const FIELD_KINDS = [
  'text', 'num', 'bytes', 'pct', 'duration', 'path', 'symbol', 'module', 'author', 'commit', 'lang',
  'date', 'bar', 'heat', 'spark', 'chip', 'delta', 'code', 'bool',
] as const satisfies readonly FieldKind[];
const KIND_SET: ReadonlySet<string> = new Set(FIELD_KINDS);
// Compile-time check that FIELD_KINDS lists every FieldKind.
type MissingKind = Exclude<FieldKind, (typeof FIELD_KINDS)[number]>;
const allKindsListed: MissingKind extends never ? true : never = true;
void allKindsListed;

function splitColumn(token: string): {key: string; kind?: string; label?: string} {
  const eq = token.indexOf('=');
  const head = eq >= 0 ? token.slice(0, eq) : token;
  const colon = head.indexOf(':');
  return {
    key: colon >= 0 ? head.slice(0, colon) : head,
    ...(colon >= 0 ? {kind: head.slice(colon + 1)} : {}),
    ...(eq >= 0 ? {label: token.slice(eq + 1).replace(/_/g, ' ')} : {}),
  };
}

/**
 * DataTable.columns shorthand: 'path commits:bar last:date=Last_change' ('_' in a label becomes a space).
 * Never throws: a token with an unknown kind keeps its key and label and renders as plain text; a token without a
 * key is dropped. Use checkColumns() to report those to the author.
 */
export function parseColumns(spec: string): Field[] {
  const fields: Field[] = [];
  for (const token of spec.trim().split(/\s+/).filter(Boolean)) {
    const {key, kind, label} = splitColumn(token);
    if (!key) continue;
    fields.push({key, ...(kind && KIND_SET.has(kind) ? {kind: kind as FieldKind} : {}), ...(label ? {label} : {})});
  }
  return fields;
}

/** Problems in a columns shorthand; `statement` is the 1-based position of the offending column. Empty when valid. */
export function checkColumns(spec: string): NotationError[] {
  const errors: NotationError[] = [];
  spec.trim().split(/\s+/).filter(Boolean).forEach((token, i) => {
    const {key, kind} = splitColumn(token);
    if (!key) errors.push({statement: i + 1, message: `column "${clip(token)}" has no field name`});
    else if (kind !== undefined && !KIND_SET.has(kind)) errors.push({statement: i + 1, message: `unknown kind "${kind}" for column "${key}". Kinds: ${FIELD_KINDS.join(' ')}`});
  });
  return errors;
}
