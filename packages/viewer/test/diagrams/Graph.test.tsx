import {fireEvent, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {MAX_EDGES, MAX_NODES} from '../../src/components/diagrams/Graph.tsx';
import {POSITIONS_KEY, configurePositionStorage} from '../../src/components/diagrams/edgekit/index.ts';
import {buildPatch, buildSurface, datasetFixture, errorDataset, renderExpress, renderSpec} from '../harness.tsx';
import {bigGraph, click, drag, edgeOf, fakeStorage, focus, inside, key, lineOf, nodeIds, nodeOf, pointsOf, positionOf, stageOf, viewOf, type FakeStorage} from './util.tsx';

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
    expect(cell.querySelector('[data-gl-note]')!.textContent).toBe('5 modules · 6 edges · 2 in cycles');
    expect(stageOf(view, 'g').getAttribute('aria-label')).toBe('Graph, 5 modules, 6 edges, 2 in cycles, most connected auth');
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
    expect(pointsOf(edgeBefore)[0]).toEqual([before.x + 168, before.y + 20]);

    // while the pointer is down the node and its edges follow it; nothing is stored yet
    fireEvent.pointerDown(nodeOf(view, 'g', 'ui'), {button: 0, pointerId: 1, clientX: 100, clientY: 100});
    fireEvent.pointerMove(stage, {pointerId: 1, buttons: 1, clientX: 80, clientY: 180});
    expect(positionOf(nodeOf(view, 'g', 'ui'))).toEqual({x: before.x - 20, y: before.y + 80});
    expect(pointsOf(lineOf(edgeOf(view, 'g', 'ui->auth')))[0]).toEqual([before.x - 20 + 168, before.y + 80 + 20]);
    expect(storage.items.size).toBe(0);
    fireEvent.pointerMove(stage, {pointerId: 1, buttons: 1, clientX: 60, clientY: 220});
    fireEvent.pointerUp(stage, {pointerId: 1, clientX: 60, clientY: 220});

    const after = positionOf(nodeOf(view, 'g', 'ui'));
    expect(after).toEqual({x: before.x - 40, y: before.y + 120});
    const edgeAfter = lineOf(edgeOf(view, 'g', 'ui->auth'));
    expect(edgeAfter).not.toBe(edgeBefore);
    expect(pointsOf(edgeAfter)[0]).toEqual([after.x + 168, after.y + 20]);
    // the far end still meets auth where it did
    expect(pointsOf(edgeAfter).at(-1)![0]).toBe(pointsOf(edgeBefore).at(-1)![0]);
    expect(lineOf(edgeOf(view, 'g', 'auth->ext:redis'))).toBe(untouched);
    expect(['api', 'auth', 'ext:redis', 'ext:pg'].map(id => positionOf(nodeOf(view, 'g', id)))).toEqual(others);

    expect(stored()).toEqual({'demo/test/g': {ui: {x: after.x + 84, y: after.y + 20}}});
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
    expect(positionOf(nodeOf(view, 'g', 'ui'))).toEqual({x: 500 - 84, y: 400 - 20});
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
    expect(stored()['demo/test/g']).toEqual({ui: {x: before.x - 16 + 84, y: before.y + 16 + 20}});
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
