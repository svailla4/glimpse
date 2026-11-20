import {fireEvent, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {POSITIONS_KEY, configurePositionStorage} from '../../src/components/diagrams/edgekit/index.ts';
import {buildPatch, buildSurface, renderExpress, renderSpec} from '../harness.tsx';
import {click, drag, edgeOf, fakeStorage, focus, inside, key, lineOf, nodeIds, nodeOf, pointsOf, positionOf, stageOf, type FakeStorage} from './util.tsx';

const GALLERY = 'Req[Request] --> RL{Over limit?}; RL -->|no| H[Handler]; RL -->|yes| E([429]); H --> DB[(Postgres)]; H -.-> C((cache))';
const spec = (src: string, props = '') => `root=Page('T',[f])\nf=Flowchart('${src}'${props},title='Flow',size='l')`;
const ready = async (src: string, props = '') => {
  const view = renderExpress(spec(src, props));
  await screen.findByRole('img', {name: /^Flowchart/});
  return view;
};

let storage: FakeStorage;
beforeEach(() => {
  storage = fakeStorage();
  configurePositionStorage(storage);
});
afterEach(() => configurePositionStorage(undefined));

describe('Flowchart', () => {
  it('draws every shape, labelled and dashed edges, top to bottom', async () => {
    const view = await ready(GALLERY);
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
    // an edge leaves the bottom of its source and arrives at the top of its target
    const req = positionOf(nodeOf(view, 'f', 'Req'));
    const rl = positionOf(nodeOf(view, 'f', 'RL'));
    const line = pointsOf(lineOf(edgeOf(view, 'f', 'Req->RL')));
    expect(line[0]![1]).toBeGreaterThan(req.y);
    expect(line.at(-1)![1]).toBe(rl.y);
    expect(stageOf(view, 'f').getAttribute('aria-label')).toBe('Flowchart, 6 steps, 5 connections: Request, Over limit?, Handler, 429, Postgres, cache');
    expect(view.errors).toEqual([]);
  });

  it('lays out left to right with dir=LR', async () => {
    const view = await ready(GALLERY, `,dir='LR'`);
    expect(positionOf(nodeOf(view, 'f', 'Req')).x).toBeLessThan(positionOf(nodeOf(view, 'f', 'RL')).x);
    expect(positionOf(nodeOf(view, 'f', 'RL')).x).toBeLessThan(positionOf(nodeOf(view, 'f', 'H')).x);
  });

  it.each([
    ['a Mermaid header and comments', 'flowchart TD\n%% a comment\nA --> B', ['A', 'B'], ['A->B']],
    ['a chain and a fan-out', 'A --> B --> C; A --> D & E', ['A', 'B', 'C', 'D', 'E'], ['A->B', 'A->D', 'A->E', 'B->C']],
    ['a cycle and a self-loop', 'A --> B; B --> A; B --> B', ['A', 'B'], ['A->B', 'B->A', 'B->B']],
    ['text on the arrow', 'A -- maybe later --> B', ['A', 'B'], ['A->B']],
    ['one bare node', 'Solo', ['Solo'], []],
  ])('draws %s', async (_name, src, nodes, edges) => {
    const view = await ready(src);
    expect(nodeIds(view, 'f')).toEqual(nodes);
    expect([...view.cell('f').querySelectorAll('[data-edge]')].map(e => e.getAttribute('data-edge')).sort()).toEqual(edges);
    for (const edge of view.cell('f').querySelectorAll('[data-edge]')) expect(lineOf(edge)).toMatch(/^M[-\d. ]+(?:[LQ][-\d. ]+)+$/);
  });

  it('keeps the two edges of a cycle apart', async () => {
    const view = await ready('A --> B; B --> A');
    expect(lineOf(edgeOf(view, 'f', 'A->B'))).not.toBe(lineOf(edgeOf(view, 'f', 'B->A')));
    const forth = pointsOf(lineOf(edgeOf(view, 'f', 'A->B')));
    const back = pointsOf(lineOf(edgeOf(view, 'f', 'B->A')));
    expect(back[0]![0]).toBe(forth[0]![0] + 8);
  });

  it('shows a redline with the statement and column for a parse error', async () => {
    const view = renderExpress(spec('A --> B; B ~~> C; D --> '));
    await waitFor(() => expect(view.cell('f').querySelector('[data-code="E_NOTATION"]')).not.toBeNull());
    const text = view.cell('f').querySelector('[data-code="E_NOTATION"]')!.textContent!;
    expect(text).toContain('Flowchart#f');
    expect(text).toMatch(/statement 2: expected an arrow .* at column 3/);
    expect(text).toMatch(/statement 3: expected a node id at column \d+, found end of statement/);
    expect(view.cell('f').querySelector('[data-node]')).toBeNull();
  });

  it('shows the empty state for an empty or unbound src, and draws once it is set', async () => {
    const view = renderExpress(`root=Page('T',[f])\nf=Flowchart($/src,title='Flow',size='l')`);
    await waitFor(() => expect(view.cell('f').querySelector('[data-gl-state="empty"]')!.textContent).toBe('no flowchart source'));
    view.setData('/src', '   ');
    expect(view.cell('f').querySelector('[data-gl-state="empty"]')).not.toBeNull();
    view.setData('/src', 'A --> B');
    await waitFor(() => expect(nodeIds(view, 'f')).toEqual(['A', 'B']));
    view.setData('/src', 'A --> B; B --> C{Done?}');
    await waitFor(() => expect(nodeIds(view, 'f')).toEqual(['A', 'B', 'C']));
    view.setData('/src', 'A -->');
    await waitFor(() => expect(view.cell('f').querySelector('[data-code="E_NOTATION"]')).not.toBeNull());
    view.setData('/src', 42);
    await waitFor(() => expect(view.cell('f').querySelector('[data-gl-state="empty"]')).not.toBeNull());
  });

  it('follows a patch that replaces the source', async () => {
    const base = buildSurface('test', spec('A --> B'));
    const view = renderSpec(base);
    await waitFor(() => expect(nodeIds(view, 'f')).toEqual(['A', 'B']));
    view.send(buildPatch('test', base, `f=Flowchart('X([Start]) --> Y --> Z',title='Flow',size='l')`));
    await waitFor(() => expect(nodeIds(view, 'f')).toEqual(['X', 'Y', 'Z']));
    expect(view.errors).toEqual([]);
  });

  it('wraps and cuts a 500-character label', async () => {
    const view = await ready(`A[${'long label '.repeat(45)}] --> B`);
    const lines = [...nodeOf(view, 'f', 'A').querySelectorAll('tspan')].map(t => t.textContent!);
    expect(lines).toHaveLength(3);
    expect(lines[2]!.endsWith('…')).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThan(40);
  });

  it('selects a node, dims what is not connected to it, and walks with the arrow keys', async () => {
    const view = await ready(GALLERY);
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

  it('lets nodes be dragged: edges follow, the position is stored, Re-layout brings the layout back', async () => {
    const view = await ready(GALLERY);
    const stage = stageOf(view, 'f');
    const before = positionOf(nodeOf(view, 'f', 'E'));
    const edgeBefore = lineOf(edgeOf(view, 'f', 'RL->E'));
    const other = lineOf(edgeOf(view, 'f', 'H->DB'));
    expect(within(view.cell('f')).queryByRole('button', {name: /Re-layout/})).toBeNull();

    drag(stage, nodeOf(view, 'f', 'E'), -90, 40);
    const after = positionOf(nodeOf(view, 'f', 'E'));
    expect(after).toEqual({x: before.x - 90, y: before.y + 40});
    const edgeAfter = lineOf(edgeOf(view, 'f', 'RL->E'));
    expect(edgeAfter).not.toBe(edgeBefore);
    // the edge still starts at the diamond and now ends on top of the moved pill
    expect(pointsOf(edgeAfter)[0]).toEqual(pointsOf(edgeBefore)[0]);
    expect(pointsOf(edgeAfter).at(-1)![1]).toBe(after.y);
    expect(pointsOf(edgeAfter).at(-1)![0]).toBe(pointsOf(edgeBefore).at(-1)![0] - 90);
    expect(lineOf(edgeOf(view, 'f', 'H->DB'))).toBe(other);
    // its label moved with it
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
    const view = await ready('A --> B');
    const b = nodeOf(view, 'f', 'B');
    const size = b.querySelector('rect')!;
    expect(positionOf(b)).toEqual({x: 300 - Number(size.getAttribute('width')) / 2, y: 300 - Number(size.getAttribute('height')) / 2});
    expect(within(view.cell('f')).getByRole('button', {name: /Re-layout/})).toBeTruthy();
  });
});
