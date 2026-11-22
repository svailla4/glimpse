// SurfaceStore: drafts are detached, commit modes follow design 2.2 step 5, and at most twelve surfaces are kept.
import {VIEW_BY_NAME, type A2uiMessage, type SourceRef, type SurfaceMeta} from '@glimpse/catalog';
import {beforeAll, describe, expect, it} from 'vitest';
import {dataModelOf, inPlaceMessages, MAX_SURFACES, setPath, snapshotOf, SurfaceStore, titleOf} from '../../src/session/surfaces.ts';
import {createRegistry} from '../../src/sources/registry.ts';
import {compileSpec, loadToolchain, type Toolchain} from '../../src/spec/compile.ts';
import {expandMessages} from '../../src/spec/expand.ts';
import {fakeSources} from './fakes.ts';

let tools: Toolchain;
beforeAll(async () => {
  tools = await loadToolchain();
});
const fakes = fakeSources();
const registry = createRegistry([fakes.rows, fakes.slow]);
const META: SurfaceMeta = {repo: {name: 'demo', root: '/repo', dirty: false}, rev: 1, slots: {lang: {}, module: {}, author: {}}, generatedAt: '2026-11-20T00:00:00Z'};

/** Compiles and expands a spec against the store, as the session does, and returns the draft. */
function draft(store: SurfaceStore, id: string, source: string | string[], options: {fresh?: boolean; now?: number; parts?: string[]} = {}) {
  const current = options.fresh ? undefined : store.get(id);
  const compiled = compileSpec(tools, {
    surfaceId: id,
    ...(current ? {seed: {components: [...current.components.values()], data: current.data}} : {}),
    sources: Array.isArray(source) ? source : [source],
    surfaces: store.ids(),
  });
  const expansion = expandMessages(compiled.messages, registry);
  expect(expansion.problems).toEqual([]);
  return store.draft(id, compiled.messages, {fresh: options.fresh ?? false, refs: expansion.refs, parts: options.parts ?? [], now: options.now ?? 1000});
}
/** Commits a draft and gives its new datasets a pending envelope, as the session does. */
const apply = (store: SurfaceStore, id: string, source: string | string[], options: Parameters<typeof draft>[3] = {}) => {
  const d = draft(store, id, source, options);
  store.commit(d);
  for (const key of d.newKeys) d.record.ds[key] = {$ds: key, kind: 'rows', status: 'pending', source: key};
  return d;
};
/** A stable serialisation of everything the store holds. */
const dump = (store: SurfaceStore) => JSON.stringify(store.all().map(r => ({...r, components: [...r.components], bindings: [...r.bindings], drills: [...r.drills]})));

const BASE = `$/notes='hi'\nroot=Page('Demo',[notes,table,side])\nnotes=Text($/notes)\ntable=DataTable('fake.rows src',title='Rows')\nside=Column([Text('a'),Stats()])`;

describe('draft and commit', () => {
  it('create: a new id becomes a record with title, data, bindings and new dataset keys', () => {
    const store = new SurfaceStore();
    const d = draft(store, 'demo', BASE, {now: 42, parts: ['notes', 'table', 'side', 'ghost']});
    expect(d.mode).toBe('create');
    expect(d.delta).toEqual([]);
    expect(store.has('demo')).toBe(false);
    store.commit(d);
    const record = store.get('demo')!;
    expect(record.title).toBe('Demo');
    expect(record.data).toEqual({notes: 'hi'});
    expect([...record.components.keys()]).toEqual(['root', 'notes', 'table', 'side', 'side_children_0', 'side_children_1']);
    expect([...record.bindings.values()]).toEqual<SourceRef[]>([{source: 'fake.rows', target: 'src', args: {}}, {source: 'repo.kpis', args: {}}]);
    expect(d.newKeys).toEqual([...record.bindings.keys()]);
    expect(record.parts).toEqual(['notes', 'table', 'side']);
    expect(record.createdAt).toBe(42);
    expect(store.list()).toEqual([{id: 'demo', title: 'Demo', createdAt: 42, updatedAt: 42}]);
  });

  it('patch: data and component updates keep the mode, the delta is what is published', () => {
    const store = new SurfaceStore();
    apply(store, 'demo', BASE);
    const d = apply(store, 'demo', `$/notes='changed'\nnotes=Text($/notes)`, {now: 2000});
    expect(d.mode).toBe('patch');
    expect(d.delta.map(m => Object.keys(m).find(k => k !== 'version'))).toEqual(['updateComponents', 'updateDataModel']);
    expect(d.newKeys).toEqual([]);
    expect(store.get('demo')!.data.notes).toBe('changed');
    expect(store.get('demo')!.updatedAt).toBe(2000);
    expect(store.get('demo')!.createdAt).toBe(1000);
  });

  it('patch: a component that gains a prop or a new dataset is still a patch', () => {
    const store = new SurfaceStore();
    apply(store, 'demo', BASE);
    const d = apply(store, 'demo', `table=DataTable('fake.slow',sort='-n',title='Rows')`);
    expect(d.mode).toBe('patch');
    expect(d.newKeys).toEqual(['fake_slow']);
    expect([...store.get('demo')!.bindings.keys()]).toEqual(['fake_slow', 'repo_kpis']);
  });

  it('replace: a patched component that lost a prop it had', () => {
    const store = new SurfaceStore();
    apply(store, 'demo', BASE);
    const d = apply(store, 'demo', `table=DataTable('fake.rows src')`);
    expect(d.mode).toBe('replace');
    expect(d.delta).toEqual([]);
    expect('title' in store.get('demo')!.components.get('table')!).toBe(false);
  });

  it('replace: a component that changed type', () => {
    const store = new SurfaceStore();
    apply(store, 'demo', BASE);
    expect(apply(store, 'demo', `notes=Callout('now a callout')`).mode).toBe('replace');
  });

  it('replace: root redefined; unreachable components are pruned and the data is kept', () => {
    const store = new SurfaceStore();
    apply(store, 'demo', BASE, {parts: ['notes', 'table', 'side']});
    const d = apply(store, 'demo', `root=Page('Smaller',[notes])`);
    expect(d.mode).toBe('replace');
    const record = store.get('demo')!;
    expect([...record.components.keys()]).toEqual(['root', 'notes']);
    expect(record.title).toBe('Smaller');
    expect(record.data).toEqual({notes: 'hi'});
    expect(record.bindings.size).toBe(0);
    expect(record.ds).toEqual({});
    expect(record.parts).toEqual(['notes']);
  });

  it('replace: a patch that orphans children prunes them', () => {
    const store = new SurfaceStore();
    apply(store, 'demo', BASE);
    const d = apply(store, 'demo', `side=Column([Text('only')])`);
    expect(d.mode).toBe('replace');
    expect([...store.get('demo')!.components.keys()]).toEqual(['root', 'notes', 'table', 'side', 'side_children_0']);
    expect([...store.get('demo')!.bindings.values()].map(ref => ref.source)).toEqual(['fake.rows']);
  });

  it('replace: a preset call on an existing id starts from nothing', () => {
    const store = new SurfaceStore();
    apply(store, 'feature', `$/mine=1\nroot=Page('Mine',[Text('x')])`);
    const d = apply(store, 'feature', VIEW_BY_NAME.get('feature')!.build(undefined, {}), {fresh: true, now: 5000});
    expect(d.mode).toBe('replace');
    const record = store.get('feature')!;
    expect(record.title).toBe('Feature');
    expect(record.data).toEqual({plan: [], notes: ''});
    expect(record.createdAt).toBe(1000);
  });

  it('a preset and its patch commit as one create', () => {
    const store = new SurfaceStore();
    const d = apply(store, 'feature', [VIEW_BY_NAME.get('feature')!.build(undefined, {}), `$/plan=[{title:'A',status:'doing'}]\ndesign=Flowchart({edges:[['A','B']]},title='Design')`], {fresh: true});
    expect(d.mode).toBe('create');
    expect(store.get('feature')!.data.plan).toEqual([{title: 'A', status: 'doing'}]);
    expect(store.get('feature')!.components.get('design')!.component).toBe('Flowchart');
  });

  it('a patch replaces one node of a bound diagram, whether it was written as text or as {label} (decision D21)', () => {
    const store = new SurfaceStore();
    apply(store, 'arch', `$/f={nodes:{A:'a',B:'b',C:{label:'c'}},edges:[['A','B']]}\nroot=Page('T',[f])\nf=Flowchart($/f)`);
    apply(store, 'arch', `$/f/nodes/B={label:'renamed',shape:'diamond'}\n$/f/nodes/C/label='also renamed'\n$/f/edges/1=['B','C']`);
    expect(store.get('arch')!.data.f).toEqual({nodes: {A: 'a', B: {label: 'renamed', shape: 'diamond'}, C: {label: 'also renamed'}}, edges: [['A', 'B'], ['B', 'C']]});
    // A path into a label written as text is refused: the docs say to replace the node.
    expect(() => apply(store, 'arch', `$/f/nodes/A/label='x'`)).toThrow(/segment 'A' is a primitive value/);
  });

  it('a draft never touches the store or the current record', () => {
    const store = new SurfaceStore();
    apply(store, 'demo', BASE);
    const before = dump(store);
    const record = store.get('demo')!;
    draft(store, 'demo', `$/notes='x'\n$/deep/a/b=1\nroot=Page('Other',[Text('gone')])`);
    draft(store, 'demo', VIEW_BY_NAME.get('overview')!.build(undefined, {}), {fresh: true});
    draft(store, 'other', BASE);
    expect(dump(store)).toBe(before);
    expect(store.get('demo')).toBe(record);
  });

  // Decision D1: a patch keeps the scopes the user drilled to; a show that replaces the surface clears them.
  it('a patch keeps envelopes and drill targets; a replace keeps undrilled envelopes and resets drilled ones', () => {
    const store = new SurfaceStore();
    const first = apply(store, 'demo', BASE);
    const [rowsKey, kpisKey] = first.newKeys as [string, string];
    const record = store.get('demo')!;
    record.ds[rowsKey] = {$ds: rowsKey, kind: 'rows', status: 'ready', source: 'fake.rows src/deep', data: [], drill: {target: 'src/deep', up: ''}};
    record.ds[kpisKey] = {$ds: kpisKey, kind: 'rows', status: 'ready', source: 'repo.kpis', data: []};
    record.drills.set(rowsKey, 'src/deep');

    const patched = apply(store, 'demo', `$/notes='still drilled'`);
    expect(patched.mode).toBe('patch');
    expect(patched.newKeys).toEqual([]);
    expect([...store.get('demo')!.drills]).toEqual([[rowsKey, 'src/deep']]);
    expect(store.get('demo')!.ds[rowsKey]!.drill).toEqual({target: 'src/deep', up: ''});

    const replaced = apply(store, 'demo', `root=Page('Demo',[table,side])`);
    expect(replaced.mode).toBe('replace');
    // the drilled dataset is asked for again at the spec's own scope; the other one keeps its data
    expect(replaced.newKeys).toEqual([rowsKey]);
    expect(store.get('demo')!.ds[kpisKey]).toBe(record.ds[kpisKey]);
    expect(store.get('demo')!.ds[rowsKey]).toEqual({$ds: rowsKey, kind: 'rows', status: 'pending', source: rowsKey});
    expect([...store.get('demo')!.drills]).toEqual([]);

    // a dataset no component binds any more loses its envelope
    apply(store, 'demo', `root=Page('Demo',[table])`);
    expect(Object.keys(store.get('demo')!.ds)).toEqual([rowsKey]);
    expect([...store.get('demo')!.bindings.keys()]).toEqual([rowsKey]);
  });

  it('a /ds binding that names no dataset of the surface is reported, not bound', () => {
    const store = new SurfaceStore();
    const d = draft(store, 'demo', `root=Page('x',[DataTable($/ds/git_churn)])`);
    expect(d.unknownKeys).toEqual(['git_churn']);
    expect(d.record.bindings.size).toBe(0);
  });

  it('the title falls back to the id when Page.title is bound or empty', () => {
    const store = new SurfaceStore();
    expect(apply(store, 'a', `root=Page($/meta/repo/name,[])`).record.title).toBe('a');
    expect(apply(store, 'b', `root=Page('  ',[])`).record.title).toBe('b');
  });
});

describe('eviction', () => {
  it('keeps at most twelve surfaces and evicts the least recently updated', () => {
    const store = new SurfaceStore();
    for (let i = 0; i < MAX_SURFACES; i++) expect(store.commit(draft(store, `s${i}`, `root=Page('S${i}',[])`, {now: 100 + i}))).toEqual([]);
    apply(store, 's0', `$/touched=true`, {now: 500});
    expect(store.commit(draft(store, 'extra', `root=Page('Extra',[])`, {now: 600}))).toEqual(['s1']);
    expect(store.ids()).toHaveLength(MAX_SURFACES);
    expect(store.has('s0')).toBe(true);
    expect(store.has('s1')).toBe(false);
    expect(store.has('extra')).toBe(true);
  });
});

describe('snapshots', () => {
  it('a snapshot is one createSurface with the data, /ds, /ui and /meta', () => {
    const store = new SurfaceStore();
    apply(store, 'demo', BASE);
    const record = store.get('demo')!;
    const snapshot = snapshotOf(record, META) as Extract<A2uiMessage, {createSurface: unknown}>;
    expect(snapshot.version).toBe('1.0');
    expect(snapshot.createSurface.surfaceId).toBe('demo');
    expect(snapshot.createSurface.catalogId).toBe('urn:glimpse:catalog:v1');
    expect(snapshot.createSurface.components).toHaveLength(6);
    expect(Object.keys(snapshot.createSurface.dataModel!)).toEqual(['notes', 'ds', 'ui', 'meta']);
    expect(snapshot.createSurface.dataModel!.ui).toEqual({sel: null, file: null});
    expect(snapshot.createSurface.dataModel!.meta).toBe(META);
  });

  it('/ui values the agent assigned survive in the snapshot', () => {
    const store = new SurfaceStore();
    apply(store, 'demo', `$/ui/file='src/a.ts#L3'\nroot=Page('x',[CodeView()])`);
    expect(dataModelOf(store.get('demo')!, META).ui).toEqual({sel: null, file: 'src/a.ts#L3'});
  });
});

describe('setPath', () => {
  it('creates containers, honours array indices and JSON-pointer escapes', () => {
    const data: Record<string, unknown> = {plan: [{status: 'todo'}, {status: 'todo'}], n: 1};
    setPath(data, '/plan/1/status', 'done');
    setPath(data, '/a/b/c', 1);
    setPath(data, '/n/x', 2);
    setPath(data, '/odd~1key/~0', true);
    expect(data).toEqual({plan: [{status: 'todo'}, {status: 'done'}], n: {x: 2}, a: {b: {c: 1}}, 'odd/key': {'~': true}});
  });

  it('ignores the root path and keys that would reach a prototype', () => {
    const data: Record<string, unknown> = {};
    setPath(data, '/', 1);
    setPath(data, '/__proto__/polluted', true);
    setPath(data, '/a/constructor/prototype/polluted', true);
    setPath(data, '/toString/polluted', true);
    expect(data).toEqual({toString: {polluted: true}});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype.toString as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('creates an array where the next segment is an index, as the viewer data model does (finding F073)', () => {
    const data: Record<string, unknown> = {};
    setPath(data, '/fresh/0/x', 1);
    setPath(data, '/fresh/2', 'c');
    setPath(data, '/grid/1/0', 'cell');
    expect(data).toEqual({fresh: [{x: 1}, null, 'c'], grid: [null, ['cell']]});
    // an array is only ever indexed, and never grown without bound
    setPath(data, '/fresh/length', 99);
    setPath(data, '/fresh/01', 'no');
    setPath(data, '/fresh/999999999', 'no');
    expect(data.fresh).toEqual([{x: 1}, null, 'c']);
  });
});

describe('patches below a slot (decision D4)', () => {
  it('the delta of a patch carries each touched slot once, whole and detached from the record', () => {
    const store = new SurfaceStore();
    apply(store, 'demo', `$/plan=[{title:'A',status:'todo'},{title:'B',status:'todo'}]\n$/n=1\nroot=Page('x',[Steps($/plan)])`);
    const d = draft(store, 'demo', `$/plan/0/status='done'\n$/n=2\n$/plan/1/status='doing'\n$/ui/sel=null`);
    expect(d.mode).toBe('patch');
    expect(d.delta.map(message => ('updateDataModel' in message ? [message.updateDataModel.path, message.updateDataModel.value] : []))).toEqual([
      ['/plan', [{title: 'A', status: 'done'}, {title: 'B', status: 'doing'}]],
      ['/n', 2],
      ['/ui/sel', null],
    ]);
    const sent = (d.delta[0] as Extract<A2uiMessage, {updateDataModel: unknown}>).updateDataModel.value;
    expect(sent).toEqual(d.record.data.plan);
    expect(sent).not.toBe(d.record.data.plan);
  });
});

// Decision D25: a number the user set with a Slider lives in the data, with the seed it replaced.
describe('numbers set in the tab', () => {
  const WHAT_IF = `root=Page('What if',[s,peak])\n$/w={seats:50000,secs:120}\ns=Slider('Seats',$/w/seats,1000,200000)\npeak=Stat(div($/w/seats,$/w/secs),'rps')`;
  /** What Session.setInput does to the record for gl_set {value} from Slider s. */
  const typeIn = (store: SurfaceStore, value: number) => {
    const record = store.get('w')!;
    record.typed ??= new Map();
    const typed = record.typed;
    typed.set('/w/seats', {value, seed: typed.get('/w/seats')?.seed ?? structuredClone((record.data.w as {seats: unknown}).seats)});
    setPath(record.data, '/w/seats', value);
  };
  const setup = () => {
    const store = new SurfaceStore();
    apply(store, 'w', WHAT_IF);
    typeIn(store, 80000);
    return store;
  };
  const dataMessages = (messages: A2uiMessage[]) => messages.flatMap(m => ('updateDataModel' in m ? [[m.updateDataModel.path, m.updateDataModel.value]] : []));

  it('the same seed sent again keeps the number, says so, and a patch publishes the slot as the store holds it', () => {
    const store = setup();
    const d = draft(store, 'w', `$/w={seats:50000,secs:120}`);
    expect(d.mode).toBe('patch');
    expect(d.kept).toEqual([{path: '/w/seats', value: 80000}]);
    expect(d.record.data.w).toEqual({seats: 80000, secs: 120});
    expect(d.record.typed).toEqual(new Map([['/w/seats', {value: 80000, seed: 50000}]]));
    expect(dataMessages(d.delta)).toEqual([['/w', {seats: 80000, secs: 120}]]);
    // a patch of another key of the slot keeps it without a word, and publishes the whole slot
    const other = draft(store, 'w', `$/w/secs=60`);
    expect(other.kept).toEqual([]);
    expect(dataMessages(other.delta)).toEqual([['/w', {seats: 80000, secs: 60}]]);
    expect(other.record.typed?.get('/w/seats')).toEqual({value: 80000, seed: 50000});
  });

  it('a re-show of the whole spec is replaced in place, keeps the number and sends no /w', () => {
    const store = setup();
    const d = draft(store, 'w', WHAT_IF);
    expect(d.mode).toBe('replace');
    expect(d.inPlace).toBeDefined();
    expect(d.kept).toEqual([{path: '/w/seats', value: 80000}]);
    expect(d.record.data.w).toEqual({seats: 80000, secs: 120});
    const frame = inPlaceMessages(d.inPlace!.previous, d.record, META, d.inPlace!.changed);
    expect(dataMessages(frame).map(([path]) => path)).toEqual(['/meta']);
    // a reload or a second tab gets it too
    store.commit(d);
    const snapshot = snapshotOf(store.get('w')!, META);
    expect('createSurface' in snapshot && snapshot.createSurface.dataModel?.w).toEqual({seats: 80000, secs: 120});
  });

  it('a write to the path itself wins, and the number is forgotten', () => {
    const store = setup();
    const d = draft(store, 'w', `$/w/seats=50000`);
    expect(d.kept).toEqual([]);
    expect(d.record.data.w).toEqual({seats: 50000, secs: 120});
    expect(d.record.typed).toBeUndefined();
  });

  it('a new seed wins over the number', () => {
    const store = setup();
    const d = draft(store, 'w', `$/w={seats:60000,secs:120}`);
    expect(d.kept).toEqual([]);
    expect(d.record.data.w).toEqual({seats: 60000, secs: 120});
    expect(d.record.typed).toBeUndefined();
    expect(dataMessages(d.delta)).toEqual([['/w', {seats: 60000, secs: 120}]]);
  });

  it('is forgotten when no Slider binds the path, and a preset starts from nothing', () => {
    const store = setup();
    const removed = draft(store, 'w', `root=Page('What if',[peak])`);
    expect(removed.record.typed).toBeUndefined();
    expect(removed.record.data.w).toEqual({seats: 80000, secs: 120});
    const fresh = draft(store, 'w', WHAT_IF, {fresh: true});
    expect(fresh.record.typed).toBeUndefined();
    expect(fresh.kept).toEqual([]);
    expect(fresh.record.data.w).toEqual({seats: 50000, secs: 120});
  });
});

describe('the selection in snapshots (finding F082)', () => {
  it('dataModelOf puts the stored selection and file over what the spec wrote', () => {
    const store = new SurfaceStore();
    apply(store, 'demo', `$/ui/file='src/a.ts#L3'\nroot=Page('x',[CodeView()])`);
    const record = store.get('demo')!;
    record.sel = {type: 'file', id: 'src/b.ts', path: 'src/b.ts'};
    record.file = 'src/b.ts';
    expect(dataModelOf(record, META).ui).toEqual({sel: {type: 'file', id: 'src/b.ts', path: 'src/b.ts'}, file: 'src/b.ts'});
    // a later spec write to /ui wins again
    apply(store, 'demo', `$/ui/file='src/c.ts'`);
    expect(dataModelOf(store.get('demo')!, META).ui).toEqual({sel: null, file: 'src/c.ts'});
  });
});

// Finding V044: a long Page title (a file preset's path) was cut at 80 characters inside the file name.
describe('surface titles', () => {
  const root = (title: string) => new Map([['root', {id: 'root', component: 'Page', title}]]);
  it('a long title loses whole leading path segments and keeps the file name', () => {
    const path = `${'packages/very-long-directory-name/'.repeat(3)}src/session/surfaces.ts`;
    const title = titleOf(root(path), 'file');
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title).toMatch(/^…\/[^/]/);
    expect(title.endsWith('src/session/surfaces.ts')).toBe(true);
    expect(titleOf(root('Short title'), 'x')).toBe('Short title');
    expect(titleOf(root('  '), 'fallback')).toBe('fallback');
    // no path to cut at: the end is kept
    expect(titleOf(root('x'.repeat(100) + 'END'), 'x')).toBe(`…${'x'.repeat(76)}END`);
  });
});
