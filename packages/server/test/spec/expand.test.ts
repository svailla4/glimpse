// Expansion: source refs and default sources become /ds bindings; refs, notation, columns and reserved paths are
// judged here. Runs on a registry of fakes plus the catalog's own source names.
import {datasetKey, parseRef, SOURCE_BY_NAME, type A2uiMessage, type WireComponent} from '@glimpse/catalog';
import {beforeAll, describe, expect, it} from 'vitest';
import {createRegistry} from '../../src/sources/registry.ts';
import {compileSpec, loadToolchain, type Toolchain} from '../../src/spec/compile.ts';
import {boundKeys, checkRef, expandMessages, refSignature, unboundPaths} from '../../src/spec/expand.ts';
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
      `E_ARGS DataTable#root_children_1.data: git.churn takes no argument "limit". Ref: 'git.churn [path] [top=] [since=]'`,
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

  it('a bound src is not parsed', () => {
    expect(expand(`$/flow='A --> B'\nroot=Page('x',[Flowchart($/flow)])`).problems).toEqual([]);
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
    expect(out.codes).toEqual(['E_SOURCE', 'E_NOTATION', 'E_ENUM', 'E_ARGS']);
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
