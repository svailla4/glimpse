// packages/catalog/src/diagrams.ts
// Flowchart and SequenceDiagram data (decision D21): plain objects, not a text notation. Layers, ERDiagram and Steps
// data are read here the same way (decision D24), since they too name diagram nodes (`node:'PG'`). Pure functions
// shared by the server (checks the data a spec writes and says what it corrected or left out) and the viewer (draws
// the cleaned data, and tells the model what it could not draw when the data arrived by a patch the server did not
// check).
//
// Every entry is judged on its own: a node, edge, group or step that cannot be drawn is left out and named in
// `dropped`, the rest still draws. A reasonable guess (a shape alias, an edge to a node nobody declared) is drawn and
// named in `fixes`. Only a value that is not a diagram at all is refused.
import {MAX_ENTITY_NODES, STEP_KEYS, type ErRelation, type FileLoc} from './datasets.ts';
import {describeValue, readNodes} from './links.ts';

export interface Cleaned<T> {
  ast: T;
  /** What was drawn differently from how it was written, one short clause each ("shape 'cylinder' -> store"). */
  fixes: string[];
  /** What was written but is not drawn, one short clause each. */
  dropped: string[];
}
export type Clean<T> = ({ok: true} & Cleaned<T>) | {ok: false; error: string};

const LABEL_KEYS = ['label', 'text', 'name', 'title'] as const;

/** Lines a fixes or dropped list keeps; the rest fold into "and N more". */
const MAX_NOTES = 8;
/** Blocks nested deeper than this are drawn flat. */
const MAX_DEPTH = 6;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A value as text: a non-blank string, trimmed, or a finite number. */
const textOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;
const pick = (o: Record<string, unknown>, keys: readonly string[]): unknown => {
  for (const key of keys) if (o[key] !== undefined) return o[key];
  return undefined;
};
const clip = (text: string, max = 40) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

/** Collects notes, keeps the first MAX_NOTES and counts the rest. */
class Notes {
  private readonly lines: string[] = [];
  private more = 0;
  add(line: string): void {
    if (this.lines.length < MAX_NOTES) this.lines.push(line);
    else this.more++;
  }
  /** Unknown keys, gathered across entries of one kind: one line for all of them. */
  readonly ignored = new Map<string, Set<string>>();
  ignore(what: string, keys: Iterable<string>): void {
    for (const key of keys) {
      const set = this.ignored.get(what) ?? new Set<string>();
      set.add(key);
      this.ignored.set(what, set);
    }
  }
  list(): string[] {
    const out = [...this.lines];
    for (const [what, keys] of this.ignored) out.push(`ignored ${what} ${keys.size === 1 ? 'key' : 'keys'} ${[...keys].slice(0, 6).join(', ')}${keys.size > 6 ? ', …' : ''}`);
    if (this.more > 0) out.push(`and ${this.more} more`);
    return out;
  }
}

const unknownKeys = (o: Record<string, unknown>, known: ReadonlySet<string>) => Object.keys(o).filter(key => !known.has(key));
/** What a value that is not usable text is, for the messages: as describeValue, and 'an empty string'. */
const received = (v: unknown): string => (typeof v === 'string' ? 'an empty string' : describeValue(v));
/** `o[key]` as text; a value written there that is not text is named in `dropped`. */
function textAt(o: Record<string, unknown>, key: string, where: string, dropped: Notes): string | undefined {
  const raw = o[key];
  if (raw === undefined) return undefined;
  const text = textOf(raw);
  if (text === undefined) dropped.add(`${where}: ${key}: expected text, received ${received(raw)}`);
  return text;
}
/** `o[key]` as a file location ('path#L10-20'); a value written there that is not one is named in `dropped`. */
function fileAt(o: Record<string, unknown>, key: string, where: string, dropped: Notes): FileLoc | undefined {
  const raw = o[key];
  if (raw === undefined) return undefined;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  dropped.add(`${where}: ${key}: expected 'path#L10-20', received ${received(raw)}`);
  return undefined;
}
/** The label of an entry: its label key, the value itself in a map `{ID: 'label'}`, else the id. */
const labelOf = (raw: unknown, inList: boolean, id: string): string =>
  isRecord(raw) ? (textOf(pick(raw, LABEL_KEYS)) ?? id) : inList ? id : (textOf(raw) ?? id);

/**
 * Entries written as a map `{ID: value}` or a list `[{id, ...}]` (or `['ID']`): [id, value] pairs in written order.
 * A list entry with no usable id is reported and skipped.
 */
function entries(raw: unknown, what: string, dropped: Notes): Array<[string, unknown]> {
  if (raw === undefined || raw === null) return [];
  if (isRecord(raw)) return Object.entries(raw).map(([id, value]) => [id.trim(), value]).filter(([id]) => id !== '') as Array<[string, unknown]>;
  if (!Array.isArray(raw)) {
    dropped.add(`${what}: expected a map {ID: ...} or a list, received ${describeValue(raw)}`);
    return [];
  }
  const out: Array<[string, unknown]> = [];
  raw.forEach((item, i) => {
    const id = isRecord(item) ? textOf(item.id) : textOf(item);
    if (id === undefined) dropped.add(`${what} ${i + 1}: no id`);
    else out.push([id, item]);
  });
  return out;
}

// ================================================================ node links (decision D24; readNodes is in links.ts)
/** readNodes at `where`: its alias said in `fixes`, its problem in `dropped`. */
function nodesAt(o: Record<string, unknown>, where: string, fixes: Notes, dropped: Notes, key = 'node', max = MAX_ENTITY_NODES): string[] {
  const read = readNodes(o, key, max);
  if (read.alias !== undefined) fixes.add(`${where}: ${read.alias}`);
  if (read.problem !== undefined) dropped.add(`${where}: ${read.problem}`);
  return read.ids;
}
/** How a list of ids reads in a message: ['GW', 'Q']. */
const idList = (ids: readonly string[]): string => `[${ids.slice(0, 3).map(id => `'${clip(id, 20)}'`).join(', ')}${ids.length > 3 ? ', …' : ''}]`;

// ================================================================ Flowchart
export const FLOW_SHAPES = ['box', 'diamond', 'pill', 'store', 'circle'] as const;
export type FlowShape = (typeof FLOW_SHAPES)[number];
/** `note` and `file` are what the node says when hovered or selected (decision D24); `file` also makes it a place. */
export interface FlowNode { id: string; label: string; shape: FlowShape; group?: string; note?: string; file?: FileLoc }
export interface FlowEdge { from: string; to: string; label?: string; dashed?: boolean }
export interface FlowGroup { id: string; label: string; parent?: string }
export interface FlowAst { nodes: FlowNode[]; edges: FlowEdge[]; groups: FlowGroup[] }

/** The data a Flowchart takes, as an author writes it. */
export interface FlowData {
  nodes?: Record<string, string | {label?: string; shape?: FlowShape; group?: string; note?: string; file?: FileLoc}> | Array<{id: string; label?: string; shape?: FlowShape; group?: string; note?: string; file?: FileLoc}>;
  edges?: Array<[string, string] | [string, string, string] | {from: string; to: string; label?: string; dashed?: boolean}>;
  groups?: Record<string, string | {label?: string; parent?: string}> | Array<{id: string; label?: string; parent?: string}>;
}

const SHAPE_SET: ReadonlySet<string> = new Set(FLOW_SHAPES);
/** Other words for the five shapes, Mermaid's among them. */
export const SHAPE_ALIASES: Readonly<Record<string, FlowShape>> = {
  rect: 'box', rectangle: 'box', square: 'box', process: 'box', node: 'box', subroutine: 'box',
  decision: 'diamond', rhombus: 'diamond', choice: 'diamond', condition: 'diamond', question: 'diamond', hexagon: 'diamond',
  stadium: 'pill', rounded: 'pill', round: 'pill', terminal: 'pill', start: 'pill', end: 'pill', capsule: 'pill',
  store: 'store', database: 'store', db: 'store', cylinder: 'store', storage: 'store', datastore: 'store',
  oval: 'circle', ellipse: 'circle', event: 'circle',
};
/** A node's note, and the other words for it. */
const NODE_NOTE_KEYS = ['note', 'detail', 'description'] as const;
const NODE_KEYS: ReadonlySet<string> = new Set(['id', ...LABEL_KEYS, 'shape', 'type', 'group', 'parent', 'in', ...NODE_NOTE_KEYS, 'file', 'path']);
const EDGE_FROM = ['from', 'source', 'src'] as const;
const EDGE_TO = ['to', 'target', 'dst'] as const;
const EDGE_KEYS: ReadonlySet<string> = new Set([...EDGE_FROM, ...EDGE_TO, ...LABEL_KEYS, 'dashed', 'kind', 'style']);
const GROUP_KEYS: ReadonlySet<string> = new Set(['id', ...LABEL_KEYS, 'parent', 'group', 'in']);
const FLOW_EXAMPLE = "{nodes:{A:'Request',B:{label:'Over limit?',shape:'diamond'}},edges:[['A','B'],['B','C','no']]}";

/**
 * The data of a Flowchart, cleaned: `{nodes, edges, groups?}`, or just the list of edges. Nodes and groups are maps
 * `{ID: 'label' | {...}}` or lists `[{id, ...}]`; an edge is `['from', 'to', 'label'?]` or `{from, to, label?, dashed?}`.
 * An edge may name a node no entry declares: it is drawn with its id as the label.
 */
export function cleanFlow(data: unknown): Clean<FlowAst> {
  if (typeof data === 'string') {
    return {ok: false, error: `Flowchart takes data, not Mermaid text: {nodes, edges, groups?}, e.g. ${FLOW_EXAMPLE}`};
  }
  const root = Array.isArray(data) ? {edges: data} : data;
  if (!isRecord(root)) return {ok: false, error: `expected {nodes, edges, groups?}, received ${describeValue(data)}`};
  const fixes = new Notes();
  const dropped = new Notes();

  // ---- groups
  const groups = new Map<string, FlowGroup>();
  for (const [id, raw] of entries(root.groups, 'group', dropped)) {
    if (groups.has(id)) { dropped.add(`group ${clip(id)}: repeated`); continue; }
    const o = isRecord(raw) ? raw : {};
    if (isRecord(raw)) dropped.ignore('group', unknownKeys(raw, GROUP_KEYS));
    const label = labelOf(raw, Array.isArray(root.groups), id);
    const parent = textOf(pick(o, ['parent', 'group', 'in']));
    groups.set(id, {id, label, ...(parent !== undefined && parent !== id ? {parent} : {})});
  }

  // ---- nodes
  const nodes = new Map<string, FlowNode>();
  const addGroup = (id: string, by: string) => {
    if (groups.has(id)) return;
    groups.set(id, {id, label: id});
    fixes.add(`group ${clip(id)} added for ${by} (not in groups)`);
  };
  for (const [id, raw] of entries(root.nodes, 'node', dropped)) {
    if (nodes.has(id)) { dropped.add(`node ${clip(id)}: repeated`); continue; }
    if (groups.has(id)) { dropped.add(`node ${clip(id)}: the id of a group`); continue; }
    const o = isRecord(raw) ? raw : {};
    if (isRecord(raw)) dropped.ignore('node', unknownKeys(raw, NODE_KEYS));
    const label = labelOf(raw, Array.isArray(root.nodes), id);
    let shape: FlowShape = 'box';
    const written = textOf(pick(o, ['shape', 'type']));
    if (written !== undefined) {
      const lower = written.toLowerCase();
      if (SHAPE_SET.has(lower)) shape = lower as FlowShape;
      else if (SHAPE_ALIASES[lower]) {
        shape = SHAPE_ALIASES[lower];
        fixes.add(`node ${clip(id)}: shape '${clip(written, 20)}' -> ${shape}`);
      } else fixes.add(`node ${clip(id)}: shape '${clip(written, 20)}' drawn as box (shapes: ${FLOW_SHAPES.join(' ')})`);
    }
    const group = textOf(pick(o, ['group', 'parent', 'in']));
    if (group !== undefined) addGroup(group, `node ${clip(id)}`);
    // Decision D24: a note and a file; `detail` and `description` are read as the note, `path` as the file.
    const where = `node ${clip(id)}`;
    const noteKeys = NODE_NOTE_KEYS.filter(key => o[key] !== undefined);
    const note = noteKeys[0] !== undefined ? textAt(o, noteKeys[0], where, dropped) : undefined;
    if (note !== undefined && noteKeys[0] !== 'note') fixes.add(`${where}: ${noteKeys[0]} -> note`);
    for (const extra of noteKeys.slice(1)) dropped.add(`${where}: ${extra} not read (${noteKeys[0]} is)`);
    const fileKey = o.file !== undefined ? 'file' : o.path !== undefined ? 'path' : undefined;
    const file = fileKey !== undefined ? fileAt(o, fileKey, where, dropped) : undefined;
    if (file !== undefined && fileKey === 'path') fixes.add(`${where}: path -> file`);
    if (fileKey === 'file' && o.path !== undefined) dropped.add(`${where}: path not read (file is)`);
    nodes.set(id, {id, label, shape, ...(group !== undefined ? {group} : {}), ...(note !== undefined ? {note} : {}), ...(file !== undefined ? {file} : {})});
  }
  const declared = nodes.size > 0;

  // ---- edges
  const edges: FlowEdge[] = [];
  const rawEdges = root.edges ?? root.links;
  if (rawEdges !== undefined && !Array.isArray(rawEdges)) dropped.add(`edges: expected a list, received ${describeValue(rawEdges)}`);
  const end = (id: string, edge: string): boolean => {
    if (nodes.has(id)) return true;
    if (groups.has(id)) {
      dropped.add(`edge ${edge}: ${clip(id)} is a group; edges join nodes`);
      return false;
    }
    nodes.set(id, {id, label: id, shape: 'box'});
    if (declared) fixes.add(`node ${clip(id)} added for edge ${edge} (not in nodes)`);
    return true;
  };
  (Array.isArray(rawEdges) ? rawEdges : []).forEach((raw, i) => {
    let from: string | undefined;
    let to: string | undefined;
    let label: string | undefined;
    let dashed = false;
    if (Array.isArray(raw)) {
      [from, to, label] = [textOf(raw[0]), textOf(raw[1]), textOf(raw[2])];
      if (raw.length > 3) dropped.ignore('edge', ['4th item']);
    } else if (isRecord(raw)) {
      dropped.ignore('edge', unknownKeys(raw, EDGE_KEYS));
      from = textOf(pick(raw, EDGE_FROM));
      to = textOf(pick(raw, EDGE_TO));
      label = textOf(pick(raw, LABEL_KEYS));
      const style = textOf(pick(raw, ['kind', 'style']))?.toLowerCase();
      dashed = raw.dashed === true || style === 'dashed' || style === 'dotted';
    }
    if (from === undefined || to === undefined) {
      dropped.add(`edge ${i + 1}: expected ['from', 'to', 'label'?] or {from, to}, received ${Array.isArray(raw) ? `a list of ${raw.length}` : describeValue(raw)}`);
      return;
    }
    const name = `${clip(from, 20)} -> ${clip(to, 20)}`;
    if (!end(from, name) || !end(to, name)) return;
    edges.push({from, to, ...(label !== undefined ? {label} : {}), ...(dashed ? {dashed: true} : {})});
  });

  // ---- group parents: unknown ones are added, a chain that comes back to a group is cut where it does
  for (const group of [...groups.values()]) if (group.parent !== undefined) addGroup(group.parent, `group ${clip(group.id)}`);
  for (const group of groups.values()) {
    const seen = new Set([group.id]);
    for (let at = group.parent; at !== undefined; at = groups.get(at)?.parent) {
      if (seen.has(at)) {
        dropped.add(`group ${clip(group.id)}: parent ${clip(group.parent!)} (a cycle)`);
        delete group.parent;
        break;
      }
      seen.add(at);
    }
  }
  // A group with no node in it, directly or through a nested group, has nothing to frame.
  const held = new Set<string>();
  for (const node of nodes.values()) for (let at = node.group; at !== undefined && !held.has(at); at = groups.get(at)?.parent) held.add(at);
  for (const group of groups.values()) if (!held.has(group.id)) dropped.add(`group ${clip(group.id)}: no nodes in it`);

  return {
    ok: true,
    ast: {nodes: [...nodes.values()], edges, groups: [...groups.values()].filter(group => held.has(group.id))},
    fixes: fixes.list(),
    dropped: dropped.list(),
  };
}

// ================================================================ SequenceDiagram
export type SeqArrow = 'sync' | 'reply' | 'async';
/** The blocks drawn as a labelled frame round their steps. */
export const SEQ_BLOCKS = ['loop', 'alt', 'opt', 'par', 'critical', 'break'] as const;
export type SeqFrameOp = (typeof SEQ_BLOCKS)[number];
/**
 * A step as the renderer draws it. A block written as data `{alt: 'label', steps, else}` becomes balanced frame steps:
 * `open`, an `else` divider per further branch, and `end`.
 */
export type SeqStep =
  | {kind: 'message'; from: string; to: string; label: string; arrow: SeqArrow; via?: string[]}
  | {kind: 'note'; over: string[]; text: string}
  | {kind: 'frame'; edge: 'open'; op: SeqFrameOp; label: string}
  | {kind: 'frame'; edge: 'else'; label: string}
  | {kind: 'frame'; edge: 'end'};
/**
 * A cleaned sequence. An actor's `node` is the diagram node it stands for, when written (else its id stands for it);
 * a message's `via` lists the nodes it passes through between its actors' nodes (decision D24).
 */
export interface SeqAst { actors: Array<{id: string; label: string; node?: string}>; steps: SeqStep[] }

/** The data a SequenceDiagram takes, as an author writes it. */
export interface SeqData {
  actors?: string[] | Record<string, string | {label?: string; node?: string}> | Array<{id: string; label?: string; node?: string}>;
  steps: unknown[];
}

const SEQ_ARROW_SET: ReadonlySet<string> = new Set(['sync', 'reply', 'async']);
export const ARROW_ALIASES: Readonly<Record<string, SeqArrow>> = {
  call: 'sync', request: 'sync', solid: 'sync', send: 'sync',
  return: 'reply', response: 'reply', dashed: 'reply', result: 'reply', back: 'reply',
  event: 'async', message: 'async', fire: 'async', emit: 'async', publish: 'async',
};
const BLOCK_SET: ReadonlySet<string> = new Set(SEQ_BLOCKS);
const BLOCK_ALIASES: Readonly<Record<string, SeqFrameOp>> = {while: 'loop', repeat: 'loop', if: 'alt', optional: 'opt', parallel: 'par'};
/** Blocks that only group or colour (Mermaid's rect and box): their steps are drawn, without a frame. */
const UNFRAMED: ReadonlySet<string> = new Set(['group', 'rect', 'box']);
const MESSAGE_KEYS: ReadonlySet<string> = new Set([...EDGE_FROM, ...EDGE_TO, ...LABEL_KEYS, 'arrow', 'kind', 'type', 'via']);
const ACTOR_KEYS: ReadonlySet<string> = new Set(['id', ...LABEL_KEYS, 'node', 'nodes']);
const NOTE_KEYS: ReadonlySet<string> = new Set(['note', 'over', 'actor', 'actors', 'on']);
const BLOCK_KEYS: ReadonlySet<string> = new Set([...SEQ_BLOCKS, ...Object.keys(BLOCK_ALIASES), ...UNFRAMED, 'type', 'block', ...LABEL_KEYS, 'steps', 'else', 'and']);
const SEQ_EXAMPLE = "{steps:[['User','API','POST /login'],['API','User','200','reply']]}";

/**
 * The data of a SequenceDiagram, cleaned: `{actors?, steps}`, or just the list of steps. A step is a message
 * `['from', 'to', 'label'?, 'sync'|'reply'|'async'?]` or `{from, to, label?, arrow?, via?}`, a note `{note, over: 'A' | ['A', 'B']}`,
 * or a block `{loop: 'label', steps: [...]}` (also alt, opt, par, critical, break) whose `else` lists further branches
 * `[{label, steps}]`; a `group` (rect, box) draws its steps without a frame. Actors appear in the order `actors` lists
 * them, then in order of first mention. An actor written `{label, node}` stands for that diagram node, and a message's
 * `via` names the nodes it passes through (decision D24): one id, or a list.
 */
export function cleanSequence(data: unknown): Clean<SeqAst> {
  if (typeof data === 'string') {
    return {ok: false, error: `SequenceDiagram takes data, not Mermaid text: {actors?, steps}, e.g. ${SEQ_EXAMPLE}`};
  }
  const root = Array.isArray(data) ? {steps: data} : data;
  if (!isRecord(root)) return {ok: false, error: `expected {actors?, steps} or a list of steps, received ${describeValue(data)}`};
  const rawSteps = root.steps ?? root.messages;
  if (rawSteps !== undefined && !Array.isArray(rawSteps)) return {ok: false, error: `steps: expected a list, received ${describeValue(rawSteps)}`};
  const fixes = new Notes();
  const dropped = new Notes();

  const actors = new Map<string, {id: string; label: string; node?: string}>();
  const rawActors = root.actors ?? root.participants;
  for (const [id, raw] of entries(rawActors, 'actor', dropped)) {
    if (actors.has(id)) continue;
    let node: string | undefined;
    if (isRecord(raw)) {
      dropped.ignore('actor', unknownKeys(raw, ACTOR_KEYS));
      // Decision D24: the node an actor stands for; its id when not given. An actor is one node.
      const where = `actor ${clip(id)}`;
      const ids = nodesAt(raw, where, fixes, dropped);
      if (ids.length > 1) fixes.add(`${where}: node ${idList(ids)} -> '${clip(ids[0]!, 20)}' (an actor is one node)`);
      node = ids[0];
    }
    actors.set(id, {id, label: labelOf(raw, Array.isArray(rawActors), id), ...(node !== undefined ? {node} : {})});
  }
  const declared = actors.size > 0;
  const actor = (id: string): string => {
    if (!actors.has(id)) {
      actors.set(id, {id, label: id});
      if (declared) fixes.add(`actor ${clip(id)} added (not in actors)`);
    }
    return id;
  };

  const arrowOf = (written: string | undefined, where: string): SeqArrow => {
    if (written === undefined) return 'sync';
    const lower = written.toLowerCase();
    if (SEQ_ARROW_SET.has(lower)) return lower as SeqArrow;
    if (ARROW_ALIASES[lower]) {
      fixes.add(`${where}: arrow '${clip(written, 20)}' -> ${ARROW_ALIASES[lower]}`);
      return ARROW_ALIASES[lower];
    }
    fixes.add(`${where}: arrow '${clip(written, 20)}' drawn as sync (arrows: sync reply async)`);
    return 'sync';
  };

  /** The block a step object names (undefined op: one that only groups), and the key that named it. */
  const blockOf = (o: Record<string, unknown>): {op?: SeqFrameOp; label?: string; alias?: string} | undefined => {
    for (const key of Object.keys(o)) {
      const lower = key.toLowerCase();
      if (BLOCK_SET.has(lower)) return {op: lower as SeqFrameOp, label: textOf(o[key])};
      if (BLOCK_ALIASES[lower]) return {op: BLOCK_ALIASES[lower], label: textOf(o[key]), alias: key};
      if (UNFRAMED.has(lower)) return {label: textOf(o[key]), alias: key};
    }
    const named = textOf(o.block ?? (Array.isArray(o.steps) ? o.type : undefined))?.toLowerCase();
    if (named === undefined) return undefined;
    const op = BLOCK_SET.has(named) ? (named as SeqFrameOp) : BLOCK_ALIASES[named];
    return {...(op ? {op} : {}), label: textOf(pick(o, LABEL_KEYS)), ...(op !== named ? {alias: named} : {})};
  };

  const walk = (list: unknown[], depth: number, path: string): SeqStep[] => {
    const out: SeqStep[] = [];
    list.forEach((raw, i) => {
      const where = `step ${path}${i + 1}`;
      // A message as a list.
      if (Array.isArray(raw)) {
        const [from, to, label, arrow] = [textOf(raw[0]), textOf(raw[1]), textOf(raw[2]) ?? '', textOf(raw[3])];
        if (from === undefined || to === undefined) {
          dropped.add(`${where}: expected ['from', 'to', 'label'?, arrow?], received a list of ${raw.length}`);
          return;
        }
        out.push({kind: 'message', from: actor(from), to: actor(to), label, arrow: arrowOf(arrow, where)});
        return;
      }
      if (!isRecord(raw)) {
        dropped.add(`${where}: expected a message, note or block, received ${describeValue(raw)}`);
        return;
      }
      // A note.
      if (raw.note !== undefined) {
        dropped.ignore('note', unknownKeys(raw, NOTE_KEYS));
        const text = textOf(raw.note) ?? '';
        const overRaw = pick(raw, ['over', 'actor', 'actors', 'on']);
        const over = (Array.isArray(overRaw) ? overRaw : [overRaw]).map(textOf).filter((id): id is string => id !== undefined);
        if (over.length === 0) {
          dropped.add(`${where}: a note needs over: 'A' or over: ['A', 'B']`);
          return;
        }
        out.push({kind: 'note', over: over.map(actor), text});
        return;
      }
      // A block.
      const block = blockOf(raw);
      if (block) {
        dropped.ignore('block', unknownKeys(raw, BLOCK_KEYS));
        if (block.alias !== undefined) fixes.add(`${where}: block '${clip(block.alias, 20)}' ${block.op ? `-> ${block.op}` : 'drawn without a frame'}`);
        const own = Array.isArray(raw.steps) ? raw.steps : [];
        const elseRaw = raw.else ?? raw.and;
        const branchesRaw: Array<{label?: string; steps: unknown[]}> = [{label: block.label, steps: own}];
        if (Array.isArray(elseRaw)) {
          // [{label, steps}, ...] are branches; any other list is the steps of one unnamed branch.
          const branchList = elseRaw.length > 0 && elseRaw.every(item => isRecord(item) && Array.isArray(item.steps));
          if (branchList) for (const item of elseRaw as Array<Record<string, unknown>>) branchesRaw.push({label: textOf(pick(item, LABEL_KEYS)), steps: item.steps as unknown[]});
          else branchesRaw.push({steps: elseRaw});
        } else if (isRecord(elseRaw) && Array.isArray(elseRaw.steps)) branchesRaw.push({label: textOf(pick(elseRaw, LABEL_KEYS)), steps: elseRaw.steps});
        else if (elseRaw !== undefined) dropped.add(`${where}: else: expected [{label, steps}], received ${describeValue(elseRaw)}`);
        const branches = branchesRaw.map((branch, b) => ({
          label: branch.label ?? '',
          steps: depth >= MAX_DEPTH ? [] : walk(branch.steps, depth + 1, `${path}${i + 1}.${branchesRaw.length > 1 ? `${b + 1}.` : ''}`),
        }));
        if (depth >= MAX_DEPTH) {
          dropped.add(`${where}: blocks nested deeper than ${MAX_DEPTH}`);
          return;
        }
        if (branches.every(branch => branch.steps.length === 0)) {
          dropped.add(`${where}: ${block.op ?? 'group'} block with no steps`);
          return;
        }
        if (!block.op) {
          for (const branch of branches) out.push(...branch.steps);
          return;
        }
        out.push({kind: 'frame', edge: 'open', op: block.op, label: branches[0]!.label});
        branches.forEach((branch, b) => {
          if (b > 0) out.push({kind: 'frame', edge: 'else', label: branch.label});
          out.push(...branch.steps);
        });
        out.push({kind: 'frame', edge: 'end'});
        return;
      }
      // A message as an object.
      const from = textOf(pick(raw, EDGE_FROM));
      const to = textOf(pick(raw, EDGE_TO));
      if (from === undefined || to === undefined) {
        dropped.add(`${where}: expected {from, to, label?}, {note, over} or a block such as {loop: 'label', steps}`);
        return;
      }
      dropped.ignore('message', unknownKeys(raw, MESSAGE_KEYS));
      // Decision D24: with the sender's and the receiver's nodes, a selected message names at most MAX_ENTITY_NODES.
      const via = nodesAt(raw, where, fixes, dropped, 'via', MAX_ENTITY_NODES - 2);
      out.push({
        kind: 'message', from: actor(from), to: actor(to), label: textOf(pick(raw, LABEL_KEYS)) ?? '',
        arrow: arrowOf(textOf(pick(raw, ['arrow', 'kind', 'type'])), where), ...(via.length > 0 ? {via} : {}),
      });
    });
    return out;
  };
  const steps = walk(Array.isArray(rawSteps) ? rawSteps : [], 0, '');
  return {ok: true, ast: {actors: [...actors.values()], steps}, fixes: fixes.list(), dropped: dropped.list()};
}

/** The messages and notes of a sequence, without its frame steps, in drawing order. */
export function seqLeaves(steps: readonly SeqStep[]): Array<Exclude<SeqStep, {kind: 'frame'}>> {
  return steps.filter((step): step is Exclude<SeqStep, {kind: 'frame'}> => step.kind !== 'frame');
}

// ================================================================ Layers (decision D24: moved here from the viewer)
export interface LayersItem { label: string; note?: string; file?: FileLoc; nodes?: string[] }
export interface LayersBand { name: string; note?: string; items: LayersItem[] }
export interface LayersAst { bands: LayersBand[] }

const BAND_KEYS: ReadonlySet<string> = new Set(['name', 'label', 'title', 'note', 'items']);
const ITEM_KEYS: ReadonlySet<string> = new Set(['label', 'name', 'title', 'note', 'file', 'node', 'nodes']);

/**
 * The data of Layers, cleaned: tiers `[{name, items, note?}]`, top tier first; a bare string is a tier without items.
 * An item is its label or `{label, file?, note?, node?}`. A tier's name is also read from `label` or `title`, an
 * item's label from `name` or `title`. Every tier and item is returned: how many are drawn is the view's business.
 */
export function cleanLayers(data: unknown): Clean<LayersAst> {
  if (!Array.isArray(data)) return {ok: false, error: `expected tiers [{name, items}], received ${describeValue(data)}`};
  const fixes = new Notes();
  const dropped = new Notes();
  const bands: LayersBand[] = [];
  data.forEach((raw: unknown, b) => {
    const tier = `tier ${b + 1}`;
    if (!isRecord(raw)) {
      const name = textOf(raw);
      if (name === undefined) dropped.add(`${tier}: expected {name, items} or a name, received ${received(raw)}`);
      else bands.push({name, items: []});
      return;
    }
    dropped.ignore('tier', unknownKeys(raw, BAND_KEYS));
    let name = textOf(pick(raw, ['name', 'label', 'title']));
    if (name === undefined) {
      name = '—';
      fixes.add(`${tier}: no name (drawn as —)`);
    }
    const note = textAt(raw, 'note', tier, dropped);
    if (raw.items !== undefined && !Array.isArray(raw.items)) dropped.add(`${tier}: items: expected a list, received ${describeValue(raw.items)}`);
    const items: LayersItem[] = [];
    (Array.isArray(raw.items) ? raw.items : []).forEach((entry: unknown, i) => {
      const at = `${tier} item ${i + 1}`;
      if (!isRecord(entry)) {
        const label = textOf(entry);
        if (label !== undefined) items.push({label});
        else dropped.add(typeof entry === 'string' ? `${at}: no label` : `${at}: expected 'label' or {label}, received ${describeValue(entry)}`);
        return;
      }
      dropped.ignore('item', unknownKeys(entry, ITEM_KEYS));
      const label = textOf(pick(entry, ['label', 'name', 'title']));
      if (label === undefined) {
        dropped.add(`${at}: no label`);
        return;
      }
      const where = `item '${clip(label, 30)}'`;
      const itemNote = textAt(entry, 'note', where, dropped);
      const file = fileAt(entry, 'file', where, dropped);
      const nodes = nodesAt(entry, where, fixes, dropped);
      items.push({label, ...(itemNote !== undefined ? {note: itemNote} : {}), ...(file !== undefined ? {file} : {}), ...(nodes.length > 0 ? {nodes} : {})});
    });
    bands.push({name, ...(note !== undefined ? {note} : {}), items});
  });
  return {ok: true, ast: {bands}, fixes: fixes.list(), dropped: dropped.list()};
}

// ================================================================ ERDiagram (decision D24: moved here from the viewer)
const ER_CARDS = ['1-1', '1-n', 'n-1', 'n-n'] as const;
type ErCard = NonNullable<ErRelation['card']>;
export interface SchemaColumn { name: string; type?: string; pk: boolean; fk: boolean; nullable: boolean }
export interface SchemaTable { name: string; file?: FileLoc; nodes?: string[]; columns: SchemaColumn[] }
export interface SchemaRelation { from: string; fromColumn?: string; to: string; toColumn?: string; label?: string; card?: ErCard }
export interface SchemaAst { tables: SchemaTable[]; relations: SchemaRelation[] }

const CARD_SET: ReadonlySet<string> = new Set(ER_CARDS);
const SCHEMA_KEYS: ReadonlySet<string> = new Set(['tables', 'relations']);
const TABLE_KEYS: ReadonlySet<string> = new Set(['name', 'columns', 'file', 'node', 'nodes']);
const COLUMN_KEYS: ReadonlySet<string> = new Set(['name', 'type', 'pk', 'fk', 'ref', 'references', 'nullable']);
const RELATION_KEYS: ReadonlySet<string> = new Set(['from', 'to', 'label', 'card']);
/** The keys a column names what it points at by. */
const POINTER_KEYS = ['fk', 'ref', 'references'] as const;
type End = {table: string; column?: string};

/**
 * The data of an ERDiagram, cleaned: `{tables, relations?}` or the bare list of tables. A column's `fk` is true, or
 * names what it points at ('users.id', or just 'users'; `ref` and `references` are read the same way): that also draws
 * the relation, many rows to one, unless `relations` already has one between the two ends. Refused: a value that is
 * not a schema at all, and tables none of which has a name.
 */
export function cleanSchema(data: unknown): Clean<SchemaAst> {
  if (!Array.isArray(data) && !isRecord(data)) return {ok: false, error: `expected tables [{name, columns}] or {tables, relations}, received ${describeValue(data)}`};
  const rawTables = Array.isArray(data) ? data : data.tables;
  if (!Array.isArray(rawTables)) return {ok: false, error: `expected tables to be an array, received ${describeValue(rawTables)}`};
  const fixes = new Notes();
  const dropped = new Notes();
  if (isRecord(data)) {
    dropped.ignore('schema', unknownKeys(data, SCHEMA_KEYS));
    if (data.relations !== undefined && !Array.isArray(data.relations)) dropped.add(`relations: expected a list, received ${describeValue(data.relations)}`);
  }
  const tables: SchemaTable[] = [];
  const byName = new Map<string, SchemaTable>();
  /** What the columns say they point at, in table and column order. */
  const pointers: Array<{from: string; to: string; key: string}> = [];
  rawTables.forEach((raw: unknown, t) => {
    if (!isRecord(raw)) {
      dropped.add(`table ${t + 1}: expected {name, columns}, received ${describeValue(raw)}`);
      return;
    }
    const name = textOf(raw.name);
    if (name === undefined) {
      dropped.add(`table ${t + 1}: no name`);
      return;
    }
    const where = `table ${clip(name)}`;
    if (byName.has(name)) {
      dropped.add(`${where}: repeated`);
      return;
    }
    dropped.ignore('table', unknownKeys(raw, TABLE_KEYS));
    if (raw.columns !== undefined && !Array.isArray(raw.columns)) dropped.add(`${where}: columns: expected a list, received ${describeValue(raw.columns)}`);
    const columns: SchemaColumn[] = [];
    (Array.isArray(raw.columns) ? raw.columns : []).forEach((col: unknown, c) => {
      // A bare string is a column name.
      const colName = isRecord(col) ? textOf(col.name) : textOf(col);
      if (colName === undefined) {
        dropped.add(isRecord(col) || typeof col === 'string' ? `${where} column ${c + 1}: no name` : `${where} column ${c + 1}: expected 'name' or {name, type?}, received ${describeValue(col)}`);
        return;
      }
      const o = isRecord(col) ? col : {};
      if (isRecord(col)) dropped.ignore('column', unknownKeys(col, COLUMN_KEYS));
      const key = POINTER_KEYS.find(k => typeof o[k] === 'string' && o[k].trim() !== '');
      if (key !== undefined) pointers.push({from: `${name}.${colName}`, to: String(o[key]).trim(), key});
      const type = textOf(o.type);
      columns.push({name: colName, ...(type !== undefined ? {type} : {}), pk: o.pk === true, fk: o.fk === true || key !== undefined, nullable: o.nullable === true});
    });
    const file = fileAt(raw, 'file', where, dropped);
    const nodes = nodesAt(raw, where, fixes, dropped);
    const table: SchemaTable = {name, ...(file !== undefined ? {file} : {}), ...(nodes.length > 0 ? {nodes} : {}), columns};
    byName.set(name, table);
    tables.push(table);
  });
  if (rawTables.length > 0 && tables.length === 0) {
    return {ok: false, error: `expected tables [{name, columns}], but none of the ${rawTables.length} ${rawTables.length === 1 ? 'entry has' : 'entries have'} a name`};
  }
  // 'table.column' or 'table'. A table name may itself contain dots, so whole names are tried first.
  const end = (text: string): End | undefined => {
    if (byName.has(text)) return {table: text};
    const dot = text.lastIndexOf('.');
    const table = dot > 0 ? text.slice(0, dot) : undefined;
    return table !== undefined && byName.has(table) ? {table, column: text.slice(dot + 1)} : undefined;
  };
  const relation = (from: End, to: End, label: string | undefined, card: ErCard | undefined): SchemaRelation => ({
    from: from.table, ...(from.column !== undefined ? {fromColumn: from.column} : {}),
    to: to.table, ...(to.column !== undefined ? {toColumn: to.column} : {}),
    ...(label !== undefined ? {label} : {}), ...(card !== undefined ? {card} : {}),
  });
  const relations: SchemaRelation[] = [];
  (isRecord(data) && Array.isArray(data.relations) ? data.relations : []).forEach((raw: unknown, r) => {
    const at = `relation ${r + 1}`;
    const fromText = isRecord(raw) ? textOf(raw.from) : undefined;
    const toText = isRecord(raw) ? textOf(raw.to) : undefined;
    if (!isRecord(raw)) {
      dropped.add(`${at}: expected {from: 'table.column', to: 'table.column'}, received ${describeValue(raw)}`);
      return;
    }
    if (fromText === undefined || toText === undefined) {
      dropped.add(`${at}: no ${fromText === undefined ? 'from' : 'to'}`);
      return;
    }
    dropped.ignore('relation', unknownKeys(raw, RELATION_KEYS));
    const from = end(fromText);
    const to = end(toText);
    if (!from || !to) {
      dropped.add(`${at}: unknown table '${clip(from ? toText : fromText, 30)}'`);
      return;
    }
    const written = textOf(raw.card);
    const card = written !== undefined && CARD_SET.has(written) ? (written as ErCard) : undefined;
    if (written !== undefined && card === undefined) fixes.add(`${at}: card '${clip(written, 20)}' drawn without cardinality (cards: ${ER_CARDS.join(' ')})`);
    relations.push(relation(from, to, textOf(raw.label), card));
  });
  const joins = (rel: SchemaRelation, a: End, b: End) =>
    rel.from === a.table && rel.to === b.table && (rel.fromColumn ?? a.column) === a.column && (rel.toColumn ?? b.column) === b.column;
  for (const pointer of pointers) {
    const from = end(pointer.from);
    const to = end(pointer.to);
    if (!from || !to) {
      dropped.add(`column ${clip(pointer.from)}: ${pointer.key} '${clip(pointer.to, 30)}' names no table`);
      continue;
    }
    // Written out in `relations` as well, in either direction: one line is enough.
    if (relations.some(rel => joins(rel, from, to) || joins(rel, to, from))) continue;
    relations.push(relation(from, to, undefined, 'n-1'));
  }
  return {ok: true, ast: {tables, relations}, fixes: fixes.list(), dropped: dropped.list()};
}

// ================================================================ Steps and table rows (decision D24)
const STEP_KEY_SET: ReadonlySet<string> = new Set(STEP_KEYS);
/** What one item of a list links to, and where it is ('step 3', 'row 2'). */
export interface ItemLinks { at: string; file?: FileLoc; nodes?: string[] }

/**
 * What the items of a Steps list (`step`) or the inline rows of a DataTable (`row`) link to, for the server's checks:
 * one entry per item that names a file or a node, in order. A step's keys are checked (STEP_KEYS) and so is its file;
 * a row is data, so only its `node` is read. Never refused: a value that is not a list links nothing.
 */
export function cleanItems(kind: 'step' | 'row', data: unknown): Clean<ItemLinks[]> {
  const fixes = new Notes();
  const dropped = new Notes();
  const links: ItemLinks[] = [];
  (Array.isArray(data) ? data : []).forEach((item: unknown, i) => {
    if (!isRecord(item)) return;
    const at = `${kind} ${i + 1}`;
    if (kind === 'step') dropped.ignore('step', unknownKeys(item, STEP_KEY_SET));
    const file = kind === 'step' ? fileAt(item, 'file', at, dropped) : undefined;
    const nodes = nodesAt(item, at, fixes, dropped);
    if (file !== undefined || nodes.length > 0) links.push({at, ...(file !== undefined ? {file} : {}), ...(nodes.length > 0 ? {nodes} : {})});
  });
  return {ok: true, ast: links, fixes: fixes.list(), dropped: dropped.list()};
}
