// packages/catalog/src/diagrams.ts
// Flowchart and SequenceDiagram data (decision D21): plain objects, not a text notation. Pure functions shared by the
// server (checks the data a spec writes and says what it corrected or left out) and the viewer (draws the cleaned
// data, and tells the model what it could not draw when the data arrived by a patch the server did not check).
//
// Every entry is judged on its own: a node, edge, group or step that cannot be drawn is left out and named in
// `dropped`, the rest still draws. A reasonable guess (a shape alias, an edge to a node nobody declared) is drawn and
// named in `fixes`. Only a value that is not a diagram at all is refused.

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
const textOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;
const pick = (o: Record<string, unknown>, keys: readonly string[]): unknown => {
  for (const key of keys) if (o[key] !== undefined) return o[key];
  return undefined;
};
const clip = (text: string, max = 40) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
/** What a value is, for the messages: 'a string', 'an array', 'null'. */
export const describeValue = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`;

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

// ================================================================ Flowchart
export const FLOW_SHAPES = ['box', 'diamond', 'pill', 'store', 'circle'] as const;
export type FlowShape = (typeof FLOW_SHAPES)[number];
export interface FlowNode { id: string; label: string; shape: FlowShape; group?: string }
export interface FlowEdge { from: string; to: string; label?: string; dashed?: boolean }
export interface FlowGroup { id: string; label: string; parent?: string }
export interface FlowAst { nodes: FlowNode[]; edges: FlowEdge[]; groups: FlowGroup[] }

/** The data a Flowchart takes, as an author writes it. */
export interface FlowData {
  nodes?: Record<string, string | {label?: string; shape?: FlowShape; group?: string}> | Array<{id: string; label?: string; shape?: FlowShape; group?: string}>;
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
const NODE_KEYS: ReadonlySet<string> = new Set(['id', ...LABEL_KEYS, 'shape', 'type', 'group', 'parent', 'in']);
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
    nodes.set(id, {id, label, shape, ...(group !== undefined ? {group} : {})});
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
  | {kind: 'message'; from: string; to: string; label: string; arrow: SeqArrow}
  | {kind: 'note'; over: string[]; text: string}
  | {kind: 'frame'; edge: 'open'; op: SeqFrameOp; label: string}
  | {kind: 'frame'; edge: 'else'; label: string}
  | {kind: 'frame'; edge: 'end'};
export interface SeqAst { actors: Array<{id: string; label: string}>; steps: SeqStep[] }

/** The data a SequenceDiagram takes, as an author writes it. */
export interface SeqData {
  actors?: string[] | Record<string, string> | Array<{id: string; label?: string}>;
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
const MESSAGE_KEYS: ReadonlySet<string> = new Set([...EDGE_FROM, ...EDGE_TO, ...LABEL_KEYS, 'arrow', 'kind', 'type']);
const NOTE_KEYS: ReadonlySet<string> = new Set(['note', 'over', 'actor', 'actors', 'on']);
const BLOCK_KEYS: ReadonlySet<string> = new Set([...SEQ_BLOCKS, ...Object.keys(BLOCK_ALIASES), ...UNFRAMED, 'type', 'block', ...LABEL_KEYS, 'steps', 'else', 'and']);
const SEQ_EXAMPLE = "{steps:[['User','API','POST /login'],['API','User','200','reply']]}";

/**
 * The data of a SequenceDiagram, cleaned: `{actors?, steps}`, or just the list of steps. A step is a message
 * `['from', 'to', 'label'?, 'sync'|'reply'|'async'?]` or `{from, to, label?, arrow?}`, a note `{note, over: 'A' | ['A', 'B']}`,
 * or a block `{loop: 'label', steps: [...]}` (also alt, opt, par, critical, break) whose `else` lists further branches
 * `[{label, steps}]`; a `group` (rect, box) draws its steps without a frame. Actors appear in the order `actors` lists
 * them, then in order of first mention.
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

  const actors = new Map<string, {id: string; label: string}>();
  const rawActors = root.actors ?? root.participants;
  for (const [id, raw] of entries(rawActors, 'actor', dropped)) {
    if (actors.has(id)) continue;
    actors.set(id, {id, label: labelOf(raw, Array.isArray(rawActors), id)});
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
      out.push({kind: 'message', from: actor(from), to: actor(to), label: textOf(pick(raw, LABEL_KEYS)) ?? '', arrow: arrowOf(textOf(pick(raw, ['arrow', 'kind', 'type'])), where)});
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
