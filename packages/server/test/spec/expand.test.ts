// Expansion: source refs and default sources become /ds bindings; refs, notation, columns and reserved paths are
// judged here. Runs on a registry of fakes plus the catalog's own source names.
import {datasetKey, GALLERY_SPEC, parseRef, SOURCE_BY_NAME, VIEWS, type A2uiMessage, type WireComponent} from '@glimpse/catalog';
import {beforeAll, describe, expect, it} from 'vitest';
import {createRegistry} from '../../src/sources/registry.ts';
import {compileSpec, loadToolchain, type Toolchain} from '../../src/spec/compile.ts';
import {diagramNotes, linkNotes} from '../../src/spec/authored.ts';
import {boundKeys, calcNotes, checkRef, expandMessages, refSignature, splitRatio, unboundPaths} from '../../src/spec/expand.ts';
import {fakeSources} from '../session/fakes.ts';

let tools: Toolchain;
beforeAll(async () => {
  tools = await loadToolchain();
});

const fakes = fakeSources();
const registry = createRegistry([fakes.rows, fakes.slow]);

function expand(spec: string) {
  const {messages} = compileSpec(tools, {surfaceId: 's', sources: [spec], surfaces: []});
  const expansion = expandMessages(messages, registry);
  const first = messages[0]!;
  const components: WireComponent[] = 'createSurface' in first ? first.createSurface.components : [];
  const byComponent = (name: string) => components.find(c => c.component === name)!;
  return {...expansion, messages, components, byComponent, codes: expansion.problems.map(p => p.code), lines: expansion.problems.map(p => `${p.code} ${p.message}`)};
}
const key = (ref: string) => datasetKey(parseRef(ref));
const bind = (ref: string) => ({'@path': `/ds/${key(ref)}`});

describe('expandMessages: data props', () => {
  it('an omitted data prop with a default source binds that source', () => {
    const out = expand(`root=Page('x',[Stats(),Chips(),Treemap(),Graph()])`);
    expect(out.problems).toEqual([]);
    expect(out.byComponent('Stats').data).toEqual({'@path': '/ds/repo_kpis'});
    expect(out.byComponent('Chips').data).toEqual({'@path': '/ds/repo_stack'});
    expect(out.byComponent('Treemap').data).toEqual({'@path': '/ds/files_tree'});
    expect([...out.refs.keys()]).toEqual(['repo_kpis', 'repo_stack', 'files_tree', 'deps_modules']);
  });

  it('a ref string binds a keyed dataset; the same ref in two components is one dataset', () => {
    const out = expand(`root=Page('x',[DataTable('git.churn src/auth top=20'),BarChart('git.churn  top=20  src/auth'),DataTable('fake.rows')])`);
    expect(out.problems).toEqual([]);
    expect(out.byComponent('DataTable').data).toEqual(bind('git.churn src/auth top=20'));
    expect(out.byComponent('BarChart').data).toEqual(bind('git.churn src/auth top=20'));
    expect([...out.refs]).toEqual([
      [key('git.churn src/auth top=20'), {source: 'git.churn', target: 'src/auth', args: {top: '20'}}],
      ['fake_rows', {source: 'fake.rows', args: {}}],
    ]);
  });

  it('bindings and inline data pass through untouched', () => {
    const out = expand(`$/rows=[{a:1}]\nroot=Page('x',[DataTable($/rows),BarChart([{k:'a',v:1}],'k','v')])`);
    expect(out.problems).toEqual([]);
    expect(out.refs.size).toBe(0);
    expect(out.byComponent('DataTable').data).toEqual({'@path': '/rows'});
    expect(out.byComponent('BarChart').data).toEqual([{k: 'a', v: 1}]);
  });

  it('a string that is not a source stays a string where the shape allows strings', () => {
    const out = expand(`root=Page('x',[Stat('3.1k','loc'),Stat('node.js','runtime'),JsonView('plain text')])`);
    expect(out.problems).toEqual([]);
    expect(out.refs.size).toBe(0);
    expect(out.components.filter(c => c.component === 'Stat').map(c => c.value)).toEqual(['3.1k', 'node.js']);
  });

  it('...and is an error where it does not', () => {
    const out = expand(`root=Page('x',[DataTable('hello world'),Steps('todo')])`);
    expect(out.lines).toEqual([
      `E_SOURCE DataTable#root_children_0.data: "hello world" is not a source ref. Write a ref ('files.list src top=20'), a $/path or inline Rows.`,
      `E_SOURCE Steps#root_children_1.data: "todo" is not a source ref. Write a ref ('files.list src top=20'), a $/path or inline StepItem[].`,
    ]);
  });

  it('an unknown source is E_SOURCE with the nearest names', () => {
    const out = expand(`root=Page('x',[DataTable('git.chrun src')])`);
    expect(out.lines).toEqual(['E_SOURCE DataTable#root_children_0.data: unknown source "git.chrun". Nearest: git.churn git.log git.authors']);
    expect(out.problems[0]!.component).toBe('DataTable');
  });

  it('a missing required target and an unknown argument name are E_ARGS with the ref signature', () => {
    const out = expand(`root=Page('x',[DataTable('code.symbols'),DataTable('git.churn limit=5'),Graph('deps.files src/a.ts depth=2 top=3')])`);
    expect(out.lines).toEqual([
      `E_ARGS DataTable#root_children_0.data: code.symbols needs a path. Ref: 'code.symbols <path> [top=]'`,
      `E_ARGS DataTable#root_children_1.data: git.churn takes no argument "limit". Ref: 'git.churn [path] [top=] [since=] [by=]'`,
      `E_ARGS Graph#root_children_2.data: deps.files takes no argument "top". Ref: 'deps.files <path> [depth=]'`,
    ]);
  });

  it('top= is accepted on every rows source, listed or not; values are left to the source', () => {
    const out = expand(`root=Page('x',[DataTable('deps.cycles top=3'),DataTable('git.churn top=banana since=never')])`);
    expect(out.problems).toEqual([]);
  });
});

describe('expandMessages: diagram data, columns, paths', () => {
  it('inline diagram data draws; what it corrected is fixed, what it leaves out is warn, one entry at a time', () => {
    const good = expand(`root=Page('x',[Flowchart({nodes:{A:'Start',B:{label:'ok?',shape:'diamond'}},edges:[['A','B']]}),SequenceDiagram({steps:[['A','B','hi'],['B','A','yo','reply']]})])`);
    expect(good.problems).toEqual([]);
    expect(good.fixes).toEqual([]);
    expect(good.warnings).toEqual([]);
    const partly = expand(`root=Page('x',[Flowchart({nodes:{A:{label:'a',shape:'cylinder'}},edges:[['A','B'],['A']]}),SequenceDiagram({steps:[['A','B','hi'],{note:'lost'}]})])`);
    expect(partly.problems).toEqual([]);
    expect(partly.fixes).toEqual([
      "Flowchart#root_children_0: node A: shape 'cylinder' -> store",
      'Flowchart#root_children_0: node B added for edge A -> B (not in nodes)',
    ]);
    expect(partly.warnings).toEqual([
      "Flowchart#root_children_0: not drawn: edge 2: expected ['from', 'to', 'label'?] or {from, to}, received a list of 1",
      "SequenceDiagram#root_children_1: not drawn: step 2: a note needs over: 'A' or over: ['A', 'B']",
    ]);
  });

  it('Mermaid text where a diagram takes data is E_SHAPE with the shape to write instead', () => {
    const bad = expand(`root=Page('x',[Flowchart('A --> B'),SequenceDiagram('A->>B: hi'),Flowchart(42)])`);
    expect(bad.codes).toEqual(['E_SHAPE', 'E_SHAPE', 'E_SHAPE']);
    expect(bad.lines[0]).toMatch(/^E_SHAPE Flowchart#root_children_0\.data: Flowchart takes data, not Mermaid text: \{nodes, edges, groups\?\}, e\.g\. \{nodes:/);
    expect(bad.lines[1]).toMatch(/^E_SHAPE SequenceDiagram#root_children_1\.data: SequenceDiagram takes data, not Mermaid text: /);
    expect(bad.lines[2]).toBe('E_SHAPE Flowchart#root_children_2.data: expected {nodes, edges, groups?}, received a number');
  });

  it('bound diagram data is left to diagramNotes, which reads the data model after the call', () => {
    const out = expand(`$/flow={edges:[['A','B']]}\nroot=Page('x',[Flowchart($/flow)])`);
    expect(out.problems).toEqual([]);
    const flow = out.byComponent('Flowchart');
    const data = {flow: {nodes: {A: 'a'}, edges: [['A', 'B'], ['A', 'G']], groups: {G: 'Group'}}};
    // defined in this call: checked
    expect(diagramNotes([flow], data, new Set([flow.id]), new Set())).toEqual({
      fixes: [`Flowchart#${flow.id}: node B added for edge A -> B (not in nodes)`],
      warnings: [`Flowchart#${flow.id}: not drawn: edge A -> G: G is a group; edges join nodes`, `Flowchart#${flow.id}: not drawn: group G: no nodes in it`],
      files: [],
    });
    // a later patch writes $/flow/... and names no component: still checked
    expect(diagramNotes([flow], data, new Set(), new Set(['flow'])).warnings).toHaveLength(2);
    // neither defined nor written: said already, not again
    expect(diagramNotes([flow], data, new Set(), new Set(['other']))).toEqual({fixes: [], warnings: [], files: []});
    // not a diagram at all
    expect(diagramNotes([flow], {flow: 'A --> B'}, new Set([flow.id]), new Set()).warnings).toEqual([
      `Flowchart#${flow.id}: E_SHAPE $/flow: Flowchart takes data, not Mermaid text: {nodes, edges, groups?}, e.g. {nodes:{A:'Request',B:{label:'Over limit?',shape:'diamond'}},edges:[['A','B'],['B','C','no']]}`,
    ]);
  });

  // Decision D24: Layers, ERDiagram, Steps and DataTable rows are read by the catalog cleaners the tab draws with.
  it('inline Layers and ERDiagram data say what they leave out, and what is not the shape at all is E_SHAPE', () => {
    const out = expand(`root=Page('x',[Layers([{name:'Data',colour:'red',items:[{label:'Postgres',size:3,node:'PG'},true]}]),ERDiagram([{name:'users',columns:[{name:'id',unique:true}]},{name:'users',columns:[]}]),Flowchart({nodes:{PG:'Postgres'},edges:[]})])`);
    expect(out.problems).toEqual([]);
    expect(out.warnings).toEqual([
      "Layers#root_children_0: not drawn: tier 1 item 2: expected 'label' or {label}, received a boolean",
      'Layers#root_children_0: not drawn: ignored tier key colour',
      'Layers#root_children_0: not drawn: ignored item key size',
      'ERDiagram#root_children_1: not drawn: table users: repeated',
      'ERDiagram#root_children_1: not drawn: ignored column key unique',
    ]);
    const bad = expand(`root=Page('x',[Layers({name:'Data'}),ERDiagram(true)])`);
    expect(bad.lines).toEqual([
      'E_SHAPE Layers#root_children_0.data: expected tiers [{name, items}], received an object',
      'E_SHAPE ERDiagram#root_children_1.data: expected tables [{name, columns}] or {tables, relations}, received a boolean',
    ]);
  });

  it('text in a Layers data prop is a source ref, never refused as Mermaid', () => {
    const out = expand(`root=Page('x',[Layers('fake.rows')])`);
    expect(out.problems).toEqual([]);
    expect(out.byComponent('Layers').data).toEqual(bind('fake.rows'));
  });

  it('Steps items and inline DataTable rows read node like the tab: an alias is fixed, a bad value or Steps key is warn', () => {
    const out = expand(`root=Page('x',[Steps([{title:'Migrate',nodes:'PG',owner:'Mira'},{title:'Ship',node:{id:'PG'}}]),DataTable([{name:'a',nodes:['PG','Redis']},{name:'b',node:'PG'}])])`);
    expect(out.problems).toEqual([]);
    expect(out.fixes).toEqual(['Steps#root_children_0: step 1: nodes -> node', 'DataTable#root_children_1: row 1: nodes -> node']);
    expect(out.warnings).toEqual([
      "Steps#root_children_0: not drawn: step 2: node: expected 'ID' or ['ID', ...], received an object",
      'Steps#root_children_0: not drawn: ignored step key owner',
    ]);
  });

  it('the files inline diagram and Steps data name are checked like file props', () => {
    const out = expand(`root=Page('x',[Flowchart({nodes:{PG:{label:'Postgres',file:'db/schema.sql#L1-20'}},edges:[]}),Layers([{name:'Data',items:[{label:'Postgres',file:'db/schema.sql'}]}]),ERDiagram([{name:'users',file:'db/users.sql',columns:['id']}]),Steps([{title:'Migrate',file:'db/migrate.sql#L3'}])])`);
    expect(out.problems).toEqual([]);
    expect(out.files).toEqual([
      {where: 'Flowchart#root_children_0 node PG', file: 'db/schema.sql#L1-20', nested: true},
      {where: "Layers#root_children_1 item 'Postgres'", file: 'db/schema.sql', nested: true},
      {where: 'ERDiagram#root_children_2 table users', file: 'db/users.sql', nested: true},
      {where: 'Steps#root_children_3 step 1', file: 'db/migrate.sql#L3', nested: true},
    ]);
  });

  it('diagramNotes reads bound Layers, ERDiagram and Steps data too, and returns the files they name', () => {
    const comps: WireComponent[] = [
      {id: 'tiers', component: 'Layers', data: {'@path': '/tiers'}},
      {id: 'er', component: 'ERDiagram', data: {'@path': '/er'}},
      {id: 'plan', component: 'Steps', data: {'@path': '/plan'}},
    ];
    const data = {tiers: [{name: 'Data', items: [{label: 'PG', file: 'db/a.sql', colour: 'red'}]}], er: 'not a schema', plan: [{title: 'A', file: 'db/b.sql#L2'}]};
    expect(diagramNotes(comps, data, new Set(['tiers', 'er', 'plan']), new Set())).toEqual({
      fixes: [],
      warnings: ['Layers#tiers: not drawn: ignored item key colour', 'ERDiagram#er: E_SHAPE $/er: expected tables [{name, columns}] or {tables, relations}, received a string'],
      files: [{where: "Layers#tiers item 'PG'", file: 'db/a.sql', nested: true}, {where: 'Steps#plan step 1', file: 'db/b.sql#L2', nested: true}],
    });
  });

  it('an unknown column kind is E_ENUM listing the kinds', () => {
    const out = expand(`root=Page('x',[DataTable('fake.rows','path n:bars owner:author=Owned_by')])`);
    expect(out.codes).toEqual(['E_ENUM']);
    expect(out.lines[0]).toMatch(/^E_ENUM DataTable#root_children_0\.columns column 2: unknown kind "bars" for column "n"\. Kinds: text num /);
  });

  it('the list form of columns is checked entry by entry: an unknown kind is E_ENUM, the rest is warn and draws (D22)', () => {
    const bad = expand(`root=Page('x',[DataTable('fake.rows',['path',{key:'n',kind:'bars'}])])`);
    expect(bad.lines).toEqual([expect.stringMatching(/^E_ENUM DataTable#root_children_0\.columns column 2: unknown kind "bars" for column "n"\. Kinds: text num /)]);
    const partly = expand(`root=Page('x',[DataTable('fake.rows',['path',{kind:'bar'},{key:'n',width:80}])])`);
    expect(partly.problems).toEqual([]);
    expect(partly.warnings).toEqual([
      "DataTable#root_children_0.columns column 2: not drawn: no key: expected 'key' or {key, kind?, label?}",
      'DataTable#root_children_0.columns column 3: ignored key width of column "n"',
    ]);
    // not a list or a string: an object is refused by the prop's schema, anything else by the reader
    expect(() => expand(`root=Page('x',[DataTable('fake.rows',columns={path:true})])`)).toThrow(/E_TYPE DataTable#root_children_0 columns: /);
    expect(expand(`root=Page('x',[DataTable('fake.rows',columns=5)])`).lines).toEqual([
      "E_SHAPE DataTable#root_children_0.columns: expected a list ['key' or {key, kind?, label?}], received a number",
    ]);
  });

  it('assignments under /ds and /meta are rejected, in a new view and in a patch', () => {
    expect(expand(`$/ds/x=1\n$/meta/rev=9\nroot=Page('x',[])`).lines).toEqual([
      'E_PATH $/ds cannot be assigned: /ds and /meta are written by the server. Name a source in a data argument instead.',
      'E_PATH $/meta cannot be assigned: /ds and /meta are written by the server. Name a source in a data argument instead.',
    ]);
    const patch: A2uiMessage[] = [
      {version: '1.0', updateDataModel: {surfaceId: 's', path: '/ds/git_churn/data', value: []}},
      {version: '1.0', updateDataModel: {surfaceId: 's', path: '/meta', value: {}}},
      {version: '1.0', updateDataModel: {surfaceId: 's', path: '/dsx', value: 1}},
      {version: '1.0', updateDataModel: {surfaceId: 's', path: '/ui/file', value: 'a.ts'}},
      {version: '1.0', updateDataModel: {surfaceId: 's', value: {}}},
    ];
    expect(expandMessages(patch, registry).problems.map(p => p.code)).toEqual(['E_PATH', 'E_PATH', 'E_PATH']);
  });

  it('collects every problem of a call', () => {
    const out = expand(`root=Page('x',[DataTable('nope.nope'),Flowchart('???'),DataTable('fake.rows','a:zzz'),DataTable('code.refs')])`);
    expect(out.codes).toEqual(['E_SOURCE', 'E_SHAPE', 'E_ENUM', 'E_ARGS']);
  });

  it('a reserved path segment in a compiled message is E_PATH (decision D10)', () => {
    const out = expandMessages([{version: '1.0', updateDataModel: {surfaceId: 's', path: '/a/__proto__/b', value: 1}}], registry);
    expect(out.problems.map(p => `${p.code} ${p.message}`)).toEqual(['E_PATH "__proto__" cannot be used as a data path segment: __proto__, constructor and prototype are reserved. Rename it.']);
  });
});

// Decision D25: what a Slider binds, a call where it computes nothing, and calls checked against the data.
describe('expandMessages: Slider and calls', () => {
  it('a Slider value that is not a binding to a path of the model\'s own is refused with what to write', () => {
    expect(expand(`root=Page('x',[s])\ns=Slider('Seats',50000)`).lines)
      .toEqual([`E_TYPE Slider#s.value: 50000 is not a $/path. A Slider edits data: write $/w={seats:50000} and Slider('Seats',$/w/seats).`]);
    expect(expand(`root=Page('x',[s])\ns=Slider('Seats',div($/a,2))`).lines)
      .toEqual([`E_TYPE Slider#s.value: a call is not a $/path. A Slider edits data: write $/w={seats:50000} and Slider('Seats',$/w/seats).`]);
    expect(expand(`root=Page('x',[s])\ns=Slider('Seats',$w/seats)`).lines).toEqual(['E_TYPE Slider#s.value: bind an absolute $/path, e.g. $/w/seats.']);
    expect(expand(`root=Page('x',[s])\ns=Slider('Seats',$/ui/seats)`).lines)
      .toEqual(['E_PATH Slider#s.value: $/ui/seats belongs to the viewer (/ds and /meta to the server); bind a path of your own, e.g. $/w/seats.']);
    for (const path of ['/ds/x', '/meta/rev']) {
      expect(expand(`root=Page('x',[s])\ns=Slider('Seats',$${path})`).lines)
        .toEqual([`E_PATH Slider#s.value: $${path} belongs to the server (/ui to the viewer); bind a path of your own, e.g. $/w/seats.`]);
    }
  });

  it('a Slider whose min is not below its max is drawn without a range, and says so', () => {
    const out = expand(`$/w={seats:5}\nroot=Page('x',[s,t])\ns=Slider('Seats',$/w/seats,10,5)\nt=Slider('Same',$/w/seats,3,3)`);
    expect(out.problems).toEqual([]);
    expect(out.warnings).toEqual(['Slider#s: min 10 is not below max 5, so no range is drawn', 'Slider#t: min 3 is not below max 3, so no range is drawn']);
    expect(expand(`$/w={seats:5}\nroot=Page('x',[s])\ns=Slider('Seats',$/w/seats,1,10,step=1,unit='s')`).warnings).toEqual([]);
  });

  it('a call as an action is refused: it computes a number', () => {
    expect(expand(`root=Page('x',[b])\nb=Button('Go',div(1,2))`).lines).toEqual([`E_TYPE Button#b.action: div(...) computes a number; an action is Event('name',{...}).`]);
  });

  it('a call in the data model is not computed: said once, for a new view and for a patch', () => {
    expect(expand(`$/k=[{label:'x',value:mul($/a,2)},{label:'y',value:add(1,2)}]\n$/n={v:div(1,2)}\nroot=Page('x',[Stats($/k)])`).warnings)
      .toEqual([`$/k/0/value: a call in data is not computed; write it in a component argument, e.g. Stats([{label:'x',value:mul($/a,2)}]). (and 2 more)`]);
    const patch: A2uiMessage[] = [{version: '1.0', updateDataModel: {surfaceId: 's', path: '/w/rows', value: [{n: {'@call': 'mul', args: {a: {'@path': '/w/a'}, b: 2}}}]}}];
    expect(expandMessages(patch, registry).warnings).toEqual([`$/w/rows/0/n: a call in data is not computed; write it in a component argument, e.g. Stats([{label:'x',value:mul($/a,2)}]).`]);
    // a binding in data is data, and a call in a component argument is what it should be
    expect(expand(`$/k={a:1}\nroot=Page('x',[Stats([{label:'x',value:mul($/k/a,2)}])])`).warnings).toEqual([]);
  });

  it('calcNotes computes the calls against the data after the call, and says why one has no number', () => {
    const stat: WireComponent = {id: 'rps', component: 'Stat', value: {'@call': 'div', args: {a: {'@path': '/w/seats'}, b: {'@path': '/w/secs'}}}};
    const peak: WireComponent = {id: 'peak', component: 'Stats', data: [
      {label: 'a', value: {'@call': 'mul', args: {a: {'@path': '/w/seats'}, b: 2}}},
      {label: 'b', value: {'@call': 'mul', args: {a: {'@call': 'mul', args: {a: {'@path': '/w/big'}, b: 1e300}}, b: 1e300}}},
      {label: 'c', value: {'@call': 'add', args: {a: {'@path': '/w/none'}, b: 1}}},
    ]};
    const slider: WireComponent = {id: 's', component: 'Slider', label: 'Seats', value: {'@path': '/w/seats'}};
    const comps = [stat, peak, slider];
    const ids = new Set(comps.map(comp => comp.id));
    const data = {w: {seats: '50k', secs: 0, big: 1}};
    expect(calcNotes(comps, data, ids, new Set())).toEqual([
      'Stat#rps: value: div: a = $/w/seats is "50k", not a number',
      'Stats#peak: data/0/value: mul: a = $/w/seats is "50k", not a number',
      'Stats#peak: data/1/value: mul: the result is too large',
      'Slider#s: $/w/seats is "50k", not a number',
    ]);
    // division by zero; an operand not set is the unbound line's, not said twice
    expect(calcNotes([stat], {w: {seats: 100, secs: 0}}, ids, new Set())).toEqual(['Stat#rps: value: div: b = $/w/secs is 0 (division by zero)']);
    expect(calcNotes([stat], {w: {seats: 100}}, ids, new Set())).toEqual([]);
    expect(unboundPaths([stat], {w: {seats: 100}})).toEqual(['$/w/secs']);
    // scope: a component the call defines, or one reading a top segment it wrote; neither is said again
    expect(calcNotes([stat], {w: {seats: 1, secs: 0}}, new Set(), new Set(['w']))).toHaveLength(1);
    expect(calcNotes([slider], data, new Set(), new Set(['w']))).toEqual(['Slider#s: $/w/seats is "50k", not a number']);
    expect(calcNotes(comps, data, new Set(), new Set(['other']))).toEqual([]);
    // a value that computes is no line at all
    expect(calcNotes([stat, slider], {w: {seats: 50000, secs: 120}}, ids, new Set())).toEqual([]);
  });
});

// Findings F032 and F090: an `ok` whose view shows a redline. What the spec alone gives away is said at once.
// Decision D24: an id an item links to that nothing else on the view declares or links is named, with a hint.
describe('linkNotes', () => {
  const flow: WireComponent = {id: 'arch', component: 'Flowchart', data: {nodes: {PG: 'Postgres', GW: 'Gateway', Inv: 'Inventory', Q: 'Queue'}, edges: []}};
  const tiers = (...nodes: unknown[]): WireComponent => ({id: 'tiers', component: 'Layers', data: [{name: 'Data', items: nodes.map((node, i) => ({label: `item ${i}`, node}))}]});
  const all = (comps: WireComponent[]) => new Set(comps.map(comp => comp.id));
  const notes = (comps: WireComponent[], data: Record<string, unknown> = {}) => linkNotes(comps, data, all(comps), new Set());

  it('names a typo with the nearest id, and an id that is a label with the node it labels', () => {
    expect(notes([flow, tiers('PGG', 'PG')])).toEqual(["Layers#tiers: node 'PGG' links to nothing on this view (nearest: PG)"]);
    const seq: WireComponent = {id: 'checkout', component: 'SequenceDiagram', data: {actors: {U: 'User', G: {label: 'Gateway', node: 'Gateway'}, I: {label: 'Inventory', node: 'Inv2'}}, steps: [['U', 'G', 'hi'], {from: 'G', to: 'I', label: 'hold', via: ['Q']}]}};
    expect(notes([flow, seq])).toEqual(["SequenceDiagram#checkout: nodes 'Gateway' (the label of node 'GW'), 'Inv2' (nearest: Inv) link to nothing on this view"]);
  });

  it('is silent when another part declares or links the id, and never hints a one-letter id', () => {
    expect(notes([flow, tiers('PG', 'GW')])).toEqual([]);
    // two lists linking the same id link each other
    const plan: WireComponent = {id: 'plan', component: 'Steps', data: [{title: 'Cache', node: 'Redis'}]};
    expect(notes([tiers('Redis'), plan])).toEqual([]);
    // ER tables and the actors of a sequence (by their own id) declare nodes too
    const er: WireComponent = {id: 'er', component: 'ERDiagram', data: [{name: 'orders', columns: ['id']}]};
    const seq: WireComponent = {id: 's', component: 'SequenceDiagram', data: {steps: [['U', 'G', 'hi']]}};
    expect(notes([er, seq, tiers('orders', 'U')])).toEqual([]);
    expect(notes([flow, tiers('A')])).toEqual(["Layers#tiers: node 'A' links to nothing on this view"]);
  });

  it('judges only what the call defines or writes, against everything on the view', () => {
    const bound: WireComponent = {id: 'tiers', component: 'Layers', data: {'@path': '/tiers'}};
    const data = {tiers: [{name: 'Data', items: [{label: 'x', node: 'PGG'}]}]};
    expect(linkNotes([flow, bound], data, new Set(['arch']), new Set())).toEqual([]);
    expect(linkNotes([flow, bound], data, new Set(), new Set(['tiers']))).toEqual(["Layers#tiers: node 'PGG' links to nothing on this view (nearest: PG)"]);
    // a part defined by an earlier call still declares what it declares
    expect(linkNotes([flow, tiers('PG')], {}, new Set(['tiers']), new Set())).toEqual([]);
  });

  it('says nothing beside a Graph drawn from a source; an inline Graph declares its nodes', () => {
    const source: WireComponent = {id: 'g', component: 'Graph', data: {'@path': '/ds/deps_modules'}};
    expect(notes([source, tiers('anything')])).toEqual([]);
    const inline: WireComponent = {id: 'g', component: 'Graph', data: {nodes: [{id: 'api', label: 'API'}, {id: 'auth'}], edges: []}};
    expect(notes([inline, tiers('api', 'auth')])).toEqual([]);
    expect(notes([inline, tiers('API')])).toEqual(["Layers#tiers: node 'API' links to nothing on this view (the label of node 'api')"]);
  });

  it('takes a DataTable none of whose node values resolves for a node column of its own', () => {
    const k8s: WireComponent = {id: 'pods', component: 'DataTable', data: [{pod: 'web-1', node: 'ip-10-0-1-5'}, {pod: 'web-2', node: 'ip-10-0-1-6'}]};
    expect(notes([flow, k8s])).toEqual([]);
    const mixed: WireComponent = {id: 'choices', component: 'DataTable', data: [{choice: 'System of record', node: 'PG'}, {choice: 'Cache', node: 'Redis'}]};
    expect(notes([flow, mixed])).toEqual(["DataTable#choices: node 'Redis' links to nothing on this view"]);
  });

  it('names at most three ids a line, then how many more', () => {
    expect(notes([flow, tiers('PG', 'zz1', 'zz2', 'zz3', 'zz4', 'zz5')])).toEqual(["Layers#tiers: nodes 'zz1', 'zz2', 'zz3', and 2 more link to nothing on this view"]);
  });
});

describe('expandMessages: what is certain to draw wrong', () => {
  // Finding V009: the warning names the component that draws the kind the source returns.
  it('warns when a source returns a kind of data the component cannot draw, and says what draws it', () => {
    const out = expand(`root=Page('x',[DataTable('diff.impact',id='impact'),Treemap('files.list'),Graph('files.tree'),DataTable('fake.rows'),Treemap(),JsonView('deps.modules')])`);
    expect(out.problems).toEqual([]);
    expect(out.warnings).toEqual([
      "Treemap#root_children_1: files.list returns rows, which Treemap cannot draw: use DataTable('files.list'). The plate will show an error.",
      "Graph#root_children_2: files.tree returns a tree, which Graph cannot draw: use FileTree('files.tree') or Treemap('files.tree'). The plate will show an error.",
    ]);
  });

  // Finding V006: the path deps.files needs was given as focus=, and the first try was E_ARGS.
  it('a source that needs a path and has none takes the Graph focus as its target', () => {
    const out = expand(`root=Page('x',[Graph('deps.files',focus='packages/server/src/spec',depth=2),Graph('deps.files src/a.ts',focus='src/b.ts'),Graph('deps.modules',focus='src')])`);
    expect(out.problems).toEqual([]);
    expect(out.fixes).toEqual(["Graph 'deps.files' -> 'deps.files packages/server/src/spec' (focus= names its path)"]);
    const graphs = out.components.filter(comp => comp.component === 'Graph');
    expect(graphs[0]).toMatchObject({data: bind('deps.files packages/server/src/spec'), depth: 2});
    expect(graphs[0]!.focus).toBeUndefined();
    // a ref that has its path, or a source that needs none, keeps its focus
    expect(graphs[1]).toMatchObject({data: bind('deps.files src/a.ts'), focus: 'src/b.ts'});
    expect(graphs[2]).toMatchObject({data: bind('deps.modules'), focus: 'src'});
    // without a focus, the missing path is still the author's to give
    expect(expand(`root=Page('x',[Graph('deps.files')])`).codes).toEqual(['E_ARGS']);
  });

  // Finding V009: both cold writers put diff.impact in a DataTable and got a redline.
  it('a component that draws rows, bound to a graph source, draws its nodes as rows', () => {
    const out = expand(`root=Page('x',[DataTable('diff.impact',id='impact',sort='-importers'),BarChart('deps.modules src',y='fanIn')])`);
    expect(out.warnings).toEqual([]);
    expect(out.fixes).toEqual([
      "DataTable 'diff.impact' -> 'diff.impact as=rows' (its nodes as rows; Graph('diff.impact') draws the graph)",
      "DataTable.sort '-importers' -> '-fanIn'",
      "BarChart 'deps.modules src' -> 'deps.modules src as=rows' (its nodes as rows; Graph('deps.modules src') draws the graph)",
    ]);
    expect(out.byComponent('DataTable').data).toEqual(bind('diff.impact as=rows'));
    // written that way by the model, the ref is accepted as it is
    expect(checkRef('diff.impact as=rows', registry)).toMatchObject({ref: {source: 'diff.impact', args: {as: 'rows'}}});
    expect(checkRef('git.log as=rows', registry)).toMatchObject({problem: {code: 'E_ARGS'}});
  });

  it('collects the literal files and ranges for the session to check', () => {
    const out = expand(`root=Page('x',[CodeView('src/a.ts#L10-20'),CodeView(),CodeView($/ui/file),FileRef('src/b.ts'),SymbolOutline('src/c.ts'),DiffView('main..HEAD','gone.ts'),DiffView(),DiffView('wt'),CodeTour([{file:'src/d.ts#L1-9',note:'n'},{file:'src/e.ts',note:'m'}])])`);
    expect(out.files.map(entry => entry.file)).toEqual(['src/a.ts#L10-20', 'src/b.ts', 'src/c.ts', 'src/d.ts#L1-9', 'src/e.ts']);
    expect(out.files[0]!.where).toBe('CodeView#root_children_0');
    expect(out.ranges).toEqual([{where: 'DiffView#root_children_5', range: 'main..HEAD'}]);
  });

  // Finding V071: paths written in another case are recorded, and expanding with the names the session found shows,
  // binds and checks them under the inventory's spelling, each said once.
  it('records the paths it writes and uses the inventory names it is given for them', () => {
    const spec = `root=Page('x',[CodeView('readme.md#L1-5'),CommitList('git.log readme.md top=5'),DataTable('git.churn PACKAGES top=3'),FileRef('readme.md'),DiffView('wt','Gone.ts'),CodeTour([{file:'readme.md',note:'n'}]),DiffView('main..HEAD'),DataTable('fake.rows')])`;
    const first = expand(spec);
    expect(first.paths).toEqual(['readme.md#L1-5', 'readme.md', 'PACKAGES', 'Gone.ts']);
    expect(first.fixes).toEqual([]);

    const {messages} = compileSpec(tools, {surfaceId: 's', sources: [spec], surfaces: []});
    const names = new Map([['readme.md#L1-5', 'README.md#L1-5'], ['readme.md', 'README.md'], ['PACKAGES', 'packages'], ['Gone.ts', 'Gone.ts']]);
    const out = expandMessages(messages, registry, names);
    const components = 'createSurface' in messages[0]! ? messages[0].createSurface.components : [];
    const comp = (i: number) => components.find(c => c.id === `root_children_${i}`)!;
    expect(out.fixes).toEqual(["path 'readme.md#L1-5' -> 'README.md#L1-5'", "path 'readme.md' -> 'README.md'", "path 'PACKAGES' -> 'packages'"]);
    expect(comp(0).file).toBe('README.md#L1-5');
    expect(comp(1).data).toEqual(bind('git.log README.md top=5'));
    expect(comp(2).data).toEqual(bind('git.churn packages top=3'));
    expect(comp(3).file).toBe('README.md');
    expect(comp(4).file).toBe('Gone.ts');
    expect(comp(5).data).toEqual([{file: 'README.md', note: 'n'}]);
    expect([...out.refs.keys()]).toContain(key('git.log README.md top=5'));
    expect([...out.refs.keys()]).not.toContain(key('git.log readme.md top=5'));
    expect(out.files.map(entry => entry.file)).toEqual(['README.md#L1-5', 'README.md', 'README.md']);
  });

  it('collects the literal [[path]] refs of prose for the session to check, as the tab draws them', () => {
    const out = expand(`$/n='[[src/bound.ts]]'
root=Page('x',[a,b,c,d,e])
a=Text('See [[src/a.ts#L3]] and [[src/a.ts#L3]], not \`[[src/code.ts]]\`, and the dir [[src/auth/]].')
b=Markdown('**[[src/b.ts#L1-9]]**\\n\`\`\`\\n[[src/fenced.ts]]\\n\`\`\`\\n[[src/after.ts]]')
c=Callout('Race in [[src/c.ts]].',file='src/c2.ts')
d=Ask('Keep [[src/d.ts]]?',['yes','no'])
e=Markdown($/n)`);
    expect(out.files).toEqual([
      {where: 'Text#a', file: 'src/a.ts#L3'},
      {where: 'Markdown#b', file: 'src/b.ts#L1-9'},
      {where: 'Markdown#b', file: 'src/after.ts'},
      {where: 'Callout#c', file: 'src/c2.ts'},
      {where: 'Callout#c', file: 'src/c.ts'},
      {where: 'Ask#d', file: 'src/d.ts'},
    ]);
    expect(out.paths).toEqual(['src/a.ts#L3', 'src/b.ts#L1-9', 'src/after.ts', 'src/c2.ts', 'src/c.ts', 'src/d.ts']);
  });

  // Finding V071 for refs: a ref written in another case is drawn, and checked, under the inventory's name.
  it('writes a [[path]] ref the session found in another case under the inventory name, said once', () => {
    const spec = `root=Page('x',[Text('Read [[readme.md#L2]], then [[readme.md#L2]] and \`[[readme.md]]\`.'),Markdown('[[Docs/Guide.md]] and [[src/ok.ts]]')])`;
    const {messages} = compileSpec(tools, {surfaceId: 's', sources: [spec], surfaces: []});
    const out = expandMessages(messages, registry, new Map([['readme.md#L2', 'README.md#L2'], ['Docs/Guide.md', 'docs/guide.md']]));
    const components = 'createSurface' in messages[0]! ? messages[0].createSurface.components : [];
    expect(components.find(c => c.component === 'Text')!.text).toBe('Read [[README.md#L2]], then [[README.md#L2]] and `[[readme.md]]`.');
    expect(components.find(c => c.component === 'Markdown')!.text).toBe('[[docs/guide.md]] and [[src/ok.ts]]');
    expect(out.fixes).toEqual(["path 'readme.md#L2' -> 'README.md#L2'", "path 'Docs/Guide.md' -> 'docs/guide.md'"]);
    expect(out.files.map(entry => entry.file)).toEqual(['README.md#L2', 'docs/guide.md', 'src/ok.ts']);
  });

  it('checks at most MAX_CHECKS refs, however long the text', () => {
    const refs = Array.from({length: 100}, (_, i) => `[[src/f${i}.ts]]`).join(' ');
    const out = expand(`root=Page('x',[Text('${refs}')])`);
    expect(out.files).toHaveLength(64);
    expect(out.paths).toHaveLength(64);
  });

  it('collects the field names a component asks of its dataset, once they are names the source returns', () => {
    const out = expand(`root=Page('x',[ScatterPlot('fake.rows',x='churn',y='n'),DataTable('fake.rows src','path:path=File n:num',sort='-owner',group='lang'),LineChart('fake.rows',y='n owner'),BarChart($/inline,x='a'),Treemap(value='loc'),DataTable('fake.slow',sort='zzz')])`);
    expect(out.fields).toEqual([
      {where: 'ScatterPlot#root_children_0', key: key('fake.rows'), names: ['n']},
      {where: 'DataTable#root_children_1', key: key('fake.rows src'), names: ['path', 'n', 'owner']},
      {where: 'LineChart#root_children_2', key: key('fake.rows'), names: ['n', 'owner']},
      // no declared fields: checked against what the dataset returns once it has settled
      {where: 'DataTable#root_children_5', key: key('fake.slow'), names: ['zzz']},
    ]);
  });
});

// Decision D15 (finding V001): a guessed field name never produces an empty plate.
describe('expandMessages: field names', () => {
  const fixesOf = (spec: string) => expand(spec).fixes;
  const propsOf = (spec: string, name: string) => expand(spec).byComponent(name);

  it('keeps an exact name, and rewrites a case, a label, a synonym or a plural to the field meant', () => {
    expect(fixesOf(`root=Page('x',[ScatterPlot('git.hotspots',x='churn',y='Complexity',r='lines',label='file')])`)).toEqual([
      "ScatterPlot.x 'churn' -> 'commits'",
      "ScatterPlot.y 'Complexity' -> 'complexity'",
      "ScatterPlot.r 'lines' -> 'sloc'",
      "ScatterPlot.label 'file' -> 'path'",
    ]);
    expect(propsOf(`root=Page('x',[SegmentedBar('files.langs',label='language',value='lines')])`, 'SegmentedBar')).toMatchObject({label: 'lang', value: 'loc'});
    expect(propsOf(`root=Page('x',[LineChart('git.timeline src',x='date',y='commits',series='Main module')])`, 'LineChart')).toMatchObject({x: 'week', y: 'commits', series: 'module'});
    expect(propsOf(`root=Page('x',[BarChart('git.churn by=module',x='module',y='churn')])`, 'BarChart')).toMatchObject({x: 'module', y: 'commits'});
    expect(propsOf(`root=Page('x',[BarChart('git.authors',x='name',y='count')])`, 'BarChart')).toMatchObject({x: 'author', y: 'commits'});
    expect(fixesOf(`root=Page('x',[ScatterPlot('git.hotspots',x='commits',y='complexity')])`)).toEqual([]);
  });

  it('a field only a variant of the source returns selects that variant', () => {
    const out = expand(`root=Page('x',[BarChart('git.churn',x='module',y='churn')])`);
    expect(out.fixes).toEqual(["BarChart 'git.churn' -> 'git.churn by=module' (it has the field module)", "BarChart.y 'churn' -> 'commits'"]);
    expect(out.byComponent('BarChart')).toMatchObject({data: bind('git.churn by=module'), x: 'module', y: 'commits'});
    // a variant the ref already chose, or a field the plain rows have, changes nothing
    expect(expand(`root=Page('x',[BarChart('git.churn by=module',x='module')])`).fixes).toEqual([]);
    expect(expand(`root=Page('x',[BarChart('git.churn',x='path',y='commits')])`).fixes).toEqual([]);
  });

  it('a field the rows carry beyond the declared columns is a field like any other', () => {
    expect(fixesOf(`root=Page('x',[DataTable('git.hotspots',columns='path isTest:bool commits'),DataTable('diff.files wt',columns='path add del')])`)).toEqual([]);
  });

  it('drops what fits nothing, so the component draws its default encoding, and says which fields there are', () => {
    const out = expand(`root=Page('x',[ScatterPlot('git.hotspots',x='zzz',y='complexity'),LineChart('git.activity',x='day',y='commits yyy'),DataTable('git.log',columns='sha subject when zzz:num=Z',sort='date desc',group='team')])`);
    expect(out.fixes).toEqual([
      "ScatterPlot.x 'zzz' dropped (fields: path commits complexity sloc score owner isTest)",
      "LineChart.x 'day' -> 'date'",
      "LineChart.y 'yyy' dropped (fields: date commits)",
      "DataTable.columns 'when' -> 'date'",
      "DataTable.columns 'zzz' dropped (fields: sha subject author date files add del refs)",
      "DataTable.sort 'date desc' -> '-date'",
      "DataTable.group 'team' dropped (fields: sha subject author date files add del refs)",
    ]);
    const scatter = out.byComponent('ScatterPlot');
    expect(scatter.x).toBeUndefined();
    expect(scatter.y).toBe('complexity');
    expect(out.byComponent('LineChart')).toMatchObject({x: 'date', y: 'commits'});
    expect(out.byComponent('DataTable')).toMatchObject({columns: 'sha subject date', sort: '-date'});
    expect(out.byComponent('DataTable').group).toBeUndefined();
  });

  it('repairs the field names of the list form in place, keeping each entry as written', () => {
    const out = expand(`root=Page('x',[DataTable('git.log',['sha',{key:'when',kind:'date',label:'When'},{field:'zzz'},'subject'])])`);
    expect(out.fixes).toEqual([
      "DataTable.columns 'when' -> 'date'",
      "DataTable.columns 'zzz' dropped (fields: sha subject author date files add del refs)",
    ]);
    expect(out.byComponent('DataTable').columns).toEqual(['sha', {key: 'date', kind: 'date', label: 'When'}, 'subject']);
  });

  it.each([...VIEWS.map(view => [view.name, view.build(view.targetRequired ? (view.target === 'symbol' ? 'Session' : 'src/a.ts') : undefined, {})] as const), ['gallery', GALLERY_SPEC] as const])('the %s preset names only fields its sources return', (_, source) => {
    expect(expand(source).fixes).toEqual([]);
  });

  it('inline data and sources without declared fields are left to the tab and the settle-time check', () => {
    expect(fixesOf(`$/rows=[{a:1}]\nroot=Page('x',[BarChart($/rows,x='churn'),DataTable('fake.slow',sort='zzz'),Treemap(value='lines')])`)).toEqual([]);
  });

  it('writes a Split ratio given as a share the way Split reads it (finding F037)', () => {
    expect(splitRatio('0.3')).toBe('3:7');
    expect(splitRatio('.25')).toBe('1:3');
    expect(splitRatio('30%')).toBe('3:7');
    expect(splitRatio('2/1')).toBe('2:1');
    expect(splitRatio('1:2')).toBe('1:2');
    expect(splitRatio('wide')).toBe('wide');
    const out = expand(`root=Page('x',[Split(Text('a'),Text('b'),0.3)])`);
    expect(out.byComponent('Split').ratio).toBe('3:7');
  });

  it("says what it did to Split's ratio: a share rewritten is fixed, a value Split cannot read is warn (D22)", () => {
    const out = expand(`root=Page('x',[Split(Text('a'),Text('b'),'0.3'),Split(Text('c'),Text('d'),'1:2'),Split(Text('e'),Text('f'),'wide')])`);
    expect(out.problems).toEqual([]);
    expect(out.fixes).toEqual(["Split.ratio '0.3' -> '3:7'"]);
    expect(out.warnings).toEqual(["Split#root_children_2: ratio 'wide' is not a ratio: opened half and half. Write '1:2'."]);
  });

  it('writes a Grid cols guess the way Grid reads it, with a fixed line, and warns about one it cannot read', () => {
    const out = expand(`root=Page('x',[Grid([Text('a'),Text('b')],'2fr 1fr'),Grid([Text('c'),Text('d')],'50% 50%'),Grid([Text('e')],'two'),Grid([Text('f')],'1/2',id='g'),Grid([Text('h')],'2fr 1fr')])`);
    expect(out.problems).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect(out.fixes).toEqual(["Grid.cols '2fr 1fr' -> '2:1'", "Grid.cols '50% 50%' -> '1:1'", "Grid.cols 'two' -> '2'", "Grid.cols '1/2' -> '1:2'"]);
    expect(out.components.filter(comp => comp.component === 'Grid').map(comp => comp.cols)).toEqual(['2:1', '1:1', '2', '1:2', '2:1']);
    // what Grid reads as written says nothing, whitespace included
    const plain = expand(`root=Page('x',[Grid([Text('a')],'3'),Grid([Text('b')],' 1 : 2 '),Grid([Text('c')])])`);
    expect([plain.fixes, plain.warnings]).toEqual([[], []]);
    expect(plain.components.filter(comp => comp.component === 'Grid').map(comp => comp.cols)).toEqual(['3', '1:2', undefined]);
    // a number is quoted by the repair first, then read
    expect(expand(`root=Page('x',[Grid([Text('a')],40)])`).fixes).toContain("Grid.cols '40' -> '12'");
  });

  it('warns about a Grid cols it cannot read and leaves it as written', () => {
    const out = expand(`root=Page('x',[Grid([Text('a'),Text('b')],'wide',id='g'),Grid([Text('c')],'200px 1fr',id='h')])`);
    expect(out.problems).toEqual([]);
    expect(out.fixes).toEqual([]);
    expect(out.warnings).toEqual([
      "Grid#g: cols 'wide' is not a count or a ratio: drawn as equal columns. Write '3' or '2:1'.",
      "Grid#h: cols '200px 1fr' is not a count or a ratio: drawn as equal columns. Write '3' or '2:1'.",
    ]);
    expect(out.byComponent('Grid').cols).toBe('wide');
  });
});

// Decision D22: a mark that reads as a guess is rewritten and said; a part that names no line is a warn line.
describe('expandMessages: mark', () => {
  it('rewrites a guessed mark and says it as a fix', () => {
    const out = expand(`root=Page('x',[a,b,c,d,e,f])\na=CodeView('src/a.ts',mark='lines 10-20')\nb=CodeView('src/a.ts',mark='L10:L20')\nc=CodeView('src/a.ts',mark='#L10-L20')\nd=CodeBlock('x','ts',mark='10..20')\ne=CodeView('src/a.ts',mark='10\u201320')\nf=CodeView('src/a.ts',mark='20-10')`);
    expect(out.problems).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect(out.fixes).toEqual([
      "CodeView#a: mark 'lines 10-20' -> '10-20'",
      "CodeView#b: mark 'L10:L20' -> '10-20'",
      "CodeView#c: mark '#L10-L20' -> '10-20'",
      "CodeBlock#d: mark '10..20' -> '10-20'",
      "CodeView#e: mark '10\u201320' -> '10-20'",
      "CodeView#f: mark '20-10' -> '10-20'",
    ]);
    expect(out.components.filter(comp => 'mark' in comp).map(comp => comp.mark)).toEqual(Array(6).fill('10-20'));
  });

  it('leaves a mark written the documented way alone', () => {
    const out = expand(`root=Page('x',[CodeView('src/a.ts',mark='L3,L7-9'),CodeBlock('x','ts',mark='3, 7-9'),CodeView('src/a.ts')])`);
    expect(out.fixes).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect(out.byComponent('CodeView').mark).toBe('L3,L7-9');
  });

  it('warns about the parts that name no line and keeps the rest', () => {
    const out = expand(`root=Page('x',[a,b])\na=CodeView('src/a.ts',mark='foo')\nb=CodeBlock('x','ts',mark='the loop; 10..12, 0')`);
    expect(out.problems).toEqual([]);
    expect(out.warnings).toEqual([
      "CodeView#a: mark 'foo' ignored: write 'L10-20' or '3,7-9'",
      "CodeBlock#b: mark 'the loop', '0' ignored: write 'L10-20' or '3,7-9'",
    ]);
    expect(out.fixes).toEqual(["CodeBlock#b: mark 'the loop; 10..12, 0' -> 'the loop,10-12,0'"]);
    // a number is a line (the compiler writes it as text); 0 is not one
    expect(expand(`root=Page('x',[CodeView('src/a.ts',mark=12)])`).warnings).toEqual([]);
    expect(expand(`root=Page('x',[CodeView('src/a.ts',mark=0,id='z')])`).warnings).toEqual(["CodeView#z: mark '0' ignored: write 'L10-20' or '3,7-9'"]);
  });
});

describe('checkRef and helpers', () => {
  it('checkRef returns the parsed ref and the meta, also for a fake source', () => {
    expect(checkRef('fake.rows src top=3', registry)).toEqual({ref: {source: 'fake.rows', target: 'src', args: {top: '3'}}, meta: fakes.rows.meta});
    expect(checkRef('git.log main..HEAD', registry)).toMatchObject({meta: SOURCE_BY_NAME.get('git.log')});
    expect(checkRef('nope', registry)).toMatchObject({problem: {code: 'E_SOURCE'}});
  });

  it('refSignature shows target and arguments', () => {
    expect(refSignature(SOURCE_BY_NAME.get('git.hotspots')!)).toBe(`'git.hotspots [path] [top=] [since=]'`);
    expect(refSignature(SOURCE_BY_NAME.get('files.tree')!)).toBe(`'files.tree [path]'`);
    expect(refSignature(SOURCE_BY_NAME.get('code.refs')!)).toBe(`'code.refs <symbol> [top=]'`);
  });

  it('unboundPaths reports absolute bindings with no value, never /ds, /meta or /ui', () => {
    const out = expand(`$/notes=''\n$/plan=[{title:'A'}]\nroot=Page($/meta/repo/name,[Markdown($/notes),Markdown($/missing),Steps($/plan),Text($/plan/0/title),Text($/plan/3/title),CodeView($/ui/file),Stats()])`);
    expect(unboundPaths(out.components, {notes: '', plan: [{title: 'A'}]})).toEqual(['$/missing', '$/plan/3/title']);
  });

  it('boundKeys lists the datasets the components bind', () => {
    const out = expand(`root=Page('x',[Stats(),DataTable('fake.rows src'),DataTable($/rows)])`);
    expect([...boundKeys(out.components)]).toEqual(['repo_kpis', key('fake.rows src')]);
  });
});
