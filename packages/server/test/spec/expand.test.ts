// Expansion: source refs and default sources become /ds bindings; refs, notation, columns and reserved paths are
// judged here. Runs on a registry of fakes plus the catalog's own source names.
import {datasetKey, GALLERY_SPEC, parseRef, SOURCE_BY_NAME, VIEWS, type A2uiMessage, type WireComponent} from '@glimpse/catalog';
import {beforeAll, describe, expect, it} from 'vitest';
import {createRegistry} from '../../src/sources/registry.ts';
import {compileSpec, loadToolchain, type Toolchain} from '../../src/spec/compile.ts';
import {boundKeys, checkRef, diagramNotes, expandMessages, refSignature, splitRatio, unboundPaths} from '../../src/spec/expand.ts';
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
    });
    // a later patch writes $/flow/... and names no component: still checked
    expect(diagramNotes([flow], data, new Set(), new Set(['flow'])).warnings).toHaveLength(2);
    // neither defined nor written: said already, not again
    expect(diagramNotes([flow], data, new Set(), new Set(['other']))).toEqual({fixes: [], warnings: []});
    // not a diagram at all
    expect(diagramNotes([flow], {flow: 'A --> B'}, new Set([flow.id]), new Set()).warnings).toEqual([
      `Flowchart#${flow.id}: E_SHAPE $/flow: Flowchart takes data, not Mermaid text: {nodes, edges, groups?}, e.g. {nodes:{A:'Request',B:{label:'Over limit?',shape:'diamond'}},edges:[['A','B'],['B','C','no']]}`,
    ]);
  });

  it('an unknown column kind is E_ENUM listing the kinds', () => {
    const out = expand(`root=Page('x',[DataTable('fake.rows','path n:bars owner:author=Owned_by')])`);
    expect(out.codes).toEqual(['E_ENUM']);
    expect(out.lines[0]).toMatch(/^E_ENUM DataTable#root_children_0\.columns column 2: unknown kind "bars" for column "n"\. Kinds: text num /);
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

// Findings F032 and F090: an `ok` whose view shows a redline. What the spec alone gives away is said at once.
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
