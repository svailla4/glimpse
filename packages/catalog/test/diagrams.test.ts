import {describe, expect, it} from 'vitest';
import {cleanFlow, cleanSequence, seqLeaves, type Clean, type FlowAst, type SeqAst} from '../src/index.ts';

function ok<T>(result: Clean<T>): {ast: T; fixes: string[]; dropped: string[]} {
  if (!result.ok) throw new Error(result.error);
  return result;
}
const flow = (data: unknown) => ok<FlowAst>(cleanFlow(data));
const seq = (data: unknown) => ok<SeqAst>(cleanSequence(data));

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
});
