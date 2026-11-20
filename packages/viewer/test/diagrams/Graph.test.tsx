import {fireEvent, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {MAX_EDGES, MAX_NODES, NAME_KEEP, distinctLabels, fitLabel, fitSub, nameZoom} from '../../src/components/diagrams/Graph.tsx';
import {LOD_ZOOM, MONO_11, POSITIONS_KEY, READABLE_ZOOM, UI_12, configurePositionStorage, textWidth} from '../../src/components/diagrams/edgekit/index.ts';
import {buildPatch, buildSurface, datasetFixture, errorDataset, renderExpress, renderSpec} from '../harness.tsx';
import {
  bigGraph, click, drag, edgeOf, fakeStorage, focus, inside, key, layeredGraph, lineOf, nodeIds, nodeOf, onOutline, onStage, pointsOf, positionOf, sizeOf, stageOf,
  touch, viewOf, type FakeStorage,
} from './util.tsx';

const SPEC = `root=Page('T',[g])\ng=Graph(title='Deps',size='l')`;
const INLINE = `root=Page('T',[g])\ng=Graph($/g,title='Deps',size='l')`;
const ready = async (spec = SPEC, options: Parameters<typeof renderExpress>[1] = {}) => {
  const view = renderExpress(spec, {datasets: 'ready', ...options});
  await screen.findAllByRole('img', {name: /^Graph/});
  return view;
};

let storage: FakeStorage;
beforeEach(() => {
  storage = fakeStorage();
  configurePositionStorage(storage);
});
afterEach(() => configurePositionStorage(undefined));

describe('Graph: states', () => {
  it('draws the fixture graph: nodes with spines, weighted edges, a group, cycle marks', async () => {
    const view = await ready();
    const cell = view.cell('g');
    expect(nodeIds(view, 'g').sort()).toEqual(['api', 'auth', 'ext:pg', 'ext:redis', 'ui']);
    expect(within(cell).getByText('2 files, 1.3k loc')).toBeTruthy();
    // category spine from /meta/slots.module: api is slot 2, an external package has none
    expect(nodeOf(view, 'g', 'api').querySelector('rect[style]')!.getAttribute('style')).toContain('--gl-cat-2');
    expect(nodeOf(view, 'g', 'ext:pg').querySelector('rect[style]')!.getAttribute('style')).toContain('--gl-cat-other');
    expect(inside(nodeOf(view, 'g', 'api')).getByText('CYCLE')).toBeTruthy();
    expect(inside(nodeOf(view, 'g', 'ui')).queryByText('CYCLE')).toBeNull();

    expect(cell.querySelectorAll('[data-edge]')).toHaveLength(6);
    const cycle = edgeOf(view, 'g', 'api->auth');
    expect(cycle.hasAttribute('data-cycle')).toBe(true);
    expect(edgeOf(view, 'g', 'ui->auth').hasAttribute('data-dashed')).toBe(true);
    // weight 9 of max 9 is the heaviest class, weight 1 the lightest
    expect(cycle.querySelectorAll('path')[1]!.getAttribute('stroke-width')).toBe('2.25');
    expect(edgeOf(view, 'g', 'ui->auth').querySelectorAll('path')[1]!.getAttribute('stroke-width')).toBe('1');
    // every edge ends in an arrowhead and is drawn with 6 px elbows
    for (const edge of cell.querySelectorAll('[data-edge]')) expect(edge.querySelectorAll('path')).toHaveLength(3);
    expect(lineOf(edgeOf(view, 'g', 'ui->auth'))).toMatch(/Q/);
    // two nodes that are almost level are joined by one straight line
    expect(lineOf(edgeOf(view, 'g', 'ui->api'))).toMatch(/^M[\d.]+ ([\d.]+)L[\d.]+ \1$/);

    expect(cell.querySelector('[data-group="srv"]')!.textContent).toBe('server');
    // decision D16: the external packages are not counted as modules (the Modules KPI does not count them either)
    expect(cell.querySelector('[data-gl-note]')!.textContent).toBe('3 modules · 2 packages · 6 edges · 2 modules in cycles');
    expect(stageOf(view, 'g').getAttribute('aria-label')).toBe('Graph, 3 modules, 2 packages, 6 edges, 2 modules in cycles, most connected auth');
    expect(view.errors).toEqual([]);
  });

  it('shows the drafting frame while the dataset is pending, then draws it when it arrives', async () => {
    const view = renderExpress(SPEC);
    await waitFor(() => expect(view.cell('g').querySelector('[data-gl-state="drafting"]')!.textContent).toContain('deps.modules'));
    expect(view.cell('g').querySelector('[data-node]')).toBeNull();
    view.setData('/ds/deps_modules', datasetFixture('deps.modules'));
    await waitFor(() => expect(nodeIds(view, 'g')).toHaveLength(5));
    expect(view.cell('g').querySelector('[data-gl-state]')).toBeNull();
  });

  it('shows the empty state for no data and for a graph without nodes', async () => {
    const view = renderExpress(INLINE);
    await waitFor(() => expect(view.cell('g').querySelector('[data-gl-state="empty"]')).not.toBeNull());
    view.setData('/g', {nodes: [], edges: []});
    await waitFor(() => expect(view.cell('g').querySelector('[data-gl-state="empty"]')!.textContent).toBe('no nodes to draw'));
    view.setData('/ds/x', null);
    expect(view.cell('g').querySelector('[data-node]')).toBeNull();
  });

  it('shows a redline for a failed dataset', async () => {
    const view = renderExpress(SPEC, {data: {'/ds/deps_modules': errorDataset('deps.modules', 'E_NO_GIT', 'not a git repository')}});
    await waitFor(() => expect(view.cell('g').querySelector('[data-code="E_NO_GIT"]')!.textContent).toContain('not a git repository'));
  });

  it.each([
    ['a string', 'hello', /expected \{nodes, edges\}, received a string/],
    ['an array', [1, 2], /received an array/],
    ['nodes that are not an array', {nodes: 'api', edges: []}, /expected nodes to be an array, received a string/],
    ['edges that are not an array', {nodes: [{id: 'a'}], edges: 7}, /expected edges to be an array, received a number/],
  ])('shows an E_SHAPE redline for %s', async (_name, data, message) => {
    const view = renderExpress(INLINE, {data: {'/g': data}});
    await waitFor(() => expect(view.cell('g').querySelector('[data-code="E_SHAPE"]')!.textContent).toMatch(message));
    expect(view.cell('g').querySelector('[data-code="E_SHAPE"]')!.textContent).toContain('Graph#g');
  });

  it('drops duplicate ids, nodes without an id and dangling edges, and counts them in the plate header', async () => {
    const data = {
      nodes: [{id: 'a', label: 'A'}, {id: 'a', label: 'again'}, {label: 'no id'}, null, {id: 7}, {id: 'b', fanIn: '3', fanOut: 'many'}],
      edges: [{from: 'a', to: 'b', weight: '4'}, {from: 'a', to: 'b'}, {from: 'a', to: 'ghost'}, {from: 7, to: 'b'}, 'nonsense', {to: 'a'}],
    };
    const view = await ready(INLINE, {data: {'/g': data}});
    expect(nodeIds(view, 'g')).toEqual(['a', '7', 'b']);
    expect([...view.cell('g').querySelectorAll('[data-edge]')].map(e => e.getAttribute('data-edge')).sort()).toEqual(['7->b', 'a->b']);
    const note = view.cell('g').querySelector('[data-gl-note]')!.textContent;
    expect(note).toContain('3 nodes · 2 edges');
    expect(note).toContain('3 dangling edges dropped');
    expect(note).toContain('2 duplicates dropped');
    expect(note).toContain('2 nodes without id dropped');
    // a node without a label is named by its id; a numeric string is a number
    expect(inside(nodeOf(view, 'g', '7')).getByText('7')).toBeTruthy();
  });

  it('cuts 500-character labels to the node and keeps the full text for assistive technology', async () => {
    const long = 'x'.repeat(500);
    const view = await ready(INLINE, {data: {'/g': {nodes: [{id: 'a', label: long, sub: long}, {id: 'b', label: 'B'}], edges: [{from: 'a', to: 'b', label: long}]}}});
    const texts = [...nodeOf(view, 'g', 'a').querySelectorAll('text')].map(t => t.textContent!);
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(text.length).toBeLessThan(40);
      expect(text.endsWith('…')).toBe(true);
    }
    expect(view.cell('g').querySelector('[data-edge-label]')!.textContent!.length).toBeLessThan(40);
    focus(stageOf(view, 'g'));
    key(stageOf(view, 'g'), 'Home');
    expect(view.cell('g').querySelector('[aria-live]')!.textContent).toContain(long);
  });

  it('draws one node, and nodes with a diff status', async () => {
    const view = await ready(INLINE, {data: {'/g': {nodes: [{id: 'only', label: 'only', status: 'modified', kind: 'file'}], edges: []}}});
    expect(nodeIds(view, 'g')).toEqual(['only']);
    const node = nodeOf(view, 'g', 'only');
    expect(inside(node).getByText('~')).toBeTruthy();
    expect(node.querySelector('rect[style]')!.getAttribute('style')).toContain('--gl-serious');
    expect(stageOf(view, 'g').getAttribute('aria-label')).toBe('Graph, 1 node, 0 edges');
  });

  it('asks for a scope above 150 nodes instead of drawing', async () => {
    const view = renderExpress(INLINE, {data: {'/g': bigGraph(MAX_NODES + 1, 10)}});
    await waitFor(() => expect(view.cell('g').querySelector('[data-code="E_TOO_LARGE"]')!.textContent).toMatch(/151 nodes .* focus=/));
    expect(view.cell('g').querySelector('[data-node]')).toBeNull();
  });

  it('lays a 150-node, 400-edge graph out after the drafting frame is on screen', async () => {
    const view = renderExpress(INLINE, {data: {'/g': bigGraph(150, 400)}});
    // First the frame, with nothing laid out yet: the layout is not part of the render that shows it.
    await screen.findByText('laying out 150 nodes');
    expect(view.cell('g').querySelector('[data-node]')).toBeNull();
    expect(view.cell('g').querySelector('[data-gl-state="drafting"]')).not.toBeNull();
    await waitFor(() => expect(nodeIds(view, 'g')).toHaveLength(150), {timeout: 20_000});
    expect(view.cell('g').querySelectorAll('[data-edge]')).toHaveLength(400);
    expect(view.cell('g').querySelector('[data-gl-state]')).toBeNull();
    expect(view.errors).toEqual([]);
  }, 30_000);
});

describe('Graph: bindings', () => {
  it('keeps the heaviest edges of a graph that has too many, and lays a dense graph out off the render path', async () => {
    const dense = bigGraph(40, MAX_EDGES + 50);
    const view = renderExpress(INLINE, {data: {'/g': dense}});
    await screen.findByText('laying out 40 nodes');
    await waitFor(() => expect(nodeIds(view, 'g')).toHaveLength(40), {timeout: 20_000});
    expect(view.cell('g').querySelectorAll('[data-edge]')).toHaveLength(MAX_EDGES);
    expect(view.cell('g').querySelector('[data-gl-note]')!.textContent).toContain('50 light edges hidden');
  }, 30_000);


  it('follows a dataset update and a patched prop', async () => {
    const base = buildSurface('test', INLINE, {datasets: 'ready', data: {g: {nodes: [{id: 'a', label: 'A'}, {id: 'b', label: 'B'}], edges: [{from: 'a', to: 'b'}]}}});
    const view = renderSpec(base);
    await waitFor(() => expect(nodeIds(view, 'g')).toEqual(['a', 'b']));
    view.setData('/g', {nodes: [{id: 'a', label: 'A'}, {id: 'b', label: 'B'}, {id: 'c', label: 'C'}], edges: [{from: 'a', to: 'b'}, {from: 'b', to: 'c'}]});
    await waitFor(() => expect(nodeIds(view, 'g')).toEqual(['a', 'b', 'c']));
    expect(positionOf(nodeOf(view, 'g', 'a')).x).toBeLessThan(positionOf(nodeOf(view, 'g', 'c')).x);

    view.send(buildPatch('test', base, `g=Graph($/g,dir='TB',title='Deps',size='l')`));
    await waitFor(() => expect(positionOf(nodeOf(view, 'g', 'a')).y).toBeLessThan(positionOf(nodeOf(view, 'g', 'c')).y));
    expect(view.errors).toEqual([]);
  });

  it('shows the neighbourhood of the focus, as deep as depth says', async () => {
    const chain = {nodes: ['a', 'b', 'c', 'd', 'e'].map(id => ({id, label: id})), edges: [{from: 'a', to: 'b'}, {from: 'b', to: 'c'}, {from: 'c', to: 'd'}, {from: 'd', to: 'e'}]};
    const view = await ready(`root=Page('T',[g])\ng=Graph($/g,focus=$/f,depth=1,title='Deps',size='l')`, {data: {'/g': chain, '/f': 'c'}});
    expect(nodeIds(view, 'g').sort()).toEqual(['b', 'c', 'd']);
    expect(nodeOf(view, 'g', 'c').hasAttribute('data-focus')).toBe(true);
    expect(nodeOf(view, 'g', 'b').hasAttribute('data-focus')).toBe(false);
    expect(view.cell('g').querySelector('[data-gl-note]')!.textContent).toContain('focus c · 1 hop');
    expect(stageOf(view, 'g').getAttribute('aria-label')).toContain('focused on c');

    // the focus is bindable: moving it redraws the neighbourhood
    view.setData('/f', 'a');
    await waitFor(() => expect(nodeIds(view, 'g').sort()).toEqual(['a', 'b']));
    // a focus that is not in the data shows everything and says so
    view.setData('/f', 'zzz');
    await waitFor(() => expect(nodeIds(view, 'g')).toHaveLength(5));
    expect(view.cell('g').querySelector('[data-gl-note]')!.textContent).toContain('focus "zzz" not found');
  });

  it('widens the neighbourhood with depth', async () => {
    const chain = {nodes: ['a', 'b', 'c', 'd', 'e'].map(id => ({id, label: id})), edges: [{from: 'a', to: 'b'}, {from: 'b', to: 'c'}, {from: 'c', to: 'd'}, {from: 'd', to: 'e'}]};
    const view = await ready(`root=Page('T',[g])\ng=Graph($/g,focus='a',depth=3,title='Deps',size='l')`, {data: {'/g': chain}});
    expect(nodeIds(view, 'g').sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(view.cell('g').querySelector('[data-gl-note]')!.textContent).toContain('focus a · 3 hops');
  });
});

describe('Graph: selection and keyboard', () => {
  it('selects on click: one vermilion node, its edges lit, everything unrelated dimmed', async () => {
    const view = await ready();
    click(nodeOf(view, 'g', 'ui'));
    expect(view.getData('/ui/sel')).toEqual({type: 'module', id: 'ui', label: 'ui'});
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_select', sourceComponentId: 'g', context: {ref: {type: 'module', id: 'ui'}}});
    expect(nodeOf(view, 'g', 'ui').hasAttribute('data-selected')).toBe(true);
    expect(view.cell('g').querySelectorAll('[data-node][data-selected]')).toHaveLength(1);
    // ui imports api and auth: those stay at full strength, the externals drop back
    for (const id of ['api', 'auth']) expect(nodeOf(view, 'g', id).hasAttribute('data-dim')).toBe(false);
    for (const id of ['ext:redis', 'ext:pg']) expect(nodeOf(view, 'g', id).hasAttribute('data-dim')).toBe(true);
    expect(edgeOf(view, 'g', 'ui->api').hasAttribute('data-hot')).toBe(true);
    expect(edgeOf(view, 'g', 'ui->api').querySelectorAll('path')[1]!.getAttribute('stroke-width')).toBe('1.5');
    expect(edgeOf(view, 'g', 'api->auth').hasAttribute('data-hot')).toBe(false);
    expect(edgeOf(view, 'g', 'api->auth').hasAttribute('data-dim')).toBe(true);
    // highlighted edges are painted last
    const order = [...view.cell('g').querySelectorAll('[data-edge]')].map(e => e.hasAttribute('data-hot'));
    expect(order.lastIndexOf(false)).toBeLessThan(order.indexOf(true));

    // a module with a representative file also moves the followed file
    click(nodeOf(view, 'g', 'api'));
    expect(view.getData('/ui/sel')).toEqual({type: 'module', id: 'api', path: 'src/api/routes.ts', label: 'api'});
    expect(view.getData('/ui/file')).toBe('src/api/routes.ts');
    expect(view.cell('g').querySelectorAll('[data-node][data-selected]')).toHaveLength(1);
  });

  it('follows a selection made elsewhere and clears with Escape', async () => {
    const view = await ready();
    expect(view.cell('g').querySelector('[data-dim]')).toBeNull();
    view.setData('/ui/sel', {type: 'module', id: 'auth'});
    expect(nodeOf(view, 'g', 'auth').hasAttribute('data-selected')).toBe(true);
    expect(nodeOf(view, 'g', 'ui').hasAttribute('data-dim')).toBe(false);
    // a selection the graph does not contain dims nothing
    view.setData('/ui/sel', {type: 'file', id: 'README.md', path: 'README.md'});
    expect(view.cell('g').querySelector('[data-dim], [data-selected]')).toBeNull();

    view.setData('/ui/sel', {type: 'module', id: 'auth'});
    focus(stageOf(view, 'g'));
    key(stageOf(view, 'g'), 'Escape');
    expect(view.getData('/ui/sel') ?? null).toBeNull();
    expect(view.cell('g').querySelector('[data-dim], [data-selected]')).toBeNull();
  });

  it('highlights file nodes inside a selected directory', async () => {
    const files = {level: 'file', nodes: [{id: 'src/a.ts', label: 'a.ts', kind: 'file'}, {id: 'src/lib/b.ts', label: 'b.ts', kind: 'file'}, {id: 'test/c.ts', label: 'c.ts', kind: 'file'}], edges: [{from: 'src/a.ts', to: 'src/lib/b.ts'}]};
    const view = await ready(INLINE, {data: {'/g': files}, ui: {sel: {type: 'dir', id: 'src', path: 'src'}}});
    expect([...view.cell('g').querySelectorAll('[data-node][data-selected]')].map(n => n.getAttribute('data-node'))).toEqual(['src/a.ts', 'src/lib/b.ts']);
    expect(nodeOf(view, 'g', 'test/c.ts').hasAttribute('data-dim')).toBe(true);
    click(nodeOf(view, 'g', 'test/c.ts'));
    expect(view.getData('/ui/sel')).toEqual({type: 'file', id: 'test/c.ts', path: 'test/c.ts', label: 'c.ts'});
    expect(view.getData('/ui/file')).toBe('test/c.ts');
  });

  it('is one tab stop: arrows walk to the nearest node, Enter selects, o opens, c copies', async () => {
    const view = await ready();
    const stage = stageOf(view, 'g');
    expect(view.cell('g').querySelectorAll('[tabindex="0"]:not(header)')).toHaveLength(1);
    focus(stage);
    const active = () => view.cell('g').querySelector('[data-node][data-active]')?.getAttribute('data-node');
    expect(active()).toBeUndefined();
    key(stage, 'ArrowRight');
    expect(active()).toBe('ui');
    expect(view.getData('/ui/sel')).toBeNull();
    key(stage, 'ArrowRight');
    expect(active()).toBe('api');
    expect(view.cell('g').querySelector('[aria-live]')!.textContent).toBe('api, 2 files, 1.3k loc · in a cycle · 2 in · 1 out');
    key(stage, 'ArrowRight');
    expect(active()).toBe('auth');
    key(stage, 'ArrowLeft');
    expect(active()).toBe('api');
    key(stage, 'End');
    expect(['ext:redis', 'ext:pg']).toContain(active());
    key(stage, 'Home');
    expect(active()).toBe('ui');
    key(stage, 'ArrowRight');

    key(stage, 'Enter');
    expect(view.getData('/ui/sel')).toMatchObject({type: 'module', id: 'api'});
    key(stage, 'o');
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_open', context: {file: 'src/api/routes.ts'}});
    key(stage, 'c');
    expect(view.clipboard).toEqual(['src/api/routes.ts']);
    // keys the stage does not use are left for the page
    expect(key(stage, 'd')).toBe(true);
    expect(key(stage, 'ArrowRight')).toBe(false);
  });

  it('opens the file on Cmd/Ctrl-click instead of selecting', async () => {
    const view = await ready();
    click(nodeOf(view, 'g', 'auth'), {metaKey: true});
    expect(view.actions.map(a => a.name)).toEqual(['gl_open']);
    expect(view.actions[0]!.context).toEqual({file: 'src/auth/service.ts'});
    expect(view.getData('/ui/sel')).toBeNull();
  });

  it('drills into a cluster on double-click and on Shift+Enter', async () => {
    const view = await ready();
    click(nodeOf(view, 'g', 'api'));
    click(nodeOf(view, 'g', 'api'));
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', context: {ds: 'deps_modules', target: 'api'}});
    // an external package is not a cluster: two clicks are two selections
    const before = view.actions.length;
    click(nodeOf(view, 'g', 'ext:pg'));
    click(nodeOf(view, 'g', 'ext:pg'));
    expect(view.actions.slice(before).map(a => a.name)).toEqual(['gl_select', 'gl_select']);

    const stage = stageOf(view, 'g');
    focus(stage);
    key(stage, 'Home');
    key(stage, 'Enter', {shiftKey: true});
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', context: {ds: 'deps_modules', target: 'ui'}});
  });
});

describe('Graph: pan and zoom', () => {
  it('fits the graph, then zooms with the keyboard, the controls and Ctrl+wheel', async () => {
    const view = await ready();
    const stage = stageOf(view, 'g');
    const fitted = viewOf(stage);
    expect(fitted.k).toBe(1);
    const zoomText = () => view.cell('g').querySelector('button[aria-label="Zoom out"]')!.previousElementSibling!.textContent;
    expect(zoomText()).toBe('100%');

    focus(stage);
    key(stage, '+');
    expect(viewOf(stage).k).toBeCloseTo(1.25);
    expect(zoomText()).toBe('125%');
    key(stage, '-');
    expect(viewOf(stage).k).toBeCloseTo(1);
    fireEvent.click(within(view.cell('g')).getByRole('button', {name: 'Zoom in'}));
    expect(viewOf(stage).k).toBeCloseTo(1.25);
    fireEvent.click(within(view.cell('g')).getByRole('button', {name: 'Zoom out'}));
    fireEvent.click(within(view.cell('g')).getByRole('button', {name: 'Zoom out'}));
    expect(viewOf(stage).k).toBeCloseTo(0.8);
    key(stage, '0');
    expect(viewOf(stage)).toEqual(fitted);

    // a plain wheel belongs to the page; Ctrl+wheel zooms around the pointer
    expect(fireEvent.wheel(stage, {deltaY: -200, clientX: 300, clientY: 200})).toBe(true);
    expect(viewOf(stage)).toEqual(fitted);
    expect(fireEvent.wheel(stage, {deltaY: -200, clientX: 300, clientY: 200, ctrlKey: true})).toBe(false);
    const zoomed = viewOf(stage);
    expect(zoomed.k).toBeGreaterThan(1);
    // the point under the pointer stays where it is
    expect((300 - zoomed.x) / zoomed.k).toBeCloseTo((300 - fitted.x) / fitted.k);
    expect((200 - zoomed.y) / zoomed.k).toBeCloseTo((200 - fitted.y) / fitted.k);
    for (let i = 0; i < 40; i++) fireEvent.wheel(stage, {deltaY: 500, ctrlKey: true});
    expect(viewOf(stage).k).toBeCloseTo(0.2);
    fireEvent.click(within(view.cell('g')).getByRole('button', {name: 'Fit to view'}));
    expect(viewOf(stage)).toEqual(fitted);
    fireEvent.click(within(view.cell('g')).getByRole('button', {name: 'Zoom in'}));
    fireEvent.click(within(view.cell('g')).getByRole('button', {name: 'Actual size'}));
    expect(viewOf(stage).k).toBe(1);
  });

  it('pans by dragging the background and with Shift+arrows, without selecting or moving nodes', async () => {
    const view = await ready();
    const stage = stageOf(view, 'g');
    const before = viewOf(stage);
    const node = positionOf(nodeOf(view, 'g', 'ui'));
    drag(stage, stage, 60, -30);
    expect(viewOf(stage)).toEqual({k: before.k, x: before.x + 60, y: before.y - 30});
    expect(positionOf(nodeOf(view, 'g', 'ui'))).toEqual(node);
    focus(stage);
    key(stage, 'ArrowRight', {shiftKey: true});
    expect(viewOf(stage).x).toBe(before.x + 60 - 48);
    expect(view.getData('/ui/sel')).toBeNull();
    expect(storage.items.size).toBe(0);
    expect(within(view.cell('g')).queryByRole('button', {name: /Re-layout/})).toBeNull();
  });

  it('scales a wide graph down to the cell and sizes an unsized graph to its content', async () => {
    const chain = {nodes: Array.from({length: 8}, (_, i) => ({id: `n${i}`, label: `n${i}`})), edges: Array.from({length: 7}, (_, i) => ({from: `n${i}`, to: `n${i + 1}`}))};
    const view = await ready(`root=Page('T',[g])\ng=Graph($/g,title='Deps')`, {data: {'/g': chain}});
    const stage = stageOf(view, 'g');
    expect(viewOf(stage).k).toBeLessThan(1);
    expect(viewOf(stage).k).toBeGreaterThan(0.4);
    // no size: as tall as the content needs, within the family limits
    const height = Number.parseFloat((stage.parentElement as HTMLElement).style.height);
    expect(height).toBeGreaterThanOrEqual(120);
    expect(height).toBeLessThanOrEqual(420);
  });
});

describe('Graph: arranging nodes', () => {
  const stored = () => JSON.parse(storage.items.get(POSITIONS_KEY) ?? '{}') as Record<string, Record<string, {x: number; y: number}>>;

  it('drags a node, re-routes its edges, leaves the rest alone and remembers the position', async () => {
    const view = await ready();
    const stage = stageOf(view, 'g');
    const before = positionOf(nodeOf(view, 'g', 'ui'));
    const others = ['api', 'auth', 'ext:redis', 'ext:pg'].map(id => positionOf(nodeOf(view, 'g', id)));
    const edgeBefore = lineOf(edgeOf(view, 'g', 'ui->auth'));
    const untouched = lineOf(edgeOf(view, 'g', 'auth->ext:redis'));
    const {w, h} = sizeOf(nodeOf(view, 'g', 'ui'));
    expect(h).toBe(40);
    expect(pointsOf(edgeBefore)[0]).toEqual([before.x + w, before.y + 20]);

    // while the pointer is down the node and its edges follow it; nothing is stored yet
    fireEvent.pointerDown(nodeOf(view, 'g', 'ui'), {button: 0, pointerId: 1, clientX: 100, clientY: 100});
    fireEvent.pointerMove(stage, {pointerId: 1, buttons: 1, clientX: 80, clientY: 180});
    expect(positionOf(nodeOf(view, 'g', 'ui'))).toEqual({x: before.x - 20, y: before.y + 80});
    // the edge leaves the node where it is now (through whichever side keeps it clear of the other nodes)
    expect(onOutline(pointsOf(lineOf(edgeOf(view, 'g', 'ui->auth')))[0], nodeOf(view, 'g', 'ui'))).toBe(true);
    expect(storage.items.size).toBe(0);
    fireEvent.pointerMove(stage, {pointerId: 1, buttons: 1, clientX: 60, clientY: 220});
    fireEvent.pointerUp(stage, {pointerId: 1, clientX: 60, clientY: 220});

    const after = positionOf(nodeOf(view, 'g', 'ui'));
    expect(after).toEqual({x: before.x - 40, y: before.y + 120});
    const edgeAfter = lineOf(edgeOf(view, 'g', 'ui->auth'));
    expect(edgeAfter).not.toBe(edgeBefore);
    expect(onOutline(pointsOf(edgeAfter)[0], nodeOf(view, 'g', 'ui'))).toBe(true);
    // the far end still meets auth, which did not move
    expect(onOutline(pointsOf(edgeAfter).at(-1), nodeOf(view, 'g', 'auth'))).toBe(true);
    expect(lineOf(edgeOf(view, 'g', 'auth->ext:redis'))).toBe(untouched);
    expect(['api', 'auth', 'ext:redis', 'ext:pg'].map(id => positionOf(nodeOf(view, 'g', id)))).toEqual(others);

    expect(stored()).toEqual({'demo/test/g': {ui: {x: after.x + w / 2, y: after.y + 20}}});
    // a drag is not a click
    expect(view.getData('/ui/sel')).toBeNull();
    expect(view.actions).toEqual([]);
  });

  it('offers Re-layout only while positions are overridden, and it restores the automatic layout', async () => {
    const view = await ready();
    const stage = stageOf(view, 'g');
    const before = positionOf(nodeOf(view, 'g', 'auth'));
    const edgeBefore = lineOf(edgeOf(view, 'g', 'api->auth'));
    expect(within(view.cell('g')).queryByRole('button', {name: /Re-layout/})).toBeNull();

    drag(stage, nodeOf(view, 'g', 'auth'), 30, 150);
    expect(positionOf(nodeOf(view, 'g', 'auth'))).toEqual({x: before.x + 30, y: before.y + 150});
    const button = within(view.cell('g')).getByRole('button', {name: /Re-layout/});
    // the control sits in the plate header
    expect(button.closest('.gl-frame-head')).not.toBeNull();

    fireEvent.click(button);
    expect(positionOf(nodeOf(view, 'g', 'auth'))).toEqual(before);
    expect(lineOf(edgeOf(view, 'g', 'api->auth'))).toBe(edgeBefore);
    expect(stored()).toEqual({});
    expect(within(view.cell('g')).queryByRole('button', {name: /Re-layout/})).toBeNull();
  });

  it('applies stored positions on top of the layout and ignores ids that no longer exist', async () => {
    storage.items.set(POSITIONS_KEY, JSON.stringify({'demo/test/g': {ui: {x: 500, y: 400}, gone: {x: 1, y: 2}}, 'demo/test/other': {api: {x: 0, y: 0}}}));
    const view = await ready();
    expect(positionOf(nodeOf(view, 'g', 'ui'))).toEqual({x: 500 - sizeOf(nodeOf(view, 'g', 'ui')).w / 2, y: 400 - 20});
    expect(nodeIds(view, 'g')).toHaveLength(5);
    expect(within(view.cell('g')).getByRole('button', {name: /Re-layout/})).toBeTruthy();
    // api belongs to another diagram's entry: untouched here
    expect(positionOf(nodeOf(view, 'g', 'api'))).not.toEqual({x: -84, y: -20});

    // moving another node keeps what is stored for ids that are not on screen
    drag(stageOf(view, 'g'), nodeOf(view, 'g', 'api'), 10, 10);
    expect(Object.keys(stored()['demo/test/g']!).sort()).toEqual(['api', 'gone', 'ui']);
    expect(stored()['demo/test/other']).toEqual({api: {x: 0, y: 0}});
  });

  it('keeps positions apart per repository, surface and component', async () => {
    const view = await ready(`root=Page('T',[g,h])\ng=Graph(title='A',size='l')\nh=Graph(title='B',size='l')`, {meta: {repo: {name: 'other', root: '/repo', dirty: false}}});
    await waitFor(() => expect(nodeIds(view, 'h')).toHaveLength(5));
    drag(stageOf(view, 'h'), nodeOf(view, 'h', 'ui'), 0, 50);
    expect(Object.keys(stored())).toEqual(['other/test/h']);
    expect(within(view.cell('h')).getByRole('button', {name: /Re-layout/})).toBeTruthy();
    expect(within(view.cell('g')).queryByRole('button', {name: /Re-layout/})).toBeNull();
    expect(positionOf(nodeOf(view, 'g', 'ui'))).not.toEqual(positionOf(nodeOf(view, 'h', 'ui')));
  });

  it('drops a drag whose button was released out of sight', async () => {
    const view = await ready();
    const stage = stageOf(view, 'g');
    const before = positionOf(nodeOf(view, 'g', 'ui'));
    fireEvent.pointerDown(nodeOf(view, 'g', 'ui'), {button: 0, pointerId: 1, clientX: 100, clientY: 100});
    // the next thing the stage sees is a plain hover somewhere else
    fireEvent.pointerMove(stage, {pointerId: 1, buttons: 0, clientX: 400, clientY: 300});
    fireEvent.pointerMove(stage, {pointerId: 1, buttons: 0, clientX: 420, clientY: 320});
    expect(positionOf(nodeOf(view, 'g', 'ui'))).toEqual(before);
    expect(view.getData('/ui/sel')).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it('moves the active node with Alt+arrows', async () => {
    const view = await ready();
    const stage = stageOf(view, 'g');
    focus(stage);
    key(stage, 'Home');
    const before = positionOf(nodeOf(view, 'g', 'ui'));
    key(stage, 'ArrowDown', {altKey: true});
    key(stage, 'ArrowLeft', {altKey: true});
    expect(positionOf(nodeOf(view, 'g', 'ui'))).toEqual({x: before.x - 16, y: before.y + 16});
    expect(stored()['demo/test/g']).toEqual({ui: {x: before.x - 16 + sizeOf(nodeOf(view, 'g', 'ui')).w / 2, y: before.y + 16 + 20}});
  });

  it('moves the group frame with its members', async () => {
    const view = await ready();
    const frame = () => view.cell('g').querySelector('[data-group="srv"] rect')!;
    const height = Number(frame().getAttribute('height'));
    drag(stageOf(view, 'g'), nodeOf(view, 'g', 'auth'), 0, 200);
    expect(Number(frame().getAttribute('height'))).toBeGreaterThan(height + 100);
  });

  it('works without any storage', async () => {
    configurePositionStorage(null);
    const view = await ready();
    const before = positionOf(nodeOf(view, 'g', 'ui'));
    drag(stageOf(view, 'g'), nodeOf(view, 'g', 'ui'), 0, 40);
    expect(positionOf(nodeOf(view, 'g', 'ui'))).toEqual({x: before.x, y: before.y + 40});
    fireEvent.click(within(view.cell('g')).getByRole('button', {name: /Re-layout/}));
    expect(positionOf(nodeOf(view, 'g', 'ui'))).toEqual(before);
  });
});

// What the stage opens with (design rule D7; review findings F001, F020, F089).
describe('Graph: a readable opening view', () => {
  const STAGE = {width: 960, height: 600};
  const nodesOf = (view: Awaited<ReturnType<typeof ready>>) => [...view.cell('g').querySelectorAll<SVGGElement>('[data-node]')];
  /** Size on screen of every label the nodes draw: the face size (inline when zoomed out, else from the sheet) times the zoom. */
  const labelSizes = (view: Awaited<ReturnType<typeof ready>>) => {
    const {k} = viewOf(stageOf(view, 'g'));
    return [...view.cell('g').querySelectorAll<SVGTextElement>('[data-node] text')]
      .filter(text => text.textContent !== 'CYCLE')
      .map(text => (Number.parseFloat(text.style.fontSize) || (text.getAttribute('class')?.includes('sub') ? 11 : 12)) * k);
  };
  const inside = (view: Awaited<ReturnType<typeof ready>>, node: Element, slack = 0) => {
    const at = onStage(stageOf(view, 'g'), node);
    return at.left >= -slack && at.top >= -slack && at.right <= STAGE.width + slack && at.bottom <= STAGE.height + slack;
  };
  const touches = (view: Awaited<ReturnType<typeof ready>>, node: Element) => {
    const at = onStage(stageOf(view, 'g'), node);
    return at.right > 0 && at.left < STAGE.width && at.bottom > 0 && at.top < STAGE.height;
  };
  const press = (view: Awaited<ReturnType<typeof ready>>, name: string) => fireEvent.click(within(view.cell('g')).getByRole('button', {name}));

  it('shows a 48-module graph whole, with every label 10 px or more on screen and nothing cut off', async () => {
    const view = await ready(INLINE, {data: {'/g': layeredGraph(6, 8)}});
    const stage = stageOf(view, 'g');
    expect(nodeIds(view, 'g')).toHaveLength(48);
    const {k} = viewOf(stage);
    // zoomed out, but not past the point where a node holds a readable name
    expect(k).toBeGreaterThanOrEqual(LOD_ZOOM);
    expect(k).toBeLessThanOrEqual(1);
    for (const node of nodesOf(view)) expect(inside(view, node)).toBe(true);
    const sizes = labelSizes(view);
    expect(sizes.length).toBeGreaterThanOrEqual(48);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(10);
    // everything is in view: no overview inset, no "n of m in view"
    expect(view.cell('g').querySelector('[data-overview]')).toBeNull();
    expect(view.cell('g').querySelector('[data-in-view]')).toBeNull();
    // the picture has the shape of the stage instead of being a tall thin column
    const boxes = nodesOf(view).map(node => ({...positionOf(node), ...sizeOf(node)}));
    const wide = Math.max(...boxes.map(b => b.x + b.w)) - Math.min(...boxes.map(b => b.x));
    const tall = Math.max(...boxes.map(b => b.y + b.h)) - Math.min(...boxes.map(b => b.y));
    expect(wide / tall).toBeGreaterThan(0.9);
    expect(wide / tall).toBeLessThan(3.2);
  });

  it('opens a graph too large to read whole at a readable zoom on its busiest node, with an overview and a count', async () => {
    const graph = bigGraph(48, 122);
    const degree = new Map<string, number>();
    for (const edge of graph.edges) for (const end of [edge.from, edge.to]) degree.set(end, (degree.get(end) ?? 0) + 1);
    const busiest = [...degree].sort((a, b) => b[1] - a[1])[0]![0];
    const view = await ready(INLINE, {data: {'/g': graph}});
    const stage = stageOf(view, 'g');
    const opened = viewOf(stage);
    expect(opened.k).toBeGreaterThanOrEqual(READABLE_ZOOM);
    expect(opened.k).toBeLessThanOrEqual(1);
    expect(Math.min(...labelSizes(view))).toBeGreaterThanOrEqual(9);
    // the stage is filled with graph, not with the void beside it, and the busiest node is on it
    expect(nodesOf(view).filter(node => touches(view, node)).length).toBeGreaterThan(6);
    const hubs = nodesOf(view).filter(node => (degree.get(node.getAttribute('data-node')!) ?? 0) === degree.get(busiest));
    expect(hubs.some(node => inside(view, node))).toBe(true);
    // where this is, and how much of it
    const overview = view.cell('g').querySelector('[data-overview]')!;
    expect(overview.querySelectorAll('rect')).toHaveLength(48 + 1);
    // only the nodes it shows whole: one cut off at the edge is not in view
    const shown = nodesOf(view).filter(node => inside(view, node, 1)).length;
    expect(shown).toBeLessThan(nodesOf(view).filter(node => touches(view, node)).length + 1);
    expect(view.cell('g').querySelector('[data-in-view]')!.textContent).toBe(`${shown} of 48 in view`);

    // "Fit to view" really fits, however far out that is, and the overview is no longer needed
    press(view, 'Fit to view');
    for (const node of nodesOf(view)) expect(inside(view, node)).toBe(true);
    expect(viewOf(stage).k).toBeLessThan(opened.k);
    expect(view.cell('g').querySelector('[data-overview]')).toBeNull();
    // nothing is drawn too small to read: a node shows its name at 10 px or more, or just its box
    for (const size of labelSizes(view)) expect(size).toBeGreaterThanOrEqual(10);

    // zooming back in from there never lands on an empty stage
    for (let i = 0; i < 8; i++) press(view, 'Zoom in');
    expect(viewOf(stage).k).toBeGreaterThan(1);
    expect(nodesOf(view).some(node => touches(view, node))).toBe(true);
    // a press on the overview moves the stage there
    const before = viewOf(stage);
    fireEvent.pointerDown(view.cell('g').querySelector('[data-overview]')!, {button: 0, pointerId: 1, clientX: 2, clientY: 2});
    expect(viewOf(stage)).not.toEqual(before);
    expect(viewOf(stage).k).toBe(before.k);
  });

  it('fits 150 nodes below the 20% the zoom buttons stop at', async () => {
    const view = renderExpress(INLINE, {datasets: 'ready', data: {'/g': bigGraph(150, 220)}});
    await waitFor(() => expect(nodeIds(view, 'g')).toHaveLength(150), {timeout: 8000});
    const stage = stageOf(view, 'g');
    expect(viewOf(stage).k).toBeGreaterThanOrEqual(READABLE_ZOOM);
    focus(stage);
    key(stage, '0');
    for (const node of nodesOf(view)) expect(inside(view, node, 1)).toBe(true);
    const fitted = viewOf(stage).k;
    // zooming out stops where everything is in view; zooming in works from there
    key(stage, '-');
    expect(viewOf(stage).k).toBeCloseTo(Math.min(fitted, Math.max(0.2, fitted * 0.8)));
    key(stage, '+');
    expect(viewOf(stage).k).toBeGreaterThan(fitted * 0.99);
  }, 15000);

  it('draws the name alone, larger, between 40% and 91%, and only the box below', async () => {
    // 32 modules: two-line nodes (a larger graph draws one-line nodes, below)
    const view = await ready(INLINE, {data: {'/g': layeredGraph(4, 8)}});
    const stage = stageOf(view, 'g');
    const node = () => nodeOf(view, 'g', 'pkg/l0/m0');
    const zoomTo = (k: number) => {
      for (let i = 0; i < 60 && Math.abs(viewOf(stage).k - k) > 0.004; i++) {
        fireEvent.wheel(stage, {deltaY: -Math.log(k / viewOf(stage).k) / 0.0015, clientX: 480, clientY: 300, ctrlKey: true});
      }
    };
    zoomTo(1);
    expect([...node().querySelectorAll('text')].map(t => t.textContent)).toEqual(['l0/m0', '3 files']);
    expect(node().querySelector('text')!.style.fontSize).toBe('');
    zoomTo(0.75);
    // two lines still fit a 40 px node at 75%: both drawn larger, so both stay 10 px on screen
    const two = [...node().querySelectorAll('text')];
    expect(two.map(t => t.textContent)).toEqual(['l0/m0', '3 files']);
    for (const text of two) expect(Number.parseFloat(text.style.fontSize) * 0.75).toBeGreaterThanOrEqual(10);
    zoomTo(0.5);
    const one = [...node().querySelectorAll('text')];
    expect(one.map(t => t.textContent)).toEqual(['l0/m0']);
    expect(Number.parseFloat(one[0]!.style.fontSize) * 0.5).toBeGreaterThanOrEqual(10);
    zoomTo(0.3);
    expect(node().querySelectorAll('text')).toHaveLength(0);
    expect(node().querySelector('rect')).not.toBeNull();
    expect(view.errors).toEqual([]);
  });

  // Finding V066: the step above said 'the frame of a group keeps a readable label too' and asserted nothing.
  it('keeps the label of a group frame at least 10 px on screen when zoomed out', async () => {
    const graph = layeredGraph(4, 8);
    const grouped = {groups: [{id: 'pkg', label: 'pkg'}], nodes: graph.nodes.map(node => ({...node, group: 'pkg'})), edges: graph.edges};
    const view = await ready(INLINE, {data: {'/g': grouped}});
    const stage = stageOf(view, 'g');
    const label = () => view.cell('g').querySelector<SVGTextElement>('[data-group] text')!;
    const zoomTo = (k: number) => {
      for (let i = 0; i < 60 && Math.abs(viewOf(stage).k - k) > 0.004; i++) {
        fireEvent.wheel(stage, {deltaY: -Math.log(k / viewOf(stage).k) / 0.0015, clientX: 480, clientY: 300, ctrlKey: true});
      }
    };
    zoomTo(1);
    expect(label().textContent).toBe('pkg');
    for (const k of [0.75, 0.5, 0.3]) {
      zoomTo(k);
      const size = Number.parseFloat(label().style.fontSize || '10.5');
      expect(size * viewOf(stage).k, `at ${k}`).toBeGreaterThanOrEqual(10);
    }
  });

  it('holds the selected node still when the zoom buttons are used, and the middle of the graph otherwise', async () => {
    const view = await ready(INLINE, {data: {'/g': layeredGraph(6, 8)}});
    const stage = stageOf(view, 'g');
    const target = nodeOf(view, 'g', 'pkg/l5/m7');
    click(target);
    const centre = () => {
      const at = onStage(stage, nodeOf(view, 'g', 'pkg/l5/m7'));
      return {x: (at.left + at.right) / 2, y: (at.top + at.bottom) / 2};
    };
    const before = centre();
    press(view, 'Zoom in');
    press(view, 'Zoom in');
    expect(centre().x).toBeCloseTo(before.x, 0);
    expect(centre().y).toBeCloseTo(before.y, 0);
    press(view, 'Actual size');
    expect(viewOf(stage).k).toBe(1);
    expect(touches(view, nodeOf(view, 'g', 'pkg/l5/m7'))).toBe(true);
  });

  it('draws one-line nodes above 32 nodes and cuts a second line at a separator, not mid-number', async () => {
    const big = layeredGraph(6, 8);
    const view = await ready(INLINE, {data: {'/g': big}});
    for (const id of nodeIds(view, 'g')) expect(sizeOf(nodeOf(view, 'g', id)).h).toBe(28);
    // what the second line said is in the tooltip text the node carries for assistive technology
    focus(stageOf(view, 'g'));
    key(stageOf(view, 'g'), 'Home');
    expect(view.cell('g').querySelector('[aria-live]')!.textContent).toMatch(/^l\d\/m\d, \d+ files/);
    view.unmount();
    // a medium graph keeps its second line, cut where a reader would cut it
    const medium = {nodes: Array.from({length: 14}, (_, i) => ({id: `m${i}`, label: `module ${i}`, sub: `${300 + i} files, 129.4k loc`, kind: 'cluster'})), edges: Array.from({length: 13}, (_, i) => ({from: `m${i}`, to: `m${i + 1}`}))};
    const cut = await ready(INLINE, {data: {'/g': medium}});
    fireEvent.click(within(cut.cell('g')).getByRole('button', {name: 'Actual size'}));
    expect([...nodeOf(cut, 'g', 'm3').querySelectorAll('text')].map(text => text.textContent)).toContain('303 files');
    expect(fitSub('697 files, 86.3k loc', 80, MONO_11)).toBe('697 files');
    expect(fitSub('12 smaller directories of src: 40 files, 3k loc', 2000, MONO_11)).toBe('12 smaller directories of src: 40 files, 3k loc');
    expect(fitSub('nothing to cut at here', 60, MONO_11).endsWith('…')).toBe(true);
  });

  it('keeps a small graph at full size in a narrow cell by giving its nodes the width their labels need', async () => {
    // the gallery case: four modules in a row in a 722 px stage used to be scaled to 75%
    const chain = {level: 'module', nodes: ['ui', 'api', 'auth', 'redis'].map(id => ({id, label: id, sub: '2 files, 1.1k loc', kind: 'cluster'})), edges: [{from: 'ui', to: 'api'}, {from: 'api', to: 'auth'}, {from: 'auth', to: 'redis'}]};
    const view = await ready(INLINE, {data: {'/g': chain}, size: {width: 722, height: 378}});
    expect(viewOf(stageOf(view, 'g')).k).toBeGreaterThanOrEqual(READABLE_ZOOM);
    const {w} = sizeOf(nodeOf(view, 'g', 'ui'));
    expect(w).toBeLessThan(168);
    expect(w).toBeGreaterThanOrEqual(112);
    // one width for the whole graph
    expect(new Set(nodeIds(view, 'g').map(id => sizeOf(nodeOf(view, 'g', id)).w)).size).toBe(1);
  });

  it('flows the way that suits the stage unless dir says otherwise', async () => {
    const chain = {nodes: Array.from({length: 7}, (_, i) => ({id: `n${i}`, label: `module number ${i}`, sub: `${i} files`})), edges: Array.from({length: 6}, (_, i) => ({from: `n${i}`, to: `n${i + 1}`}))};
    const tall = {width: 420, height: 640};
    const auto = await ready(INLINE, {data: {'/g': chain}, size: tall});
    expect(stageOf(auto, 'g').getAttribute('data-dir')).toBe('TB');
    expect(positionOf(nodeOf(auto, 'g', 'n0')).y).toBeLessThan(positionOf(nodeOf(auto, 'g', 'n6')).y);
    auto.unmount();
    const forced = await ready(`root=Page('T',[g])\ng=Graph($/g,dir='LR',title='Deps',size='l')`, {data: {'/g': chain}, size: tall});
    expect(stageOf(forced, 'g').getAttribute('data-dir')).toBe('LR');
    forced.unmount();
    // a stage much wider than tall (at 960 x 600 this chain is drawn larger top to bottom, and is)
    const wide = await ready(INLINE, {data: {'/g': chain}, size: {width: 1400, height: 420}});
    expect(stageOf(wide, 'g').getAttribute('data-dir')).toBe('LR');
  });

  // A scoped module graph of a large repository (a2ui-repo, task 12): 24 modules in a long chain of cycles, in a plate
  // with no size inside Tabs. It opened whole at 44%, where the larger zoomed-out names held 3 to 6 letters: 'com…',
  // 'expre…', 'resol…', 'valid…'. A node is only identifiable when its name says which one it is.
  it('opens no further out than keeps every zoomed-out name long enough to say which module it is', async () => {
    const names = [
      'renderers', 'samples', 'a2ui_agent', 'tools', 'catalogs', 'v0_9', 'src/*', 'common', 'catalog', 'v1_0', 'resolution', 'expressions',
      'state', 'validation', 'v1', 'universal', 'processing', 'reactivity', 'v0_8', 'rpc', 'web_core', 'zod-to-json-schema', 'types', 'errors',
    ];
    const nodes = names.map((label, i) => ({id: `mod${i}`, label, kind: i === 21 ? 'external' : 'cluster', cycle: i >= 5 && i <= 20}));
    const edges: Array<{from: string; to: string; weight: number; cycle?: boolean}> = [];
    for (let i = 0; i < 5; i++) edges.push({from: `mod${i}`, to: 'mod5', weight: 3});
    // A chain of fourteen modules, each importing the next two, with cycles back; five leaves beside it.
    for (let i = 5; i < 18; i++) {
      edges.push({from: `mod${i}`, to: `mod${i + 1}`, weight: 4});
      if (i + 2 <= 18) edges.push({from: `mod${i}`, to: `mod${i + 2}`, weight: 1});
      if (i >= 7) edges.push({from: `mod${i}`, to: `mod${i - 2}`, weight: 1, cycle: true});
    }
    for (let leaf = 19; leaf < 24; leaf++) edges.push({from: `mod${leaf - 11}`, to: `mod${leaf}`, weight: 1});
    const view = await ready(`root=Page('T',[g])\ng=Graph($/g)`, {data: {'/g': {level: 'module', nodes, edges}}, size: {width: 1256, height: 600}});
    const stage = stageOf(view, 'g');
    const {k} = viewOf(stage);
    expect(k).toBeLessThan(0.91);
    let checked = 0;
    for (const node of view.cell('g').querySelectorAll('[data-node]')) {
      const at = onStage(stage, node);
      if (at.right <= 0 || at.left >= 1256) continue;
      const label = names[Number(node.getAttribute('data-node')!.slice(3))]!;
      const drawn = node.querySelector('text')?.textContent ?? '';
      // The whole name, or at least NAME_KEEP of its letters before the ellipsis.
      expect(drawn.replace(/…$/, '').length, `'${label}' drawn as '${drawn}' at ${Math.round(k * 100)}%`).toBeGreaterThanOrEqual(Math.min(NAME_KEEP, label.length));
      checked++;
    }
    expect(checked).toBeGreaterThan(6);
  });

  it('works out the zoom from which a zoomed-out name keeps its first letters, in 5% steps', () => {
    expect(NAME_KEEP).toBe(8);
    const node = (name: string, cycle = false, w = 136) => ({w, data: {name, cycle}});
    // Short names in wide nodes: any zoom the levels of detail draw names at.
    expect(nameZoom([node('l0/m0', false, 168)])).toBeLessThanOrEqual(LOD_ZOOM);
    // 'expressions' with a cycle mark needs more than the 44% the graph opened at.
    const zoom = nameZoom([node('common', true), node('expressions', true), node('state', true)]);
    expect(zoom).toBeGreaterThan(0.44);
    expect(zoom).toBeLessThan(0.91);
    expect(Math.round(zoom * 20)).toBe(zoom * 20);
    // at that zoom, the face the node draws holds the eight letters and the mark, and 'common' whole
    const size = 10.5 / zoom;
    expect(textWidth('expressi…', {size}) + 7 / zoom + 4).toBeLessThanOrEqual(136 - 14);
    expect(textWidth('common', {size}) + 7 / zoom + 4).toBeLessThanOrEqual(136 - 14);
  });

  it('pinches with two fingers around the point between them', async () => {
    const view = await ready();
    const stage = stageOf(view, 'g');
    const before = viewOf(stage);
    touch('pointerDown', stage, 11, 400, 300);
    touch('pointerDown', stage, 12, 500, 300);
    touch('pointerMove', stage, 12, 600, 300);
    const zoomed = viewOf(stage);
    expect(zoomed.k).toBeCloseTo(before.k * 2);
    // the point that was between the fingers is between them still
    expect((500 - zoomed.x) / zoomed.k).toBeCloseTo((450 - before.x) / before.k);
    touch('pointerUp', stage, 12, 600, 300);
    touch('pointerUp', stage, 11, 400, 300);
    // lifting the fingers is not a click and not a pan
    expect(viewOf(stage)).toEqual(zoomed);
    expect(view.getData('/ui/sel')).toBeNull();
  });
});

describe('Graph: review findings', () => {
  it('gives categories without a session slot the free inks in order, and only a ninth the other ink (D6)', async () => {
    const nodes = Array.from({length: 10}, (_, i) => ({id: `m${i}`, label: `m${i}`, slotKey: `key${i}`}));
    const view = await ready(INLINE, {data: {'/g': {nodes: [...nodes, {id: 'plain', label: 'plain'}], edges: [{from: 'm0', to: 'm1'}]}}});
    const spine = (id: string) => nodeOf(view, 'g', id).querySelector('rect[style]')!.getAttribute('style')!;
    const inks = nodes.map(node => /--gl-cat-(\w+)/.exec(spine(node.id))![1]);
    // the fixture session knows none of these keys: eight distinct inks, then the remainder
    expect(new Set(inks.slice(0, 8)).size).toBe(8);
    expect(inks.slice(0, 8)).not.toContain('other');
    expect(inks.slice(8)).toEqual(['other', 'other']);
    expect(spine('plain')).toContain('--gl-cat-other');
  });

  it('lights the module a selected file or directory lies in, the innermost one only (F022)', async () => {
    const graph = {level: 'module', nodes: [
      {id: 'src', label: 'src', kind: 'cluster', file: 'src/index.ts'},
      {id: 'src/core', label: 'core', kind: 'cluster', file: 'src/core/main.ts'},
      {id: 'src/core/*', label: 'core/*', kind: 'cluster'},
      {id: 'src/core/web', label: 'web', kind: 'cluster'},
      {id: 'docs', label: 'docs', kind: 'cluster'},
      {id: 'zod', label: 'zod', kind: 'external'},
    ], edges: [{from: 'src/core/web', to: 'src/core'}, {from: 'docs', to: 'src'}, {from: 'src/core', to: 'zod'}]};
    const view = await ready(INLINE, {data: {'/g': graph}});
    const lit = () => [...view.cell('g').querySelectorAll('[data-node][data-selected]')].map(node => node.getAttribute('data-node'));
    // a directory that is a node
    view.setData('/ui/sel', {type: 'dir', id: 'src/core/web', path: 'src/core/web'});
    expect(lit()).toEqual(['src/core/web']);
    // a file: its innermost module, not every module above it
    view.setData('/ui/sel', {type: 'file', id: 'src/core/web/state/model.ts', path: 'src/core/web/state/model.ts'});
    expect(lit()).toEqual(['src/core/web']);
    // a symbol of a file in the rest of src/core
    view.setData('/ui/sel', {type: 'symbol', id: 'bind', path: 'src/core/bind.ts', line: 3});
    expect(lit().sort()).toEqual(['src/core', 'src/core/*']);
    // a directory above several modules selects them all
    view.setData('/ui/sel', {type: 'dir', id: 'src/core', path: 'src/core'});
    expect(lit().sort()).toEqual(['src/core', 'src/core/*', 'src/core/web']);
    expect(nodeOf(view, 'g', 'docs').hasAttribute('data-dim')).toBe(true);
    // nothing of the graph
    view.setData('/ui/sel', {type: 'file', id: 'README.md', path: 'README.md'});
    expect(lit()).toEqual([]);
  });

  it('treats the rest clusters as the places they stand for: (other) holds what no module does, dir/* the rest of dir', async () => {
    const graph = {level: 'module', nodes: [
      {id: '(root)', label: '(other)', sub: '3 smaller directories of the root: 9 files, 1.2k loc', kind: 'cluster'},
      {id: 'src', label: 'src', kind: 'cluster'},
      {id: 'src/*', label: 'src/*', kind: 'cluster'},
      {id: 'src/core', label: 'core', kind: 'cluster'},
    ], edges: [{from: 'src/core', to: '(root)'}, {from: 'src/*', to: 'src/core'}]};
    const view = renderExpress(SPEC, {datasets: 'ready'});
    await screen.findAllByRole('img', {name: /^Graph/});
    view.setData('/ds/deps_modules', {...datasetFixture('deps.modules'), data: graph});
    await waitFor(() => expect(nodeIds(view, 'g')).toHaveLength(4));
    const lit = () => [...view.cell('g').querySelectorAll('[data-node][data-selected]')].map(node => node.getAttribute('data-node')).sort();
    view.setData('/ui/sel', {type: 'file', id: 'tools/gen.py', path: 'tools/gen.py'});
    expect(lit()).toEqual(['(root)']);
    view.setData('/ui/sel', {type: 'file', id: 'src/core/a.ts', path: 'src/core/a.ts'});
    expect(lit()).toEqual(['src/core']);
    view.setData('/ui/sel', {type: 'file', id: 'src/util.ts', path: 'src/util.ts'});
    expect(lit()).toEqual(['src', 'src/*']);
    // the label the data gives is drawn, and a rest cluster drills by its id like any module
    expect(nodeOf(view, 'g', '(root)').textContent).toContain('(other)');
    click(nodeOf(view, 'g', '(root)'));
    click(nodeOf(view, 'g', '(root)'));
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', context: {ds: 'deps_modules', target: '(root)'}});
  });

  it('drills into a directory group on a double-click on its label, and only dispatches (D1, F027)', async () => {
    const graph = {level: 'module', groups: [{id: 'dir:typescript', label: 'typescript'}, {id: 'misc', label: 'misc'}], nodes: [
      {id: 'typescript/core', label: 'core', kind: 'cluster', group: 'dir:typescript'},
      {id: 'typescript/web', label: 'web', kind: 'cluster', group: 'dir:typescript'},
      {id: 'tools', label: 'tools', kind: 'cluster', group: 'misc'},
    ], edges: [{from: 'typescript/web', to: 'typescript/core'}, {from: 'tools', to: 'typescript/core'}]};
    const view = renderExpress(SPEC, {datasets: 'ready'});
    await screen.findAllByRole('img', {name: /^Graph/});
    view.setData('/ds/deps_modules', {...datasetFixture('deps.modules'), data: graph});
    await waitFor(() => expect(nodeIds(view, 'g')).toHaveLength(3));
    const label = (id: string) => view.cell('g').querySelector(`[data-group="${id}"] text`)!;
    expect(view.cell('g').querySelector('[data-group="dir:typescript"]')!.hasAttribute('data-drillable')).toBe(true);
    expect(view.cell('g').querySelector('[data-group="misc"]')!.hasAttribute('data-drillable')).toBe(false);
    click(label('dir:typescript'));
    expect(view.actions.filter(action => action.name === 'gl_drill')).toEqual([]);
    click(label('dir:typescript'));
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', context: {ds: 'deps_modules', target: 'typescript'}});
    // a click on a frame selects nothing, and the graph draws no way back of its own: the plate's scope row is it
    expect(view.getData('/ui/sel')).toBeNull();
    expect(within(view.cell('g')).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Zoom out', 'Zoom in', 'Fit to view', 'Actual size']);
    // the frame line takes the double-click as well
    const frame = view.cell('g').querySelector('[data-group="dir:typescript"] [data-group-handle]')!;
    click(frame);
    click(frame);
    expect(view.actions.filter(action => action.name === 'gl_drill')).toHaveLength(2);
  });

  it('shows the scope row of the plate while the dataset is drilled, and keeps it across a re-render (D1)', async () => {
    const base = buildSurface('test', SPEC, {datasets: 'ready'});
    const view = renderSpec(base);
    await screen.findAllByRole('img', {name: /^Graph/});
    view.setData('/ds/deps_modules', {...datasetFixture('deps.modules'), drill: {target: 'src/api', up: 'src'}});
    await waitFor(() => expect(view.cell('g').querySelector('[data-gl-scope]')!.textContent).toBe('src/api'));
    // Finding V066: a real re-render: the model redefines the component (a new title); the crumb comes from the
    // dataset's envelope, not from state the component held, so it is still there.
    view.send(buildPatch('test', base, "g=Graph(title='Deps again',size='l')"));
    await waitFor(() => expect(view.cell('g').textContent).toContain('Deps again'));
    const cell = view.cell('g');
    expect(cell.querySelector('[data-gl-scope]')!.textContent).toBe('src/api');
    fireEvent.click(cell.querySelector('[data-gl-scope-up]')!);
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', context: {ds: 'deps_modules', target: 'src'}});
    fireEvent.click(cell.querySelector('[data-gl-scope-reset]')!);
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', context: {ds: 'deps_modules', target: ''}});
  });

  it('does not report a focus as missing when it is the scope the graph is drawn for (F046)', async () => {
    const graph = {level: 'module', groups: [{id: 'dir:server', label: 'server'}], nodes: [{id: 'server/spec', label: 'spec', kind: 'cluster'}, {id: 'server/mcp', label: 'mcp', kind: 'cluster'}, {id: 'zod', label: 'zod', kind: 'external'}], edges: [{from: 'server/mcp', to: 'server/spec'}, {from: 'server/spec', to: 'zod'}]};
    const note = async (focusProp: string) => {
      const view = await ready(`root=Page('T',[g])\ng=Graph($/g,focus='${focusProp}',title='Deps',size='l')`, {data: {'/g': graph}});
      const text = view.cell('g').querySelector('[data-gl-note]')!.textContent;
      view.unmount();
      return text;
    };
    expect(await note('server')).toBe('2 modules · 1 package · 2 edges');
    expect(await note('server/')).toBe('2 modules · 1 package · 2 edges');
    expect(await note('nowhere')).toBe('2 modules · 1 package · 2 edges · focus "nowhere" not found');
    expect(await note('server/spec')).toBe('2 modules · 1 package · 2 edges · focus server/spec · 1 hop');
  });

  it('cuts a path label at its directories and keeps the last segment (D12)', () => {
    const cut = fitLabel('typescript/renderers/react/generic-binder', 120, UI_12);
    expect(cut.startsWith('…')).toBe(true);
    expect(cut.endsWith('generic-binder')).toBe(true);
    expect(textWidth(cut, UI_12)).toBeLessThanOrEqual(120);
    expect(fitLabel('short/path', 120, UI_12)).toBe('short/path');
    // not a path: cut at the end, as before
    expect(fitLabel('a sentence with a/slash in it that is long', 100, UI_12).endsWith('…')).toBe(true);
    expect(fitLabel('x'.repeat(80), 100, UI_12).endsWith('…')).toBe(true);
  });

  it('draws the lightest third of many edges in the rule colour until they are selected', async () => {
    const view = await ready(INLINE, {data: {'/g': layeredGraph(6, 8)}});
    const cell = view.cell('g');
    const faint = cell.querySelectorAll('[data-edge][data-faint]').length;
    const all = cell.querySelectorAll('[data-edge]').length;
    expect(all).toBeGreaterThan(40);
    expect(faint).toBeGreaterThan(0);
    expect(faint).toBeLessThan(all);
    click(nodeOf(view, 'g', 'pkg/l0/m0'));
    for (const edge of cell.querySelectorAll('[data-edge][data-hot]')) expect(edge.hasAttribute('data-faint')).toBe(false);
    // a small graph keeps every edge in ink
    view.unmount();
    const small = await ready();
    expect(small.cell('g').querySelector('[data-edge][data-faint]')).toBeNull();
  });
});

describe('Graph: what the model hears and what the person reads (D14, D16, V007, V048, V059)', () => {
  const modules = {level: 'module', nodes: [
    {id: 'packages/server/src/host', label: 'host', kind: 'cluster'},
    {id: 'packages/server/src/mcp', label: 'mcp', kind: 'cluster'},
    {id: 'packages/viewer/src', label: 'viewer', kind: 'cluster'},
  ], edges: [{from: 'packages/server/src/mcp', to: 'packages/server/src/host'}, {from: 'packages/viewer/src', to: 'packages/server/src/mcp'}]};

  it('reports a focus that matches no node as W_FOCUS with the nearest ids, and withdraws it once it does (V007)', async () => {
    const view = renderExpress(`root=Page('T',[g])\ng=Graph($/g,focus='packages/server/src/spec',title='Deps',size='l')`, {data: {'/g': modules}});
    await waitFor(() => expect(view.stateOf('g')).toBe('W_FOCUS'));
    const said = view.reports.findLast(report => report.code === 'W_FOCUS')!;
    expect(said.message).toBe('Graph#g: focus "packages/server/src/spec" matches no node; nearest: packages/server/src/mcp, packages/server/src/host, packages/viewer/src');
    // The person sees the whole graph and the note.
    expect(nodeIds(view, 'g')).toHaveLength(3);
    expect(view.cell('g').querySelector('[data-gl-note]')!.textContent).toContain('not found');
    view.setData('/g', {...modules, nodes: [...modules.nodes, {id: 'packages/server/src/spec', label: 'spec', kind: 'cluster'}]});
    await waitFor(() => expect(view.stateOf('g')).toBe('OK'));
  });

  it('says nothing about a focus that names the scope the graph is drawn for', async () => {
    const view = renderExpress(`root=Page('T',[g])\ng=Graph($/g,focus='packages',title='Deps',size='l')`, {data: {'/g': modules}});
    await waitFor(() => expect(nodeIds(view, 'g')).toHaveLength(3));
    await waitFor(() => expect(view.stateOf('g')).toBe('OK'));
    expect(view.reports).toEqual([]);
  });

  it('draws a graph without nodes as the truthful answer of its source (I_EMPTY), not as a problem', async () => {
    const view = renderExpress(SPEC, {datasets: 'ready'});
    await screen.findAllByRole('img', {name: /^Graph/});
    view.setData('/ds/deps_modules', {...datasetFixture('deps.modules'), data: {level: 'module', nodes: [], edges: []}, note: 'no import cycles'});
    await waitFor(() => expect(view.cell('g').querySelector('[data-gl-state="empty"]')!.textContent).toContain('no import cycles'));
    await waitFor(() => expect(view.stateOf('g')).toBe('I_EMPTY'));
    // Inline data with no nodes is a problem the model should hear about.
    const inline = renderExpress(INLINE, {data: {'/g': {nodes: [], edges: []}}});
    await waitFor(() => expect(inline.stateOf('g')).toBe('W_EMPTY'));
  });

  it('says how many of how many modules a cut graph shows, once (D16)', async () => {
    const view = renderExpress(SPEC, {datasets: 'ready'});
    await screen.findAllByRole('img', {name: /^Graph/});
    view.setData('/ds/deps_modules', {...datasetFixture('deps.modules'), data: modules, truncated: {total: 90, returned: 3, strategy: 'treecut'}});
    // one phrase, in the graph's unit: '3 of 90 modules', not 'showing 3 of 90 · tree cut' beside '3 modules'
    await waitFor(() => expect(view.cell('g').querySelector('[data-gl-note]')!.textContent).toMatch(/^3 of 90 modules · 2 edges/));
    expect(view.cell('g').querySelector('[data-gl-marginal]')).toBeNull();
    expect(view.cell('g').textContent!.match(/3 of 90/g)).toHaveLength(1);
    // a graph the source did not cut says how many it has
    view.setData('/ds/deps_modules', {...datasetFixture('deps.modules'), data: modules, truncated: undefined});
    await waitFor(() => expect(view.cell('g').querySelector('[data-gl-note]')!.textContent).toMatch(/^3 modules · 2 edges/));
  });

  it('tells nodes that would read alike apart, and never cuts a package name like a path (V048)', async () => {
    const graph = {level: 'file', nodes: [
      {id: 'typescript/core/src/state/types.ts', label: 'types.ts', kind: 'file'},
      {id: 'typescript/core/src/catalog/types.ts', label: 'types.ts', kind: 'file'},
      {id: '.github/scripts', label: 'scripts', kind: 'dir'},
      {id: 'typescript/scripts', label: 'scripts', kind: 'dir'},
      {id: 'ext:@angular/platform-browser-dynamic', label: '@angular/platform-browser-dynamic', kind: 'external'},
    ], edges: []};
    const view = renderExpress(INLINE, {data: {'/g': graph}});
    await waitFor(() => expect(nodeIds(view, 'g')).toHaveLength(5));
    const name = (id: string) => nodeOf(view, 'g', id).querySelector('text')!.textContent!;
    expect(name('typescript/core/src/state/types.ts')).toBe('state/types.ts');
    expect(name('typescript/core/src/catalog/types.ts')).toBe('catalog/types.ts');
    expect(name('.github/scripts')).toBe('.github/scripts');
    expect(name('typescript/scripts')).toBe('typescript/scripts');
    const pkg = name('ext:@angular/platform-browser-dynamic');
    expect(pkg.startsWith('@angular/')).toBe(true);
    expect(pkg.endsWith('…')).toBe(true);
    expect(fitLabel('@angular/platform-browser-dynamic', 80, UI_12, true).startsWith('@angular')).toBe(true);
    // Zoomed out, labels that end alike keep the start of their path when they are cut ('.git…/scripts', not '…/scripts').
    const {labels, ends} = distinctLabels([
      {id: '.github/scripts', label: '.github/scripts'}, {id: 'typescript/scripts', label: 'typescript/scripts'},
      {id: 'a/x/types.ts', label: 'types.ts'}, {id: 'b/x/types.ts', label: 'types.ts'}, {id: 'ext:@scope/scripts', label: '@scope/scripts', pkg: true},
    ], label => label);
    expect([...ends].sort()).toEqual(['.github/scripts', 'a/x/types.ts', 'b/x/types.ts', 'typescript/scripts']);
    expect(labels.get('a/x/types.ts')).toBe('a/x/types.ts');
    expect(labels.has('.github/scripts')).toBe(false);
  });

  it('drills a rest cluster of a scoped graph by its id, and offers no drill on files or packages (V059)', async () => {
    const graph = {level: 'module', nodes: [
      {id: 'typescript/catalogs/shared/sandbox/*', label: 'sandbox/*', kind: 'cluster'},
      {id: 'typescript/core/web_core', label: 'web_core', kind: 'cluster'},
      {id: 'typescript/core/web_core/src/index.ts', label: 'index.ts', kind: 'file'},
      {id: 'ext:zod', label: 'zod', kind: 'external'},
    ], edges: [{from: 'typescript/catalogs/shared/sandbox/*', to: 'typescript/core/web_core'}, {from: 'typescript/core/web_core', to: 'ext:zod'}]};
    const view = renderExpress(SPEC, {datasets: 'ready'});
    await screen.findAllByRole('img', {name: /^Graph/});
    view.setData('/ds/deps_modules', {...datasetFixture('deps.modules'), data: graph});
    await waitFor(() => expect(nodeIds(view, 'g')).toHaveLength(4));
    click(nodeOf(view, 'g', 'typescript/catalogs/shared/sandbox/*'));
    click(nodeOf(view, 'g', 'typescript/catalogs/shared/sandbox/*'));
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill', context: {ds: 'deps_modules', target: 'typescript/catalogs/shared/sandbox/*'}});
    for (const id of ['typescript/core/web_core/src/index.ts', 'ext:zod']) {
      const before = view.actions.length;
      click(nodeOf(view, 'g', id));
      click(nodeOf(view, 'g', id));
      expect(view.actions.slice(before).map(a => a.name)).toEqual(['gl_select', 'gl_select']);
    }
  });
});
