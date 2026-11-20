// packages/catalog/src/notation.ts
// Mermaid-style arrow notation for Flowchart.src and SequenceDiagram.src. Pure functions shared by the server
// (validates literal src at show time) and the viewer (parses, lays out, paints). No Mermaid dependency.
import type {Field, FieldKind} from './datasets.ts';

export interface NotationError { statement: number; message: string }
export type ParseResult<T> = {ok: true; ast: T} | {ok: false; errors: NotationError[]};

export type FlowShape = 'box' | 'diamond' | 'pill' | 'store' | 'circle';
export interface FlowNode { id: string; label: string; shape: FlowShape }
export interface FlowEdge { from: string; to: string; label?: string; dashed?: boolean }
export interface FlowAst { nodes: FlowNode[]; edges: FlowEdge[] }

export type SeqArrow = 'sync' | 'reply' | 'async';
export type SeqStep =
  | {kind: 'message'; from: string; to: string; label: string; arrow: SeqArrow}
  | {kind: 'note'; over: string[]; text: string};
export interface SeqAst { actors: Array<{id: string; label: string}>; steps: SeqStep[] }

// ---------------------------------------------------------------- statements
const clip = (text: string, max = 40) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

/** Splits on newlines, then on ';' outside brackets, pipes and double quotes (so labels may contain ';'). */
function splitOutsideBrackets(line: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let pipe = false;
  let quote = false;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) { if (c === '"') quote = false; continue; }
    if (c === '"') quote = true;
    else if (c === '|' && depth === 0) pipe = !pipe;
    else if (pipe) continue;
    else if (c === '[' || c === '(' || c === '{') depth++;
    else if (c === ']' || c === ')' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) { out.push(line.slice(start, i)); start = i + 1; }
  }
  out.push(line.slice(start));
  return out;
}

/** Statements after dropping blanks, `%%` comments and a leading header. Index + 1 is the statement number in errors. */
function statements(src: string, header: RegExp, bracketAware: boolean): string[] {
  const out: string[] = [];
  for (const line of src.split(/\r?\n/)) {
    if (line.trim().startsWith('%%')) continue;
    for (const part of bracketAware ? splitOutsideBrackets(line) : line.split(';')) {
      const text = part.trim();
      if (text && !text.startsWith('%%')) out.push(text);
    }
  }
  if (out.length > 0 && header.test(out[0]!)) out.shift();
  return out;
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
const ARROW = /^(-\.+->|-{2,}>|={2,}>|-{3,})\s*(?:\|([^|]*)\|)?/;
const ARROW_TEXT: ReadonlyArray<readonly [RegExp, boolean]> = [
  [/^--\s+(.+?)\s+-{2,}>/, false],      // -- label -->
  [/^-\.\s*(.+?)\s*\.+->/, true],       // -. label .->
  [/^==\s+(.+?)\s+={2,}>/, false],      // == label ==>
];

class FlowSyntaxError extends Error {}

function unquote(label: string): string {
  const t = label.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

interface FlowBuilder { nodes: Map<string, FlowNode & {explicit: boolean}>; edges: FlowEdge[] }

/**
 * A node written as plain words instead of `id[label]`: "Enter credentials --> Valid?". The words up to the next
 * arrow (or `&`, or the end) are the label, the id is the label with every other character run turned into `_`
 * ("Enter_credentials", so the same words name the same node and "Valid?" is also reachable as `Valid`), and a
 * trailing `?` makes it a diamond. Text that is a plain id, or that contains brackets, pipes or `>`, is not free
 * text: the id[label] grammar reads it and reports what is wrong with it.
 */
function freeNode(rest: string): {id: string; label: string; length: number} | undefined {
  const stop = rest.search(/--|-\.|==|&/);
  const raw = stop < 0 ? rest : rest.slice(0, stop);
  const text = raw.trim();
  const label = /^"[^"]+"$/.test(text) ? text.slice(1, -1).trim() : text;
  if (label === '' || /[[\]{}()|<>"]/.test(label) || /^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) return undefined;
  const slug = label.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  if (slug === '') return undefined;
  return {id: /^[\p{L}_]/u.test(slug) ? slug : `n_${slug}`, label, length: raw.length};
}

function parseFlowStatement(text: string, b: FlowBuilder): void {
  let pos = 0;
  const rest = () => text.slice(pos);
  const skip = () => { while (pos < text.length && /\s/.test(text[pos]!)) pos++; };
  const found = () => (pos >= text.length ? 'end of statement' : `"${clip(rest(), 16)}"`);

  const node = (): string => {
    skip();
    const free = freeNode(rest());
    if (free) {
      pos += free.length;
      if (!b.nodes.has(free.id)) b.nodes.set(free.id, {id: free.id, label: free.label, shape: free.label.endsWith('?') ? 'diamond' : 'box', explicit: true});
      return free.id;
    }
    const m = ID.exec(rest());
    if (!m) throw new FlowSyntaxError(`expected a node id at column ${pos + 1}, found ${found()}`);
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
      if (end < 0) throw new FlowSyntaxError(`unclosed "${open}" in node ${id} (column ${pos + 1})`);
      label = unquote(text.slice(from, end)) || id;
      shape = kind;
      pos = end + close.length;
      break;
    }
    const known = b.nodes.get(id);
    if (!known) b.nodes.set(id, {id, label, shape: shape ?? 'box', explicit: shape !== undefined});
    else if (!known.explicit && shape !== undefined) Object.assign(known, {label, shape, explicit: true});
    return id;
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
    throw new FlowSyntaxError(`expected an arrow (-->, -->|label|, -- label -->, -.->) at column ${pos + 1}, found ${found()}`);
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
 * `((circle))`; edges `-->`, `-->|label|`, `-- label -->`, `-.->`, `-.->|label|`. Also accepted from Mermaid:
 * `A & B --> C`, `==>`, `---`, `-. label .->`, quoted labels, and styling / subgraph lines (skipped).
 */
export function parseFlow(src: string): ParseResult<FlowAst> {
  const b: FlowBuilder = {nodes: new Map(), edges: []};
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
/** Mermaid block and bookkeeping lines; accepted and skipped (blocks are flattened). */
const SEQ_IGNORED = /^(?:autonumber|activate|deactivate|title|loop|alt|else|opt|par|and|rect|critical|option|break|box)\b|^end$/i;
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
 * `participant A [as Label]`. Actors appear in order of first mention; `A->>A: text` is a self-message.
 */
export function parseSequence(src: string): ParseResult<SeqAst> {
  const actors = new Map<string, {id: string; label: string}>();
  const steps: SeqStep[] = [];
  const errors: NotationError[] = [];
  const actor = (id: string, label?: string) => {
    const known = actors.get(id);
    if (!known) actors.set(id, {id, label: label ?? id});
    else if (label) known.label = label;
    return id;
  };
  statements(src, SEQ_HEADER, false).forEach((text, i) => {
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
    if (SEQ_IGNORED.test(text)) return;
    fail(`expected "A->>B: text", "A-->>B: text", "A-)B: text", "Note over A: text" or "participant A", found "${clip(text)}"`);
  });
  if (errors.length === 0 && steps.length === 0) errors.push({statement: 1, message: 'no messages: expected something like "User->>API: POST /login"'});
  if (errors.length > 0) return {ok: false, errors};
  return {ok: true, ast: {actors: [...actors.values()], steps}};
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
