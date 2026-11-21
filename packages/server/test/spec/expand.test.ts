// Expansion: source refs and default sources become /ds bindings; refs, notation, columns and reserved paths are
// judged here. Runs on a registry of fakes plus the catalog's own source names.
import {COMPONENT_BY_NAME, datasetKey, GALLERY_SPEC, parseRef, signatureOf, SOURCE_BY_NAME, VIEWS, type A2uiMessage, type WireComponent} from '@glimpse/catalog';
import {beforeAll, describe, expect, it} from 'vitest';
import {createRegistry} from '../../src/sources/registry.ts';
import {compileSpec, loadToolchain, type Seed, type Toolchain} from '../../src/spec/compile.ts';
import {formatProblems, NOTHING_RENDERED} from '../../src/spec/errors.ts';
import {boundKeys, checkRef, componentsOf, expandMessages, refSignature, splitRatio, unboundPaths} from '../../src/spec/expand.ts';
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

  it('...and is an error where it does not, naming the notation the prop also takes', () => {
    const out = expand(`root=Page('x',[DataTable('hello world'),Steps('todo'),CommitList('hello')])`);
    expect(out.lines).toEqual([
      `E_SOURCE DataTable#root_children_0.data: "hello world" is not a source ref or a Markdown table. Write a ref ('files.list src top=20'), a $/path, inline Rows or a Markdown table: '| a | b |\\n|---|---|\\n| x | 1 |'`,
      `E_SOURCE Steps#root_children_1.data: "todo" is not a source ref or a task list. Write a ref ('files.list src top=20'), a $/path, inline StepItem[] or a task list: '- [x] done\\n- [ ] todo'`,
      `E_SOURCE CommitList#root_children_2.data: "hello" is not a source ref. Write a ref ('files.list src top=20'), a $/path or inline CommitRow[].`,
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

describe('expandMessages: notation, columns, paths', () => {
  it('a literal Flowchart or SequenceDiagram source is parsed; errors name the statement', () => {
    const good = expand(`root=Page('x',[Flowchart('A[Start] --> B{ok?}; B -->|yes| C([Done])'),SequenceDiagram('A->>B: hi; B-->>A: yo')])`);
    expect(good.problems).toEqual([]);
    const bad = expand(`root=Page('x',[Flowchart('A --> B; B -> C'),SequenceDiagram('A->>B: hi; nonsense here')])`);
    expect(bad.codes).toEqual(['E_NOTATION', 'E_NOTATION']);
    expect(bad.lines[0]).toMatch(/^E_NOTATION Flowchart#root_children_0\.src statement 2: /);
    expect(bad.lines[1]).toMatch(/^E_NOTATION SequenceDiagram#root_children_1\.src statement 2: /);
  });

  it('a src bound to a path this call writes is parsed like a literal one', () => {
    expect(expand(`$/flow='A --> B'\nroot=Page('x',[Flowchart($/flow)])`).problems).toEqual([]);
    const bad = expand(`$/seq='A->>B: hi\\nnonsense here'\nroot=Page('x',[seq])\nseq=SequenceDiagram($/seq)`);
    expect(bad.lines).toEqual([expect.stringMatching(/^E_NOTATION \$\/seq \(SequenceDiagram#seq\.src\) statement 2: expected "A->>B: text"/)]);
  });

  // Measurement: a writer's 'alt … else … end' gave no signal at all. Blocks are frames now; a block left open, or an
  // `end` that closes nothing, is said the way the data notations say a repair.
  it('a sequence block left open or an end too many is a fixed line', () => {
    const open = expand(`$/seq='sequenceDiagram\\nA->>S: get\\nalt hit\\nS-->>A: rows\\nelse miss\\nS->>D: compute'\nroot=Page('x',[seq])\nseq=SequenceDiagram($/seq)`);
    expect(open.problems).toEqual([]);
    expect(open.fixes).toEqual([`$/seq (SequenceDiagram#seq.src) line 3: alt closed at the end (no 'end')`]);
    const inline = expand(`root=Page('x',[seq])\nseq=SequenceDiagram('A->>B: x; end')`);
    expect(inline.fixes).toEqual([`SequenceDiagram#seq.src line 1: 'end' closes no block: skipped`]);
    expect(expand(`root=Page('x',[seq])\nseq=SequenceDiagram('A->>B: x\\nalt ok\\nB-->>A: y\\nend')`).fixes).toEqual([]);
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
    const out = expand(`root=Page('x',[DataTable('nope.nope'),Flowchart('???'),DataTable('fake.rows','a:zzz'),DataTable('code.refs'),Steps('- [x] a\\nnope')])`);
    expect(out.codes).toEqual(['E_SOURCE', 'E_NOTATION', 'E_ENUM', 'E_ARGS', 'E_NOTATION']);
  });

  it('a reserved path segment in a compiled message is E_PATH (decision D10)', () => {
    const out = expandMessages([{version: '1.0', updateDataModel: {surfaceId: 's', path: '/a/__proto__/b', value: 1}}], registry);
    expect(out.problems.map(p => `${p.code} ${p.message}`)).toEqual(['E_PATH "__proto__" cannot be used as a data path segment: __proto__, constructor and prototype are reserved. Rename it.']);
  });
});

// Data as text: a string in the notation a data prop takes is parsed by the server into the data shape the component
// already draws, inline or through the data model. The tab never receives a notation string.
describe('expandMessages: data as text', () => {
  const messagesOf = (spec: string, seed?: Seed) =>
    compileSpec(tools, {surfaceId: 's', sources: [spec], surfaces: seed ? ['s'] : [], ...(seed ? {seed} : {})}).messages;
  /** A stored view as the session keeps it: the compiled, expanded first call. */
  function stored(spec: string): Seed {
    const messages = messagesOf(spec);
    expect(expandMessages(messages, registry).problems).toEqual([]);
    const first = messages[0]!;
    if (!('createSurface' in first)) throw new Error('not a new view');
    return {components: first.createSurface.components, data: first.createSurface.dataModel ?? {}};
  }
  const dataModel = (messages: A2uiMessage[]) => ('createSurface' in messages[0]! ? messages[0].createSurface.dataModel ?? {} : {});
  const updates = (messages: A2uiMessage[]) => messages.flatMap(message => ('updateDataModel' in message ? [message.updateDataModel] : []));

  const CASES: ReadonlyArray<readonly [string, string, unknown]> = [
    ['Graph', 'graph LR\\na[API] --> b[DB]', {nodes: [{id: 'a', label: 'API'}, {id: 'b', label: 'DB'}], edges: [{from: 'a', to: 'b'}], dir: 'LR'}],
    ['ERDiagram', 'erDiagram\\nusers ||--o{ orders : places', {tables: [{name: 'users', columns: []}, {name: 'orders', columns: []}], relations: [{from: 'users', to: 'orders', card: '1-n', label: 'places'}]}],
    ['DataTable', '| path | loc |\\n|---|---|\\n| src/a.ts | 120 |\\n| src/b.ts | 80 |', [{path: 'src/a.ts', loc: 120}, {path: 'src/b.ts', loc: 80}]],
    ['BarChart', '| lang | files |\\n|---|---|\\n| ts | 12 |', [{lang: 'ts', files: 12}]],
    ['Histogram', '| loc |\\n|---|\\n| 3 |\\n| 9 |', [{loc: 3}, {loc: 9}]],
    ['List', '| Title | value |\\n|---|---|\\n| redis | 14 |', [{title: 'redis', value: 14}]],
    ['Steps', '- [x] Add the middleware\\n- [~] Wire the router — behind a flag\\n- [ ] Tests', [{title: 'Add the middleware', status: 'done'}, {title: 'Wire the router', note: 'behind a flag', status: 'doing'}, {title: 'Tests', status: 'todo'}]],
    ['KeyValue', 'Language: TypeScript\\nTests: true\\nFiles: 412', [{label: 'Language', value: 'TypeScript'}, {label: 'Tests', value: true}, {label: 'Files', value: 412}]],
    ['Stats', 'Files: 412\\nCoverage: 87% (+2)', [{label: 'Files', value: 412}, {label: 'Coverage', value: 87, unit: '%', delta: 2}]],
    ['Layers', 'API: routes, middleware\\nDomain: ledger — no I/O', [{name: 'API', items: ['routes', 'middleware']}, {name: 'Domain', items: ['ledger'], note: 'no I/O'}]],
  ];

  it.each(CASES)('%s takes its data written inline as text', (name, text, data) => {
    const out = expand(`root=Page('x',[${name}('${text}')])`);
    expect(out.problems).toEqual([]);
    expect(out.fixes).toEqual([]);
    expect(out.refs.size).toBe(0);
    expect(out.byComponent(name).data).toEqual(data);
  });

  it.each(CASES)('%s takes its data as text through the data model, in one call', (name, text, data) => {
    const out = expand(`$/x='${text}'\nroot=Page('x',[${name}($/x)])`);
    expect(out.problems).toEqual([]);
    expect(out.byComponent(name).data).toEqual({'@path': '/x'});
    expect(dataModel(out.messages).x).toEqual(data);
  });

  it('a patch that sets data a stored part binds is read in that part\'s notation; a write below it is left alone', () => {
    const seed = stored(`$/plan=[]\nroot=Page('x',[plan])\nplan=Steps($/plan,title='Plan')`);
    const patch = messagesOf(`$/plan='- [x] A\\n- [~] B'`, seed);
    const out = expandMessages(patch, registry, undefined, seed);
    expect(out.problems).toEqual([]);
    expect(updates(patch)).toEqual([{surfaceId: 's', path: '/plan', value: [{title: 'A', status: 'done'}, {title: 'B', status: 'doing'}]}]);
    // the stored part is not changed, and nothing else is sent
    expect(seed.components.find(comp => comp.id === 'plan')!.data).toEqual({'@path': '/plan'});
    expect(patch.flatMap(componentsOf)).toEqual([]);

    const status = messagesOf(`$/plan/1/status='done'`, {...seed, data: {plan: [{title: 'A', status: 'done'}, {title: 'B', status: 'doing'}]}});
    const before = structuredClone(status);
    expect(expandMessages(status, registry, undefined, seed).problems).toEqual([]);
    expect(status).toEqual(before);
  });

  it('text stored by an earlier call and bound only now is parsed and sent as one more data write', () => {
    const seed = stored(`$/later='- [x] A\\n- [ ] B'\nroot=Page('x',[Text('t')])`);
    expect(seed.data.later).toBe('- [x] A\n- [ ] B');
    const patch = messagesOf(`n=Steps($/later)`, seed);
    const out = expandMessages(patch, registry, undefined, seed);
    expect(out.problems).toEqual([]);
    expect(updates(patch)).toEqual([{surfaceId: 's', path: '/later', value: [{title: 'A', status: 'done'}, {title: 'B', status: 'todo'}]}]);
    // a stored value that is already data, or a call without a stored view, adds nothing
    const data = stored(`$/later=[{title:'A'}]\nroot=Page('x',[Text('t')])`);
    const again = messagesOf(`n=Steps($/later)`, data);
    expandMessages(again, registry, undefined, data);
    expect(updates(again)).toEqual([]);
  });

  it('a preset call whose patch sets a slot as text gets the parsed data; the preset\'s own empty slot is left as it is', () => {
    const feature = VIEWS.find(view => view.name === 'feature')!;
    const {messages} = compileSpec(tools, {surfaceId: 'feature', sources: [feature.build(undefined, {}), `$/plan='- [x] Spec\\n- [~] Code'`], surfaces: []});
    const out = expandMessages(messages, registry);
    expect(out.problems).toEqual([]);
    const plan = [{title: 'Spec', status: 'done'}, {title: 'Code', status: 'doing'}];
    const written = [...updates(messages).filter(update => update.path === '/plan').map(update => update.value), dataModel(messages).plan];
    expect(written).toContainEqual(plan);
    expect(written.every(value => Array.isArray(value))).toBe(true);
  });

  it('a bound string in no notation, and a bound Flowchart src, stay strings', () => {
    const out = expand(`$/x='hello'\n$/flow='A --> B'\nroot=Page('x',[Steps($/x),Flowchart($/flow)])`);
    expect(out.problems).toEqual([]);
    expect(dataModel(out.messages)).toMatchObject({x: 'hello', flow: 'A --> B'});
  });

  it('a source ref, an unknown source and a string-valued shape keep their meaning', () => {
    expect(expand(`root=Page('x',[Graph('deps.modules src/auth')])`).byComponent('Graph').data).toEqual(bind('deps.modules src/auth'));
    expect(expand(`root=Page('x',[DataTable('git.chrun src')])`).lines[0]).toMatch(/^E_SOURCE DataTable#root_children_0\.data: unknown source "git\.chrun"/);
    const out = expand(`root=Page('x',[Stat('node.js','runtime'),JsonView('a: b')])`);
    expect(out.problems).toEqual([]);
    expect(out.byComponent('JsonView').data).toBe('a: b');
  });

  it('a notation error is E_NOTATION with line, column and a corrected example, then the signature and the notation', () => {
    const inline = expand(`root=Page('x',[plan])\nplan=Steps('- [x] Ship\\n- [~] Docs\\nTests later')`);
    expect(inline.lines).toEqual(['E_NOTATION Steps#plan.data line 3 col 1: expected a step "- [ ] title", found "Tests later". Example: - [ ] Tests later']);
    expect(inline.problems[0]).toMatchObject({component: 'Steps', notation: 'tasks'});
    expect(formatProblems(inline.problems).split('\n')).toEqual([
      'E_NOTATION Steps#plan.data line 3 col 1: expected a step "- [ ] title", found "Tests later". Example: - [ ] Tests later',
      'sig Steps(data, current?)',
      'notation a step per line: - [x] done, - [~] doing, - [ ] todo, - [!] blocked, - [-] skipped; then — note; [[path#L10]] links a file',
      NOTHING_RENDERED,
    ]);

    const bound = expand(`$/arch='graph LR\\nstream => lazy'\nroot=Page('x',[arch])\narch=Graph($/arch)`);
    expect(bound.lines).toEqual(['E_NOTATION $/arch (Graph#arch.data) line 2 col 8: expected an arrow (-->, -->|label|, -- label -->, -.->), found "=> lazy". Example: stream --> lazy']);
    expect(bound.problems[0]).toMatchObject({component: 'Graph', notation: 'graph'});
    expect(formatProblems(bound.problems).split('\n').slice(1, 3)).toEqual([
      `sig ${signatureOf(COMPONENT_BY_NAME.get('Graph')!)}`,
      'notation Mermaid graph: a[Label<br>sub] -->|label| b, -.-> dashed, subgraph g[Title] … end, :::new|changed|gone, click a "path#L10"',
    ]);

    // every error of a string is reported
    const several = expand(`root=Page('x',[Steps('- [x] a\\nfoo\\n- [ ] b\\nbar')])`);
    expect(several.lines.map(line => /line \d+ col \d+/.exec(line)?.[0])).toEqual(['line 2 col 1', 'line 4 col 1']);
  });

  it('a slip the parser repaired is a fixed line naming where it was', () => {
    const graph = expand(`root=Page('x',[g])\ng=Graph('graph LR\\na:::hot --> b')`);
    expect(graph.problems).toEqual([]);
    expect(graph.fixes).toEqual(["Graph#g.data line 2: ':::hot' dropped (status: new changed gone affected)"]);
    expect((graph.byComponent('Graph').data as {nodes: unknown[]}).nodes).toEqual([{id: 'a', label: 'a'}, {id: 'b', label: 'b'}]);

    const table = expand(`$/kinds='| kind | n |\\n| x | 1 |'\nroot=Page('x',[kinds])\nkinds=DataTable($/kinds)`);
    expect(table.problems).toEqual([]);
    expect(table.fixes).toEqual(['$/kinds (DataTable#kinds.data) line 1: no |---| row under the header: line 1 read as the header']);
    expect(dataModel(table.messages).kinds).toEqual([{kind: 'x', n: 1}]);
  });

  it('files the data names are checked like CodeTour stops, under the inventory\'s names', () => {
    const spec = `$/plan='- [x] Limit [[src/api/limiter.ts#L3]]\\n- [ ] Docs [[readme.md]]'
root=Page('x',[g,plan,layers,er])
g=Graph('graph LR\\na[API] --> b[limiter]\\nclick b "src/api/limiter.ts#L1-10"')
plan=Steps($/plan)
layers=Layers('Domain: ledger [[src/ledger.ts]], payouts')
er=ERDiagram('erDiagram\\nusers {\\nuuid id PK\\n}\\nclick users "db/schema.sql"')`;
    const out = expand(spec);
    expect(out.problems).toEqual([]);
    expect(out.files).toEqual([
      {where: 'Graph#g.data node b', file: 'src/api/limiter.ts#L1-10'},
      {where: 'Layers#layers.data layer Domain item ledger', file: 'src/ledger.ts'},
      {where: 'ERDiagram#er.data table users', file: 'db/schema.sql'},
      {where: 'Steps#plan.data step 1', file: 'src/api/limiter.ts#L3'},
      {where: 'Steps#plan.data step 2', file: 'readme.md'},
    ]);
    expect(out.paths).toContain('readme.md');

    const messages = messagesOf(spec);
    const named = expandMessages(messages, registry, new Map([['readme.md', 'README.md']]));
    expect(named.fixes).toEqual(["path 'readme.md' -> 'README.md'"]);
    expect((dataModel(messages).plan as Array<{file?: string}>)[1]!.file).toBe('README.md');
  });

  // Measurement (notations round): `graph LR` made an eleven-node chain LR by rule, and it opened at 46% in its plate.
  // The header's direction is the writer's preference: it goes with the data; Graph's own dir stays a rule.
  it('a graph header direction goes with the data, never into Graph.dir; an erDiagram one fills an unset dir', () => {
    const inline = expand(`root=Page('x',[Graph('graph TB\\na --> b')])`).byComponent('Graph');
    expect(inline.dir).toBeUndefined();
    expect(inline.data).toMatchObject({dir: 'TB'});
    const explicit = expand(`root=Page('x',[Graph('graph TB\\na --> b','LR')])`).byComponent('Graph');
    expect([explicit.dir, (explicit.data as {dir?: string}).dir]).toEqual(['LR', 'TB']);
    const bound = expand(`$/g='graph TB\\na --> b'\nroot=Page('x',[Graph($/g)])`);
    expect(bound.byComponent('Graph').dir).toBeUndefined();
    expect(dataModel(bound.messages).g).toMatchObject({dir: 'TB'});
    expect(expand(`root=Page('x',[ERDiagram('erDiagram\\ndirection LR\\na ||--o{ b : has')])`).byComponent('ERDiagram').dir).toBe('LR');
    expect(expand(`root=Page('x',[ERDiagram('erDiagram\\ndirection LR\\na ||--o{ b : has',dir='TB')])`).byComponent('ERDiagram').dir).toBe('TB');
    const seed = stored(`$/g=null\nroot=Page('x',[g])\ng=Graph($/g)`);
    const patch = messagesOf(`$/g='graph TB\\na --> b'`, seed);
    expect(expandMessages(patch, registry, undefined, seed).problems).toEqual([]);
    expect(seed.components.find(comp => comp.id === 'g')!.dir).toBeUndefined();
    expect(patch.flatMap(componentsOf)).toEqual([]);
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
