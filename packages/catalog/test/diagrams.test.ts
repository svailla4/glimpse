import {describe, expect, it} from 'vitest';
import {
  MAX_ENTITY_NODES, cleanFlow, cleanItems, cleanLayers, cleanSchema, cleanSequence, readNodes, rowNodes, seqLeaves,
  type Clean, type FlowAst, type LayersAst, type SchemaAst, type SeqAst,
} from '../src/index.ts';

function ok<T>(result: Clean<T>): {ast: T; fixes: string[]; dropped: string[]} {
  if (!result.ok) throw new Error(result.error);
  return result;
}
const flow = (data: unknown) => ok<FlowAst>(cleanFlow(data));
const seq = (data: unknown) => ok<SeqAst>(cleanSequence(data));
const layers = (data: unknown) => ok<LayersAst>(cleanLayers(data));
const schema = (data: unknown) => ok<SchemaAst>(cleanSchema(data));
const ids = (n: number) => Array.from({length: n}, (_, i) => `n${i}`);

describe('cleanFlow', () => {
  it('reads nodes as a map of labels or objects, edges as tuples or objects, and groups', () => {
    const {ast, fixes, dropped} = flow({
      groups: {api: 'API', db: {label: 'Storage'}},
      nodes: {R: {label: 'routes', group: 'api'}, L: {label: 'Over limit?', shape: 'diamond', group: 'api'}, P: {label: 'Postgres', shape: 'store', group: 'db'}, E: '429'},
      edges: [['R', 'L'], ['L', 'P', 'no'], {from: 'L', to: 'E', label: 'yes', dashed: true}],
    });
    expect(ast.nodes).toEqual([
      {id: 'R', label: 'routes', shape: 'box', group: 'api'},
      {id: 'L', label: 'Over limit?', shape: 'diamond', group: 'api'},
      {id: 'P', label: 'Postgres', shape: 'store', group: 'db'},
      {id: 'E', label: '429', shape: 'box'},
    ]);
    expect(ast.edges).toEqual([{from: 'R', to: 'L'}, {from: 'L', to: 'P', label: 'no'}, {from: 'L', to: 'E', label: 'yes', dashed: true}]);
    expect(ast.groups).toEqual([{id: 'api', label: 'API'}, {id: 'db', label: 'Storage'}]);
    expect(fixes).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('reads lists of entries too, and a bare list as the edges', () => {
    expect(flow({nodes: [{id: 'A', label: 'Start'}, 'B'], groups: [{id: 'g', label: 'G'}], edges: [['A', 'B']]}).ast.nodes.map(n => [n.id, n.label])).toEqual([['A', 'Start'], ['B', 'B']]);
    const bare = flow([['A', 'B', 'go'], ['B', 'C']]);
    expect(bare.ast.nodes.map(n => n.id)).toEqual(['A', 'B', 'C']);
    // Nodes nobody declared are expected when there is no nodes map: no fix is said for them.
    expect(bare.fixes).toEqual([]);
  });

  it('draws a guess and says so: shape aliases, unknown shapes, undeclared nodes and groups', () => {
    const {ast, fixes} = flow({nodes: {A: {label: 'a', shape: 'cylinder'}, B: {label: 'b', shape: 'hexagonal-prism'}, C: {label: 'c', group: 'svc'}}, edges: [['A', 'X']]});
    expect(ast.nodes.map(n => [n.id, n.shape])).toEqual([['A', 'store'], ['B', 'box'], ['C', 'box'], ['X', 'box']]);
    expect(ast.groups).toEqual([{id: 'svc', label: 'svc'}]);
    expect(fixes).toEqual([
      "node A: shape 'cylinder' -> store",
      "node B: shape 'hexagonal-prism' drawn as box (shapes: box diamond pill store circle)",
      'group svc added for node C (not in groups)',
      'node X added for edge A -> X (not in nodes)',
    ]);
  });

  it('leaves out what cannot be drawn, names it, and draws the rest', () => {
    const {ast, dropped} = flow({
      groups: {g: 'G', empty: 'Nobody'},
      nodes: {A: {label: 'a', group: 'g', colour: 'red'}, B: 'b'},
      edges: [['A', 'B'], ['A'], {from: 'A'}, ['A', 'g'], 42],
    });
    expect(ast.edges).toEqual([{from: 'A', to: 'B'}]);
    expect(ast.groups.map(g => g.id)).toEqual(['g']);
    expect(dropped).toEqual([
      "edge 2: expected ['from', 'to', 'label'?] or {from, to}, received a list of 1",
      "edge 3: expected ['from', 'to', 'label'?] or {from, to}, received an object",
      'edge A -> g: g is a group; edges join nodes',
      "edge 5: expected ['from', 'to', 'label'?] or {from, to}, received a number",
      'group empty: no nodes in it',
      'ignored node key colour',
    ]);
  });

  it('nests groups, and cuts a parent chain that comes back to a group', () => {
    const nested = flow({groups: {outer: 'Outer', inner: {label: 'Inner', parent: 'outer'}}, nodes: {A: {label: 'a', group: 'inner'}}});
    expect(nested.ast.groups).toEqual([{id: 'outer', label: 'Outer'}, {id: 'inner', label: 'Inner', parent: 'outer'}]);
    expect(nested.dropped).toEqual([]);
    const cycle = flow({groups: {a: {label: 'A', parent: 'b'}, b: {label: 'B', parent: 'a'}}, nodes: {N: {label: 'n', group: 'a'}}});
    // b holds no node once the cycle is cut.
    expect(cycle.dropped).toEqual(['group a: parent b (a cycle)', 'group b: no nodes in it']);
    expect(cycle.ast.groups.find(g => g.id === 'a')?.parent).toBeUndefined();
  });

  it('refuses only what is not a diagram, and says Mermaid text is no longer read', () => {
    const text = cleanFlow('A --> B');
    expect(text.ok).toBe(false);
    expect(!text.ok && text.error).toMatch(/^Flowchart takes data, not Mermaid text: \{nodes, edges, groups\?\}, e\.g\. \{nodes:/);
    expect(cleanFlow(7)).toEqual({ok: false, error: 'expected {nodes, edges, groups?}, received a number'});
    expect(flow({}).ast).toEqual({nodes: [], edges: [], groups: []});
  });

  it('folds a long list of notes into a count', () => {
    const {dropped} = flow({nodes: {A: 'a'}, edges: Array.from({length: 12}, () => ['A'])});
    expect(dropped).toHaveLength(9);
    expect(dropped.at(-1)).toBe('and 4 more');
  });

  // Decision links-through-node-ids: a node's note and file.
  it('reads a node note and file, and the other words for them, saying so', () => {
    const {ast, fixes, dropped} = flow({nodes: {
      P: {label: 'Postgres', shape: 'store', note: 'orders', file: ' db/schema.sql#L1-20 '},
      Q: {label: 'Queue', description: 'jobs', path: 'src/queue.ts'},
      W: {label: 'Worker', detail: 3},
      N: 'Plain',
      M: {label: 'Mailer', notes: 'smtp'},
    }});
    expect(ast.nodes).toEqual([
      {id: 'P', label: 'Postgres', shape: 'store', note: 'orders', file: 'db/schema.sql#L1-20'},
      {id: 'Q', label: 'Queue', shape: 'box', note: 'jobs', file: 'src/queue.ts'},
      {id: 'W', label: 'Worker', shape: 'box', note: '3'},
      {id: 'N', label: 'Plain', shape: 'box'},
      {id: 'M', label: 'Mailer', shape: 'box', note: 'smtp'},
    ]);
    expect(fixes).toEqual(['node Q: description -> note', 'node Q: path -> file', 'node W: detail -> note', 'node M: notes -> note']);
    expect(dropped).toEqual([]);
  });

  it('names a note or file it cannot read, a second note, and the keys it does not know', () => {
    const {ast, dropped} = flow({nodes: {
      R: {label: 'r', note: {}, file: 42},
      S: {label: 's', note: 'kept', detail: 'second'},
      T: {label: 't', file: 'src/t.ts', path: 'src/other.ts', colour: 'red'},
      U: {label: 'u', file: '  '},
    }});
    expect(ast.nodes.map(node => [node.id, node.note, node.file])).toEqual([['R', undefined, undefined], ['S', 'kept', undefined], ['T', undefined, 'src/t.ts'], ['U', undefined, undefined]]);
    expect(dropped).toEqual([
      'node R: note: expected text, received an object',
      "node R: file: expected 'path#L10-20', received a number",
      'node S: detail not read (note is)',
      'node T: path not read (file is)',
      "node U: file: expected 'path#L10-20', received an empty string",
      'ignored node key colour',
    ]);
  });
});

// Decision links-through-node-ids: the diagram node ids an item names.
describe('readNodes', () => {
  it('reads one id, a list (each id once, in order) and a number', () => {
    expect(readNodes({node: 'PG'})).toEqual({ids: ['PG']});
    expect(readNodes({node: [' PG ', 'Redis', 'PG']})).toEqual({ids: ['PG', 'Redis']});
    expect(readNodes({node: 7})).toEqual({ids: ['7']});
    expect(readNodes({})).toEqual({ids: []});
    expect(readNodes({node: []})).toEqual({ids: []});
  });

  it('reads nodes as node and says so; with both, node is read and nodes named', () => {
    expect(readNodes({nodes: ['PG']})).toEqual({ids: ['PG'], alias: 'nodes -> node'});
    expect(readNodes({node: 'A', nodes: 'B'})).toEqual({ids: ['A'], problem: 'nodes not read (node is)'});
    // Another key has no alias.
    expect(readNodes({nodes: 'X'}, 'via')).toEqual({ids: []});
    expect(readNodes({via: ['X', 'Y']}, 'via')).toEqual({ids: ['X', 'Y']});
  });

  it('names what is not an id and keeps the ids it could read', () => {
    expect(readNodes({node: {}})).toEqual({ids: [], problem: "node: expected 'ID' or ['ID', ...], received an object"});
    expect(readNodes({node: ''})).toEqual({ids: [], problem: "node: expected 'ID' or ['ID', ...], received an empty string"});
    expect(readNodes({node: ['PG', {}, 'Redis']})).toEqual({ids: ['PG', 'Redis'], problem: "node: expected 'ID' or ['ID', ...], received an object in the list"});
  });

  it(`keeps the first ${MAX_ENTITY_NODES} ids, or the first max, and says how many were written`, () => {
    expect(readNodes({node: ids(20)})).toEqual({ids: ids(MAX_ENTITY_NODES), problem: `node: 20 ids, the first ${MAX_ENTITY_NODES} kept`});
    expect(readNodes({via: ids(5)}, 'via', 3)).toEqual({ids: ids(3), problem: 'via: 5 ids, the first 3 kept'});
  });
});

// Decision links-through-node-ids (owner's rule): a table row links only through a field named exactly `node` holding text ids.
describe('rowNodes', () => {
  it('reads node as one text id or a list of them, and nothing else', () => {
    expect(rowNodes({node: ' PG '})).toEqual({ids: ['PG']});
    expect(rowNodes({node: ['PG', 'Redis', 'PG']})).toEqual({ids: ['PG', 'Redis']});
    expect(rowNodes({nodes: ['PG']})).toEqual({ids: []});
    expect(rowNodes({cluster: 'prod', nodes: 12})).toEqual({ids: []});
    expect(rowNodes({})).toEqual({ids: []});
  });

  it('says what it did not link, never as not drawn: numbers, null, empty text and objects are not ids', () => {
    expect(rowNodes({node: 12})).toEqual({ids: [], problem: 'node 12 is not a node id, not linked'});
    expect(rowNodes({node: null})).toEqual({ids: [], problem: 'node null is not a node id, not linked'});
    expect(rowNodes({node: ''})).toEqual({ids: [], problem: "node '' is not a node id, not linked"});
    expect(rowNodes({node: ['PG', {id: 'Q'}]})).toEqual({ids: ['PG'], problem: 'node entry 2 {...} is not a node id, not linked'});
    expect(rowNodes({node: ids(20)})).toEqual({ids: ids(MAX_ENTITY_NODES), problem: `node: 20 ids, the first ${MAX_ENTITY_NODES} linked`});
  });
});

describe('cleanSequence', () => {
  it('reads messages as tuples or objects, notes, and actors in declared then first-mention order', () => {
    const {ast, fixes, dropped} = seq({
      actors: {U: 'User', A: 'API'},
      steps: [['U', 'A', 'POST /login'], {from: 'A', to: 'DB', label: 'insert', arrow: 'async'}, ['A', 'U', '200', 'reply'], {note: 'tokens live 15 min', over: ['A', 'DB']}],
    });
    expect(ast.actors).toEqual([{id: 'U', label: 'User'}, {id: 'A', label: 'API'}, {id: 'DB', label: 'DB'}]);
    expect(ast.steps).toEqual([
      {kind: 'message', from: 'U', to: 'A', label: 'POST /login', arrow: 'sync'},
      {kind: 'message', from: 'A', to: 'DB', label: 'insert', arrow: 'async'},
      {kind: 'message', from: 'A', to: 'U', label: '200', arrow: 'reply'},
      {kind: 'note', over: ['A', 'DB'], text: 'tokens live 15 min'},
    ]);
    expect(fixes).toEqual(['actor DB added (not in actors)']);
    expect(dropped).toEqual([]);
  });

  it('reads blocks with their branches as balanced frame steps: open, an else per further branch, end', () => {
    const {ast} = seq([
      {loop: 'every 500 ms', steps: [['Box', 'Car', 'poll']]},
      {alt: 'valid', steps: [['API', 'User', '200', 'reply']], else: [{label: 'invalid', steps: [['API', 'User', '401', 'reply']]}]},
      {par: 'fan out', steps: [['A', 'B', 'x']], and: [['A', 'C', 'y']]},
    ]);
    const shape = (step: (typeof ast.steps)[number]) =>
      step.kind === 'frame' ? (step.edge === 'open' ? `${step.op}[${step.label}]` : step.edge === 'else' ? `else[${step.label}]` : 'end') : step.kind === 'message' ? step.label : 'note';
    expect(ast.steps.map(shape)).toEqual([
      'loop[every 500 ms]', 'poll', 'end',
      'alt[valid]', '200', 'else[invalid]', '401', 'end',
      'par[fan out]', 'x', 'else[]', 'y', 'end',
    ]);
    expect(seqLeaves(ast.steps).map(leaf => leaf.kind === 'message' && leaf.label)).toEqual(['poll', '200', '401', 'x', 'y']);
  });

  it('draws a group (rect, box) as its steps without a frame, and says so', () => {
    const {ast, fixes} = seq([{group: 'setup', steps: [['A', 'B', 'x']]}, {box: 'z', steps: [['B', 'A', 'y']]}]);
    expect(ast.steps.map(step => step.kind)).toEqual(['message', 'message']);
    expect(fixes).toEqual(["step 1: block 'group' drawn without a frame", "step 2: block 'box' drawn without a frame"]);
  });

  it('draws a guess and says so: arrow and block aliases', () => {
    const {ast, fixes} = seq([['A', 'B', 'x', 'return'], ['A', 'B', 'y', 'zigzag'], {while: 'retrying', steps: [['A', 'B', 'z']]}]);
    expect(ast.steps.slice(0, 2).map(step => step.kind === 'message' && step.arrow)).toEqual(['reply', 'sync']);
    expect(ast.steps[2]).toEqual({kind: 'frame', edge: 'open', op: 'loop', label: 'retrying'});
    expect(fixes).toEqual([
      "step 1: arrow 'return' -> reply",
      "step 2: arrow 'zigzag' drawn as sync (arrows: sync reply async)",
      "step 3: block 'while' -> loop",
    ]);
  });

  it('leaves out what cannot be drawn, names it with its place in the tree, and draws the rest', () => {
    const {ast, dropped} = seq([['A', 'B', 'ok'], ['A'], {note: 'floating'}, {opt: 'empty', steps: []}, {loop: 'x', steps: [['A', 'B', 'in'], 'nonsense']}, {wat: 1}]);
    expect(seqLeaves(ast.steps)).toHaveLength(2);
    expect(dropped).toEqual([
      "step 2: expected ['from', 'to', 'label'?, arrow?], received a list of 1",
      "step 3: a note needs over: 'A' or over: ['A', 'B']",
      'step 4: opt block with no steps',
      'step 5.2: expected a message, note or block, received a string',
      "step 6: expected {from, to, label?}, {note, over} or a block such as {loop: 'label', steps}",
    ]);
  });

  it('refuses only what is not a sequence, and says Mermaid text is no longer read', () => {
    const text = cleanSequence('A->>B: hi');
    expect(!text.ok && text.error).toMatch(/^SequenceDiagram takes data, not Mermaid text: \{actors\?, steps\}/);
    expect(cleanSequence({steps: 'A->>B'})).toEqual({ok: false, error: 'steps: expected a list, received a string'});
    expect(cleanSequence(null)).toEqual({ok: false, error: 'expected {actors?, steps} or a list of steps, received null'});
  });

  // Decision links-through-node-ids: the node an actor stands for, and the nodes a message passes through.
  it('reads the node an actor stands for, in a map or a list; an actor without one has none', () => {
    const map = seq({actors: {G: {label: 'Gateway', node: 'GW'}, U: 'User'}, steps: [['U', 'G', 'hi']]});
    expect(map.ast.actors).toEqual([{id: 'G', label: 'Gateway', node: 'GW'}, {id: 'U', label: 'User'}]);
    expect(map.fixes).toEqual([]);
    expect(map.dropped).toEqual([]);
    const list = seq({actors: [{id: 'G', label: 'Gateway', node: 'GW'}, 'U'], steps: [['U', 'G', 'hi']]});
    expect(list.ast.actors).toEqual([{id: 'G', label: 'Gateway', node: 'GW'}, {id: 'U', label: 'U'}]);
  });

  it('draws an actor as one node, reads nodes as node, and names a node it cannot read and keys it does not know', () => {
    const {ast, fixes, dropped} = seq({
      actors: {Q: {label: 'Queue', nodes: ['MQ', 'Bus'], colour: 'teal'}, X: {label: 'X', node: {}}},
      steps: [['Q', 'X', 'push']],
    });
    expect(ast.actors).toEqual([{id: 'Q', label: 'Queue', node: 'MQ'}, {id: 'X', label: 'X'}]);
    expect(fixes).toEqual(['actor Q: nodes -> node', "actor Q: node ['MQ', 'Bus'] -> 'MQ' (an actor is one node)"]);
    expect(dropped).toEqual(["actor X: node: expected 'ID' or ['ID', ...], received an object", 'ignored actor key colour']);
  });

  it(`reads a message's via as one id or a list, names one it cannot read, and keeps ${MAX_ENTITY_NODES - 2}`, () => {
    const {ast, dropped} = seq([
      {from: 'U', to: 'G', label: 'POST /checkout', via: 'CDN'},
      {from: 'U', to: 'G', label: 'retry', via: ['CDN', 'Q']},
      {from: 'U', to: 'G', label: 'bad', via: {}},
      {from: 'U', to: 'G', label: 'long', via: ids(20)},
      {from: 'U', to: 'G', label: 'plain'},
    ]);
    expect(ast.steps.map(step => step.kind === 'message' && step.via)).toEqual([['CDN'], ['CDN', 'Q'], undefined, ids(MAX_ENTITY_NODES - 2), undefined]);
    expect(dropped).toEqual([
      "step 3: via: expected 'ID' or ['ID', ...], received an object",
      `step 4: via: 20 ids, the first ${MAX_ENTITY_NODES - 2} kept`,
    ]);
  });

  it('reads a list or {via} after a list message label or arrow as its via, and names what else it cannot read', () => {
    const {ast, fixes, dropped} = seq([
      ['A', 'B', 'x', ['Q']],
      ['A', 'B', 'y', 'async', {via: ['Q', 'R'], colour: 'red'}],
      ['A', 'B', 'z', null, 'Q'],
      ['A', 'B', 'w', true],
      ['A', 'B', 'v', 'sync', 'more', 'still'],
      ['A', 'B', 'u', 'reply', ['Q'], 'extra'],
      ['A', 'B', {text: 'hi'}],
    ]);
    expect(ast.steps.map(step => step.kind === 'message' && [step.label, step.arrow, step.via])).toEqual([
      ['x', 'sync', ['Q']], ['y', 'async', ['Q', 'R']], ['z', 'sync', undefined], ['w', 'sync', undefined],
      ['v', 'sync', undefined], ['u', 'reply', ['Q']], ['', 'sync', undefined],
    ]);
    expect(fixes).toEqual([
      'step 1: via read from the list form; write {from, to, label, via}',
      'step 2: via read from the list form; write {from, to, label, via}',
      'step 4: arrow a boolean drawn as sync (arrows: sync reply async)',
      'step 6: via read from the list form; write {from, to, label, via}',
    ]);
    expect(dropped).toEqual([
      'step 3: 1 more element not read (write {from, to, label?, arrow?, via?})',
      'step 5: 2 more elements not read (write {from, to, label?, arrow?, via?})',
      'step 6: 1 more element not read (write {from, to, label?, arrow?, via?})',
      'step 7: label: expected text, received an object',
      'ignored message key colour',
    ]);
  });
});

// Decision links-through-node-ids: Layers is read here, by the server and the viewer alike.
describe('cleanLayers', () => {
  it('names a tier by name, label or title, and an item by label, name or title', () => {
    const {ast, fixes, dropped} = layers([
      {title: 'Interface', items: [{title: 'ui'}, {name: 'api', file: 'src/api.ts'}]},
      {label: 'Domain', items: ['auth'], note: 'owns sessions'},
      {name: 'Storage', title: 'ignored', items: [{label: 'postgres', name: 'pg'}]},
    ]);
    expect(ast.bands).toEqual([
      {name: 'Interface', items: [{label: 'ui'}, {label: 'api', file: 'src/api.ts'}]},
      {name: 'Domain', note: 'owns sessions', items: [{label: 'auth'}]},
      {name: 'Storage', items: [{label: 'postgres'}]},
    ]);
    expect(fixes).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('draws what it can of malformed tiers and items and names the rest', () => {
    const {ast, fixes, dropped} = layers([
      {name: 'Mixed', items: ['ok', 7, null, {note: 'no label'}, {label: 'fine'}, ['nested'], '']},
      {items: ['nameless tier']},
      {name: 'No items', items: 'oops'},
      'bare',
      42,
      null,
      true,
    ]);
    expect(ast.bands.map(band => band.name)).toEqual(['Mixed', '—', 'No items', 'bare', '42']);
    expect(ast.bands.map(band => band.items.map(item => item.label))).toEqual([['ok', '7', 'fine'], ['nameless tier'], [], [], []]);
    expect(fixes).toEqual(['tier 2: no name (drawn as —)']);
    expect(dropped).toEqual([
      "tier 1 item 3: expected 'label' or {label}, received null",
      'tier 1 item 4: no label',
      "tier 1 item 6: expected 'label' or {label}, received an array",
      'tier 1 item 7: no label',
      'tier 3: items: expected a list, received a string',
      'tier 6: expected {name, items} or a name, received null',
      'tier 7: expected {name, items} or a name, received a boolean',
    ]);
  });

  it('reads the nodes an item stands for, and names notes, files and keys it cannot use', () => {
    const {ast, fixes, dropped} = layers([{name: 'Data', colour: 'x', note: {}, items: [
      {label: 'Postgres', nodes: 'PG', colour: 'red', file: 3},
      {label: 'Cache', node: ['Redis', 'Mem'], note: 'hot keys', file: 'src/cache.ts#L4'},
      {label: 'Blob', node: {}},
    ]}]);
    expect(ast.bands[0]!.items).toEqual([
      {label: 'Postgres', nodes: ['PG']},
      {label: 'Cache', note: 'hot keys', file: 'src/cache.ts#L4', nodes: ['Redis', 'Mem']},
      {label: 'Blob'},
    ]);
    expect(fixes).toEqual(["item 'Postgres': nodes -> node"]);
    expect(dropped).toEqual([
      'tier 1: note: expected text, received an object',
      "item 'Postgres': file: expected 'path#L10-20', received a number",
      "item 'Blob': node: expected 'ID' or ['ID', ...], received an object",
      'ignored tier key colour',
      'ignored item key colour',
    ]);
  });

  it('reads an item path as its file and says so', () => {
    const {ast, fixes, dropped} = layers([{name: 'Data', items: [{label: 'a', path: 'src/a.ts'}, {label: 'b', file: 'src/b.ts', path: 'src/c.ts'}]}]);
    expect(ast.bands[0]!.items).toEqual([{label: 'a', file: 'src/a.ts'}, {label: 'b', file: 'src/b.ts'}]);
    expect(fixes).toEqual(["item 'a': path -> file"]);
    expect(dropped).toEqual(["item 'b': path not read (file is)"]);
  });

  it('returns every tier and item (the view caps what it draws), and refuses only what is not a list', () => {
    expect(layers(Array.from({length: 100}, (_, i) => ({name: `t${i}`, items: ids(80)}))).ast.bands.map(band => band.items.length)).toEqual(Array(100).fill(80));
    expect(cleanLayers({name: 'not a list'})).toEqual({ok: false, error: 'expected tiers [{name, items}], received an object'});
    expect(cleanLayers('tiers')).toEqual({ok: false, error: 'expected tiers [{name, items}], received a string'});
    expect(layers([]).ast).toEqual({bands: []});
  });
});

// Decision links-through-node-ids: ERDiagram is read here, by the server and the viewer alike.
// The tab's "N not drawn": the notes fold past 8 lines and name unknown keys, so their lines are not the count.
describe('droppedCount', () => {
  it('counts every entry left out, the folded ones too, and no unknown key', () => {
    const layers = cleanLayers([{name: 'T', items: Array(20).fill(null)}]);
    expect(layers.ok && [layers.dropped.length, layers.dropped.at(-1), layers.droppedCount]).toEqual([9, 'and 12 more', 20]);
    const keys = cleanLayers([{name: 'T', items: [{label: 'pg', colour: 'b'}]}]);
    expect(keys.ok && [keys.dropped, keys.droppedCount]).toEqual([['ignored item key colour'], 0]);
    const schema = cleanSchema([{name: 'ok', columns: []}, ...Array.from({length: 30}, () => ({columns: []}))]);
    expect(schema.ok && [schema.dropped.length, schema.droppedCount]).toEqual([9, 30]);
    const flow = cleanFlow({nodes: {A: {label: 'A', colour: 'red'}}, edges: [['A'], ['A']]});
    expect(flow.ok && [flow.dropped.length, flow.droppedCount]).toEqual([3, 2]);
    const seq = cleanSequence({steps: [['A', 'B', 'go'], {note: 'x'}, {note: 'y', colour: 'r'}]});
    expect(seq.ok && seq.droppedCount).toBe(2);
  });
});

describe('cleanSchema', () => {
  const TABLES = [
    {name: 'users', columns: [{name: 'id', type: 'uuid', pk: true}, 'email']},
    {name: 'orders', columns: [{name: 'id', pk: true}, {name: 'user_id', fk: 'users.id'}, {name: 'shop', ref: 'shops'}]},
    {name: 'shops', columns: [{name: 'id', pk: true}]},
  ];

  it('reads a bare list of tables and draws the relation a string fk or ref names, once', () => {
    const {ast, fixes, dropped} = schema(TABLES);
    expect(ast.tables.map(table => table.name)).toEqual(['users', 'orders', 'shops']);
    expect(ast.tables[0]!.columns).toEqual([{name: 'id', type: 'uuid', pk: true, fk: false, nullable: false}, {name: 'email', pk: false, fk: false, nullable: false}]);
    expect(ast.relations).toEqual([
      {from: 'orders', fromColumn: 'user_id', to: 'users', toColumn: 'id', card: 'n-1'},
      {from: 'orders', fromColumn: 'shop', to: 'shops', card: 'n-1'},
    ]);
    // a column that points somewhere is marked as a foreign key
    expect(ast.tables[1]!.columns.filter(column => column.fk).map(column => column.name)).toEqual(['user_id', 'shop']);
    expect(fixes).toEqual([]);
    expect(dropped).toEqual([]);
    // written out in relations as well, in either direction: drawn once
    const both = schema({tables: TABLES, relations: [{from: 'users.id', to: 'orders.user_id', label: 'places', card: '1-n'}]});
    expect(both.ast.relations.filter(rel => [rel.from, rel.to].sort().join() === 'orders,users')).toEqual([{from: 'users', fromColumn: 'id', to: 'orders', toColumn: 'user_id', label: 'places', card: '1-n'}]);
  });

  it('reads the file and the nodes a table stands for', () => {
    const {ast, fixes, dropped} = schema([
      {name: 'orders', file: 'db/schema.sql#L10-30', node: 'PG', columns: ['id']},
      {name: 'payments', file: 'db/schema.sql#L32-50', nodes: ['PG', 'Ledger'], columns: ['id']},
      {name: 'audit', file: 7, node: {}, columns: []},
    ]);
    expect(ast.tables.map(({name, file, nodes}) => ({name, file, nodes}))).toEqual([
      {name: 'orders', file: 'db/schema.sql#L10-30', nodes: ['PG']},
      {name: 'payments', file: 'db/schema.sql#L32-50', nodes: ['PG', 'Ledger']},
      {name: 'audit', file: undefined, nodes: undefined},
    ]);
    expect(fixes).toEqual(['table payments: nodes -> node']);
    expect(dropped).toEqual([
      "table audit: file: expected 'path#L10-20', received a number",
      "table audit: node: expected 'ID' or ['ID', ...], received an object",
    ]);
  });

  it('reads a table path as its file and says so', () => {
    const {ast, fixes, dropped} = schema([{name: 'users', path: 'db/schema.sql#L1-9', columns: ['id']}]);
    expect(ast.tables[0]!.file).toBe('db/schema.sql#L1-9');
    expect(fixes).toEqual(['table users: path -> file']);
    expect(dropped).toEqual([]);
  });

  it('draws what it can of malformed tables and relations and names the rest', () => {
    const {ast, fixes, dropped} = schema({
      tables: [
        {name: 'a', columns: ['bare', {name: 'ok', type: 7}, {type: 'nameless'}, null]},
        {name: 'a', columns: []},
        {columns: [{name: 'x'}]},
        {name: 'b.c', columns: 'none'},
        'junk',
      ],
      relations: [{from: 'a.ok', to: 'b.c'}, {from: 'a', to: 'ghost'}, {from: 'a.nope', to: 'a.bare', card: 'weird'}, 'junk'],
    });
    expect(ast.tables.map(table => [table.name, table.columns.map(column => column.name)])).toEqual([['a', ['bare', 'ok']], ['b.c', []]]);
    expect(ast.tables[0]!.columns[1]).toEqual({name: 'ok', type: '7', pk: false, fk: false, nullable: false});
    expect(ast.relations).toEqual([{from: 'a', fromColumn: 'ok', to: 'b.c'}, {from: 'a', fromColumn: 'nope', to: 'a', toColumn: 'bare'}]);
    expect(fixes).toEqual(["relation 3: card 'weird' drawn without cardinality (cards: 1-1 1-n n-1 n-n)"]);
    expect(dropped).toEqual([
      'table a column 3: no name',
      "table a column 4: expected 'name' or {name, type?}, received null",
      'table a: repeated',
      'table 3: no name',
      'table b.c: columns: expected a list, received a string',
      'table 5: expected {name, columns}, received a string',
      "relation 2: unknown table 'ghost'",
      "relation 4: expected {from: 'table.column', to: 'table.column'}, received a string",
    ]);
  });

  it('names a pointer at a table that is not there, a relation end left out, and keys it does not know', () => {
    const {ast, dropped} = schema({
      tables: [{name: 'orders', x: 1, columns: [{name: 'user_id', fk: 'user.id', unique: true, default: 0}]}],
      relations: [{to: 'orders'}, {from: 'orders', to: 'orders', y: 2}],
      views: [],
    });
    expect(ast.relations).toEqual([{from: 'orders', to: 'orders'}]);
    expect(dropped).toEqual([
      'relation 1: no from',
      "column orders.user_id: fk 'user.id' names no table",
      'ignored schema key views',
      'ignored table key x',
      'ignored column keys unique, default',
      'ignored relation key y',
    ]);
    expect(schema({tables: [], relations: 'none'}).dropped).toEqual(['relations: expected a list, received a string']);
  });

  it('refuses only what is not a schema, with the messages the viewer shows', () => {
    expect(cleanSchema(7)).toEqual({ok: false, error: 'expected tables [{name, columns}] or {tables, relations}, received a number'});
    expect(cleanSchema({tables: 'x'})).toEqual({ok: false, error: 'expected tables to be an array, received a string'});
    expect(cleanSchema([{columns: []}, 'x'])).toEqual({ok: false, error: 'expected tables [{name, columns}], but none of the 2 entries have a name'});
    expect(schema([]).ast).toEqual({tables: [], relations: []});
  });
});

// Decision links-through-node-ids: what Steps items and inline table rows link to, for the server's checks.
describe('cleanItems', () => {
  it('reads a step file and nodes, checks step keys, and lists only the steps that link', () => {
    const result = cleanItems('step', [
      {title: 'Add the table', node: 'PG', file: 'src/a.ts#L2', link: 'x'},
      'Plain',
      {name: 'Wire it', nodes: ['A', 'B'], status: 'doing', note: 'n'},
      {label: 'Bad file', file: 3},
      {title: 'Nothing'},
    ]);
    expect(result).toEqual({
      ok: true,
      ast: [{at: 'step 1', file: 'src/a.ts#L2', nodes: ['PG']}, {at: 'step 3', nodes: ['A', 'B']}],
      fixes: ['step 3: nodes -> node'],
      dropped: ["step 4: file: expected 'path#L10-20', received a number", 'ignored step key link'],
      // an unknown key leaves nothing out
      droppedCount: 1,
    });
  });

  it('reads only node in a row, as rowNodes: a row is data, so its other keys, nodes and numbers are not read', () => {
    expect(cleanItems('row', [{choice: 'System of record', node: 'PG', file: 3}, {nodes: 'Q'}, {name: 'r'}, {node: {}}, {node: 12}])).toEqual({
      ok: true,
      ast: [{at: 'row 1', nodes: ['PG']}],
      fixes: [],
      dropped: ['row 4: node {...} is not a node id, not linked', 'row 5: node 12 is not a node id, not linked'],
      droppedCount: 2,
    });
  });

  it('reads a step path as its file and says so', () => {
    expect(cleanItems('step', [{title: 'a', path: 'src/a.ts#L2'}, {title: 'b', file: 'src/b.ts', path: 'src/c.ts'}])).toEqual({
      ok: true,
      ast: [{at: 'step 1', file: 'src/a.ts#L2'}, {at: 'step 2', file: 'src/b.ts'}],
      fixes: ['step 1: path -> file'],
      dropped: ['step 2: path not read (file is)'],
      droppedCount: 1,
    });
  });

  it('never refuses: a value that is not a list links nothing', () => {
    for (const value of ['git.log', {title: 'x'}, null, undefined]) expect(cleanItems('step', value)).toEqual({ok: true, ast: [], fixes: [], dropped: [], droppedCount: 0});
  });
});
