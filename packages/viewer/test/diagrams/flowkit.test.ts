// The diagram engine without a DOM (decisions D19, D20): the ELK graph a diagram asks for and what is made of ELK's
// answer (ELK itself runs here in-process, as in the worker), the height and opening view, and the geometry, text and
// position helpers the diagrams still use.
import type {ElkExtendedEdge, ElkNode} from 'elkjs/lib/elk-api.js';
import ELK from 'elkjs/lib/elk.bundled.js';
import {afterEach, describe, expect, it} from 'vitest';
import {LABEL_FLOOR, framesAround, minimapSpot} from '../../src/components/diagrams/flowkit/Diagram.tsx';
import {
  CONTROLS, GROUP_PAD, MIN_HEIGHT, MONO_11, PAD, POSITIONS_KEY, READABLE_ZOOM, UI_12, boundsOf, clipToShapes, configurePositionStorage, cutAt,
  fitText, freeSpot, fromElk, hasCycle, labelPlate, markPath, midpoint, nearestInDirection, outlineInset, partCount, positionsKey, readPositions,
  readableZoom, roundedPath, routeAround, runsAlongFrame, scoreLayout, signatureOf, simplify, sizeDiagram, textWidth, toElk, wrapText,
  writePositions,
  type Box, type Laid, type LayoutSpec, type Point,
} from '../../src/components/diagrams/flowkit/index.ts';
import {labelGrowth} from '../../src/components/diagrams/flowkit/parts.tsx';
import {crosses, fakeStorage} from './util.tsx';

const elk = new ELK();
const lay = async (spec: LayoutSpec): Promise<Laid> => fromElk(await elk.layout(toElk(spec)), spec);
const box = (x: number, y: number, w = 100, h = 40): Box => ({x, y, w, h});
/** Every segment of an orthogonal route runs along one axis. */
const orthogonal = (points: readonly Point[]) => points.every((p, i) => i === 0 || Math.abs(p.x - points[i - 1]!.x) < 0.5 || Math.abs(p.y - points[i - 1]!.y) < 0.5);
const inside = (inner: Box, outer: Box, slack = 0.5) =>
  inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.w <= outer.x + outer.w + slack && inner.y + inner.h <= outer.y + outer.h + slack;
const node = (id: string, group?: string, w = 120, h = 32) => ({id, w, h, ...(group ? {group} : {})});

describe('toElk: what a diagram asks ELK for', () => {
  it('asks for a layered layout over the whole hierarchy, orthogonal edges in root coordinates, in the direction given', () => {
    const graph = toElk({dir: 'LR', nodes: [node('a'), node('b')], edges: [{key: '0', from: 'a', to: 'b'}]});
    expect(graph.layoutOptions).toMatchObject({
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL', 'elk.json.edgeCoords': 'ROOT',
    });
    expect(toElk({dir: 'TB', nodes: [], edges: []}).layoutOptions!['elk.direction']).toBe('DOWN');
    expect(toElk({dir: 'RL', nodes: [], edges: []}).layoutOptions!['elk.direction']).toBe('LEFT');
    expect(toElk({dir: 'BT', nodes: [], edges: []}).layoutOptions!['elk.direction']).toBe('UP');
    expect(graph.children!.map(child => [child.id, child.width, child.height])).toEqual([['a', 120, 32], ['b', 120, 32]]);
    // every edge on the root, with opaque ids
    expect(graph.edges).toEqual([{id: '\u0000e0', sources: ['a'], targets: ['b']}]);
  });

  it('makes a group a compound node with room for its label, and leaves out groups that hold nothing', () => {
    const graph = toElk({
      dir: 'LR',
      nodes: [node('a', 'g'), node('b', 'inner'), node('c', 'unknown')],
      edges: [],
      groups: [{id: 'g', minWidth: 300}, {id: 'inner', parent: 'g'}, {id: 'empty'}, {id: 'loop1', parent: 'loop2'}, {id: 'loop2', parent: 'loop1'}],
    });
    // the group and the lone node share no edge: two parts, the group's in a box of its own, the lone node beside it
    const part = graph.children![0]!;
    expect(part.id.startsWith('\u0000')).toBe(true);
    const g = part.children!.find(child => child.id === 'g')!;
    expect(g.layoutOptions).toMatchObject({'elk.padding': `[top=${GROUP_PAD.top},left=${GROUP_PAD.side},bottom=${GROUP_PAD.bottom},right=${GROUP_PAD.side}]`, 'elk.nodeSize.minimum': '(300, 0)'});
    expect(g.children!.map(child => child.id).sort()).toEqual(['a', 'inner']);
    expect(g.children!.find(child => child.id === 'inner')!.children!.map(child => child.id)).toEqual(['b']);
    // a node of a group that does not exist is drawn on its own; a group without members has no frame
    expect(graph.children!.map(child => child.id)).toEqual([part.id, 'c']);
    expect(part.children!.map(child => child.id)).toEqual(['g']);
  });

  it('attaches an edge at a row through a fixed port on the side the flow leaves or enters by', () => {
    const graph = toElk({dir: 'LR', nodes: [node('t', undefined, 160, 92), node('u', undefined, 160, 70)], edges: [{key: '0', from: 't', to: 'u', fromPort: 37, toPort: 59}]});
    const t = graph.children![0]!;
    const u = graph.children![1]!;
    expect(t.layoutOptions).toEqual({'elk.portConstraints': 'FIXED_POS'});
    expect(t.ports).toEqual([{id: expect.any(String), x: 160, y: 36.5, width: 1, height: 1, layoutOptions: {'elk.port.side': 'EAST'}}]);
    expect(u.ports).toEqual([{id: expect.any(String), x: -1, y: 58.5, width: 1, height: 1, layoutOptions: {'elk.port.side': 'WEST'}}]);
    expect(graph.edges![0]!.sources).toEqual([t.ports![0]!.id]);
    expect(graph.edges![0]!.targets).toEqual([u.ports![0]!.id]);
  });

  it('puts each label on its edge (a label option), and lays a dense diagram out with shared ends and closer lanes', () => {
    const graph = toElk({dir: 'LR', nodes: [node('a'), node('b')], edges: [{key: '0', from: 'a', to: 'b', label: {w: 40, h: 16}}], dense: true});
    expect((graph.edges![0] as ElkExtendedEdge).labels).toEqual([{text: ' ', width: 40, height: 16, layoutOptions: {'elk.edgeLabels.inline': 'true'}}]);
    expect(graph.layoutOptions!['elk.layered.mergeEdges']).toBe('true');
    expect(Number(graph.layoutOptions!['elk.spacing.edgeEdge'])).toBeLessThan(Number(toElk({dir: 'LR', nodes: [], edges: []}).layoutOptions!['elk.spacing.edgeEdge']));
  });

  it('has one signature per layout input', () => {
    const spec: LayoutSpec = {dir: 'LR', nodes: [node('a'), node('b')], edges: [{key: '0', from: 'a', to: 'b'}]};
    expect(signatureOf(spec)).toBe(signatureOf(structuredClone(spec)));
    expect(signatureOf(spec)).not.toBe(signatureOf({...spec, dir: 'TB'}));
    expect(signatureOf(spec)).not.toBe(signatureOf({...spec, nodes: [node('a'), node('b', undefined, 130)]}));
    expect(signatureOf(spec)).not.toBe(signatureOf({...spec, edges: [{key: '0', from: 'a', to: 'b', label: {w: 20, h: 16}}]}));
    expect(signatureOf(spec)).not.toBe(signatureOf({...spec, dense: true}));
  });
});

describe('fromElk: ELK lays the diagram out (in-process here, in the worker in the browser)', () => {
  it('places every node without overlap, routes every edge orthogonally from its source to its target', async () => {
    const laid = await lay({dir: 'LR', nodes: ['a', 'b', 'c', 'd'].map(id => node(id)), edges: [{key: '0', from: 'a', to: 'b'}, {key: '1', from: 'b', to: 'c'}, {key: '2', from: 'a', to: 'd'}]});
    const boxes = [...laid.boxes.values()];
    expect(boxes).toHaveLength(4);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(inside(boxes[i]!, boxes[j]!) || boxes[i]!.x + boxes[i]!.w <= boxes[j]!.x || boxes[j]!.x + boxes[j]!.w <= boxes[i]!.x || boxes[i]!.y + boxes[i]!.h <= boxes[j]!.y || boxes[j]!.y + boxes[j]!.h <= boxes[i]!.y).toBe(true);
    // the flow runs left to right
    expect(laid.boxes.get('a')!.x).toBeLessThan(laid.boxes.get('b')!.x);
    expect(laid.boxes.get('b')!.x).toBeLessThan(laid.boxes.get('c')!.x);
    for (const [key, route] of laid.routes) {
      expect(orthogonal(route.points), `edge ${key}`).toBe(true);
    }
    const ab = laid.routes.get('0')!.points;
    const a = laid.boxes.get('a')!;
    const b = laid.boxes.get('b')!;
    expect(Math.abs(ab[0]!.x - (a.x + a.w))).toBeLessThanOrEqual(1);
    expect(Math.abs(ab.at(-1)!.x - b.x)).toBeLessThanOrEqual(1);
    // the bounds hold everything drawn
    for (const bx of boxes) expect(inside(bx, laid.bounds)).toBe(true);
  });

  it('lays out top to bottom with dir TB', async () => {
    const laid = await lay({dir: 'TB', nodes: [node('a'), node('b')], edges: [{key: '0', from: 'a', to: 'b'}]});
    expect(laid.boxes.get('a')!.y + laid.boxes.get('a')!.h).toBeLessThan(laid.boxes.get('b')!.y);
    expect(laid.dir).toBe('TB');
  });

  // D19: a group is sized around its children, and an edge is never drawn through a group it does not belong to.
  it('sizes every group around its members, below its label band, and routes no edge through a group it does not belong to', async () => {
    const groups = [{id: 'api'}, {id: 'core'}, {id: 'ui'}, {id: 'ui/forms', parent: 'ui'}];
    const nodes = [
      node('api/routes', 'api'), node('api/auth', 'api'), node('api/jobs', 'api'),
      node('core/model', 'core'), node('core/store', 'core'),
      node('ui/app', 'ui'), node('ui/forms/login', 'ui/forms'), node('ui/forms/signup', 'ui/forms'),
      node('log'),
    ];
    const edges = [
      ['ui/app', 'ui/forms/login'], ['ui/app', 'ui/forms/signup'], ['ui/forms/login', 'api/auth'], ['ui/forms/signup', 'api/auth'],
      ['ui/app', 'api/routes'], ['api/routes', 'core/model'], ['api/auth', 'core/store'], ['api/jobs', 'core/store'], ['api/routes', 'api/jobs'],
      ['core/store', 'log'], ['ui/app', 'log'], ['api/jobs', 'log'],
    ].map(([from, to], i) => ({key: String(i), from: from!, to: to!}));
    const groupOf = new Map(nodes.map(n => [n.id, n.group]));
    const parentOf = new Map(groups.map(g => [g.id, g.parent]));
    /** The groups a node is in, innermost first. */
    const chain = (id: string) => {
      const out: string[] = [];
      for (let at = groupOf.get(id); at !== undefined; at = parentOf.get(at)) out.push(at);
      return out;
    };
    for (const dir of ['LR', 'TB'] as const) {
      const laid = await lay({dir, nodes, edges, groups});
      expect([...laid.frames.keys()].sort()).toEqual(['api', 'core', 'ui', 'ui/forms']);
      for (const n of nodes) {
        for (const group of chain(n.id)) {
          const frame = laid.frames.get(group)!;
          const b = laid.boxes.get(n.id)!;
          expect(inside(b, frame), `${n.id} inside ${group} (${dir})`).toBe(true);
          // below the band the label is drawn in
          expect(b.y - frame.y, `${n.id} under the label of ${group}`).toBeGreaterThanOrEqual(GROUP_PAD.top - 0.5);
        }
      }
      expect(inside(laid.frames.get('ui/forms')!, laid.frames.get('ui')!)).toBe(true);
      for (const edge of edges) {
        const route = laid.routes.get(edge.key)!.points;
        const own = new Set([...chain(edge.from), ...chain(edge.to)]);
        for (const [group, frame] of laid.frames) {
          if (own.has(group)) continue;
          expect(crosses(route, frame), `${edge.from} -> ${edge.to} through ${group} (${dir})`).toBe(false);
        }
        // and never through a node that is not one of its ends
        for (const [id, b] of laid.boxes) if (id !== edge.from && id !== edge.to) expect(crosses(route, b), `${edge.from} -> ${edge.to} through ${id}`).toBe(false);
      }
    }
  });

  // D19: an ER relation ends at the row of its column, on the table's side.
  it('connects table columns at their ports: the route starts and ends at the rows, on the sides', async () => {
    const HEAD = 26;
    const ROW = 22;
    const rowY = (i: number) => HEAD + i * ROW + ROW / 2;
    for (const dir of ['LR', 'TB'] as const) {
      const laid = await lay({
        dir,
        nodes: [node('users', undefined, 168, HEAD + 4 * ROW), node('orders', undefined, 168, HEAD + 3 * ROW), node('items', undefined, 168, HEAD + 3 * ROW)],
        edges: [
          {key: '0', from: 'orders', to: 'users', fromPort: rowY(1), toPort: rowY(0)},
          {key: '1', from: 'items', to: 'orders', fromPort: rowY(2), toPort: rowY(0)},
        ],
      });
      for (const [key, from, to, fromRow, toRow] of [['0', 'orders', 'users', 1, 0], ['1', 'items', 'orders', 2, 0]] as const) {
        const route = laid.routes.get(key)!.points;
        const a = laid.boxes.get(from)!;
        const b = laid.boxes.get(to)!;
        const start = route[0]!;
        const end = route.at(-1)!;
        expect(Math.abs(start.y - (a.y + rowY(fromRow))), `${key} starts at its row (${dir})`).toBeLessThanOrEqual(1);
        expect(Math.abs(end.y - (b.y + rowY(toRow))), `${key} ends at its row (${dir})`).toBeLessThanOrEqual(1);
        // on a side, not the top or the bottom
        expect(Math.min(Math.abs(start.x - a.x), Math.abs(start.x - (a.x + a.w)))).toBeLessThanOrEqual(1.5);
        expect(Math.min(Math.abs(end.x - b.x), Math.abs(end.x - (b.x + b.w)))).toBeLessThanOrEqual(1.5);
        expect(orthogonal(route)).toBe(true);
      }
    }
  });

  it('puts each label on its own edge, clear of every node', async () => {
    const plate = labelPlate('validates');
    const laid = await lay({
      dir: 'LR',
      nodes: ['a', 'b', 'c', 'd'].map(id => node(id)),
      edges: [{key: '0', from: 'a', to: 'b', label: plate}, {key: '1', from: 'a', to: 'c', label: plate}, {key: '2', from: 'a', to: 'd', label: labelPlate('a much longer label that wraps')}],
    });
    for (const [key, route] of laid.routes) {
      const label = route.label!;
      const centre = {x: label.x + label.w / 2, y: label.y + label.h / 2};
      // the route passes through the label plate
      expect(crosses(route.points, {x: label.x - 1, y: label.y - 1, w: label.w + 2, h: label.h + 2}, 0), `label ${key} on its edge`).toBe(true);
      for (const b of laid.boxes.values()) expect(crosses([centre, centre], b, 0) && inside({...centre, w: 0, h: 0}, b)).toBe(false);
    }
  });

  it('ends an edge on the outline of a diamond or a circle, not on its bounding box', async () => {
    const laid = await lay({
      dir: 'TB',
      nodes: [node('start'), {id: 'ask', w: 120, h: 64, shape: 'diamond'}, {id: 'end', w: 56, h: 56, shape: 'circle'}],
      edges: [{key: '0', from: 'start', to: 'ask'}, {key: '1', from: 'ask', to: 'end'}],
    });
    const ask = laid.boxes.get('ask')!;
    const into = laid.routes.get('0')!.points.at(-1)!;
    // at the top vertex, or on a slope below the box's top edge
    const dx = Math.abs(into.x - (ask.x + ask.w / 2));
    expect(into.y - ask.y).toBeCloseTo((ask.h / 2) * Math.min(1, dx / (ask.w / 2)), 0);
    const out = laid.routes.get('1')!.points[0]!;
    expect(ask.y + ask.h - out.y).toBeCloseTo((ask.h / 2) * Math.min(1, Math.abs(out.x - (ask.x + ask.w / 2)) / (ask.w / 2)), 0);
  });

  it('accepts an empty diagram, a single node and a self-loop', async () => {
    expect((await lay({dir: 'LR', nodes: [], edges: []})).boxes.size).toBe(0);
    const one = await lay({dir: 'LR', nodes: [node('a')], edges: [{key: '0', from: 'a', to: 'a', label: {w: 30, h: 16}}]});
    expect(one.boxes.get('a')).toMatchObject({w: 120, h: 32});
    const loop = one.routes.get('0')!;
    expect(loop.points.length).toBeGreaterThanOrEqual(3);
    expect(orthogonal(loop.points)).toBe(true);
    expect(loop.label).toBeDefined();
  });

  it('lays out the 150-node cap with groups in well under a second', async () => {
    const nodes = Array.from({length: 150}, (_, i) => node(`n${i}`, `g${i % 12}`));
    const edges = Array.from({length: 220}, (_, i) => ({key: String(i), from: `n${(i * 7) % 150}`, to: `n${(i * 13 + 5) % 150}`}));
    const groups = Array.from({length: 12}, (_, i) => ({id: `g${i}`}));
    const started = performance.now();
    const laid = await lay({dir: 'LR', nodes, edges, groups, dense: true});
    expect(performance.now() - started).toBeLessThan(5000);
    expect(laid.boxes.size).toBe(150);
    expect(laid.frames.size).toBe(12);
  });
});

describe('sizeDiagram: the height and the opening view (D20)', () => {
  const sized = (bounds: Box, width: number, cap: number, floor = READABLE_ZOOM, extra: Partial<Parameters<typeof sizeDiagram>[0]> = {}) =>
    sizeDiagram({bounds, width, cap, floor, readable: Math.max(READABLE_ZOOM, floor), dir: 'LR', ...extra});

  it('is as tall as the drawing at 100% when it fits the width, plus its paper and the controls bar', () => {
    const s = sized(box(0, 0, 600, 200), 1000, 640);
    expect(s).toMatchObject({mode: 'fit', height: 200 + PAD * 2 + CONTROLS, canvas: 200 + PAD * 2});
    expect(s.view.zoom).toBe(1);
    // centred
    expect(s.view.x).toBe(200);
    expect(s.view.y).toBe(PAD);
  });

  it('scales a wide drawing to the width (never above 100%) and is as tall as it then is, never under 140 px', () => {
    // a diagram whose nodes keep readable faces when zoomed out (Graph's levels of detail): a floor of 40%
    const s = sized(box(0, 0, 1200, 300), 632, 640, 0.4);
    expect(s.mode).toBe('fit');
    expect(s.view.zoom).toBeCloseTo(0.5);
    expect(s.height).toBe(150 + PAD * 2 + CONTROLS);
    const flat = sized(box(0, 0, 1200, 40), 1232, 640);
    // with text that does not grow when zoomed out, the same drawing is too wide to read whole
    expect(sized(box(0, 0, 1200, 300), 632, 640).mode).toBe('readable');
    expect(flat.height).toBe(MIN_HEIGHT);
    expect(flat.view.zoom).toBe(1);
    // a drawing with the origin elsewhere is centred all the same
    const moved = sized(box(-50, 30, 600, 200), 1000, 640);
    expect(moved.view.x + -50 * moved.view.zoom).toBe(200);
  });

  it('caps the height at the size step and fits under it while the text stays readable', () => {
    const s = sized(box(0, 0, 400, 800), 1000, 420, 0.4);
    expect(s.height).toBe(420);
    expect(s.mode).toBe('fit');
    expect(s.view.zoom).toBeCloseTo((420 - CONTROLS - PAD * 2) / 800, 5);
    // every node inside the canvas, centred
    expect(s.view.y).toBeCloseTo(PAD);
    expect(s.view.x).toBeCloseTo((1000 - 400 * s.view.zoom) / 2);
    // past the floor it opens readable instead, still within the cap
    const readable = sized(box(0, 0, 400, 800), 1000, 420);
    expect(readable.mode).toBe('readable');
    expect(readable.height).toBeLessThanOrEqual(420);
  });

  it('opens a drawing too large to read whole at the readable zoom, at the start of the flow, never past its ends', () => {
    const bounds = box(0, 0, 3000, 300);
    const s = sized(bounds, 800, 640, readableZoom(11));
    expect(s.mode).toBe('readable');
    expect(s.view.zoom).toBe(readableZoom(11));
    // the first layer at the left edge, with the paper of a fitted drawing
    expect(s.view.x).toBe(PAD);
    // as tall as the drawing at that zoom
    expect(s.canvas).toBe(Math.ceil(300 * s.view.zoom) + PAD * 2);
    // right to left: the flow starts at the right edge
    const rl = sized(bounds, 800, 640, readableZoom(11), {dir: 'RL'});
    expect(rl.view.x + 3000 * rl.view.zoom).toBe(800 - PAD);
    // top to bottom, centred across the flow on the anchor, clamped to the drawing
    const tall = sized(box(0, 0, 3000, 3000), 800, 640, readableZoom(11), {dir: 'TB', anchor: {x: 1500, y: 20}});
    expect(tall.view.y).toBe(PAD);
    expect(tall.view.x).toBeCloseTo(400 - 1500 * tall.view.zoom);
    const edge = sized(box(0, 0, 3000, 3000), 800, 640, readableZoom(11), {dir: 'TB', anchor: {x: 10, y: 20}});
    expect(edge.view.x).toBe(PAD);
  });

  it('ends the canvas between two rows instead of through a node, and moves across the flow so no node is cut at a side', () => {
    const rows = [0, 120, 240, 360, 480, 600].flatMap(y => [box(0, y, 160, 60), box(400, y, 160, 60), box(800, y, 160, 60), box(1200, y, 160, 60)]);
    const bounds = boundsOf(rows)!;
    const s = sized(bounds, 700, 420, 0.91, {dir: 'TB', boxes: rows, anchor: {x: 80, y: 30}});
    expect(s.mode).toBe('readable');
    expect(cutAt(rows, s.view, 'y', s.canvas)).toBe(0);
    expect(cutAt(rows, s.view, 'x', 700)).toBe(0);
    expect(s.height).toBeLessThanOrEqual(420);
    expect(s.height).toBeGreaterThanOrEqual(MIN_HEIGHT);
    // the flow still starts at the top
    expect(s.view.y).toBe(PAD);
  });

  it('cuts a tall node rather than leave it out with more than a quarter of the canvas', () => {
    // a table of many rows under a short one: ending above the tall table would leave a third of the canvas
    const tables = [box(0, 0, 200, 92), box(0, 124, 200, 312), box(300, 20, 200, 92)];
    const s = sized(boundsOf(tables)!, 1000, 420, 0.91, {dir: 'LR', boxes: tables});
    expect(s.mode).toBe('readable');
    expect(s.canvas).toBe(420 - CONTROLS);
  });

  it('chooses the direction that shows a diagram larger at the width it has', () => {
    const wide = box(0, 0, 1400, 200);
    const tall = box(0, 0, 300, 1100);
    expect(scoreLayout(wide, 1300, 640, 0.84)).toBeGreaterThan(scoreLayout(tall, 1300, 640, 0.84));
    expect(scoreLayout(tall, 500, 640, 0.84)).toBeGreaterThan(scoreLayout(wide, 500, 640, 0.84));
    // whole beats in part
    expect(scoreLayout(box(0, 0, 300, 200), 600, 640, 0.84)).toBeGreaterThan(0);
    expect(scoreLayout(box(0, 0, 9000, 200), 600, 640, 0.84)).toBeLessThan(0);
  });

  it('works out the zoom at which text is 10 px on screen', () => {
    expect(readableZoom(12)).toBe(0.84);
    expect(readableZoom(11)).toBe(0.91);
    expect(readableZoom(10)).toBe(1);
    expect(READABLE_ZOOM * 12).toBeGreaterThanOrEqual(10);
  });
});

// Review round after the swap (findings on loops, labels, packing, wrapping, the opening window, dragging).
describe('what ELK is asked, round 2', () => {
  const edgesOf = (pairs: ReadonlyArray<readonly [string, string]>) => pairs.map(([from, to], i) => ({key: String(i), from, to}));
  const y = (laid: Laid, id: string) => laid.boxes.get(id)!.y;

  // A state machine was drawn with Paused on top and Idle (the first state) at the bottom: ELK's default cycle
  // breaking ignored the order the states were written in.
  it('breaks a loop at the edge back to an earlier node, and never turns round an edge that is in no loop', async () => {
    const machine = await lay({dir: 'TB', nodes: ['Idle', 'Running', 'Paused', 'Stopped'].map(id => node(id)), edges: edgesOf([['Idle', 'Running'], ['Running', 'Paused'], ['Paused', 'Running'], ['Running', 'Stopped'], ['Stopped', 'Idle']])});
    expect(y(machine, 'Idle')).toBeLessThan(y(machine, 'Running'));
    expect(y(machine, 'Running')).toBeLessThan(y(machine, 'Paused'));
    expect(y(machine, 'Running')).toBeLessThan(y(machine, 'Stopped'));
    const loop = await lay({dir: 'TB', nodes: ['A', 'B', 'C'].map(id => node(id)), edges: edgesOf([['A', 'B'], ['B', 'C'], ['B', 'A']])});
    expect(y(loop, 'A')).toBeLessThan(y(loop, 'B'));
    expect(y(loop, 'B')).toBeLessThan(y(loop, 'C'));
    // listed target first, as a schema lists its tables: the edge still points down
    const listed = await lay({dir: 'TB', nodes: [node('users'), node('sessions')], edges: edgesOf([['sessions', 'users']])});
    expect(y(listed, 'sessions')).toBeLessThan(y(listed, 'users'));
    expect(toElk({dir: 'TB', nodes: [], edges: []}).layoutOptions!['elk.layered.cycleBreaking.strategy']).toBe('GREEDY_MODEL_ORDER');
  });

  // An eight-node TB graph with seven labelled edges was 62% taller than without its labels: each centre label took a
  // layer of its own with a full layer gap on each side.
  it('keeps a labelled graph within 1.3 times the height of the same graph without labels', async () => {
    const nodes = ['checks', 'rules', 'core', 'tool', 'model', 'store', 'surface', 'stream'].map(id => node(id, undefined, 168, 40));
    const pairs = [['rules', 'core', 'when'], ['checks', 'core', 'checks'], ['core', 'tool', 'calls'], ['tool', 'model', 'validates'], ['tool', 'store', 'reads'], ['tool', 'surface', 'metadata'], ['surface', 'stream', 'v0.9']] as const;
    const plain = await lay({dir: 'TB', nodes, edges: edgesOf(pairs.map(([a, b]) => [a, b] as const)), layerGap: 40, nodeGap: 16});
    const labelled = await lay({dir: 'TB', nodes, edges: pairs.map(([from, to, text], i) => ({key: String(i), from, to, label: labelPlate(text)})), layerGap: 40, nodeGap: 16});
    expect(labelled.bounds.h / plain.bounds.h).toBeLessThanOrEqual(1.3);
    // and every label is still on its own edge, clear of the nodes
    for (const [key, route] of labelled.routes) {
      const plate = route.label!;
      expect(crosses(route.points, {x: plate.x - 1, y: plate.y - 1, w: plate.w + 2, h: plate.h + 2}, 0), `label ${key}`).toBe(true);
      for (const b of labelled.boxes.values()) expect(crosses([{x: plate.x, y: plate.y}, {x: plate.x + plate.w, y: plate.y + plate.h}], b, 1)).toBe(false);
    }
  });

  // The module graph stacked its 13 isolated modules in the first layer (one tall column): with the groups' children
  // in the run, ELK packs no disconnected parts.
  it('lays parts that share no edge out apart: lone nodes are packed in rows below the main part, never in its first layer', async () => {
    const nodes = [node('app', 'g'), node('lib', 'g'), node('core'), node('db'), ...['skills', 'swift', 'docs', 'specs', 'tools', 'blueprints'].map(id => node(id))];
    const spec: LayoutSpec = {dir: 'LR', nodes, edges: edgesOf([['app', 'lib'], ['lib', 'core'], ['core', 'db']]), groups: [{id: 'g'}], aspect: 2};
    const laid = await lay(spec);
    const main = boundsOf(['app', 'lib', 'core', 'db'].map(id => laid.boxes.get(id)!))!;
    for (const id of ['skills', 'swift', 'docs', 'specs', 'tools', 'blueprints']) {
      expect(laid.boxes.get(id)!.y, `${id} below the main part`).toBeGreaterThanOrEqual(main.y + main.h);
    }
    // packed in rows, not one column
    expect(new Set(['skills', 'swift', 'docs', 'specs', 'tools', 'blueprints'].map(id => laid.boxes.get(id)!.y)).size).toBeLessThan(6);
    // the group still holds its members and edges still run in root coordinates
    const frame = laid.frames.get('g')!;
    for (const id of ['app', 'lib']) expect(inside(laid.boxes.get(id)!, frame)).toBe(true);
    const ab = laid.routes.get('0')!.points;
    expect(Math.abs(ab[0]!.x - (laid.boxes.get('app')!.x + laid.boxes.get('app')!.w))).toBeLessThanOrEqual(1);
    expect(partCount(spec)).toBe(7);
    expect(partCount({...spec, nodes: nodes.slice(0, 4)})).toBe(1);
  });

  // An 11-step start-up chart opened at 88% in a 132 px canvas, 7 of 11 in view: a flow too long
  // for its plate is wrapped into rows (ELK's own wrapping, cut where one edge crosses).
  it('wraps an 11-step chain into rows that fit a 616 px plate at 100%, each row still left to right', async () => {
    const ids = 'abcdefghijk'.split('');
    const edges = edgesOf(ids.slice(1).map((id, i) => [ids[i]!, id] as const));
    const flat = await lay({dir: 'LR', nodes: ids.map(id => node(id, undefined, 110, 36)), edges});
    expect(flat.bounds.w).toBeGreaterThan(616);
    const wrapped = await lay({dir: 'LR', nodes: ids.map(id => node(id, undefined, 110, 36)), edges, wrap: 1.07});
    expect(wrapped.bounds.w).toBeLessThanOrEqual(616 - PAD * 2);
    expect(sizeDiagram({bounds: wrapped.bounds, width: 616, cap: 640, floor: 0.84, readable: 0.84, dir: 'LR'})).toMatchObject({mode: 'fit', view: {zoom: 1}});
    // within a row the flow runs left to right
    for (const edge of edges) {
      const a = wrapped.boxes.get(edge.from)!;
      const b = wrapped.boxes.get(edge.to)!;
      if (Math.abs(a.y - b.y) < 1) expect(a.x).toBeLessThan(b.x);
    }
    expect(toElk({dir: 'LR', nodes: [], edges: [], wrap: 1.07}).layoutOptions!['elk.layered.wrapping.strategy']).toBe('SINGLE_EDGE');
    expect(toElk({dir: 'LR', nodes: [], edges: [], wrap: 1.07, wrapAny: true}).layoutOptions!['elk.layered.wrapping.strategy']).toBe('MULTI_EDGE');
  });

  it('tells a diagram with a loop from one without (only those are wrapped across several edges)', () => {
    const nodes = ['a', 'b', 'c'].map(id => node(id));
    expect(hasCycle({nodes, edges: edgesOf([['a', 'b'], ['b', 'c']])})).toBe(false);
    expect(hasCycle({nodes, edges: edgesOf([['a', 'b'], ['b', 'c'], ['c', 'a']])})).toBe(true);
    // a self-loop alone is not a cycle the wrap could cut badly
    expect(hasCycle({nodes, edges: edgesOf([['a', 'a'], ['a', 'b']])})).toBe(false);
  });
});

describe('the opening window, round 2', () => {
  // A row too wide for the canvas: centred on its middle box, it cut the boxes at both ends (unslice() would not take
  // the anchor off the canvas, so the cut was kept). Now a box that cannot be shown whole is moved past the edge.
  it('moves a node that cannot be shown whole past the edge instead of slicing it', () => {
    const rows = [0, 100, 200, 300, 400].flatMap(y => [box(0, y, 200, 60), box(240, y, 200, 60), box(480, y, 200, 60)]);
    const s = sizeDiagram({bounds: boundsOf(rows)!, width: 600, cap: 420, floor: 0.91, readable: 0.91, dir: 'TB', anchor: {x: 340, y: 30}, boxes: rows});
    expect(s.mode).toBe('readable');
    expect(cutAt(rows, s.view, 'x', 600)).toBe(0);
    expect(cutAt(rows, s.view, 'y', s.canvas)).toBe(0);
    // two of each row whole, the first row at the top
    const whole = rows.filter(b => b.x * s.view.zoom + s.view.x >= -0.5 && (b.x + b.w) * s.view.zoom + s.view.x <= 600.5);
    expect(whole.length).toBeGreaterThanOrEqual(2 * Math.floor(s.canvas / (100 * s.view.zoom)));
  });

  // A size-s chart (160 px) of a three-line box over a tall diamond cut the diamond at the bottom: the window assumed the
  // canvas could end above it, which it could not without losing more than a quarter of itself.
  it('cuts no node at the bottom when the canvas cannot end above it', () => {
    const chart = [box(0, 0, 160, 60), box(10, 104, 140, 92), box(0, 240, 160, 40)];
    const s = sizeDiagram({bounds: boundsOf(chart)!, width: 616, cap: 160, floor: 0.84, readable: 0.84, dir: 'TB', boxes: chart});
    expect(s.mode).toBe('readable');
    expect(cutAt(chart, s.view, 'y', s.canvas)).toBe(0);
    expect(chart.some(b => b.y * s.view.zoom + s.view.y >= -0.5 && (b.y + b.h) * s.view.zoom + s.view.y <= s.canvas + 0.5)).toBe(true);
  });

  // The 150-node graph in 8 groups opened with the left 55% of the stage blank: ELK stretched the first group's frame
  // into a tall, mostly empty column and the view was pinned to the drawing's start edge.
  it('opens a 150-node grouped graph on nodes: 30% or more of the stage holds node boxes, and the minimap covers none', async () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const nodes = Array.from({length: 150}, (_, i) => node(`n${i}`, `g${i % 8}`, 112, 28));
    const pairs = new Set<string>();
    while (pairs.size < 230) {
      const a = Math.floor(random() * 150);
      const b = Math.floor(random() * 150);
      if (a !== b) pairs.add(`${a} ${b}`);
    }
    const edges = [...pairs].map((pair, i) => {
      const [a, b] = pair.split(' ');
      return {key: String(i), from: `n${a}`, to: `n${b}`};
    });
    const laid = await lay({dir: 'LR', nodes, edges, groups: Array.from({length: 8}, (_, i) => ({id: `g${i}`})), dense: true, nodeGap: 16, layerGap: 40});
    const s = sizeDiagram({bounds: laid.bounds, width: 1254, cap: 640, floor: 0.4, readable: READABLE_ZOOM, dir: 'LR', boxes: laid.boxes.values()});
    expect(s.mode).toBe('readable');
    const onScreenAt = (view: {x: number; y: number; zoom: number}) => [...laid.boxes.values()].map(b => ({x: b.x * view.zoom + view.x, y: b.y * view.zoom + view.y, w: b.w * view.zoom, h: b.h * view.zoom}));
    const onScreen = onScreenAt(s.view);
    // The stage in 8 x 4 cells: how many of them hold (a part of) a node. Node boxes are far apart in a graph this
    // dense (many lanes between the layers), so this, not the area of the boxes, says whether the stage is empty.
    const held = (shown: Box[]) => {
      let n = 0;
      for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 4; j++) {
          const cell = box((1254 / 8) * i, (s.canvas / 4) * j, 1254 / 8, s.canvas / 4);
          if (shown.some(b => b.x < cell.x + cell.w && cell.x < b.x + b.w && b.y < cell.y + cell.h && cell.y < b.y + b.h)) n++;
        }
      }
      return n / 32;
    };
    expect(held(onScreen)).toBeGreaterThanOrEqual(0.3);
    // and no less of it than the window pinned to the start of the drawing
    expect(held(onScreen)).toBeGreaterThanOrEqual(held(onScreenAt({...s.view, x: PAD - laid.bounds.x * s.view.zoom})));
    // no node the stage shows across is cut at the top or the bottom
    const across = [...laid.boxes.values()].filter(b => (b.x + b.w) * s.view.zoom + s.view.x > 0 && b.x * s.view.zoom + s.view.x < 1254);
    expect(cutAt(across, s.view, 'y', s.canvas)).toBe(0);
    const spot = minimapSpot(laid.bounds, s.view, [...laid.boxes.values()], 1254, s.canvas);
    expect(spot).toBeDefined();
    if (spot!.kind === 'corner') {
      const x = spot!.corner.endsWith('right') ? 1254 - 8 - spot!.w : 8;
      const y = spot!.corner.startsWith('bottom') ? s.canvas - 8 - spot!.h : 8;
      for (const b of onScreen) expect(b.x < x + spot!.w && x < b.x + b.w && b.y < y + spot!.h && y < b.y + b.h).toBe(false);
    }
  }, 30_000);

  it('does not pin the window to the start of a drawing whose start is an empty, stretched frame', () => {
    // a frame from x 0 holds nodes only from x 1300 on: pinned to the start, the stage showed paper
    const nodes = [0, 1, 2, 3, 4, 5].flatMap(i => [box(1300 + i * 160, 40, 112, 28), box(1300 + i * 160, 120, 112, 28), box(1300 + i * 160, 200, 112, 28)]);
    const bounds = box(0, 0, 2300, 260);
    const s = sizeDiagram({bounds, width: 1254, cap: 640, floor: 0.84, readable: 0.84, dir: 'LR', boxes: nodes});
    const shown = nodes.filter(b => b.x * s.view.zoom + s.view.x >= 0 && (b.x + b.w) * s.view.zoom + s.view.x <= 1254);
    expect(shown.length).toBeGreaterThanOrEqual(12);
    expect(cutAt(nodes, s.view, 'x', 1254)).toBe(0);
  });

  it('puts the minimap in a free corner, else in a strip in the controls bar', () => {
    const view = {x: 0, y: 0, zoom: 1};
    const bounds = box(0, 0, 2000, 400);
    // nothing in the bottom-right corner
    expect(minimapSpot(bounds, view, [box(0, 0, 300, 100)], 900, 400)).toMatchObject({kind: 'corner', corner: 'bottom-right'});
    // the bottom right taken: the top right
    expect(minimapSpot(bounds, view, [box(700, 300, 200, 100)], 900, 400)).toMatchObject({kind: 'corner', corner: 'top-right'});
    // every corner taken, or a canvas too short for one: the strip, shaped like the drawing
    const full = [box(0, 0, 900, 400)];
    expect(minimapSpot(bounds, view, full, 900, 400)).toMatchObject({kind: 'strip', h: 22});
    expect(minimapSpot(bounds, view, [], 900, 120)).toMatchObject({kind: 'strip'});
    // a narrow stage still gets the strip beside its short count; one with no room at all, none
    expect(minimapSpot(bounds, view, full, 300, 400)).toMatchObject({kind: 'strip'});
    expect(minimapSpot(bounds, view, full, 200, 400)).toBeUndefined();
  });
});

describe('dragging, round 2', () => {
  // After 'payments' was dragged across another node's column, its edge dropped straight through 'auth', and the
  // 'charges' edge climbed through the DATA frame: a moved end got a plain step route with no obstacles.
  it('routes an edge whose node was dragged round every other node, and round frames it does not belong to', () => {
    const a = box(0, 0, 120, 32);
    const b = box(400, 300, 120, 32);
    const wall = [box(180, -40, 120, 140), box(200, 200, 120, 40), box(380, 160, 160, 40)];
    const frame = box(160, 260, 200, 160);
    const route = routeAround(a, b, {nodes: wall, frames: [frame]});
    expect(route.length).toBeGreaterThanOrEqual(2);
    expect(orthogonal(route)).toBe(true);
    for (const other of wall) expect(crosses(route, other)).toBe(false);
    expect(crosses(route, frame)).toBe(false);
    // it starts and ends on the two boxes' sides
    const onSide = (p: Point, q: Box) => (Math.abs(p.x - q.x) < 1 || Math.abs(p.x - q.x - q.w) < 1 || Math.abs(p.y - q.y) < 1 || Math.abs(p.y - q.y - q.h) < 1);
    expect(onSide(route[0]!, a) && onSide(route.at(-1)!, b)).toBe(true);
  });

  it('finds a way through a crowd with the grid search when no simple route is free', () => {
    const a = box(0, 200, 100, 30);
    const b = box(600, 200, 100, 30);
    // a column of nodes between them, with one gap in the middle of it, and nodes above and below both ends
    const crowd = [box(300, -200, 100, 380), box(300, 260, 100, 380), box(-50, 120, 800, 40), box(-50, 280, 800, 40)];
    const route = routeAround(a, b, {nodes: crowd});
    for (const other of crowd) expect(crosses(route, other), JSON.stringify(route)).toBe(false);
    expect(orthogonal(route)).toBe(true);
  });

  it('moves a node dropped on another to the nearest free place beside it', () => {
    const others = [box(0, 0, 120, 32), box(200, 0, 120, 32)];
    expect(freeSpot(box(500, 0, 120, 32), others, 20)).toEqual(box(500, 0, 120, 32));
    const spot = freeSpot(box(210, 10, 120, 32), others, 20)!;
    for (const other of others) expect(spot.x + spot.w + 19.5 <= other.x || other.x + other.w + 19.5 <= spot.x || spot.y + spot.h + 19.5 <= other.y || other.y + other.h + 19.5 <= spot.y).toBe(true);
    expect(Math.hypot(spot.x - 210, spot.y - 10)).toBeLessThan(80);
  });

  it('draws the frames of a dragged node round where its members are now', () => {
    const auto = new Map([['outer', box(0, 0, 400, 200)], ['inner', box(12, 28, 200, 100)]]);
    const boxes = new Map([['a', box(24, 56, 100, 32)], ['b', box(600, 300, 100, 32)], ['c', box(300, 60, 80, 32)]]);
    const chains = new Map([['a', ['inner', 'outer']], ['b', ['inner', 'outer']], ['c', ['outer']]]);
    const frames = framesAround(auto, new Set(['b']), boxes, chains);
    const inner = frames.get('inner')!;
    const outer = frames.get('outer')!;
    for (const id of ['a', 'b']) expect(inside(boxes.get(id)!, inner)).toBe(true);
    expect(inside(inner, outer)).toBe(true);
    expect(inside(boxes.get('c')!, outer)).toBe(true);
    // nothing moved: ELK's frames
    expect(framesAround(auto, new Set(), boxes, chains)).toBe(auto);
  });

  it('knows an edge ELK ran along a frame (drawn light so it does not read as a second frame)', () => {
    const frame = box(100, 100, 400, 300);
    expect(runsAlongFrame([{x: 0, y: 90}, {x: 520, y: 90}], [frame])).toBe(true);
    expect(runsAlongFrame([{x: 90, y: 0}, {x: 90, y: 420}], [frame])).toBe(true);
    // across it, or along it for a short stretch, or far from it: no
    expect(runsAlongFrame([{x: 300, y: 0}, {x: 300, y: 500}], [frame])).toBe(false);
    expect(runsAlongFrame([{x: 100, y: 90}, {x: 160, y: 90}], [frame])).toBe(false);
    expect(runsAlongFrame([{x: 0, y: 40}, {x: 520, y: 40}], [frame])).toBe(false);
  });
});

describe('edge labels when zoomed out', () => {
  it('grow below 91% so their 11 px text stays 10 px on screen, and the floor with labels is 55%', () => {
    expect(labelGrowth(1)).toBe(1);
    expect(labelGrowth(0.91)).toBe(1);
    for (const k of [0.9, 0.8, 0.7, 0.55]) expect(11 * labelGrowth(k) * k).toBeGreaterThanOrEqual(10 - 1e-9);
    expect(LABEL_FLOOR).toBeCloseTo(0.55);
  });
});

describe('geometry', () => {
  it('rounds corners with 6 px elbows and shortens them on short segments', () => {
    expect(roundedPath([{x: 0, y: 0}, {x: 50, y: 0}, {x: 50, y: 50}])).toBe('M0 0L44 0Q50 0 50 6L50 50');
    expect(roundedPath([{x: 0, y: 0}, {x: 4, y: 0}, {x: 4, y: 50}])).toBe('M0 0L2 0Q4 0 4 2L4 50');
    expect(roundedPath([])).toBe('');
    expect(roundedPath([{x: 1, y: 2}, {x: 3, y: 2}])).toBe('M1 2L3 2');
  });

  it('draws an open chevron, a bar and a crow\'s foot at the end of an edge', () => {
    expect(markPath('arrow', {x: 100, y: 0}, {x: 0, y: 0})).toBe('M93 3.5L100 0L93 -3.5');
    expect(markPath('one', {x: 100, y: 0}, {x: 0, y: 0})).toBe('M92 5L92 -5');
    expect(markPath('many', {x: 100, y: 0}, {x: 0, y: 0})).toBe('M100 5L90 0L100 -5');
    expect(markPath('none', {x: 100, y: 0}, {x: 0, y: 0})).toBe('');
    expect(markPath('arrow', {x: 1, y: 1}, {x: 1, y: 1})).toBe('');
    expect(markPath('arrow', undefined, undefined)).toBe('');
  });

  it('simplifies, measures and bounds', () => {
    expect(simplify([{x: 0, y: 0}, {x: 0, y: 0}, {x: 5, y: 0}, {x: 9, y: 0}, {x: 9, y: 4}])).toEqual([{x: 0, y: 0}, {x: 9, y: 0}, {x: 9, y: 4}]);
    expect(midpoint([{x: 0, y: 0}, {x: 10, y: 0}, {x: 10, y: 30}])).toEqual({x: 10, y: 10});
    expect(boundsOf([box(0, 0), box(50, 60)], [{x: -5, y: 300}])).toEqual({x: -5, y: 0, w: 155, h: 300});
    expect(boundsOf([])).toBeUndefined();
  });

  it('finds the nearest node in a direction', () => {
    const boxes = new Map([['a', box(0, 0)], ['b', box(200, 10)], ['c', box(200, 300)], ['d', box(0, 300)]]);
    expect(nearestInDirection(boxes, 'a', 1, 0)).toBe('b');
    expect(nearestInDirection(boxes, 'a', 0, 1)).toBe('d');
    expect(nearestInDirection(boxes, 'a', -1, 0)).toBeUndefined();
    expect(nearestInDirection(boxes, 'c', 0, -1)).toBe('b');
    expect(nearestInDirection(boxes, 'missing', 1, 0)).toBeUndefined();
  });

  it('pulls the ends of a route onto a diamond, a circle and the round end of a pill', () => {
    const diamond = box(0, 100, 120, 60);
    // straight into the top vertex: unchanged; 30 px off the middle: half-way down the slope
    expect(clipToShapes([{x: 60, y: 0}, {x: 60, y: 100}], {box: box(0, -40)}, {box: diamond, shape: 'diamond'}).at(-1)).toEqual({x: 60, y: 100});
    expect(clipToShapes([{x: 30, y: 0}, {x: 30, y: 100}], {box: box(0, -40)}, {box: diamond, shape: 'diamond'}).at(-1)).toEqual({x: 30, y: 115});
    expect(outlineInset(box(0, 0, 60, 60), 'circle', 0, true)).toBe(0);
    expect(outlineInset(box(0, 0, 60, 60), 'circle', 30, true)).toBe(30);
    // a pill's round ends are its short sides: a line into its long side is not moved
    expect(outlineInset(box(0, 0, 120, 40), 'pill', 50, true)).toBe(0);
    expect(outlineInset(box(0, 0, 120, 40), 'pill', 10, false)).toBeCloseTo(20 - Math.sqrt(300));
    // boxes and cylinders keep ELK's end
    expect(clipToShapes([{x: 30, y: 0}, {x: 30, y: 100}], {box: box(0, -40)}, {box: diamond, shape: 'rect'}).at(-1)).toEqual({x: 30, y: 100});
  });
});

describe('text', () => {
  it('estimates widths and cuts with an ellipsis', () => {
    expect(textWidth('abcd', MONO_11)).toBeCloseTo(26.4);
    expect(textWidth('iiii', UI_12)).toBeLessThan(textWidth('mmmm', UI_12));
    expect(fitText('short', 200, UI_12)).toBe('short');
    const cut = fitText('x'.repeat(500), 120, UI_12);
    expect(cut.endsWith('…')).toBe(true);
    expect(textWidth(cut, UI_12)).toBeLessThanOrEqual(120);
    expect(fitText('', 10, UI_12)).toBe('');
  });

  it('wraps at words and cuts the last line', () => {
    expect(wrapText('Back off and retry later', 80, 3, UI_12)).toEqual(['Back off and', 'retry later']);
    const lines = wrapText('word '.repeat(100), 80, 2, UI_12);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith('…')).toBe(true);
    expect(wrapText('y'.repeat(500), 80, 3, UI_12)).toHaveLength(1);
    expect(wrapText('   ', 80, 3, UI_12)).toEqual(['']);
  });

  it('measures r, t and f between an i and a letter, and full-width glyphs at an em', () => {
    const narrow = textWidth('i', UI_12);
    const slim = textWidth('r', UI_12);
    const letter = textWidth('a', UI_12);
    expect(slim).toBeGreaterThan(narrow);
    expect(slim).toBeLessThan(letter);
    expect(textWidth('模块', MONO_11)).toBeCloseTo(22);
  });

  it('makes an edge label plate of one line, or two for a long label', () => {
    const one = labelPlate('reads');
    expect(one.lines).toEqual(['reads']);
    expect(one.h).toBe(16);
    const two = labelPlate('progress frames over the event channel');
    expect(two.lines).toHaveLength(2);
    expect(two.h).toBe(29);
    expect(labelPlate('x'.repeat(500)).lines.at(-1)!.endsWith('…')).toBe(true);
  });
});

describe('positions', () => {
  afterEach(() => configurePositionStorage(undefined));

  it('stores positions per diagram under glimpse.pos.v1', () => {
    const storage = fakeStorage();
    configurePositionStorage(storage);
    const key = positionsKey('demo', 'overview', 'deps');
    expect(key).toBe('demo/overview/deps');
    expect(readPositions(key)).toEqual({});
    writePositions(key, {a: {x: 1, y: 2}});
    writePositions('demo/overview/other', {b: {x: 3, y: 4}});
    expect(JSON.parse(storage.items.get(POSITIONS_KEY)!)).toEqual({'demo/overview/deps': {a: {x: 1, y: 2}}, 'demo/overview/other': {b: {x: 3, y: 4}}});
    expect(readPositions(key)).toEqual({a: {x: 1, y: 2}});
    writePositions(key, {});
    expect(JSON.parse(storage.items.get(POSITIONS_KEY)!)).toEqual({'demo/overview/other': {b: {x: 3, y: 4}}});
  });

  it('ignores malformed stored values', () => {
    configurePositionStorage(fakeStorage({[POSITIONS_KEY]: '{not json'}));
    expect(readPositions('k')).toEqual({});
    configurePositionStorage(fakeStorage({[POSITIONS_KEY]: JSON.stringify({k: {a: {x: 1, y: 2}, b: {x: 'no'}, c: null}, bad: 3, list: [1]})}));
    expect(readPositions('k')).toEqual({a: {x: 1, y: 2}});
    expect(readPositions('bad')).toEqual({});
  });

  it('falls back to memory when storage throws or is missing', () => {
    configurePositionStorage({
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('quota'); },
    });
    writePositions('k', {a: {x: 5, y: 6}});
    expect(readPositions('k')).toEqual({a: {x: 5, y: 6}});
    configurePositionStorage(null);
    expect(readPositions('k')).toEqual({});
    writePositions('k', {a: {x: 7, y: 8}});
    expect(readPositions('k')).toEqual({a: {x: 7, y: 8}});
  });
});

// Rules jsdom cannot lay out, checked as text (the visual proof is in the screenshots of the review rounds).
describe('flowkit.module.css', () => {
  const css = async () => {
    const {readFileSync} = await import('node:fs');
    const {join} = await import('node:path');
    return readFileSync(join(import.meta.dirname, '..', '..', 'src', 'components', 'diagrams', 'flowkit', 'flowkit.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  };
  const rule = (text: string, selector: string) => {
    const at = text.indexOf(`${selector} {`);
    if (at < 0) throw new Error(`no rule for ${selector}`);
    return text.slice(text.indexOf('{', at) + 1, text.indexOf('}', at)).trim();
  };

  // Finding V049: zoomed in, nodes pass under the overview; it fades while the pointer is over the diagram.
  it('fades the minimap while the pointer is over the diagram, and brings it back on the minimap', async () => {
    const text = await css();
    expect(rule(text, '.stage:hover ~ .minimap')).toMatch(/opacity: 0\.\d+/);
    expect(rule(text, '.minimap:hover')).toContain('opacity: 1');
  });

  it('sets React Flow\'s variables from the Linework tokens on what holds the canvas, its controls and its minimap', async () => {
    const root = rule(await css(), '.root');
    for (const name of ['--xy-minimap-background-color', '--xy-minimap-mask-background-color', '--xy-minimap-node-background-color', '--xy-background-pattern-color']) {
      expect(root, name).toMatch(new RegExp(`${name}: (?:var\\(--(?:gl|dg)-|color-mix\\()`));
    }
    // the controls bar under the canvas is the CONTROLS of sizing.ts
    expect(root).toContain(`--dg-controls: ${CONTROLS}px`);
  });

  it('keeps every rule in the gl.components layer and handles out of reach', async () => {
    const text = await css();
    expect(text.trim().startsWith('@layer gl.components {')).toBe(true);
    expect(rule(text, '.handle')).toContain('pointer-events: none');
  });
});

// The layout runs in ELK, never on the page: the page side has no ELK code at all (decision D19).
describe('no ELK on the page side', () => {
  it('builds ELK JSON on the page; the ELK engine itself is only in the worker', async () => {
    const {readFileSync, readdirSync} = await import('node:fs');
    const {join} = await import('node:path');
    const dir = join(import.meta.dirname, '..', '..', 'src', 'components', 'diagrams', 'flowkit');
    for (const file of readdirSync(dir)) {
      if (!/\.(ts|tsx)$/.test(file) || file === 'elk.worker.ts') continue;
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source, file).not.toMatch(/from 'elkjs\/lib\/elk\.bundled\.js'|from 'elkjs'|elkjs\/lib\/main/);
    }
  });
  it('lays out an ELK graph the page builds without changing it', async () => {
    const graph: ElkNode = toElk({dir: 'LR', nodes: [node('a'), node('b')], edges: [{key: '0', from: 'a', to: 'b'}]});
    const before = JSON.stringify(graph);
    await elk.layout(structuredClone(graph));
    expect(JSON.stringify(graph)).toBe(before);
  });
});
