// The pipeline end to end on fakes (design 2.2): frames in order, all-or-nothing, datasets, the working tree,
// colour slots, and the host actions the viewer can send.
import {mkdir, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GALLERY_SPEC, VIEW_BY_NAME, type A2uiMessage, type Dataset, type SurfaceMeta} from '@glimpse/catalog';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';
import {ActionRouter} from '../../src/session/actions.ts';
import {MAX_SURFACES} from '../../src/session/surfaces.ts';
import {SpecError} from '../../src/spec/errors.ts';
import {fakeDeps, fixedSource, kinds, sleep, tempRoot, testSession, until, type Frame, type TestSession} from './fakes.ts';

let dir: Awaited<ReturnType<typeof tempRoot>>;
beforeAll(async () => {
  dir = await tempRoot();
});
afterAll(() => dir.cleanup());

const live: TestSession[] = [];
function start(options: Parameters<typeof testSession>[1] = {}): TestSession {
  const t = testSession(dir.root, options);
  live.push(t);
  return t;
}
afterEach(() => {
  for (const t of live.splice(0)) t.session.dispose();
});

const spec = (id: string, text: string) => ({id, sources: [text], fresh: false});
const preset = (name: string, patch?: string) => ({id: name, sources: [VIEW_BY_NAME.get(name)!.build(undefined, {}), ...(patch ? [patch] : [])], fresh: true, view: name});
const BASE = `$/notes='hi'\nroot=Page('Demo',[notes,table,slow])\nnotes=Text($/notes)\ntable=DataTable('fake.rows src top=5',title='Rows')\nslow=DataTable('fake.slow')`;

const created = (frame: Frame) => {
  const message = frame.messages.find(m => 'createSurface' in m) as Extract<A2uiMessage, {createSurface: unknown}> | undefined;
  if (!message) throw new Error('no createSurface in frame');
  return message.createSurface;
};
const dataUpdates = (frames: Frame[]) => frames.flatMap(f => f.messages).flatMap(m => ('updateDataModel' in m ? [m.updateDataModel] : []));
const dump = (t: TestSession) => JSON.stringify(t.session.surfaces.all().map(r => ({...r, components: [...r.components], bindings: [...r.bindings], drills: [...r.drills]})));

describe('show', () => {
  it('create: one focused frame with the snapshot; ready data inline, slow data pending, then filled', async () => {
    const t = start();
    const outcome = await t.session.show(spec('demo', BASE));
    expect(outcome).toMatchObject({id: 'demo', mode: 'create', url: '#/demo', openUrl: 'http://127.0.0.1:4517/#t=test-token-0123456789', tab: 'none', fixes: [], warnings: [], parts: ['notes', 'table', 'slow'], slots: ['$/notes'], first: true});
    expect(outcome.openUrl).toMatch(/#t=/);
    expect(t.host.frames).toHaveLength(1);
    expect(t.host.frames[0]).toMatchObject({surfaceId: 'demo', focus: 'demo'});
    expect(kinds(t.host.frames[0]!)).toEqual(['createSurface']);
    const model = created(t.host.frames[0]!).dataModel as {notes: string; ds: Record<string, Dataset>; ui: unknown; meta: SurfaceMeta};
    expect(model.notes).toBe('hi');
    expect(model.ui).toEqual({sel: null, file: null});
    expect(model.meta).toMatchObject({repo: {name: t.session.name, root: dir.root, branch: 'main', dirty: false}, rev: 1});
    expect(Object.values(model.ds).map(d => [d.source, d.status])).toEqual([['fake.rows src top=5', 'pending'], ['fake.slow', 'pending']]);

    await outcome.datasets[0]!.settled;
    expect(t.session.datasetState('demo', outcome.datasets[0]!.key)).toEqual({status: 'ready', summary: '5/25 rows; fields path n owner; top src/file00.ts 25'});
    expect(t.session.datasetState('demo', outcome.datasets[1]!.key)).toEqual({status: 'pending'});
    t.deps.sources.release();
    await outcome.datasets[1]!.settled;
    const fills = dataUpdates(t.host.frames.slice(1));
    expect(fills.map(u => [u.path, (u.value as Dataset).status])).toEqual([[`/ds/${outcome.datasets[0]!.key}`, 'ready'], ['/ds/fake_slow', 'ready']]);
    expect(t.host.frames.slice(1).every(f => f.focus === undefined)).toBe(true);
  });

  it('a dataset already in memory is bound ready in the first frame', async () => {
    const t = start();
    await (await t.session.show(spec('one', `root=Page('One',[DataTable('fake.rows')])`))).datasets[0]!.settled;
    await t.session.show(spec('two', `root=Page('Two',[List('fake.rows')])`));
    const model = created(t.host.frames.at(-1)!).dataModel as {ds: Record<string, Dataset>};
    expect(model.ds.fake_rows).toMatchObject({status: 'ready', cache: 'hit'});
    expect(t.deps.sources.runs.get('fake.rows  {}')).toBe(1);
  });

  it('patch: the compiled delta plus envelopes for new datasets, nothing else', async () => {
    const t = start();
    await (await t.session.show(spec('demo', BASE))).datasets[0]!.settled;
    const before = t.host.frames.length;
    const outcome = await t.session.show(spec('demo', `$/notes='changed'\ntable=DataTable('fake.rows lib',title='Rows')`));
    expect(outcome).toMatchObject({mode: 'patch', parts: [], slots: [], first: false});
    expect(outcome.datasets.map(d => d.ref)).toEqual(['fake.rows lib']);
    const frame = t.host.frames[before]!;
    expect(kinds(frame)).toEqual(['updateComponents', 'updateDataModel', 'updateDataModel']);
    expect(dataUpdates([frame]).map(u => u.path)).toEqual(['/notes', `/ds/${outcome.datasets[0]!.key}`]);
    expect(frame.focus).toBe('demo');
  });

  it('replace: deleteSurface then the snapshot, in one frame; data survives', async () => {
    const t = start();
    await t.session.show(spec('demo', BASE));
    const outcome = await t.session.show(spec('demo', `root=Page('Smaller',[notes])`));
    expect(outcome.mode).toBe('replace');
    const frame = t.host.frames.at(-1)!;
    expect(kinds(frame)).toEqual(['deleteSurface', 'createSurface']);
    expect(created(frame).components.map(c => c.id)).toEqual(['root', 'notes']);
    expect(created(frame).dataModel).toMatchObject({notes: 'hi', ds: {}});
    expect(outcome.parts).toEqual(['notes']);
    expect(outcome.slots).toEqual(['$/notes']);
  });

  // Integrator item: the slots line listed the data of a spec that had been replaced.
  it('the slots of a replace are those the new view reads or this call writes, not leftovers', async () => {
    const t = start();
    await t.session.show(spec('demo', `$/a='one'\n$/b='two'\nroot=Page('First',[Text($/a),Text($/b)])`));
    expect((await t.session.show(spec('demo', `root=Page('Second',[Text('plain')])`))).slots).toEqual([]);
    expect((await t.session.show(spec('demo', `$/c='three'\nroot=Page('Third',[Text($/b)])`))).slots).toEqual(['$/b', '$/c']);
  });

  it('a preset with a spec is one create; a preset on an existing id replaces it', async () => {
    const t = start();
    const first = await t.session.show(preset('feature', `$/plan=[{title:'A',status:'doing'}]`));
    expect(first).toMatchObject({mode: 'create', parts: ['plan', 'design', 'notes', 'changes', 'impact'], slots: ['$/plan', '$/notes']});
    expect(created(t.host.frames[0]!).dataModel).toMatchObject({plan: [{title: 'A', status: 'doing'}]});
    expect(t.session.surfaces.get('feature')!.view).toBe('feature');
    const second = await t.session.show(preset('feature'));
    expect(second.mode).toBe('replace');
    expect(t.session.surfaces.get('feature')!.data).toEqual({plan: [], notes: ''});
  });

  it('the gallery compiles, expands and binds no dataset at all', async () => {
    const t = start();
    const outcome = await t.session.show({id: 'gallery', sources: [GALLERY_SPEC], fresh: true, view: 'gallery'});
    expect(outcome.datasets).toEqual([]);
    expect(outcome.warnings).toEqual([]);
    expect(new Set([...t.session.surfaces.get('gallery')!.components.values()].map(c => c.component)).size).toBe(43);
  });

  it('reports repairs and unbound paths', async () => {
    const t = start();
    const outcome = await t.session.show(spec('demo', `root=Page('x',[Tetx($/nothing),DataTable($/ds/ghost)])`));
    expect(outcome.fixes).toEqual(['Tetx -> Text']);
    expect(outcome.warnings).toEqual(['unbound $/nothing', 'unbound $/ds/ghost']);
  });

  it('a failing source becomes an error envelope; the rest of the view is unaffected', async () => {
    const t = start();
    const outcome = await t.session.show(spec('demo', `root=Page('x',[DataTable('fake.rows boom'),Stats()])`));
    await Promise.all(outcome.datasets.map(d => d.settled));
    expect(t.session.datasetState('demo', outcome.datasets[0]!.key)).toEqual({status: 'error', error: {code: 'E_TARGET', message: 'no such path: boom'}});
    expect(t.session.datasetState('demo', 'repo_kpis')).toEqual({status: 'error', error: {code: 'E_INTERNAL', message: 'not implemented'}});
  });
});

describe('all or nothing', () => {
  it.each([
    ['a compile error', `notes=Text($/notes)\nnotes=Callout('x','purple')`],
    ['an unknown source', `table=DataTable('git.chrun')`],
    ['a reserved path', `$/notes='x'\n$/ds/fake_slow=1`],
    ['bad notation', `notes=Flowchart('A -> B')`],
    ['a part the new root leaves out', `$/notes='x'\nroot=Page('Demo',[notes])\nextra=Text('nobody shows me')`],
    ['a reserved name in a path', `$/notes='x'\n$/__proto__/polluted=1`],
    ['a reserved name as a key', `$/notes={constructor:{prototype:{polluted:1}}}`],
    ['a syntax error after valid statements', `$/notes='x'\nnotes=Text('y',,)`],
  ])('%s leaves every surface byte-identical and publishes nothing', async (_name, text) => {
    const t = start();
    await t.session.show(spec('demo', BASE));
    await t.session.show(spec('other', `root=Page('Other',[Text('x')])`));
    await sleep(5);
    const before = dump(t);
    const frames = t.host.frames.length;
    await expect(t.session.show(spec('demo', text))).rejects.toBeInstanceOf(SpecError);
    expect(dump(t)).toBe(before);
    expect(t.host.frames).toHaveLength(frames);
  });

  it('a failed first show creates nothing, and a failed preset does not replace', async () => {
    const t = start();
    await expect(t.session.show(spec('main', `root=Page('x',[Nope()])`))).rejects.toBeInstanceOf(SpecError);
    expect(t.session.surfaces.ids()).toEqual([]);
    await t.session.show(spec('feature', `root=Page('Mine',[Text('x')])`));
    const before = dump(t);
    await expect(t.session.show(preset('feature', `design=Flowchart('A -> B')`))).rejects.toBeInstanceOf(SpecError);
    expect(dump(t)).toBe(before);
  });

  it('a patch that writes the data a stored diagram binds is checked like inline data (D21)', async () => {
    const t = start();
    await t.session.show(spec('seq', `$/seq={steps:[['A','B','hi']]}\nroot=Page('S',[s])\ns=SequenceDiagram($/seq)`));
    const dropped = await t.session.show(spec('seq', `$/seq/steps/1={note:'lost'}`));
    expect(dropped.warnings).toContain("SequenceDiagram#s: not drawn: step 2: a note needs over: 'A' or over: ['A', 'B']");
    const text = await t.session.show(spec('seq', `$/seq='A->>B: hi'`));
    expect(text.warnings).toContainEqual(expect.stringMatching(/^SequenceDiagram#s: E_SHAPE \$\/seq: SequenceDiagram takes data, not Mermaid text/));
  });

  it('a patch of a view that does not exist says so', async () => {
    const t = start();
    await t.session.show(spec('overview', `root=Page('x',[])`));
    await expect(t.session.show(spec('main', `$/notes='x'`))).rejects.toThrow(/^E_REF there is no view "main" to patch.*Existing views: overview\.$/);
  });

  it('parallel calls on one surface both land, each on the result of the other', async () => {
    const t = start();
    await t.session.show(spec('demo', BASE));
    await Promise.all([t.session.show(spec('demo', `$/a=1`)), t.session.show(spec('demo', `$/b=2`)), t.session.show(spec('demo', `$/notes='c'`))]);
    expect(t.session.surfaces.get('demo')!.data).toEqual({notes: 'c', a: 1, b: 2});
  });
});

describe('lazy start and eviction', () => {
  it('starts the host on the first valid show only, once', async () => {
    const t = start();
    t.session.warm();
    await t.session.services();
    expect(t.hostStarts).toBe(0);
    await expect(t.session.show(spec('main', `root=Nope()`))).rejects.toBeInstanceOf(SpecError);
    expect(t.hostStarts).toBe(0);
    await Promise.all([t.session.show(spec('a', `root=Page('A',[])`)), t.session.show(spec('b', `root=Page('B',[])`))]);
    await t.session.show(spec('c', `root=Page('C',[])`));
    expect(t.hostStarts).toBe(1);
    expect(t.host.opened).toBe(3);
  });

  it('the thirteenth surface evicts the least recently updated one and tells the tab', async () => {
    let clock = 1000;
    const t = start({now: () => clock++});
    for (let i = 0; i < MAX_SURFACES; i++) await t.session.show(spec(`s${i}`, `root=Page('S${i}',[])`));
    await t.session.show(spec('s0', `$/touched=true`));
    await t.session.show(spec('extra', `root=Page('Extra',[])`));
    expect(t.session.surfaces.ids()).not.toContain('s1');
    expect(t.session.surfaces.ids()).toHaveLength(MAX_SURFACES);
    const [evict, create] = t.host.frames.slice(-2) as [Frame, Frame];
    expect(evict).toMatchObject({surfaceId: 's1', messages: [{deleteSurface: {surfaceId: 's1'}}]});
    expect(create.surfaceId).toBe('extra');
  });
});

describe('replay and info', () => {
  it('replays one snapshot per surface with the current data', async () => {
    const t = start();
    const outcome = await t.session.show(spec('demo', BASE));
    await t.session.show(spec('other', `root=Page('Other',[])`));
    await outcome.datasets[0]!.settled;
    const replay = t.session.replay();
    expect(replay.map(r => r.surfaceId)).toEqual(['demo', 'other']);
    const model = (replay[0]!.messages[0] as Extract<A2uiMessage, {createSurface: unknown}>).createSurface.dataModel as {ds: Record<string, Dataset>};
    expect(Object.values(model.ds).map(d => d.status)).toEqual(['ready', 'pending']);
    expect(t.session.surfaceList().map(s => [s.id, s.title])).toEqual([['demo', 'Demo'], ['other', 'Other']]);
  });

  it('session info: eight-character id from CLAUDE_CODE_SESSION_ID, repo facts once loaded', async () => {
    const t = start({env: {GLIMPSE_NO_OPEN: '1', CLAUDE_CODE_SESSION_ID: '0f3c9a2e-77aa-4b1c-9d00-aaaaaaaaaaaa'}});
    expect(t.session.id).toBe('0f3c9a2e');
    expect(t.session.info().repo).toEqual({name: t.session.name});
    await t.session.services();
    expect(t.session.info()).toEqual({id: '0f3c9a2e', project: dir.root, repo: {name: t.session.name, branch: 'main', head: '4f2a91c0ffee4f2a91c0ffee4f2a91c0ffee4f2a'}, version: '0.0.0-test'});
    expect(start().session.id).toMatch(/^[a-z0-9]{8}$/);
  });

  it('outside a git repository the meta has no branch or head', async () => {
    const t = start({deps: fakeDeps({git: null})});
    await t.session.show(spec('demo', `root=Page('x',[])`));
    expect(t.session.meta().repo).toEqual({name: t.session.name, root: dir.root, dirty: false});
  });
});

describe('working tree', () => {
  it('watches only while a tab is connected', async () => {
    const t = start();
    await t.session.show(spec('demo', BASE));
    expect(t.deps.watching()).toBe(false);
    t.session.tabsChanged(1);
    expect(t.deps.watching()).toBe(true);
    t.session.tabsChanged(2);
    t.session.tabsChanged(0);
    expect(t.deps.watching()).toBe(false);
  });

  it('a change bumps the revision, drops the index, publishes /meta and re-runs working-tree datasets only', async () => {
    const t = start();
    const outcome = await t.session.show(spec('demo', BASE));
    t.deps.sources.release();
    await Promise.all(outcome.datasets.map(d => d.settled));
    t.session.tabsChanged(1);
    const frames = t.host.frames.length;
    t.deps.touchTree();
    t.deps.touchTree();
    await until(() => t.deps.sources.runs.get('fake.slow ') === 2, 3000);
    expect(t.deps.calls.invalidated).toBe(1);
    expect(t.session.meta().rev).toBe(2);
    const metas = dataUpdates(t.host.frames.slice(frames)).filter(u => u.path === '/meta');
    expect(metas).toHaveLength(1);
    expect((metas[0]!.value as SurfaceMeta).rev).toBe(2);
    expect(t.deps.sources.runs.get('fake.rows src {"top":"5"}')).toBe(1);
    // the old data stays on screen until the new result arrives
    expect(t.session.datasetState('demo', 'fake_slow')?.status).toBe('ready');
    t.deps.sources.release();
    await until(() => dataUpdates(t.host.frames.slice(frames)).some(u => u.path === '/ds/fake_slow'));
  });

  it('a new HEAD re-runs every dataset', async () => {
    const t = start();
    const outcome = await t.session.show(spec('demo', `root=Page('x',[DataTable('fake.rows')])`));
    await outcome.datasets[0]!.settled;
    t.session.tabsChanged(1);
    t.deps.git.info = {branch: 'main', head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', shallow: false};
    t.deps.touchTree();
    await until(() => t.deps.sources.runs.get('fake.rows  {}') === 2, 3000);
    expect(t.session.meta().repo.head).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });
});

describe('colour slots', () => {
  it('assigns slots 1 to 8 per kind, heaviest first, and publishes them once', async () => {
    const langs = Array.from({length: 10}, (_, i) => ({lang: `L${i}`, loc: i === 3 ? 9999 : 100 - i}));
    const graph = {nodes: [{id: 'small', label: 'small', loc: 5}, {id: 'big', label: 'big', loc: 500, slotKey: 'core'}, {id: 'mid', label: 'mid', loc: 50}], edges: []};
    const authors = [{author: 'Jon', commits: 3}, {author: 'Mira', commits: 30}];
    const t = start({deps: fakeDeps({extra: [fixedSource('files.langs', langs), fixedSource('deps.modules', graph), fixedSource('git.authors', authors)]})});
    await t.session.show(spec('demo', `root=Page('x',[])`));
    const meta = await until(() => {
      const found = dataUpdates(t.host.frames).find(u => u.path === '/meta');
      return found ? (found.value as SurfaceMeta) : undefined;
    });
    expect(meta.slots.lang).toEqual({L3: 1, L0: 2, L1: 3, L2: 4, L4: 5, L5: 6, L6: 7, L7: 8});
    expect(meta.slots.module).toEqual({core: 1, mid: 2, small: 3});
    expect(meta.slots.author).toEqual({Mira: 1, Jon: 2});
    await t.session.show(spec('two', `root=Page('y',[])`));
    await sleep(20);
    expect(dataUpdates(t.host.frames).filter(u => u.path === '/meta')).toHaveLength(1);
    expect((created(t.host.frames.find(f => f.surfaceId === 'two')!).dataModel as {meta: SurfaceMeta}).meta.slots.author).toEqual({Mira: 1, Jon: 2});
  });

  it('survives malformed slot data and sources that fail', async () => {
    const t = start({deps: fakeDeps({extra: [fixedSource('files.langs', 'not rows'), fixedSource('deps.modules', {nodes: [null, {id: 7}, {id: 'ok', loc: 'NaN'}]})]})});
    await t.session.show(spec('demo', `root=Page('x',[])`));
    await sleep(30);
    expect(t.session.meta().slots).toEqual({lang: {}, module: {ok: 1}, author: {}});
  });
});

describe('host actions', () => {
  const action = (name: string, context: Record<string, unknown> = {}, source = 'root', surfaceId = 'demo') =>
    ({version: '1.0', action: {name, surfaceId, sourceComponentId: source, timestamp: '2026-11-20T00:00:00Z', context}});

  async function withRouter(text = BASE) {
    const t = start();
    const logged: string[] = [];
    const outcome = await t.session.show(spec('demo', text));
    return {t, outcome, logged, router: new ActionRouter(t.session, m => void logged.push(m))};
  }

  it('gl_select is kept as the pending selection; a newer one replaces it; null clears it', async () => {
    const {t, router} = await withRouter();
    expect(router.handle(action('gl_select', {ref: {type: 'file', id: 'src/a.ts', path: 'src/a.ts', line: 3}}, 'table'))).toBe(true);
    expect(router.handle(action('gl_select', {ref: {type: 'file', id: 'src/b.ts', path: 'src/b.ts'}}, 'table'))).toBe(true);
    expect(t.session.events.drain()).toEqual(['viewer: select file src/b.ts (demo)']);
    router.handle(action('gl_select', {ref: {type: 'module', id: 'auth'}}));
    router.handle(action('gl_select', {ref: null}));
    expect(t.session.events.drain()).toEqual([]);
  });

  it('other actions are queued as press, answer or event lines by the kind of their source', async () => {
    const {t, router} = await withRouter(`root=Page('x',[go,ask,note])\ngo=Button('Go',Event('approve',{plan:1}))\nask=Ask('Which?',['Redis','Memory'],'store')\nnote=Text('n')`);
    router.handle(action('approve', {plan: 1}, 'go'));
    router.handle(action('store', {choice: 'Redis'}, 'ask'));
    router.handle(action('custom', {}, 'note'));
    expect(t.session.events.drain()).toEqual(['viewer: press demo approve {"plan":1}', 'viewer: answer demo store {"choice":"Redis"}', 'viewer: event demo custom']);
  });

  it('refuses malformed posts, unknown surfaces and components, and unknown gl_ names', async () => {
    const {t, router} = await withRouter();
    const bad: unknown[] = [
      null, 'x', {}, {version: '0.9', action: action('x').action}, {version: '1.0'}, {version: '1.0', action: {name: 'x'}},
      action('press', {}, 'root', 'nope'), action('press', {}, 'ghost'), action('gl_unknown'), action('gl_select', {ref: {type: 'weird', id: 'x'}}),
      action('gl_select', {ref: {type: 'file'}}), action('gl_select', {}), action('gl_drill', {ds: 'fake_slow'}), action('gl_open', {}),
      action('x'.repeat(2000)),
    ];
    for (const message of bad) expect(router.handle(message)).toBe(false);
    expect(t.session.events.size).toBe(0);
  });

  it('logs renderer errors and never queues them', async () => {
    const {t, router, logged} = await withRouter();
    expect(router.handle({version: '1.0', error: {code: 'VALIDATION_FAILED', message: 'bad\nthing', surfaceId: 'demo'}})).toBe(true);
    expect(logged).toEqual(['glimpse: viewer error VALIDATION_FAILED (demo): bad thing']);
    expect(t.session.events.size).toBe(0);
  });

  it('gl_drill re-runs one dataset with a new target under the same key, and "" restores it', async () => {
    const {t, outcome, router} = await withRouter();
    const key = outcome.datasets[0]!.key;
    await outcome.datasets[0]!.settled;
    const frames = t.host.frames.length;
    router.handle(action('gl_drill', {ds: key, target: 'src/file1'}, 'table'));
    await until(() => t.session.surfaces.get('demo')!.ds[key]?.status === 'ready' && t.session.surfaces.get('demo')!.ds[key]?.source === 'fake.rows src/file1 top=5');
    const updates = dataUpdates(t.host.frames.slice(frames)).map(u => [u.path, (u.value as Dataset).status, (u.value as Dataset).source, (u.value as Dataset).$ds]);
    expect(updates).toEqual([[`/ds/${key}`, 'pending', 'fake.rows src/file1 top=5', key], [`/ds/${key}`, 'ready', 'fake.rows src/file1 top=5', key]]);
    expect((t.session.surfaces.get('demo')!.ds[key]!.data as unknown[]).length).toBe(5);
    router.handle(action('gl_drill', {ds: key, target: ''}, 'table'));
    await until(() => t.session.surfaces.get('demo')!.ds[key]?.source === 'fake.rows src top=5' && t.session.surfaces.get('demo')!.ds[key]?.status === 'ready');
    expect(router.handle(action('gl_drill', {ds: 'not_bound', target: 'x'}, 'table'))).toBe(true);
    expect(t.session.surfaces.get('demo')!.drills.size).toBe(0);
  });

  it('gl_refresh recomputes the working-tree datasets of the surface under a new revision', async () => {
    const {t, outcome, router} = await withRouter();
    t.deps.sources.release();
    await Promise.all(outcome.datasets.map(d => d.settled));
    router.handle(action('gl_refresh'));
    await until(() => t.deps.sources.runs.get('fake.slow ') === 2);
    expect(t.session.meta().rev).toBe(2);
    expect(t.deps.calls.invalidated).toBe(1);
  });

  it('gl_close deletes the surface and tells the tab', async () => {
    const {t, router} = await withRouter();
    expect(router.handle(action('gl_close'))).toBe(true);
    expect(t.session.surfaces.has('demo')).toBe(false);
    expect(t.host.frames.at(-1)).toMatchObject({surfaceId: 'demo', messages: [{deleteSurface: {surfaceId: 'demo'}}]});
    expect(router.handle(action('gl_close'))).toBe(false);
  });

  it('gl_open launches the editor for a path inside the root, as an argument vector', async () => {
    await mkdir(join(dir.root, 'src'), {recursive: true});
    await writeFile(join(dir.root, 'src', 'a b.ts'), 'x');
    // finding V019: an absolute program is the user's own choice and is run as written
    const t = start({env: {GLIMPSE_EDITOR: '/opt/edit/myedit --goto {file}:{line} --reuse', DISPLAY: ':0'}});
    expect(await t.session.openFile('src/a b.ts#L12-20')).toBeUndefined();
    expect(t.launched).toEqual([['/opt/edit/myedit', ['--goto', `${join(dir.root, 'src', 'a b.ts')}:12`, '--reuse']]]);
  });

  it('gl_open refuses anything outside the root and opens nothing under GLIMPSE_NO_OPEN', async () => {
    await symlink(tmpdir(), join(dir.root, 'escape')).catch(() => {});
    const t = start({env: {GLIMPSE_EDITOR: 'myedit {file}', DISPLAY: ':0'}});
    for (const file of ['../outside.ts', '/etc/hosts', 'src/../../x', 'escape/x.ts', '']) {
      expect((await t.session.openFile(file))?.code).toBe('E_PATH');
    }
    expect(t.launched).toEqual([]);
    const quiet = start({env: {GLIMPSE_NO_OPEN: '1', GLIMPSE_EDITOR: 'myedit {file}'}});
    expect(await quiet.session.openFile('src/a b.ts')).toBeUndefined();
    expect(quiet.launched).toEqual([]);
  });
});

describe('dispose', () => {
  it('aborts running sources, stops the watcher and wakes waiters', async () => {
    const t = start();
    const outcome = await t.session.show(spec('demo', BASE));
    t.session.tabsChanged(1);
    const waiting = t.session.events.wait(10_000);
    t.session.dispose();
    await waiting;
    await outcome.datasets[1]!.settled;
    expect(t.deps.watching()).toBe(false);
    expect(t.session.surfaces.get('demo')!.ds.fake_slow!.status).toBe('pending');
    t.session.dispose();
  });
});
