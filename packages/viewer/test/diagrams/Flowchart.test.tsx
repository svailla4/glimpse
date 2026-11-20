import {fireEvent, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {headerDir} from '../../src/components/diagrams/Flowchart.tsx';
import {CONTROLS, POSITIONS_KEY, configurePositionStorage} from '../../src/components/diagrams/flowkit/index.ts';
import {buildPatch, buildSurface, renderExpress, renderSpec} from '../harness.tsx';
import {
  click, drag, drawn, edgeOf, elk, fakeStorage, focus, inside, key, lineOf, nodeIds, nodeOf, onStage, pointsOf, positionOf, runsAlong, sizeOf, stageHeight,
  stageOf, viewOf, type FakeStorage,
} from './util.tsx';

const GALLERY = 'flowchart TD; Req[Request] --> RL{Over limit?}; RL -->|no| H[Handler]; RL -->|yes| E([429]); H --> DB[(Postgres)]; H -.-> C((cache))';
const spec = (src: string, props = '') => `root=Page('T',[f])\nf=Flowchart('${src}'${props},title='Flow',size='l')`;
const ready = async (src: string, props = '') => {
  const view = renderExpress(spec(src, props));
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

  // The owner's demo: 'graph LR; ...' drew top to bottom, because the header's direction was dropped.
  it.each([
    ['graph LR', 'LR', 'RIGHT'],
    ['flowchart LR', 'LR', 'RIGHT'],
    ['graph TD', 'TB', 'DOWN'],
    ['flowchart TB', 'TB', 'DOWN'],
    ['graph RL', 'RL', 'LEFT'],
    ['flowchart BT', 'BT', 'UP'],
  ])('honours the direction of a "%s" header when dir is not given', async (header, dir, elkDir) => {
    const view = await ready(`${header}; M[main.ts]-->A[AuthProvider]; A-->R[AppRoot]`);
    expect(stageOf(view, 'f').getAttribute('data-dir')).toBe(dir);
    expect(elk.requests.at(-1)!.graph.layoutOptions!['elk.direction']).toBe(elkDir);
    const m = positionOf(nodeOf(view, 'f', 'M'));
    const r = positionOf(nodeOf(view, 'f', 'R'));
    if (dir === 'LR') expect(m.x).toBeLessThan(r.x);
    if (dir === 'RL') expect(m.x).toBeGreaterThan(r.x);
    if (dir === 'TB') expect(m.y).toBeLessThan(r.y);
    if (dir === 'BT') expect(m.y).toBeGreaterThan(r.y);
  });

  it('lets dir win over the header, and reads a header after blank lines and comments', async () => {
    const view = await ready('graph LR; A-->B; B-->C', `,dir='TB'`);
    expect(stageOf(view, 'f').getAttribute('data-dir')).toBe('TB');
    expect(positionOf(nodeOf(view, 'f', 'A')).y).toBeLessThan(positionOf(nodeOf(view, 'f', 'C')).y);
    expect(headerDir('\n%% the start\n  graph LR\nA --> B')).toBe('LR');
    expect(headerDir('graph lr; A --> B')).toBe('LR');
    expect(headerDir('graph; A --> B')).toBeUndefined();
    expect(headerDir('A --> B; graph LR')).toBeUndefined();
    expect(headerDir('')).toBeUndefined();
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
    // The way back goes round the side: the two never share a stretch of line.
    const forth = pointsOf(lineOf(edgeOf(view, 'f', 'A->B'))).map(([x, y]) => ({x, y}));
    const back = pointsOf(lineOf(edgeOf(view, 'f', 'B->A'))).map(([x, y]) => ({x, y}));
    expect(runsAlong(forth, back)).toBe(false);
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
    const view = await ready('A --> B');
    const b = nodeOf(view, 'f', 'B');
    const {w, h} = sizeOf(b);
    expect(positionOf(b)).toEqual({x: 300 - w / 2, y: 300 - h / 2});
    expect(within(view.cell('f')).getByRole('button', {name: /Re-layout/})).toBeTruthy();
  });

  it('draws nodes written as plain words: the words are the label, and a question is a diamond (F044)', async () => {
    const view = await ready('Start --> Enter credentials --> Valid?; Valid? -- yes --> Session');
    const cell = view.cell('f');
    expect(nodeIds(view, 'f')).toHaveLength(4);
    expect(cell.querySelector('[data-gl-state="redline"]')).toBeNull();
    const labels = [...cell.querySelectorAll('[data-node]')].map(node => node.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Start', 'Enter credentials', 'Valid?', 'Session']));
    const question = [...cell.querySelectorAll('[data-node]')].find(node => node.textContent === 'Valid?')!;
    expect(question.querySelector('polygon')).not.toBeNull();
    expect(cell.querySelectorAll('[data-edge]')).toHaveLength(3);
  });
});

describe('Flowchart: content-sized and readable (decisions D18, D20, V005)', () => {
  const LOGIN = 'Start([Open login page]) --> Form[Enter email and password]\\nForm --> Submit[Submit credentials]\\nSubmit --> Check{Credentials valid?}\\nCheck -->|yes| Session[Create session]\\nSession --> Done([Signed in])\\nCheck -->|no| Fail[Show error and count the attempt]\\nFail -->|retry| Form';
  const STATES = 'Start((start)) -->|show with root=| Created\\nCreated -->|show without root=| Patched\\nPatched -->|show without root=| Patched\\nCreated -->|show with root=| Replaced\\nPatched -->|show with root=| Replaced\\nReplaced -->|show without root=| Patched\\nCreated -->|removed| Deleted\\nPatched -->|removed| Deleted\\nReplaced -->|removed| Deleted';

  it('makes an unsized plate as tall as a tall chart, up to 640 px, at 100% instead of shrinking its 11 px labels', async () => {
    const view = renderExpress(`root=Page('T',[f])\nf=Flowchart('${LOGIN}',dir='TB',title='Login')`, {size: {width: 618, height: 600}});
    await screen.findByRole('img', {name: /^Flowchart/});
    await drawn(view, 'f');
    expect(zoomOf(view)).toBe(100);
    const height = stageHeight(stageOf(view, 'f'));
    expect(height).toBeGreaterThan(420);
    expect(height).toBeLessThanOrEqual(640);
  });

  // The owner's demo: a short chart opened in a 640 px stage with most of it empty paper.
  it('makes a small chart open fitted and centred, every node inside, the plate no taller than the chart', async () => {
    const view = renderExpress(`root=Page('T',[f])\nf=Flowchart('graph LR; A[Request] --> B[Handler] --> C[Store]',title='Small')`);
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
    const view = renderExpress(`root=Page('T',[f])\nf=Flowchart('${STATES}',dir='LR',title='States')`, {size: {width, height: 600}});
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
    const view = await ready('A -->|show with id and spec, no root| B');
    const label = view.cell('f').querySelector('[data-edge-label]')!;
    expect([...label.querySelectorAll('span')].map(t => t.textContent)).toEqual(['show with id and', 'spec, no root']);
  });
});
