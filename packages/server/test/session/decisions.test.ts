// The cross-area decisions as the session keeps them, on fakes: the way back from a drill (D1), what the viewer
// reported (D3), whole-slot data patches (D4), freshness on every call (D8) and what may be read or opened (D10).
// Each block names the review finding it guards.
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {VIEW_BY_NAME, type A2uiMessage, type Dataset, type SurfaceMeta} from '@glimpse/catalog';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';
import type {Source} from '../../src/contracts.ts';
import {ActionRouter} from '../../src/session/actions.ts';
import {treeStamp} from '../../src/session/freshness.ts';
import {createRunGit} from '../../src/session/rungit.ts';
import {drillOf} from '../../src/session/session.ts';
import {inPlaceMessages} from '../../src/session/surfaces.ts';
import {fakeDeps, kinds, sleep, tempRoot, testSession, until, type Frame, type TestSession} from './fakes.ts';

let dir: Awaited<ReturnType<typeof tempRoot>>;
beforeAll(async () => {
  dir = await tempRoot();
  await mkdir(join(dir.root, 'src'), {recursive: true});
  await mkdir(join(dir.root, '.git'), {recursive: true});
  await writeFile(join(dir.root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(dir.root, 'src', 'service.ts'), 'export const s = 1;\n');
  await writeFile(join(dir.root, '.git', 'config'), '[remote "origin"]\n\turl = https://example.invalid/x.git\n\ttoken = not-for-the-viewer\n');
  await writeFile(join(dir.root, '.env'), 'API_KEY=not-for-the-viewer\n');
  await symlink(join(dir.root, 'src', 'a.ts'), join(dir.root, 'link.ts')).catch(() => {});
});
afterAll(() => dir.cleanup());

const live: TestSession[] = [];
function start(options: Parameters<typeof testSession>[1] = {}, root = dir.root): TestSession {
  const t = testSession(root, options);
  live.push(t);
  return t;
}
afterEach(() => {
  for (const t of live.splice(0)) t.session.dispose();
});

const spec = (id: string, text: string) => ({id, sources: [text], fresh: false});
const BASE = `$/notes='hi'\nroot=Page('Demo',[notes,table,slow])\nnotes=Text($/notes)\ntable=DataTable('fake.rows src top=5',title='Rows')\nslow=DataTable('fake.slow')`;
const dataUpdates = (frames: Frame[]) => frames.flatMap(f => f.messages).flatMap(m => ('updateDataModel' in m ? [m.updateDataModel] : []));
const created = (frame: Frame) => (frame.messages.find(m => 'createSurface' in m) as Extract<A2uiMessage, {createSurface: unknown}>).createSurface;
const action = (name: string, context: Record<string, unknown> = {}, source = 'root', surfaceId = 'demo') =>
  ({version: '1.0', action: {name, surfaceId, sourceComponentId: source, timestamp: '2026-11-20T00:00:00Z', context}});
/** What a tab posts (D27): a problem or any other renderer error as an A2UI `error`; I_* and OK beside the messages. */
const tell = (router: ActionRouter, code: string, message: string, surfaceId = 'demo'): boolean => {
  if (code !== 'OK' && !code.startsWith('I_')) return router.handle({version: '1.0', error: {code, message, surfaceId}});
  const [, component = '', id = '', text = ''] = /^(\w+)#([^:]+):\s?([\s\S]*)$/.exec(message) ?? [];
  return router.state({surfaceId, component, id, code, message: text});
};

// ---------------------------------------------------------------- D8: blocker F059, major F048
describe('D8: every call looks at the tree first, tab or no tab', () => {
  it('a change made while no tab is connected is picked up by the next look', async () => {
    const t = start();
    const outcome = await t.session.show(spec('demo', BASE));
    t.deps.sources.release();
    await Promise.all(outcome.datasets.map(d => d.settled));
    expect(t.deps.watching()).toBe(false);

    await t.session.revalidate();
    expect(t.session.meta().rev).toBe(1);
    expect(t.deps.calls.invalidated).toBe(0);

    // the agent commits: HEAD moves, nobody is watching
    t.deps.git.info = {branch: 'main', head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', shallow: false};
    t.deps.moveTree();
    await t.session.revalidate();
    expect(t.session.meta()).toMatchObject({rev: 2, repo: {head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}});
    expect(t.deps.calls.invalidated).toBe(1);
    // a source that follows HEAD has run again: nothing is answered from the old HEAD, on screen or to a query
    await t.session.runRef('fake.rows src top=5');
    expect(t.deps.sources.runs.get('fake.rows src {"top":"5"}')).toBe(2);
    await t.session.runRef('fake.rows other');
    await t.session.revalidate();
    expect(t.deps.sources.runs.get('fake.rows src {"top":"5"}')).toBe(2);
  });

  it('there is no "looked a moment ago" shortcut: edit, then ask at once', async () => {
    const t = start();
    await t.session.show(spec('demo', `root=Page('x',[DataTable('fake.slow')])`));
    await t.session.revalidate();
    t.deps.moveTree();
    await t.session.revalidate();
    expect(t.session.meta().rev).toBe(2);
    expect(t.deps.calls.checks).toBe(2);
  });

  it('a call that arrives while a look is in flight gets a look of its own, shared with its neighbours', async () => {
    const t = start();
    await t.session.show(spec('demo', `root=Page('x',[])`));
    const first = t.session.revalidate();
    t.deps.moveTree();
    const second = t.session.revalidate();
    const third = t.session.revalidate();
    expect(third).toBe(second);
    await Promise.all([first, second, third]);
    expect(t.deps.calls.checks).toBe(2);
    expect(t.session.meta().rev).toBe(2);
  });

  it('a change the watcher reported is applied before the call, not after its quiet period', async () => {
    const t = start();
    await t.session.show(spec('demo', `root=Page('x',[DataTable('fake.slow')])`));
    t.session.tabsChanged(1);
    await sleep(5);
    t.deps.touchTree();
    expect(t.session.meta().rev).toBe(1);
    await t.session.revalidate();
    expect(t.session.meta().rev).toBe(2);
    // ... and it is applied once: the debounce timer finds nothing left to do
    await sleep(700);
    expect(t.session.meta().rev).toBe(2);
  });

  it('a tab that connects later starts fresh', async () => {
    const t = start();
    await t.session.show(spec('demo', `root=Page('x',[DataTable('fake.slow')])`));
    const frames = t.host.frames.length;
    t.deps.moveTree();
    t.session.tabsChanged(1);
    const meta = await until(() => dataUpdates(t.host.frames.slice(frames)).find(u => u.path === '/meta'));
    expect((meta.value as SurfaceMeta).rev).toBe(2);
    await until(() => t.deps.sources.runs.get('fake.slow ') === 2);
    // a second tab looks again; a tab that leaves does not
    const checks = t.deps.calls.checks;
    t.session.tabsChanged(2);
    t.session.tabsChanged(1);
    await sleep(10);
    expect(t.deps.calls.checks).toBe(checks + 1);
  });

  it('does nothing before the services are loaded and never rejects', async () => {
    const t = start();
    await expect(t.session.revalidate()).resolves.toBeUndefined();
    expect(t.deps.calls.checks).toBe(0);
  });

  // Findings V055 and V068: with a watcher that looks for itself (the production one always does), `git init` in a
  // plain directory changed no file it lists, so every later call still answered "not a git repository".
  it('`git init` in a plain directory is noticed by the next call, whatever the watcher says', async () => {
    const plain = await tempRoot();
    try {
      await writeFile(join(plain.root, 'a.ts'), 'one\n');
      const t = start({deps: fakeDeps({git: null})}, plain.root);
      await t.session.show(spec('demo', `root=Page('x',[DataTable('fake.rows')])`));
      await t.session.revalidate();
      expect(t.session.meta().rev).toBe(1);
      expect(t.session.isGit).toBe(false);
      await mkdir(join(plain.root, '.git'));
      t.deps.git.info = {branch: 'main', head: 'cccccccccccccccccccccccccccccccccccccccc', shallow: false};
      await t.session.revalidate();
      expect(t.session.meta().rev).toBe(2);
      expect(t.session.isGit).toBe(true);
      expect(t.session.meta().repo.head).toBe('cccccccccccccccccccccccccccccccccccccccc');
      await t.session.revalidate();
      expect(t.session.meta().rev).toBe(2);
    } finally {
      await plain.cleanup();
    }
  });

  // Finding V052: main moved (a commit from a sibling worktree, a fetch) while HEAD stayed, and main..HEAD was
  // answered from memory for the rest of the session.
  it('a ref that moves without HEAD moving is a change for the sources that read it', async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-refs-')));
    const git = (...args: string[]) => execFileSync('git', args, {cwd: repo, stdio: 'pipe', env: {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'}}).toString().trim();
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', ['test', 'example.invalid'].join('@'));
      await writeFile(join(repo, 'a.ts'), 'one\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'first');
      git('checkout', '-q', '-b', 'feat');
      const runs = new Map<string, number>();
      const range: Source = {
        meta: {name: 'fake.range', kind: 'rows', doc: 'Rows of a range.', shape: 'Rows', budget: 10, target: 'range'},
        run: async (_ctx, ref) => {
          runs.set(ref.target ?? '', (runs.get(ref.target ?? '') ?? 0) + 1);
          return {data: [{n: 1}], summary: '1 row'};
        },
      };
      const t = start({deps: fakeDeps({extra: [range]}), env: {GLIMPSE_NO_OPEN: '1', PATH: process.env.PATH ?? ''}}, repo);
      await t.session.revalidate();
      await t.session.runRef('fake.range main..HEAD');
      await t.session.runRef('fake.range src/a.ts');
      await t.session.revalidate();
      await t.session.runRef('fake.range main..HEAD');
      expect(runs.get('main..HEAD')).toBe(1);
      // main moves; HEAD (feat) does not
      git('update-ref', 'refs/heads/main', git('commit-tree', '-p', 'HEAD', '-m', 'on main', `${git('rev-parse', 'HEAD')}^{tree}`));
      await t.session.revalidate();
      await t.session.runRef('fake.range main..HEAD');
      expect(runs.get('main..HEAD')).toBe(2);
    } finally {
      await rm(repo, {recursive: true, force: true});
    }
  });

  // Finding V023: a burst of gl_refresh posts re-read the tree once per post, one after another.
  it('refresh requests that arrive while one waits for its turn join it', async () => {
    const t = start();
    await t.session.show(spec('demo', BASE));
    const before = t.deps.calls.invalidated;
    for (let i = 0; i < 50; i++) t.session.refresh('demo');
    await until(() => t.deps.calls.invalidated > before);
    await sleep(30);
    expect(t.deps.calls.invalidated - before).toBe(1);
  });

  describe('without a watcher that can look for itself', () => {
    it('a directory without git: a new or changed file is a change', async () => {
      const plain = await tempRoot();
      try {
        await writeFile(join(plain.root, 'a.ts'), 'one\n');
        const t = start({deps: fakeDeps({check: false, git: null})}, plain.root);
        await t.session.show(spec('demo', `root=Page('x',[DataTable('fake.slow')])`));
        await t.session.revalidate();
        expect(t.session.meta().rev).toBe(1);
        await writeFile(join(plain.root, 'b.ts'), 'two\n');
        await t.session.revalidate();
        expect(t.session.meta().rev).toBe(2);
        await writeFile(join(plain.root, 'a.ts'), 'one, changed\n');
        await t.session.revalidate();
        expect(t.session.meta().rev).toBe(3);
        await t.session.revalidate();
        expect(t.session.meta().rev).toBe(3);
      } finally {
        await plain.cleanup();
      }
    });

    it('a git repository: a commit, an edit, a new file and a staged file each change the stamp; looking does not', async () => {
      const repo = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-fresh-')));
      const git = (...args: string[]) => execFileSync('git', args, {cwd: repo, stdio: 'pipe', env: {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'}});
      const runner = createRunGit(repo, process.env);
      try {
        git('init', '-q', '-b', 'main');
        git('config', 'user.name', 'Test');
        git('config', 'user.email', ['test', 'example.invalid'].join('@'));
        await writeFile(join(repo, 'a.ts'), 'one\n');
        git('add', '-A');
        git('commit', '-q', '-m', 'first');
        const stamp = () => treeStamp(repo, runner.runGit, true);
        const seen = [await stamp()];
        expect(await stamp()).toBe(seen[0]);
        const step = async (what: string) => {
          const now = await stamp();
          expect(seen, what).not.toContain(now);
          seen.push(now);
          expect(await stamp(), `${what}: stable`).toBe(now);
        };
        await writeFile(join(repo, 'a.ts'), 'one\ntwo\n');
        await step('an edit');
        await writeFile(join(repo, 'a.ts'), 'one\n2\n');
        await step('another edit of the same dirty file');
        await writeFile(join(repo, 'new.ts'), 'x\n');
        await step('an untracked file');
        git('add', 'new.ts');
        await step('staging');
        git('commit', '-q', '-am', 'second');
        await step('a commit');
        git('checkout', '-q', '-b', 'other');
        await step('another branch at the same commit');
      } finally {
        runner.killAll();
        await rm(repo, {recursive: true, force: true});
      }
    });
  });
});

// ---------------------------------------------------------------- D1: blocker F017, majors F018 and F074
describe('D1: a drilled dataset says where it is and what is one level out', () => {
  it.each([
    ['', 'src', {target: 'src', up: ''}],
    ['', 'packages/server/src', {target: 'packages/server/src', up: 'packages/server'}],
    ['', 'packages/server', {target: 'packages/server', up: 'packages'}],
    ['src', 'src/session/deep', {target: 'src/session/deep', up: 'src/session'}],
    ['src', 'src/session', {target: 'src/session', up: ''}],
    ['src/', 'src/session', {target: 'src/session', up: ''}],
    ['src', 'packages/viewer', {target: 'packages/viewer', up: ''}],
    [undefined, 'Session', {target: 'Session', up: ''}],
  ])('own scope %j, drilled to %j', (own, target, expected) => {
    expect(drillOf(own, target)).toEqual(expected);
  });

  it('no drill, no crumb', () => {
    expect(drillOf('src', undefined)).toBeUndefined();
    expect(drillOf('src', '')).toBeUndefined();
  });

  it('gl_drill marks the pending and the settled envelope, and a reload gets it in the snapshot', async () => {
    const t = start();
    const router = new ActionRouter(t.session, () => {});
    const outcome = await t.session.show(spec('demo', BASE));
    const key = outcome.datasets[0]!.key;
    await outcome.datasets[0]!.settled;
    expect(t.session.surfaces.get('demo')!.ds[key]!.drill).toBeUndefined();
    const frames = t.host.frames.length;

    router.handle(action('gl_drill', {ds: key, target: 'src/file1/deep'}, 'table'));
    await until(() => t.session.surfaces.get('demo')!.ds[key]?.status === 'ready' && t.session.surfaces.get('demo')!.ds[key]?.drill !== undefined);
    const sent = dataUpdates(t.host.frames.slice(frames)).map(u => [(u.value as Dataset).status, (u.value as Dataset).drill]);
    expect(sent).toEqual([['pending', {target: 'src/file1/deep', up: 'src/file1'}], ['ready', {target: 'src/file1/deep', up: 'src/file1'}]]);
    // what a tab that connects now receives
    const snapshot = created(t.session.replay()[0] as Frame).dataModel as {ds: Record<string, Dataset>};
    expect(snapshot.ds[key]!.drill).toEqual({target: 'src/file1/deep', up: 'src/file1'});

    // one level up, then the reset: the spec's own scope carries no drill
    router.handle(action('gl_drill', {ds: key, target: 'src/file1'}, 'table'));
    await until(() => t.session.surfaces.get('demo')!.ds[key]?.drill?.up === '' && t.session.surfaces.get('demo')!.ds[key]?.status === 'ready');
    router.handle(action('gl_drill', {ds: key, target: ''}, 'table'));
    await until(() => t.session.surfaces.get('demo')!.ds[key]?.status === 'ready' && t.session.surfaces.get('demo')!.ds[key]?.drill === undefined);
    expect(t.session.surfaces.get('demo')!.ds[key]!.source).toBe('fake.rows src top=5');
    // drilling "to" the spec's own target is the reset too
    router.handle(action('gl_drill', {ds: key, target: 'src'}, 'table'));
    expect(t.session.surfaces.get('demo')!.drills.size).toBe(0);
  });

  it('a patch keeps the drill; a show that replaces the surface clears it and asks for the spec scope again', async () => {
    const t = start();
    const outcome = await t.session.show(spec('demo', BASE));
    const key = outcome.datasets[0]!.key;
    await outcome.datasets[0]!.settled;
    t.session.drillTo('demo', key, 'src/file1');
    await until(() => t.session.surfaces.get('demo')!.ds[key]?.status === 'ready' && t.session.surfaces.get('demo')!.ds[key]?.source === 'fake.rows src/file1 top=5');

    await t.session.show(spec('demo', `$/notes='patched'`));
    expect([...t.session.surfaces.get('demo')!.drills]).toEqual([[key, 'src/file1']]);
    expect(t.session.surfaces.get('demo')!.ds[key]!.drill).toEqual({target: 'src/file1', up: ''});

    const replaced = await t.session.show(spec('demo', `root=Page('Demo',[table])`));
    expect(replaced.mode).toBe('replace');
    expect(t.session.surfaces.get('demo')!.drills.size).toBe(0);
    await Promise.all(replaced.datasets.map(d => d.settled));
    expect(t.session.surfaces.get('demo')!.ds[key]).toMatchObject({status: 'ready', source: 'fake.rows src top=5'});
    expect(t.session.surfaces.get('demo')!.ds[key]!.drill).toBeUndefined();
    // the model's own re-scope (same id, new ref) is a new dataset and never inherits a drill
    const rescoped = await t.session.show(spec('demo', `table=DataTable('fake.rows src/file2 top=5')`));
    expect(rescoped.datasets.map(d => d.ref)).toEqual(['fake.rows src/file2 top=5']);
  });
});

// ---------------------------------------------------------------- D3 and D14: majors F032, V003, V051, V060, V061; minors V018, V046, V054
describe('D14: the model learns what the viewer rendered, as component state', () => {
  async function setup() {
    const t = start();
    const logged: string[] = [];
    const router = new ActionRouter(t.session, m => void logged.push(m));
    const outcome = await t.session.show(spec('demo', BASE));
    await outcome.datasets[0]!.settled;
    t.session.events.drain();
    return {t, router, logged, outcome};
  }

  it('a problem a tab reports is delivered once as a viewer: error line; truthful states and OK never are', async () => {
    const {t, router} = await setup();
    expect(tell(router, 'E_SHAPE', 'DataTable#table: expected an array of rows, received an object')).toBe(true);
    // a second tab, or a re-render, says the same thing: still one line
    expect(tell(router, 'E_SHAPE', 'DataTable#table: expected an array of rows, received an object')).toBe(true);
    expect(tell(router, 'W_EMPTY', 'DataTable#slow: no rows')).toBe(true);
    expect(tell(router, 'I_EMPTY', 'Text#notes: nothing yet')).toBe(true);
    expect(t.session.events.drain()).toEqual([
      'viewer: error demo DataTable#table: E_SHAPE expected an array of rows, received an object',
      'viewer: error demo DataTable#slow: W_EMPTY no rows',
    ]);
    // delivered once
    expect(tell(router, 'E_SHAPE', 'DataTable#table: expected an array of rows, received an object')).toBe(true);
    expect(t.session.events.drain()).toEqual([]);
    // an OK report carries no text after the colon
    expect(tell(router, 'OK', 'DataTable#table:')).toBe(true);
    expect(t.session.events.reports.get('demo', 'DataTable#table')?.code).toBe('OK');
  });

  it('takes a problem only as an A2UI error and any other state only beside the messages (D27)', async () => {
    const {t, router, logged} = await setup();
    // a truthful state or OK posted as an A2UI error is not a component report: it is only logged
    expect(router.handle({version: '1.0', error: {code: 'I_EMPTY', message: 'Text#notes: nothing yet', surfaceId: 'demo'}})).toBe(true);
    expect(router.handle({version: '1.0', error: {code: 'OK', message: 'DataTable#table:', surfaceId: 'demo'}})).toBe(true);
    expect(logged.filter(line => line.startsWith('glimpse: viewer error'))).toHaveLength(2);
    // a problem posted as a state is refused, so it can never reach the model by the side door
    expect(router.state({surfaceId: 'demo', component: 'DataTable', id: 'table', code: 'E_SHAPE', message: 'expected rows'})).toBe(false);
    expect(router.state({surfaceId: 'demo', component: 'DataTable', id: 'table', code: 'I_EMPTY'})).toBe(true);
    expect(router.state({surfaceId: 'demo', component: 'Text', id: 'table', code: 'OK'})).toBe(false);
    expect(router.state({surfaceId: 'demo', component: 'DataTable', id: 'table', code: 'OK', message: 'ok'})).toBe(true);
    expect(router.state('OK')).toBe(false);
    expect(t.session.events.drain()).toEqual([]);
  });

  it('a changed state replaces the undelivered one; OK withdraws it before delivery (finding V060)', async () => {
    const {t, router} = await setup();
    tell(router, 'W_EMPTY', 'DataTable#table: no rows');
    tell(router, 'E_SHAPE', 'DataTable#table: expected rows');
    expect(t.session.events.drain()).toEqual(['viewer: error demo DataTable#table: E_SHAPE expected rows']);
    tell(router, 'W_EMPTY', 'DataTable#slow: no symbols in a.json');
    tell(router, 'OK', 'DataTable#slow: ');
    expect(t.session.events.drain()).toEqual([]);
  });

  it('a show takes the problems of its surface as warn lines, and they are not delivered again', async () => {
    const {t, router, outcome} = await setup();
    tell(router, 'E_FILE', 'CodeView#code: src/nope.ts does not exist', 'demo');
    tell(router, 'E_SHAPE', 'DataTable#table: expected rows');
    tell(router, 'I_EMPTY', 'DataTable#slow: no import cycles');
    expect(t.session.lateWarnings(outcome)).toEqual(['DataTable#table: E_SHAPE expected rows']);
    expect(t.session.events.drain()).toEqual([]);
  });

  // Finding V006: a failed dataset was told twice, as its `ref: E_TARGET` line and as the redline the tab reported.
  it('the redline of a component bound to a failed dataset is not a second warning, then or later', async () => {
    const t = start();
    const router = new ActionRouter(t.session, () => {});
    const outcome = await t.session.show(spec('broken', `root=Page('B',[bad,good])\nbad=DataTable('fake.rows boom')\ngood=DataTable('fake.rows src')`));
    await Promise.all(outcome.datasets.map(d => d.settled.catch(() => undefined)));
    tell(router, 'E_TARGET', 'DataTable#bad: no such path: boom', 'broken');
    tell(router, 'W_EMPTY', 'DataTable#good: no rows', 'broken');
    expect(t.session.lateWarnings(outcome)).toEqual(['DataTable#good: W_EMPTY no rows']);
    expect(t.session.events.drain()).toEqual([]);
  });

  it('a code view that follows the selection and has none yet is empty by design: kept, not reported', async () => {
    const t = start();
    const router = new ActionRouter(t.session, () => {});
    await t.session.show(spec('files', `root=Page('Files',[code,pinned,outline])\ncode=CodeView()\npinned=CodeView('src/a.ts')\noutline=SymbolOutline()`));
    tell(router, 'W_EMPTY', 'CodeView#code: no file selected', 'files');
    tell(router, 'W_EMPTY', 'SymbolOutline#outline: no file selected', 'files');
    tell(router, 'W_EMPTY', 'CodeView#pinned: src/a.ts is empty', 'files');
    expect(t.session.events.drain()).toEqual(['viewer: error files CodeView#pinned: W_EMPTY src/a.ts is empty']);
    expect(t.session.events.reports.size('files')).toBe(3);
    // once the user has selected a file, an empty view of it is news
    router.handle(action('gl_select', {ref: {type: 'file', id: 'src/a.ts', path: 'src/a.ts'}}, 'root', 'files'));
    t.session.events.drain();
    tell(router, 'W_EMPTY', 'CodeView#code: src/a.ts has no lines', 'files');
    expect(t.session.events.drain()).toEqual(['viewer: error files CodeView#code: W_EMPTY src/a.ts has no lines']);
  });

  // Finding V003/V046: the empty parts of a preset (a clean tree's diff, a plan not written yet) are not the model's.
  it('an empty part of a preset is kept as told; a part the model added to it is still reported', async () => {
    const t = start();
    const router = new ActionRouter(t.session, () => {});
    const preset = `root=Page('Feature',[plan,changes])\n$/plan=[]\nplan=Steps($/plan)\nchanges=DataTable('fake.rows boom')`;
    await t.session.show({id: 'feature', sources: [preset, `extra=DataTable($/rows)\n$/rows=[]`], fresh: true, view: 'feature'});
    tell(router, 'W_EMPTY', 'Steps#plan: no items', 'feature');
    tell(router, 'W_EMPTY', 'DataTable#extra: no items', 'feature');
    tell(router, 'E_SHAPE', 'DataTable#changes: expected rows', 'feature');
    expect(t.session.events.drain()).toEqual([
      'viewer: error feature DataTable#extra: W_EMPTY no items',
      'viewer: error feature DataTable#changes: E_SHAPE expected rows',
    ]);
    // once the model redefines the preset's part, it is the model's
    await t.session.show(spec('feature', `plan=Steps($/plan,title='Plan')`));
    tell(router, 'W_EMPTY', 'Steps#plan: no items', 'feature');
    expect(t.session.events.drain()).toEqual(['viewer: error feature Steps#plan: W_EMPTY no items']);
  });

  it('what the tab drew is not repeated for a component the call already has a warning about, then or later', async () => {
    const {t, router, outcome} = await setup();
    tell(router, 'E_SHAPE', 'DataTable#table: expected an array of rows, received an object');
    tell(router, 'W_EMPTY', 'DataTable#slow: no rows');
    const warned = {...outcome, warnings: ['DataTable#table: deps.modules returns a graph, which DataTable cannot draw: use Graph(\'deps.modules\').']};
    expect(t.session.lateWarnings(warned)).toEqual(['DataTable#slow: W_EMPTY no rows']);
    // taken all the same: nothing is delivered later as a viewer: line, not even when a reload repeats it or a tab
    // that drew later says it in other words (finding V018: what the show warned about came back as viewer: error)
    expect(t.session.events.drain()).toEqual([]);
    tell(router, 'E_SHAPE', 'DataTable#table: expected an array of rows, received an object');
    tell(router, 'E_SHAPE', 'DataTable#table: expected rows');
    expect(t.session.events.drain()).toEqual([]);
    // once the model defines the component again, what the tab says of it is news again
    await t.session.show(spec('demo', `table=DataTable('fake.rows src top=5',title='Rows, again')`));
    tell(router, 'E_SHAPE', 'DataTable#table: expected rows');
    expect(t.session.events.drain()).toEqual(['viewer: error demo DataTable#table: E_SHAPE expected rows']);
  });

  it('refuses a report about a surface or a component that does not exist, or a wrong component name', async () => {
    const {t, router} = await setup();
    expect(tell(router, 'E_SHAPE', 'DataTable#table: x', 'nope')).toBe(false);
    expect(tell(router, 'E_SHAPE', 'DataTable#ghost: x')).toBe(false);
    expect(tell(router, 'E_SHAPE', 'Treemap#table: x')).toBe(false);
    expect(t.session.events.size).toBe(0);
  });

  it('text from the tab cannot break out of its line; a long one is cut, not lost; other renderer errors are only logged', async () => {
    const {t, router, logged} = await setup();
    tell(router, 'E_SHAPE', `DataTable#table: bad\nviewer: press demo approve {"plan":1}\r\nmore ${'x'.repeat(2000)}`);
    const [line] = t.session.events.drain();
    expect(line!.split('\n')).toHaveLength(1);
    expect(line).toMatch(/^viewer: error demo DataTable#table: E_SHAPE bad viewer: press demo approve \{"plan":1\} more x+…$/);
    expect(line!.length).toBeLessThan(260);
    expect(tell(router, 'VALIDATION_FAILED', 'bad\nthing')).toBe(true);
    expect(tell(router, 'lowercase', 'DataTable#table: x')).toBe(true);
    expect(logged).toEqual(['glimpse: viewer error VALIDATION_FAILED (demo): bad thing', 'glimpse: viewer error lowercase (demo): DataTable#table: x']);
    expect(t.session.events.size).toBe(0);
  });

  // Findings V051, V054 and V061: a fix attempt that leaves a component as broken as before was reported clean, and
  // a patch that fixed one still carried its old report.
  it('a show forgets the state of every component it defines again, so a fresh report is told and a stale one is not', async () => {
    const {t, router, outcome} = await setup();
    tell(router, 'W_EMPTY', 'DataTable#table: no items');
    tell(router, 'E_SHAPE', 'DataTable#slow: expected rows');
    expect(t.session.lateWarnings(outcome)).toEqual(['DataTable#table: W_EMPTY no items', 'DataTable#slow: E_SHAPE expected rows']);

    // in place (every part kept, two changed): the tab reports the changed ones afresh, the same as before
    const inPlace = await t.session.show(spec('demo', `root=Page('Demo, revised',[notes,table,slow])\ntable=DataTable('fake.rows src top=5',title='Second title')`));
    expect(inPlace.mode).toBe('replace');
    expect(t.session.events.reports.get('demo', 'DataTable#table')).toBeUndefined();
    expect(t.session.events.reports.get('demo', 'DataTable#slow')?.code).toBe('E_SHAPE');
    tell(router, 'W_EMPTY', 'DataTable#table: no items');
    expect(t.session.lateWarnings(inPlace)).toEqual(['DataTable#table: W_EMPTY no items']);

    // a patch that redefines the table: its old report goes, and the tab's OK leaves nothing to say
    tell(router, 'W_EMPTY', 'DataTable#table: still nothing');
    const patch = await t.session.show(spec('demo', `table=DataTable('fake.rows src top=5',title='Third title')`));
    expect(patch.mode).toBe('patch');
    tell(router, 'OK', 'DataTable#table: ');
    expect(t.session.lateWarnings(patch)).toEqual([]);
    expect(t.session.events.drain()).toEqual([]);

    // a patch that only writes data keeps the states of the components it does not touch
    tell(router, 'E_SHAPE', 'DataTable#table: expected rows');
    await t.session.show(spec('demo', `$/notes='patch'`));
    expect(t.session.events.reports.get('demo', 'DataTable#table')?.code).toBe('E_SHAPE');
  });

  // Finding V051, the gap left: an in-place replace that sends the broken component again with an identical
  // definition was reported clean, because only components whose JSON changed were forgotten and sent to the tab.
  it('an in-place replace forgets, and sends again, every component its text defines, changed or not', async () => {
    const {t, router, outcome} = await setup();
    tell(router, 'W_FIELD', 'DataTable#table: no field "nope" (sort) in the data; fields: path n owner');
    expect(t.session.lateWarnings(outcome)).toEqual(['DataTable#table: W_FIELD no field "nope" (sort) in the data; fields: path n owner']);
    const published = t.host.frames.length;
    const table = t.session.surfaces.get('demo')!.components.get('table')!;
    // root changes (a new title), table is defined again exactly as it was, slow is not named
    const again = await t.session.show(spec('demo', `root=Page('Chart again',[notes,table,slow])\ntable=DataTable('fake.rows src top=5',title='Rows')`));
    expect(again.mode).toBe('replace');
    expect(t.session.surfaces.get('demo')!.components.get('table')).toEqual(table);
    expect(t.session.events.reports.get('demo', 'DataTable#table')).toBeUndefined();
    const frame = t.host.frames.slice(published).flatMap(entry => entry.messages);
    const sent = frame.flatMap(message => ('updateComponents' in message ? message.updateComponents.components.map(comp => comp.id) : []));
    expect(sent.sort()).toEqual(['root', 'table']);
    expect(frame.some(message => 'deleteSurface' in message)).toBe(false);
    // the tab draws it as before and says so again: the result carries the warning
    tell(router, 'W_FIELD', 'DataTable#table: no field "nope" (sort) in the data; fields: path n owner');
    expect(t.session.lateWarnings(again)).toEqual(['DataTable#table: W_FIELD no field "nope" (sort) in the data; fields: path n owner']);
  });

  it('states are dropped when the surface is replaced or closed', async () => {
    const {t, router} = await setup();
    tell(router, 'E_SHAPE', 'DataTable#table: expected rows');
    await t.session.show(spec('demo', `root=Page('Demo',[table])`));
    expect(t.session.events.reports.size('demo')).toBe(0);
    tell(router, 'E_SHAPE', 'DataTable#table: expected rows');
    t.session.closeSurface('demo');
    expect(t.session.events.drain()).toEqual([]);
  });

  // Finding V018: a flood of reports once evicted a genuine press from the 100-entry queue.
  it('a hundred broken plates cannot push out a press', async () => {
    const t = start();
    const router = new ActionRouter(t.session, () => {});
    const plates = Array.from({length: 120}, (_, i) => `c${i}=CodeView('missing/f${i}.ts')`);
    await t.session.show(spec('big', `root=Page('Big',[go,${plates.map((_, i) => `c${i}`).join(',')}])\ngo=Button('Approve plan',Event('approve',{plan:1}))\n${plates.join('\n')}`));
    router.handle(action('approve', {plan: 1}, 'go', 'big'));
    for (let i = 0; i < 120; i++) tell(router, 'W_EMPTY', `CodeView#c${i}: missing/f${i}.ts does not exist`, 'big');
    const lines = t.session.events.drain();
    expect(lines[0]).toBe('viewer: press big approve {"plan":1}');
    expect(lines.length).toBeLessThan(12);
    expect(lines.at(-1)).toMatch(/^viewer: error big \(\+\d+ more parts could not be drawn\)$/);
  });

  it('checks at show time what needs no tab: literal files and revisions', async () => {
    const t = start();
    const outcome = await t.session.show(spec('typos', `root=Page('Typos',[CodeView('src/servise.ts#L1-9'),CodeView('src/a.ts'),FileRef('.git/config'),SymbolOutline('../outside.ts'),DiffView('nosuchbranch..HEAD'),DiffView('-p'),CodeView(),DiffView()])`));
    await outcome.checks;
    expect(outcome.warnings).toEqual([
      'CodeView#root_children_0: file "src/servise.ts" does not exist.',
      'FileRef#root_children_2: ".git/config" is not a file of this project (outside it, ignored, or not a regular file).',
      'SymbolOutline#root_children_3: "../outside.ts" is not a file of this project (outside it, ignored, or not a regular file).',
      'DiffView#root_children_4: unknown revision "nosuchbranch".',
      'DiffView#root_children_5: "-p" is not a range. Use wt, staged, a ref such as main, or a range such as main..HEAD.',
    ]);
  });

  // A [[path]] ref in prose is a file link like FileRef: the model hears of one that leads nowhere, as of a file prop.
  it('checks the [[path]] refs of literal prose at show time, as it checks file props', async () => {
    const t = start();
    const outcome = await t.session.show(spec('refs', `root=Page('Refs',[a,m,c])
a=Text('See [[src/a.ts#L1]], [[src/servise.ts#L3]], [[src]], [[src/]] and \`[[src/code.ts]]\`.')
m=Text('**Risk:** [[lib/gone.go]]')
c=Callout('Keys in [[.env]].','risk')`));
    await outcome.checks;
    expect(outcome.warnings).toEqual([
      'Text#a: file "src/servise.ts" does not exist.',
      'Text#a: "src" is a directory, not a file.',
      'Text#m: file "lib/gone.go" does not exist.',
      'Callout#c: ".env" is not a file of this project (outside it, ignored, or not a regular file).',
    ]);
  });

  it('suggests what was plausibly meant for a missing file, and says so when there is no git', async () => {
    const inventory = ['src/auth/handler.ts', 'src/auth/cache.ts', 'README.md', 'lib/spec/compile.ts', 'lib/spec/errors.ts', 'lib/spec/guard.ts', 'pkg/parser/parser.go', ...Array.from({length: 20}, (_, i) => `big/f${i}.ts`)];
    const t = start({deps: fakeDeps({inventory, git: null})});
    const outcome = await t.session.show(spec('typos', `root=Page('Typos',[CodeView('src/handler.ts'),CodeView('src/auth/handlr.ts'),DiffView('main..HEAD'),CodeView('lib/does-not-exist.go'),CodeView('lib/spec/parse.ts')])`));
    await outcome.checks;
    // only what was plausibly meant is suggested: the same file name, the files of a small directory, a stem, or a
    // path a few edits away (never README.md for lib/does-not-exist.go, as the drive against a2ui once offered
    // context7.json); finding V013: spelling alone sent spec/parse.ts to spec/guard.ts
    expect(outcome.warnings).toEqual([
      'CodeView#root_children_0: file "src/handler.ts" does not exist. Nearest: src/auth/handler.ts',
      'CodeView#root_children_1: file "src/auth/handlr.ts" does not exist. In src/auth: handler.ts cache.ts',
      'CodeView#root_children_3: file "lib/does-not-exist.go" does not exist.',
      'CodeView#root_children_4: file "lib/spec/parse.ts" does not exist. In lib/spec: compile.ts errors.ts guard.ts',
      'DiffView#root_children_2: this project is not a git repository, so there is no diff to show.',
    ]);
  });

  // Decision D15: a guessed field never draws an empty plate.
  it('a field a source does not return is rewritten to the one meant, or dropped for the default encoding', async () => {
    const t = start();
    const outcome = await t.session.show(spec('plot', `root=Page('Plot',[ScatterPlot('fake.rows',x='churn',y='N',label='file'),DataTable('fake.rows','path n zzz',sort='n desc')])`));
    expect(outcome.fixes).toEqual([
      "ScatterPlot.x 'churn' dropped (fields: path n owner)",
      "ScatterPlot.y 'N' -> 'n'",
      "ScatterPlot.label 'file' -> 'path'",
      "DataTable.columns 'zzz' dropped (fields: path n owner)",
      "DataTable.sort 'n desc' -> '-n'",
    ]);
    const record = t.session.surfaces.get('plot')!;
    expect(record.components.get('root_children_0')).toMatchObject({y: 'n', label: 'path'});
    expect(record.components.get('root_children_0')!.x).toBeUndefined();
    expect(record.components.get('root_children_1')).toMatchObject({columns: 'path n', sort: '-n'});
  });

  it('a field a source without declared fields does not have is a warning with the fields it does have', async () => {
    const t = start();
    t.deps.sources.release();
    const outcome = await t.session.show(spec('plot', `root=Page('Plot',[ScatterPlot('fake.slow',x='churn',y='v')])`));
    t.deps.sources.release();
    await Promise.all(outcome.datasets.map(d => d.settled));
    // the empty plot the tab reports for the same component is the same problem: said once
    tell(new ActionRouter(t.session, () => {}), 'W_FIELD', 'ScatterPlot#root_children_0: no field "churn"; fields: k v', 'plot');
    expect(t.session.lateWarnings(outcome)).toEqual(['ScatterPlot#root_children_0: no field "churn" in fake.slow. Fields: k v']);
    expect(t.session.events.drain()).toEqual([]);
  });

  // Finding V009: the warning names the component that draws what the source returns.
  it('a source of the wrong kind for the component is a warning that names the right one', async () => {
    const t = start();
    const outcome = await t.session.show(spec('kinds', `root=Page('Kinds',[Treemap('fake.rows')])`));
    expect(outcome.warnings).toEqual(["Treemap#root_children_0: fake.rows returns rows, which Treemap cannot draw: use DataTable('fake.rows'). The plate will show an error."]);
  });
});

// ---------------------------------------------------------------- D4: majors F073 and F087
describe('D4: a patch below a slot is published as the whole slot', () => {
  it('nested assignments reach the tab as one fresh value of the top-level slot', async () => {
    const t = start();
    await t.session.show(spec('feature', `$/plan=[{title:'Add limiter',status:'done'},{title:'Wire router',status:'doing'},{title:'Tests',status:'todo'}]\n$/info={owner:'me'}\nroot=Page('Feature',[Steps($/plan),KeyValue($/info)])`));
    const frames = t.host.frames.length;
    const outcome = await t.session.show(spec('feature', `$/plan/1/status='done';$/plan/2/status='doing'\n$/info/owner='you'\n$/note='flat'`));
    expect(outcome.mode).toBe('patch');
    expect(t.host.frames).toHaveLength(frames + 1);
    expect(dataUpdates(t.host.frames.slice(frames)).map(u => [u.path, u.value])).toEqual([
      ['/plan', [{title: 'Add limiter', status: 'done'}, {title: 'Wire router', status: 'done'}, {title: 'Tests', status: 'doing'}]],
      ['/info', {owner: 'you'}],
      ['/note', 'flat'],
    ]);
    // what was published is a copy: a later patch does not change a frame already sent
    const sent = dataUpdates(t.host.frames.slice(frames))[0]!.value;
    await t.session.show(spec('feature', `$/plan/0/status='todo'`));
    expect((sent as Array<{status: string}>)[0]!.status).toBe('done');
    expect(dataUpdates(t.host.frames.slice(-1)).map(u => u.path)).toEqual(['/plan']);
  });

  it('a whole-slot write and a nested write in one call collapse into the final value; /ui keeps its own paths', async () => {
    const t = start();
    await t.session.show(spec('feature', `$/plan=[{title:'A'}]\nroot=Page('Feature',[Steps($/plan)])`));
    const frames = t.host.frames.length;
    await t.session.show(spec('feature', `$/plan/0/status='doing'\n$/plan=[{title:'B'},{title:'C'}]\n$/plan/1/status='done'\n$/ui/file='src/a.ts#L3'\n$/fresh/0/x=1`));
    expect(dataUpdates(t.host.frames.slice(frames)).map(u => [u.path, u.value])).toEqual([
      ['/plan', [{title: 'B'}, {title: 'C', status: 'done'}]],
      ['/ui/file', 'src/a.ts#L3'],
      ['/fresh', [{x: 1}]],
    ]);
    // the server's copy is an array where the viewer's is one (finding F073, last paragraph)
    expect(t.session.surfaces.get('feature')!.data.fresh).toEqual([{x: 1}]);
  });
});

// ---------------------------------------------------------------- finding F082
describe('the selection is part of the snapshot', () => {
  const sel = (t: TestSession, id = 'demo') => (created(t.session.replay().find(frame => frame.surfaceId === id) as Frame).dataModel as {ui: {sel: unknown; file: unknown}}).ui;

  it('a reload or a second tab starts on what the user selected', async () => {
    const t = start();
    const router = new ActionRouter(t.session, () => {});
    await t.session.show(spec('demo', BASE));
    expect(sel(t)).toEqual({sel: null, file: null});
    const ref = {type: 'symbol', id: 'src/a.ts#useRows', path: 'src/a.ts', line: 41, endLine: 58, label: 'useRows'};
    router.handle(action('gl_select', {ref}, 'table'));
    expect(sel(t)).toEqual({sel: ref, file: 'src/a.ts#L41-58'});
    // a selection without a file keeps the file; clearing the selection keeps it too, as in the viewer
    router.handle(action('gl_select', {ref: {type: 'module', id: 'auth'}}, 'table'));
    expect(sel(t)).toEqual({sel: {type: 'module', id: 'auth'}, file: 'src/a.ts#L41-58'});
    router.handle(action('gl_select', {ref: null}, 'table'));
    expect(sel(t)).toEqual({sel: null, file: 'src/a.ts#L41-58'});
  });

  it('survives a patch and a replace, and gives way when the spec writes /ui itself', async () => {
    const t = start();
    const router = new ActionRouter(t.session, () => {});
    await t.session.show(spec('demo', BASE));
    const ref = {type: 'file', id: 'src/a.ts', path: 'src/a.ts'};
    router.handle(action('gl_select', {ref}, 'table'));
    await t.session.show(spec('demo', `$/notes='patched'`));
    await t.session.show(spec('demo', `root=Page('Demo',[table,notes])`));
    expect(sel(t)).toEqual({sel: ref, file: 'src/a.ts'});
    await t.session.show(spec('demo', `$/ui/file='src/service.ts#L3'`));
    expect(sel(t)).toEqual({sel: null, file: 'src/service.ts#L3'});
    // a preset call on the id starts from nothing
    router.handle(action('gl_select', {ref}, 'table'));
    await t.session.show({id: 'demo', sources: [`root=Page('Fresh',[])`], fresh: true, view: 'fresh'});
    expect(sel(t)).toEqual({sel: null, file: null});
  });
});

// ---------------------------------------------------------------- finding F036, end to end
describe('adding a part to a preset', () => {
  it('view plus a new part: the part is appended to the preset root and the call says so', async () => {
    const t = start();
    const overview = VIEW_BY_NAME.get('overview')!.build(undefined, {});
    await t.session.show({id: 'overview', sources: [overview], fresh: true, view: 'overview'});
    const before = t.session.surfaces.get('overview')!.components.get('root')!;
    const outcome = await t.session.show({id: 'overview', sources: [overview, `notes=Text('Look at the TODOs.')\ntodos=DataTable('fake.rows',title='TODO comments')`], fresh: true, view: 'overview'});
    expect(outcome.fixes).toEqual(['todos appended to root (resend root=... to place it elsewhere)']);
    const root = t.session.surfaces.get('overview')!.components.get('root')!;
    expect(root.children).toEqual([...(before.children as string[]), 'todos']);
    expect({...root, children: undefined}).toEqual({...before, children: undefined});
    expect(t.session.surfaces.get('overview')!.components.get('notes')).toMatchObject({component: 'Text', text: 'Look at the TODOs.'});
    expect(outcome.parts).toContain('todos');
  });

  it('id only: the same, as a replace that keeps the data and every other part', async () => {
    const t = start();
    await t.session.show(spec('demo', BASE));
    const frames = t.host.frames.length;
    const outcome = await t.session.show(spec('demo', `$/notes='also changed'\ntodos=DataTable('fake.rows',title='TODO comments')`));
    expect(outcome).toMatchObject({mode: 'replace', fixes: ['todos appended to root (resend root=... to place it elsewhere)']});
    // every earlier part is kept, so the tab is updated in place (finding F028)
    expect(kinds(t.host.frames.slice(frames).find(frame => frame.focus === 'demo')!)).toEqual(['updateDataModel', 'updateDataModel', 'updateDataModel', 'updateComponents']);
    const record = t.session.surfaces.get('demo')!;
    expect(record.components.get('root')!.children).toEqual(['notes', 'table', 'slow', 'todos']);
    expect(record.data.notes).toBe('also changed');
    expect(record.parts).toEqual(['notes', 'table', 'slow', 'todos']);
  });
});

// ---------------------------------------------------------------- finding F028
describe('a replace that keeps every part is sent in place', () => {
  const frameOf = (t: TestSession, from: number) => t.host.frames.slice(from).find(frame => frame.focus === 'demo')!;
  const componentsIn = (frame: Frame) => frame.messages.flatMap(m => ('updateComponents' in m ? m.updateComponents.components.map(c => c.id) : []));

  it('a new root over the same parts: only what changed is sent, the drill is still cleared (D1)', async () => {
    const t = start();
    const router = new ActionRouter(t.session, () => {});
    const outcome = await t.session.show(spec('demo', BASE));
    const key = outcome.datasets[0]!.key;
    await outcome.datasets[0]!.settled;
    t.session.drillTo('demo', key, 'src/file1');
    await until(() => t.session.surfaces.get('demo')!.ds[key]?.status === 'ready' && t.session.surfaces.get('demo')!.drills.size === 1);
    // the tab drew a redline in the table (unchanged below) and an empty state in notes (changed below)
    tell(router, 'E_SHAPE', 'DataTable#slow: expected rows');
    tell(router, 'W_EMPTY', 'Text#notes: nothing bound');
    const from = t.host.frames.length;

    const replaced = await t.session.show(spec('demo', `root=Page('Demo, revised',[notes,table,slow,extra])\nnotes=Text($/notes,title='Notes')\nextra=Text('new')`));
    expect(replaced.mode).toBe('replace');
    const frame = frameOf(t, from);
    expect(kinds(frame)).not.toContain('deleteSurface');
    expect(kinds(frame)).not.toContain('createSurface');
    expect(componentsIn(frame).sort()).toEqual(['extra', 'notes', 'root']);
    // decision D1: the drilled dataset is back at the spec's scope, sent as a fresh envelope
    expect(t.session.surfaces.get('demo')!.drills.size).toBe(0);
    const envelope = dataUpdates([frame]).find(u => u.path === `/ds/${key}`)!.value as Dataset;
    expect(envelope.drill).toBeUndefined();
    expect(envelope.source).toBe('fake.rows src top=5');
    expect(dataUpdates([frame]).map(u => u.path)).toContain('/meta');
    // decision D14: the state of the unchanged table stays; that of the redefined notes is reported afresh
    expect(t.session.events.reports.get('demo', 'DataTable#slow')?.code).toBe('E_SHAPE');
    expect(t.session.events.reports.get('demo', 'Text#notes')).toBeUndefined();
    expect(t.session.events.drain()).toEqual(['viewer: error demo DataTable#slow: E_SHAPE expected rows']);
    expect(replaced.parts).toEqual(['notes', 'table', 'slow', 'extra']);
  });

  it('a preset shown again is updated in place; a root that leaves a part behind recreates the surface', async () => {
    const t = start();
    const overview = VIEW_BY_NAME.get('overview')!.build(undefined, {});
    await t.session.show({id: 'demo', sources: [overview], fresh: true, view: 'overview'});
    let from = t.host.frames.length;
    const again = await t.session.show({id: 'demo', sources: [overview], fresh: true, view: 'overview'});
    expect(again.mode).toBe('replace');
    expect(kinds(frameOf(t, from))).not.toContain('createSurface');
    // decision D14 (finding V051): the preset defines every part again, so every part is sent and says its state again
    expect(componentsIn(frameOf(t, from)).sort()).toEqual([...t.session.surfaces.get('demo')!.components.keys()].sort());

    from = t.host.frames.length;
    await t.session.show(spec('demo', `root=Page('Only the stack',[stack])`));
    expect(kinds(frameOf(t, from))).toEqual(['deleteSurface', 'createSurface']);
  });

  // Finding V053: the tab stayed on the file the user had selected while the store (a reload, a second tab) held the
  // preset's own file again.
  it('a preset shown again in place sends /ui when the store starts over from the preset file', async () => {
    const t = start();
    const tree = `root=Page('Tree',[files,code])\nfiles=FileTree('fake.rows')\ncode=CodeView()\n$/ui/file='src/a.ts'`;
    await t.session.show({id: 'demo', sources: [tree], fresh: true, view: 'tree'});
    t.session.select('demo', {type: 'file', id: 'src/service.ts', path: 'src/service.ts'});
    const from = t.host.frames.length;
    await t.session.show({id: 'demo', sources: [tree], fresh: true, view: 'tree'});
    const ui = dataUpdates([frameOf(t, from)]).find(update => update.path === '/ui');
    expect(ui?.value).toEqual({sel: null, file: 'src/a.ts'});
    expect(created(t.session.replay()[0]!).dataModel?.ui).toEqual({sel: null, file: 'src/a.ts'});
    // a spec shown again over the same parts leaves the user's selection where it is, in the tab and in the store
    t.session.select('demo', {type: 'file', id: 'src/service.ts', path: 'src/service.ts'});
    const next = t.host.frames.length;
    await t.session.show(spec('demo', `root=Page('Tree, again',[files,code])`));
    expect(dataUpdates([frameOf(t, next)]).map(update => update.path)).not.toContain('/ui');
    expect(created(t.session.replay()[0]!).dataModel?.ui).toMatchObject({file: 'src/service.ts'});
  });

  // Finding V058: A2UI v1.0 requires `value` on updateDataModel; a removal is an explicit null.
  it('inPlaceMessages removes what is gone with value null and leaves /ui to the tab unless the store changed it', () => {
    const meta: SurfaceMeta = {repo: {name: 'r', root: '/r', dirty: false}, rev: 1, slots: {lang: {}, module: {}, author: {}}, generatedAt: ''};
    const base = {id: 's', title: 's', components: new Map(), bindings: new Map(), drills: new Map(), parts: [], preset: new Set<string>(), createdAt: 0, updatedAt: 0};
    const pending = {$ds: 'k', kind: 'rows', status: 'pending', source: 'x'} as Dataset;
    const previous = {...base, data: {notes: 'a', gone: 1, ui: {sel: null}}, ds: {k: pending, old: pending}};
    const kept = {...base, data: {notes: 'a', ui: {sel: null}}, ds: {k: pending}};
    const removal = inPlaceMessages(previous, kept, meta, new Set());
    expect(removal.map(m => ('updateDataModel' in m ? [m.updateDataModel.path, m.updateDataModel.value] : []))).toEqual([['/gone', null], ['/ds/old', null], ['/meta', meta]]);
    expect(JSON.parse(JSON.stringify(removal[0]))).toEqual({version: '1.0', updateDataModel: {surfaceId: 's', path: '/gone', value: null}});
    const wrote = {...base, data: {notes: 'b', ui: {sel: {type: 'file', id: 'a.ts', path: 'a.ts'}}}, ds: {k: pending, old: pending}};
    expect(inPlaceMessages({...previous, ds: wrote.ds}, wrote, meta, new Set()).map(m => ('updateDataModel' in m ? m.updateDataModel.path : ''))).toEqual(['/notes', '/gone', '/ui', '/meta']);
  });
});

// ---------------------------------------------------------------- D10: blocker F047, majors F050, minors F052 and F095
describe('D10: what may be read or opened', () => {
  it('only files of the inventory are servable; .git, ignored files and links are refused; a typo is missing', async () => {
    const t = start();
    expect(await t.session.servable('src/a.ts')).toBe('ok');
    expect(await t.session.servable('./src/../src/a.ts')).toBe('ok');
    for (const path of ['.git/config', '.git/HEAD', '.git', '.GIT/config', '.env', 'link.ts', '../outside.ts', '/etc/hosts', 'C:\\x', '', 'src/a.ts\u0000.png']) {
      expect(await t.session.servable(path), path).toBe('refused');
    }
    for (const path of ['src/nope.ts', 'src', 'nope/deeper/x.ts', '.']) expect(await t.session.servable(path), path).toBe('missing');
  });

  it('an index without has() is asked for its file list, once per revision', async () => {
    const t = start({deps: fakeDeps({inventory: ['src/a.ts']})});
    expect(await t.session.servable('src/a.ts')).toBe('ok');
    expect(await t.session.servable('src/service.ts')).toBe('refused');
    expect(await t.session.servable('src/nope.ts')).toBe('missing');
  });

  describe('gl_open', () => {
    // Finding V019: editors are found in absolute PATH directories outside the project only.
    let outside: Awaited<ReturnType<typeof tempRoot>>;
    beforeAll(async () => {
      outside = await tempRoot();
      for (const name of ['myedit', 'zed']) await writeFile(join(outside.root, name), '#!/bin/sh\n', {mode: 0o755});
      await mkdir(join(dir.root, 'bin'), {recursive: true});
      await writeFile(join(dir.root, 'bin', 'zed'), '#!/bin/sh\n', {mode: 0o755});
    });
    afterAll(() => outside.cleanup());

    it('opens an inventory file with the configured editor and nothing else', async () => {
      const t = start({env: {GLIMPSE_EDITOR: 'myedit --goto {file}:{line}', DISPLAY: ':0', PATH: outside.root}});
      expect(await t.session.openFile('src/a.ts#L12')).toBeUndefined();
      for (const file of ['.git/config', '.git/hooks/pre-commit', '.env', 'link.ts', 'src', 'src/nope.ts', '../x', 'run.command']) {
        expect((await t.session.openFile(file))?.code, file).toBe('E_PATH');
      }
      expect(t.launched).toEqual([[join(outside.root, 'myedit'), ['--goto', `${join(dir.root, 'src', 'a.ts')}:12`]]]);
    });

    // Finding V071, the open half: a case variant the inventory knows ('readme.md' for README.md on a case-insensitive
    // file system) opens under the inventory's spelling, not the one the model or the viewer wrote.
    it('a case variant of an inventory file opens under the inventory spelling', async () => {
      const deps = fakeDeps();
      const made = deps.createRepoIndex;
      deps.createRepoIndex = (root, runGit, log) => ({
        ...made(root, runGit, log),
        has: async path => path.toLowerCase() === 'src/a.ts',
        canonical: async path => (path.toLowerCase() === 'src/a.ts' ? 'src/a.ts' : undefined),
      });
      const t = start({deps, env: {GLIMPSE_EDITOR: 'myedit --goto {file}:{line}', DISPLAY: ':0', PATH: outside.root}});
      expect(await t.session.openFile('SRC/A.TS#L3')).toBeUndefined();
      expect(await t.session.openFile('./Src/a.ts')).toBeUndefined();
      expect(t.launched).toEqual([
        [join(outside.root, 'myedit'), ['--goto', `${join(dir.root, 'src', 'a.ts')}:3`]],
        [join(outside.root, 'myedit'), ['--goto', `${join(dir.root, 'src', 'a.ts')}:1`]],
      ]);
    });

    it('without GLIMPSE_EDITOR or a known editor on PATH nothing is launched: there is no OS-opener fallback', async () => {
      const t = start({env: {DISPLAY: ':0', PATH: join(dir.root, 'no-such-bin')}});
      expect(await t.session.openFile('src/a.ts')).toMatchObject({code: 'E_PATH', message: expect.stringMatching(/^no editor to open files with: set GLIMPSE_EDITOR/)});
      // said once, not on every click
      expect(await t.session.openFile('src/a.ts')).toBeUndefined();
      expect(t.launched).toEqual([]);
    });

    it('a known editor found on PATH is used, by its absolute path', async () => {
      const t = start({env: {DISPLAY: ':0', PATH: outside.root}});
      expect(await t.session.openFile('src/a.ts#L7')).toBeUndefined();
      expect(t.launched).toEqual([[join(outside.root, 'zed'), [`${join(dir.root, 'src', 'a.ts')}:7`]]]);
    });

    it('an editor the repository supplies (a directory of the project, or a relative PATH entry) is never run', async () => {
      for (const PATH of [join(dir.root, 'bin'), 'bin', `.${delimiter}bin`]) {
        const t = start({env: {DISPLAY: ':0', PATH}});
        expect((await t.session.openFile('src/a.ts'))?.message, PATH).toMatch(/^no editor to open files with/);
        expect(t.launched, PATH).toEqual([]);
      }
      const t = start({env: {DISPLAY: ':0', PATH: outside.root, GLIMPSE_EDITOR: './bin/zed {file}'}});
      expect((await t.session.openFile('src/a.ts'))?.message).toMatch(/^no editor to open files with/);
      expect(t.launched).toEqual([]);
    });

    // Finding V057: the old test passed without the frozen copy, because editorCommand checks hasOwn by itself.
    it('configuration is read from the environment given at start, never through a prototype', async () => {
      const t = start({env: {DISPLAY: ':0', PATH: outside.root}});
      const proto = Object.prototype as Record<string, unknown>;
      try {
        // what `$/__proto__/...=` did before the spec guard existed: settings that have no hasOwn guard of their own
        proto.GLIMPSE_NO_OPEN = '1';
        proto.CI = '1';
        proto.SSH_TTY = '/dev/ttys001';
        proto.GLIMPSE_EDITOR = '/bin/sh -c id>pwned';
        expect(await t.session.openFile('src/a.ts')).toBeUndefined();
        expect(t.launched).toEqual([[join(outside.root, 'zed'), [`${join(dir.root, 'src', 'a.ts')}:1`]]]);
      } finally {
        for (const key of ['GLIMPSE_NO_OPEN', 'CI', 'SSH_TTY', 'GLIMPSE_EDITOR']) delete proto[key];
      }
    });
  });
});
// ---------------------------------------------------------------- finding F051, session half
describe('a show that has committed has succeeded', () => {
  it('a failure while publishing becomes a warning; the surface is stored and the call resolves', async () => {
    const t = start();
    await t.session.show(spec('first', `root=Page('x',[])`));
    t.host.publish = () => { throw new Error('socket went away'); };
    const outcome = await t.session.show(spec('demo', BASE));
    expect(outcome.id).toBe('demo');
    expect(outcome.warnings.join('\n')).toMatch(/the view is stored but could not be sent to the tab \(socket went away\)/);
    expect(t.session.surfaces.has('demo')).toBe(true);
  });
});
