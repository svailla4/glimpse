import type {EntityRef} from '@glimpse/catalog';
import {fireEvent, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {CONTROLS, POSITIONS_KEY, configurePositionStorage, legsOf} from '../../src/components/diagrams/flowkit/index.ts';
import {buildPatch, buildSurface, renderExpress, renderSpec} from '../harness.tsx';
import {
  click, drag, drawn, edgeOf, elk, fakeStorage, focus, inside, key, lineOf, nodeIds, nodeOf, onStage, pointsOf, positionOf, runsAlong, sizeOf, stageHeight,
  stageOf, viewOf, wrapperOf, type FakeStorage,
} from './util.tsx';

// Express data literals, as a model writes them.
const GALLERY = "{nodes:{Req:'Request',RL:{label:'Over limit?',shape:'diamond'},H:'Handler',E:{label:'429',shape:'pill'},DB:{label:'Postgres',shape:'store'},C:{label:'cache',shape:'circle'}},edges:[['Req','RL'],['RL','H','no'],['RL','E','yes'],['H','DB'],{from:'H',to:'C',dashed:true}]}";
const spec = (data: string, props = '') => `root=Page('T',[f])\nf=Flowchart(${data}${props},title='Flow',size='l')`;
const ready = async (data: string, props = '') => {
  const view = renderExpress(spec(data, props));
  await screen.findByRole('img', {name: /^Flowchart/});
  await drawn(view, 'f');
  return view;
};
const zoomOf = (view: ReturnType<typeof renderExpress>) => Number.parseInt(view.cell('f').querySelector('[data-zoom]')!.textContent!, 10);

let storage: FakeStorage;
beforeEach(() => {
  storage = fakeStorage();
  configurePositionStorage(storage);
});
afterEach(() => configurePositionStorage(undefined));

describe('Flowchart', () => {
  it('draws every shape, labelled and dashed edges, top to bottom', async () => {
    const view = await ready(GALLERY, `,dir='TB'`);
    expect(nodeIds(view, 'f')).toEqual(['Req', 'RL', 'H', 'E', 'DB', 'C']);
    const shape = (id: string) => nodeOf(view, 'f', id).querySelector('[data-shape]')!;
    expect(shape('Req').getAttribute('data-shape')).toBe('box');
    expect(shape('Req').querySelector('rect:not([rx])')).not.toBeNull();
    expect(shape('RL').querySelector('polygon')).not.toBeNull();
    expect(shape('E').querySelector('rect[rx]')).not.toBeNull();
    expect(shape('DB').querySelectorAll('path')).toHaveLength(2);
    expect(shape('C').querySelector('ellipse')).not.toBeNull();
    expect(inside(nodeOf(view, 'f', 'RL')).getByText('Over limit?')).toBeTruthy();

    // a diamond is at least 96 x 56 and its label fits inside
    const diamond = shape('RL').querySelector('polygon')!.getAttribute('points')!.split(' ').map(p => p.split(',').map(Number));
    expect(diamond[1]![0]).toBeGreaterThanOrEqual(96);
    expect(diamond[2]![1]).toBeGreaterThanOrEqual(56);

    expect(view.cell('f').querySelectorAll('[data-edge]')).toHaveLength(5);
    expect(edgeOf(view, 'f', 'H->C').hasAttribute('data-dashed')).toBe(true);
    expect(edgeOf(view, 'f', 'H->DB').hasAttribute('data-dashed')).toBe(false);
    expect([...view.cell('f').querySelectorAll('[data-edge-label]')].map(l => l.textContent).sort()).toEqual(['no', 'yes']);
    // the flow runs down the page
    expect(positionOf(nodeOf(view, 'f', 'Req')).y).toBeLessThan(positionOf(nodeOf(view, 'f', 'RL')).y);
    expect(positionOf(nodeOf(view, 'f', 'RL')).y).toBeLessThan(positionOf(nodeOf(view, 'f', 'H')).y);
    // an edge leaves the bottom of its source and arrives at the top of its target: the diamond's top vertex
    const req = positionOf(nodeOf(view, 'f', 'Req'));
    const rl = positionOf(nodeOf(view, 'f', 'RL'));
    const line = pointsOf(lineOf(edgeOf(view, 'f', 'Req->RL')));
    expect(line[0]![1]).toBeCloseTo(req.y + sizeOf(nodeOf(view, 'f', 'Req')).h, 0);
    expect(line.at(-1)![1]).toBeCloseTo(rl.y, 0);
    expect(line.at(-1)![0]).toBeCloseTo(rl.x + sizeOf(nodeOf(view, 'f', 'RL')).w / 2, 0);
    expect(stageOf(view, 'f').getAttribute('aria-label')).toBe('Flowchart, 6 steps, 5 connections: Request, Over limit?, Handler, 429, Postgres, cache');
    expect(view.errors).toEqual([]);
  });

  it('lays out left to right with dir=LR', async () => {
    const view = await ready(GALLERY, `,dir='LR'`);
    expect(positionOf(nodeOf(view, 'f', 'Req')).x).toBeLessThan(positionOf(nodeOf(view, 'f', 'RL')).x);
    expect(positionOf(nodeOf(view, 'f', 'RL')).x).toBeLessThan(positionOf(nodeOf(view, 'f', 'H')).x);
  });

  it('lays out top to bottom with dir=TB, and tells ELK the direction', async () => {
    const view = await ready("{nodes:{M:'main.ts',A:'AuthProvider',R:'AppRoot'},edges:[['M','A'],['A','R']]}", `,dir='TB'`);
    expect(stageOf(view, 'f').getAttribute('data-dir')).toBe('TB');
    expect(elk.requests.at(-1)!.graph.layoutOptions!['elk.direction']).toBe('DOWN');
    expect(positionOf(nodeOf(view, 'f', 'M')).y).toBeLessThan(positionOf(nodeOf(view, 'f', 'R')).y);
  });

  it.each([
    ['edges alone', "[['A','B']]", ['A', 'B'], ['A->B']],
    ['a chain and a fan-out', "{edges:[['A','B'],['B','C'],['A','D'],['A','E']]}", ['A', 'B', 'C', 'D', 'E'], ['A->B', 'A->D', 'A->E', 'B->C']],
    ['a cycle and a self-loop', "{edges:[['A','B'],['B','A'],['B','B']]}", ['A', 'B'], ['A->B', 'B->A', 'B->B']],
    ['nodes as a list', "{nodes:[{id:'A',label:'a'},{id:'B',label:'b'}],edges:[{source:'A',target:'B',text:'maybe later'}]}", ['A', 'B'], ['A->B']],
    ['one bare node', "{nodes:{Solo:'Solo'}}", ['Solo'], []],
  ])('draws %s', async (_name, data, nodes, edges) => {
    const view = await ready(data);
    expect(nodeIds(view, 'f')).toEqual(nodes);
    expect([...view.cell('f').querySelectorAll('[data-edge]')].map(e => e.getAttribute('data-edge')).sort()).toEqual(edges);
    for (const edge of view.cell('f').querySelectorAll('[data-edge]')) expect(lineOf(edge)).toMatch(/^M[-\d. ]+(?:[LQ][-\d. ]+)+$/);
  });

  it('keeps the two edges of a cycle apart', async () => {
    const view = await ready("[['A','B'],['B','A']]");
    expect(lineOf(edgeOf(view, 'f', 'A->B'))).not.toBe(lineOf(edgeOf(view, 'f', 'B->A')));
    // The way back goes round the side: the two never share a stretch of line.
    const forth = pointsOf(lineOf(edgeOf(view, 'f', 'A->B'))).map(([x, y]) => ({x, y}));
    const back = pointsOf(lineOf(edgeOf(view, 'f', 'B->A'))).map(([x, y]) => ({x, y}));
    expect(runsAlong(forth, back)).toBe(false);
  });

  it('draws groups as labelled frames around their nodes, nested groups inside their parent', async () => {
    const view = await ready("{groups:{api:'API',db:{label:'Storage',parent:'api'}},nodes:{R:{label:'routes',group:'api'},P:{label:'Postgres',shape:'store',group:'db'},U:'User'},edges:[['U','R'],['R','P']]}");
    const cell = view.cell('f');
    expect(cell.querySelector('[data-group="api"]')!.textContent).toBe('API');
    expect(cell.querySelector('[data-group="db"]')!.textContent).toBe('Storage');
    const group = elk.requests.at(-1)!.graph.children!.find(child => child.id === 'api')!;
    expect(group.children!.map(child => child.id).sort()).toEqual(['R', 'db']);
    expect(group.children!.find(child => child.id === 'db')!.children!.map(child => child.id)).toEqual(['P']);
    expect(view.errors).toEqual([]);
  });

  it('refuses Mermaid text with a redline that says what to write instead', async () => {
    const view = renderExpress(`root=Page('T',[f])\nf=Flowchart($/f,title='Flow',size='l')`, {data: {'/f': 'A --> B'}});
    await waitFor(() => expect(view.cell('f').querySelector('[data-code="E_SHAPE"]')).not.toBeNull());
    const text = view.cell('f').querySelector('[data-code="E_SHAPE"]')!.textContent!;
    expect(text).toContain('Flowchart#f');
    expect(text).toContain('Flowchart takes data, not Mermaid text: {nodes, edges, groups?}');
    expect(view.cell('f').querySelector('[data-node]')).toBeNull();
  });

  it('draws what it can of data a patch wrote and tells the model what it left out (W_DROPPED)', async () => {
    const view = renderExpress(`root=Page('T',[f])\nf=Flowchart($/f,title='Flow',size='l')`, {data: {'/f': {nodes: {A: 'a', B: 'b'}, edges: [['A', 'B']]}}});
    await drawn(view, 'f');
    await waitFor(() => expect(view.stateOf('f')).toBe('OK'));
    // The server sends a patched path's whole top-level value ($/f), as here.
    view.setData('/f', {nodes: {A: 'a', B: 'b'}, edges: [['A', 'B'], ['A']]});
    await waitFor(() => expect(view.stateOf('f')).toBe('W_DROPPED'));
    expect(view.reports.findLast(report => report.code === 'W_DROPPED')!.message).toBe("Flowchart#f: not drawn: edge 2: expected ['from', 'to', 'label'?] or {from, to}, received a list of 1");
    expect(nodeIds(view, 'f')).toEqual(['A', 'B']);
    expect(view.cell('f').querySelector('[data-gl-note]')!.textContent).toContain('1 not drawn');
    view.setData('/f', {nodes: {A: 'a', B: 'b'}, edges: [['A', 'B'], ['B', 'A']]});
    await waitFor(() => expect(view.stateOf('f')).toBe('OK'));
  });

  it('follows a patch of one node ($/f/nodes/B={label}, which the server sends as the new $/f)', async () => {
    const view = renderExpress(`root=Page('T',[f])\nf=Flowchart($/f,title='Flow',size='l')`, {data: {'/f': {nodes: {A: 'a', B: 'b'}, edges: [['A', 'B']]}}});
    await drawn(view, 'f');
    view.setData('/f', {nodes: {A: 'a', B: {label: 'renamed'}}, edges: [['A', 'B']]});
    await waitFor(() => expect(inside(nodeOf(view, 'f', 'B')).getByText('renamed')).toBeTruthy());
  });

  it('shows the empty state for empty or unbound data, and draws once it is set', async () => {
    const view = renderExpress(`root=Page('T',[f])\nf=Flowchart($/f,title='Flow',size='l')`);
    await waitFor(() => expect(view.cell('f').querySelector('[data-gl-state="empty"]')).not.toBeNull());
    view.setData('/f', {nodes: {}});
    await waitFor(() => expect(view.cell('f').querySelector('[data-gl-state="empty"]')!.textContent).toContain('no nodes to draw'));
    view.setData('/f', {edges: [['A', 'B']]});
    await waitFor(() => expect(nodeIds(view, 'f')).toEqual(['A', 'B']));
    view.setData('/f', {edges: [['A', 'B'], ['B', 'C']]});
    await waitFor(() => expect(nodeIds(view, 'f')).toEqual(['A', 'B', 'C']));
    view.setData('/f', 42);
    await waitFor(() => expect(view.cell('f').querySelector('[data-code="E_SHAPE"]')).not.toBeNull());
  });

  it('follows a patch that replaces the source', async () => {
    const base = buildSurface('test', spec("[['A','B']]"));
    const view = renderSpec(base);
    await waitFor(() => expect(nodeIds(view, 'f')).toEqual(['A', 'B']));
    view.send(buildPatch('test', base, `f=Flowchart({nodes:{X:{label:'Start',shape:'pill'}},edges:[['X','Y'],['Y','Z']]},title='Flow',size='l')`));
    await waitFor(() => expect(nodeIds(view, 'f')).toEqual(['X', 'Y', 'Z']));
    expect(view.errors).toEqual([]);
  });

  it('wraps and cuts a 500-character label', async () => {
    const view = await ready(`{nodes:{A:'${'long label '.repeat(45)}'},edges:[['A','B']]}`);
    const lines = [...nodeOf(view, 'f', 'A').querySelectorAll('tspan')].map(t => t.textContent!);
    expect(lines).toHaveLength(3);
    expect(lines[2]!.endsWith('…')).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThan(40);
  });

  it('selects a node, dims what is not connected to it, and walks with the arrow keys', async () => {
    const view = await ready(GALLERY, `,dir='TB'`);
    click(nodeOf(view, 'f', 'H'));
    expect(view.getData('/ui/sel')).toEqual({type: 'node', id: 'H', label: 'Handler'});
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_select', sourceComponentId: 'f'});
    expect(nodeOf(view, 'f', 'H').querySelector('[data-shape]')!.hasAttribute('data-selected')).toBe(true);
    expect(nodeOf(view, 'f', 'E').hasAttribute('data-dim')).toBe(true);
    expect(nodeOf(view, 'f', 'RL').hasAttribute('data-dim')).toBe(false);
    expect(edgeOf(view, 'f', 'RL->H').hasAttribute('data-hot')).toBe(true);
    expect(edgeOf(view, 'f', 'RL->E').hasAttribute('data-dim')).toBe(true);
    // the label of a dimmed edge dims with it
    const labels = [...view.cell('f').querySelectorAll('[data-edge-label]')];
    expect(labels.find(l => l.textContent === 'yes')!.hasAttribute('data-dim')).toBe(true);
    expect(labels.find(l => l.textContent === 'no')!.hasAttribute('data-dim')).toBe(false);

    const stage = stageOf(view, 'f');
    focus(stage);
    key(stage, 'Home');
    expect(view.cell('f').querySelector('[data-active]')!.getAttribute('data-node')).toBe('Req');
    key(stage, 'ArrowDown');
    expect(view.cell('f').querySelector('[data-active]')!.getAttribute('data-node')).toBe('RL');
    key(stage, 'Enter');
    expect(view.getData('/ui/sel')).toMatchObject({id: 'RL'});
    key(stage, 'Escape');
    expect(view.getData('/ui/sel') ?? null).toBeNull();
  });

  // Decision links-through-node-ids: a node's note and file are in its tooltip, its announcement and, once selected, the plate's margin.
  it('shows a node\'s note and file, marks the node, and selects the file with it', async () => {
    const view = await ready("{nodes:{A:{label:'API',note:'routes',file:'src/api.ts#L3-9'},B:'Worker',C:{label:'Store',description:'orders'}},edges:[['A','B'],['B','C']]}", `,dir='LR'`);
    const noted = (id: string) => nodeOf(view, 'f', id).querySelector('[data-shape]')!.hasAttribute('data-noted');
    expect(['A', 'B', 'C'].map(noted)).toEqual([true, false, true]);
    expect(nodeOf(view, 'f', 'A').querySelector('circle')).not.toBeNull();
    // the size is the label's: a note does not grow the box
    expect(sizeOf(nodeOf(view, 'f', 'B')).h).toBe(sizeOf(nodeOf(view, 'f', 'A')).h);

    fireEvent.mouseEnter(wrapperOf(nodeOf(view, 'f', 'A')), {clientX: 10, clientY: 10});
    await waitFor(() => expect(document.querySelector('.gl-tooltip')?.textContent).toBe('APIroutes · src/api.ts#L3-9'));

    const stage = stageOf(view, 'f');
    focus(stage);
    key(stage, 'Home');
    expect(view.cell('f').querySelector('[aria-live]')!.textContent).toBe('API, routes · src/api.ts#L3-9');

    click(nodeOf(view, 'f', 'A'));
    expect(view.getData('/ui/sel')).toEqual({type: 'node', id: 'A', label: 'API', path: 'src/api.ts', line: 3, endLine: 9});
    expect(view.getData('/ui/file')).toBe('src/api.ts#L3-9');
    expect(view.cell('f').querySelector('[data-gl-note]')!.textContent).toBe('API: routes · src/api.ts#L3-9');
    click(nodeOf(view, 'f', 'C'));
    expect(view.getData('/ui/sel')).toEqual({type: 'node', id: 'C', label: 'Store'});
    expect(view.cell('f').querySelector('[data-gl-note]')!.textContent).toBe('Store: orders');
    // a node without a note leaves the margin empty
    click(nodeOf(view, 'f', 'B'));
    expect(view.cell('f').querySelector('[data-gl-note]')).toBeNull();

    click(nodeOf(view, 'f', 'A'), {metaKey: true});
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_open', context: {file: 'src/api.ts#L3-9'}});
    // and the node lights when its file is selected elsewhere
    view.setData('/ui/sel', {type: 'file', id: 'src/api.ts', path: 'src/api.ts'});
    expect(nodeOf(view, 'f', 'A').hasAttribute('data-selected')).toBe(true);
  });

  it('legsOf: the consecutive pairs of a path, both ways; nothing for a node or a single id (links-through-node-ids)', () => {
    const message: EntityRef = {type: 'message', id: 'co:1', nodes: ['Client', 'CDN', 'Q', 'GW']};
    expect([...legsOf(message)].sort()).toEqual([['CDN', 'Client'], ['CDN', 'Q'], ['Client', 'CDN'], ['GW', 'Q'], ['Q', 'CDN'], ['Q', 'GW']].map(pair => JSON.stringify(pair)).sort());
    expect(legsOf(message).has(JSON.stringify(['Client', 'GW']))).toBe(false);
    // a self-message is a leg from its node to itself
    expect([...legsOf({type: 'message', id: 's:2', nodes: ['A', 'A']})]).toEqual([JSON.stringify(['A', 'A'])]);
    expect(legsOf(null).size).toBe(0);
    expect(legsOf({type: 'node', id: 'orders', nodes: ['PG']}).size).toBe(0);
    expect(legsOf({type: 'row', id: 'r', nodes: ['PG']}).size).toBe(0);
  });

  // Decision links-through-node-ids: a selection that is not a node and names several (a message) is a path: only its legs are hot.
  it('lights the boxes a selected message passes through and only the edges between consecutive ones', async () => {
    const view = await ready("{nodes:{A:'a',B:'b',C:'c',D:'d'},edges:[['A','B'],['B','C'],['A','C'],['C','D']]}", `,dir='LR'`);
    const lit = () => nodeIds(view, 'f').filter(id => nodeOf(view, 'f', id).hasAttribute('data-selected'));
    view.setData('/ui/sel', {type: 'message', id: 's:1', label: '1. a to c: go', nodes: ['A', 'B', 'C']});
    expect(lit()).toEqual(['A', 'B', 'C']);
    expect(edgeOf(view, 'f', 'A->B').hasAttribute('data-hot')).toBe(true);
    expect(edgeOf(view, 'f', 'B->C').hasAttribute('data-hot')).toBe(true);
    expect(edgeOf(view, 'f', 'A->C').hasAttribute('data-hot')).toBe(false);
    expect(edgeOf(view, 'f', 'C->D').hasAttribute('data-hot')).toBe(false);
    // nothing brings its neighbours: D is not on the path
    expect(nodeOf(view, 'f', 'D').hasAttribute('data-dim')).toBe(true);
    // a leg is hot in either direction
    view.setData('/ui/sel', {type: 'message', id: 's:2', label: '2. c to a, reply: ok', nodes: ['C', 'B', 'A']});
    expect(['A->B', 'B->C', 'A->C'].map(edge => edgeOf(view, 'f', edge).hasAttribute('data-hot'))).toEqual([true, true, false]);

    // a row linked to one node lights that node alone, with no neighbours
    view.setData('/ui/sel', {type: 'row', id: 'r', label: 'r', nodes: ['A']});
    expect(lit()).toEqual(['A']);
    expect(nodeOf(view, 'f', 'B').hasAttribute('data-dim')).toBe(true);
    expect(view.cell('f').querySelector('[data-edge][data-hot]')).toBeNull();
    // a node selected elsewhere (a sequence actor, a Layers item) is this node: its neighbours light as on a click
    view.setData('/ui/sel', {type: 'node', id: 'C', label: 'Gateway'});
    expect(lit()).toEqual(['C']);
    expect(nodeOf(view, 'f', 'D').hasAttribute('data-dim')).toBe(false);
    expect(edgeOf(view, 'f', 'C->D').hasAttribute('data-hot')).toBe(true);
  });

  it('lets nodes be dragged: edges follow, the position is stored, Re-layout brings the layout back', async () => {
    const view = await ready(GALLERY, `,dir='TB'`);
    const before = positionOf(nodeOf(view, 'f', 'E'));
    const edgeBefore = lineOf(edgeOf(view, 'f', 'RL->E'));
    const other = lineOf(edgeOf(view, 'f', 'H->DB'));
    expect(within(view.cell('f')).queryByRole('button', {name: /Re-layout/})).toBeNull();

    const {k} = viewOf(stageOf(view, 'f'));
    await drag(nodeOf(view, 'f', 'E'), 90, 40);
    // 90 px on screen is 90 / k in the drawing (onto free paper: a node dropped on another is moved off it)
    const after = positionOf(nodeOf(view, 'f', 'E'));
    expect(after.x).toBeCloseTo(before.x + 90 / k, -0.5);
    expect(after.y).toBeCloseTo(before.y + 40 / k, -0.5);
    expect(lineOf(edgeOf(view, 'f', 'RL->E'))).not.toBe(edgeBefore);
    expect(lineOf(edgeOf(view, 'f', 'H->DB'))).toBe(other);
    // its label is still drawn
    expect(view.cell('f').querySelectorAll('[data-edge-label]')).toHaveLength(2);
    const stored = JSON.parse(storage.items.get(POSITIONS_KEY)!);
    expect(Object.keys(stored)).toEqual(['demo/test/f']);
    expect(Object.keys(stored['demo/test/f'])).toEqual(['E']);

    fireEvent.click(within(view.cell('f')).getByRole('button', {name: /Re-layout/}));
    expect(positionOf(nodeOf(view, 'f', 'E'))).toEqual(before);
    expect(lineOf(edgeOf(view, 'f', 'RL->E'))).toBe(edgeBefore);
    expect(JSON.parse(storage.items.get(POSITIONS_KEY)!)).toEqual({});
    expect(within(view.cell('f')).queryByRole('button', {name: /Re-layout/})).toBeNull();
  });

  it('restores dragged positions from storage', async () => {
    storage.items.set(POSITIONS_KEY, JSON.stringify({'demo/test/f': {B: {x: 300, y: 300}, Old: {x: 0, y: 0}}}));
    const view = await ready("[['A','B']]");
    const b = nodeOf(view, 'f', 'B');
    const {w, h} = sizeOf(b);
    expect(positionOf(b)).toEqual({x: 300 - w / 2, y: 300 - h / 2});
    expect(within(view.cell('f')).getByRole('button', {name: /Re-layout/})).toBeTruthy();
  });
});

describe('Flowchart: content-sized and readable (decisions diagrams-open-readable, content-sized-plates, V005)', () => {
  const LOGIN = "{nodes:{Start:{label:'Open login page',shape:'pill'},Form:'Enter email and password',Submit:'Submit credentials',Check:{label:'Credentials valid?',shape:'diamond'},Session:'Create session',Done:{label:'Signed in',shape:'pill'},Fail:'Show error and count the attempt'},edges:[['Start','Form'],['Form','Submit'],['Submit','Check'],['Check','Session','yes'],['Session','Done'],['Check','Fail','no'],['Fail','Form','retry']]}";
  const STATES = "{nodes:{Start:{label:'start',shape:'circle'}},edges:[['Start','Created','show with root='],['Created','Patched','show without root='],['Patched','Patched','show without root='],['Created','Replaced','show with root='],['Patched','Replaced','show with root='],['Replaced','Patched','show without root='],['Created','Deleted','removed'],['Patched','Deleted','removed'],['Replaced','Deleted','removed']]}";

  it('makes an unsized plate as tall as a tall chart, up to 640 px, at 100% instead of shrinking its 11 px labels', async () => {
    const view = renderExpress(`root=Page('T',[f])\nf=Flowchart(${LOGIN},dir='TB',title='Login')`, {size: {width: 618, height: 600}});
    await screen.findByRole('img', {name: /^Flowchart/});
    await drawn(view, 'f');
    expect(zoomOf(view)).toBe(100);
    const height = stageHeight(stageOf(view, 'f'));
    expect(height).toBeGreaterThan(420);
    expect(height).toBeLessThanOrEqual(640);
  });

  // The owner's demo: a short chart opened in a 640 px stage with most of it empty paper.
  it('makes a small chart open fitted and centred, every node inside, the plate no taller than the chart', async () => {
    const view = renderExpress(`root=Page('T',[f])\nf=Flowchart({nodes:{A:'Request',B:'Handler',C:'Store'},edges:[['A','B'],['B','C']]},dir='LR',title='Small')`);
    await screen.findByRole('img', {name: /^Flowchart/});
    await drawn(view, 'f');
    const stage = stageOf(view, 'f');
    expect(stage.parentElement!.getAttribute('data-mode')).toBe('fit');
    const height = stageHeight(stage);
    expect(height).toBeLessThan(200);
    const canvas = height - CONTROLS;
    const boxes = nodeIds(view, 'f').map(id => onStage(stage, nodeOf(view, 'f', id)));
    for (const box of boxes) expect(box.left >= 0 && box.right <= 960 && box.top >= 0 && box.bottom <= canvas).toBe(true);
    // centred: as much paper left as right, and above as below
    const left = Math.min(...boxes.map(b => b.left));
    const right = 960 - Math.max(...boxes.map(b => b.right));
    expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
    const top = Math.min(...boxes.map(b => b.top));
    const bottom = canvas - Math.max(...boxes.map(b => b.bottom));
    expect(Math.abs(top - bottom)).toBeLessThanOrEqual(2);
    expect(viewOf(stage).k).toBe(1);
  });

  // 724 px: the span=7 plate of a 1440 px page, where the chart opened at 91% with '3 of 5 in view': its edge labels
  // held the opening zoom at 91% (they did not grow when zoomed out) and each label cost a whole layer gap. Now the
  // labels grow below 91% (the floor is the 12 px node names: 84%), a labelled gap is the usual gap plus the label, and
  // the view cuts no node: it opens whole when that reads, else on a window of whole nodes with the minimap.
  it.each([560, 724, 960])('opens the labelled states chart in its %s px plate with every text 10 px or more on screen and no node cut', async width => {
    const view = renderExpress(`root=Page('T',[f])\nf=Flowchart(${STATES},dir='LR',title='States')`, {size: {width, height: 600}});
    await screen.findByRole('img', {name: /^Flowchart/});
    await drawn(view, 'f');
    const stage = stageOf(view, 'f');
    const mode = stage.parentElement!.getAttribute('data-mode');
    const {k} = viewOf(stage);
    expect(k).toBeGreaterThanOrEqual(0.84);
    const canvas = stageHeight(stage) - CONTROLS;
    let whole = 0;
    for (const node of view.cell('f').querySelectorAll('[data-node]')) {
      const at = onStage(stage, node);
      const inside = at.left >= -0.5 && at.right <= width + 0.5 && at.top >= -0.5 && at.bottom <= canvas + 0.5;
      const out = at.right <= 0.5 || at.left >= width - 0.5 || at.bottom <= 0.5 || at.top >= canvas - 0.5;
      expect(inside || out, `${node.getAttribute('data-node')} is cut`).toBe(true);
      if (inside) whole++;
    }
    if (mode === 'fit') expect(whole).toBe(5);
    else {
      expect(whole).toBeGreaterThanOrEqual(3);
      expect(view.cell('f').querySelector('[data-in-view]')!.textContent).toMatch(new RegExp(`^${whole}( of |/)5`));
      expect(view.cell('f').querySelector('.react-flow__minimap')).not.toBeNull();
    }
    // node names are 12 px; an edge label is 11 px down to 91% and grows below it, so it stays 10 px on screen
    expect(12 * k).toBeGreaterThanOrEqual(10);
    const labels = [...view.cell('f').querySelectorAll<HTMLElement>('[data-edge-label]')];
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect((Number.parseFloat(label.style.fontSize) || 11) * k, label.textContent!).toBeGreaterThanOrEqual(10);
  });

  it('draws a long edge label on two lines', async () => {
    const view = await ready("[['A','B','show with id and spec, no root']]");
    const label = view.cell('f').querySelector('[data-edge-label]')!;
    expect([...label.querySelectorAll('span')].map(t => t.textContent)).toEqual(['show with id and', 'spec, no root']);
  });
});
