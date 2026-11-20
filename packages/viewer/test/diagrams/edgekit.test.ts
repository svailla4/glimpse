import {afterEach, describe, expect, it} from 'vitest';
import {
  POSITIONS_KEY, READABLE_ZOOM, bandsOf, boundsOf, channelBetween, configurePositionStorage, fitText, inBand, labelAnchor, layoutDiagram, markPath,
  midpoint, nearestInDirection, nearestOn, openingView, positionsKey, readPositions, roundedPath, routeAround, routeEdge, routeLoop, signatureOf, simplify,
  textWidth, wrapText, writePositions, MONO_11, UI_12,
  type Box, type LayoutSpec, type Point,
} from '../../src/components/diagrams/edgekit/index.ts';
import {fakeStorage} from './util.tsx';

const box = (x: number, y: number, w = 100, h = 40): Box => ({x, y, w, h});
/** Every segment of an orthogonal route runs along one axis. */
const orthogonal = (points: readonly Point[]) => points.every((p, i) => i === 0 || Math.abs(p.x - points[i - 1]!.x) < 0.5 || Math.abs(p.y - points[i - 1]!.y) < 0.5);

describe('routeEdge', () => {
  it('runs with the flow from the far side of the source to the near side of the target, turning halfway', () => {
    const points = routeEdge(box(0, 0), box(200, 100), {dir: 'LR'});
    expect(points).toEqual([{x: 100, y: 20}, {x: 150, y: 20}, {x: 150, y: 120}, {x: 200, y: 120}]);
  });

  it('is one straight segment between level boxes', () => {
    expect(routeEdge(box(0, 0), box(200, 0), {dir: 'LR'})).toEqual([{x: 100, y: 20}, {x: 200, y: 20}]);
  });

  it('straightens a small step by meeting in the middle', () => {
    const points = routeEdge(box(0, 0), box(200, 10), {dir: 'LR'});
    expect(points).toEqual([{x: 100, y: 25}, {x: 200, y: 25}]);
  });

  it('runs against the flow one lane over, so a two-node cycle stays two lines', () => {
    const forth = routeEdge(box(0, 0), box(200, 0), {dir: 'LR'});
    const back = routeEdge(box(200, 0), box(0, 0), {dir: 'LR'});
    expect(back).toEqual([{x: 200, y: 28}, {x: 100, y: 28}]);
    expect(back[0]!.y).not.toBe(forth[0]!.y);
  });

  it('transposes for a top-to-bottom flow', () => {
    const points = routeEdge(box(0, 0), box(150, 200), {dir: 'TB'});
    expect(points).toEqual([{x: 50, y: 40}, {x: 50, y: 120}, {x: 200, y: 120}, {x: 200, y: 200}]);
  });

  it('connects boxes stacked across the flow through their facing sides', () => {
    const points = routeEdge(box(0, 0), box(30, 200), {dir: 'LR'});
    expect(points[0]).toEqual({x: 50, y: 40});
    expect(points.at(-1)).toEqual({x: 80, y: 200});
    expect(orthogonal(points)).toBe(true);
  });

  it('joins overlapping boxes with a stub instead of failing', () => {
    const points = routeEdge(box(0, 0), box(50, 10), {dir: 'LR'});
    expect(points).toHaveLength(2);
    expect(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });

  it('passes through waypoints and puts turns in the channel it is given', () => {
    const points = routeEdge(box(0, 0), box(600, 0), {dir: 'LR', via: [{x: 350, y: 200}], channel: (from, to) => Math.min(from, to) + 20});
    expect(orthogonal(points)).toBe(true);
    expect(points).toContainEqual({x: 120, y: 200});
    expect(points).toContainEqual({x: 370, y: 20});
    expect(points.at(-1)).toEqual({x: 600, y: 20});
  });

  it('attaches at ports and pulls the end onto a diamond outline', () => {
    const ported = routeEdge(box(0, 0, 100, 100), box(300, 0, 100, 100), {dir: 'LR', fromPort: -30, toPort: 30});
    expect(ported[0]).toEqual({x: 100, y: 20});
    expect(ported.at(-1)).toEqual({x: 300, y: 80});
    const diamond = routeEdge(box(0, 0, 100, 100), box(300, 0, 100, 100), {dir: 'LR', fromShape: 'diamond', fromPort: 25});
    expect(diamond[0]).toEqual({x: 75, y: 75});
  });

  it('draws a loop for an edge from a node to itself', () => {
    const lr = routeLoop(box(0, 0), 'LR');
    expect(orthogonal(lr)).toBe(true);
    expect(lr[0]!.x).toBe(100);
    expect(lr.at(-1)!.y).toBe(0);
    expect(orthogonal(routeLoop(box(0, 0), 'TB'))).toBe(true);
  });
});

describe('paths', () => {
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

  it('simplifies, measures and projects', () => {
    expect(simplify([{x: 0, y: 0}, {x: 0, y: 0}, {x: 5, y: 0}, {x: 9, y: 0}, {x: 9, y: 4}])).toEqual([{x: 0, y: 0}, {x: 9, y: 0}, {x: 9, y: 4}]);
    expect(midpoint([{x: 0, y: 0}, {x: 10, y: 0}, {x: 10, y: 30}])).toEqual({x: 10, y: 10});
    expect(nearestOn([{x: 0, y: 0}, {x: 10, y: 0}], {x: 4, y: 7})).toEqual({x: 4, y: 0});
    expect(boundsOf([box(0, 0), box(50, 60)], [{x: -5, y: 300}])).toEqual({x: -5, y: 0, w: 155, h: 300});
    expect(boundsOf([])).toBeUndefined();
  });

  it('puts a label on the stretch that runs across the flow', () => {
    const route = [{x: 0, y: 0}, {x: 0, y: 30}, {x: 80, y: 30}, {x: 80, y: 60}];
    expect(labelAnchor(route, 'TB')).toEqual({x: 40, y: 30});
    expect(labelAnchor([{x: 0, y: 0}, {x: 0, y: 60}], 'TB')).toEqual({x: 0, y: 30});
    expect(labelAnchor([{x: 0, y: 0}, {x: 0, y: 60}], 'TB', {x: 3, y: 20})).toEqual({x: 0, y: 20});
  });
});

describe('ranks', () => {
  const bands = bandsOf([box(0, 0), box(0, 100), box(200, 0, 60), box(400, 50)], 'LR');
  it('merges the boxes of a rank into one band', () => {
    expect(bands).toEqual([{from: 0, to: 100}, {from: 200, to: 260}, {from: 400, to: 500}]);
    expect(inBand(bands, 230)).toBe(true);
    expect(inBand(bands, 150)).toBe(false);
    expect(bandsOf([box(0, 0), box(0, 100)], 'TB')).toEqual([{from: 0, to: 40}, {from: 100, to: 140}]);
  });
  it('puts channels in the middle of the gap between two ranks', () => {
    const channel = channelBetween(bands);
    expect(channel(100, 230)).toBe(150);
    expect(channel(230, 400)).toBe(330);
    expect(channel(400, 230)).toBe(330);
    expect(channel(10, 90)).toBe(50);
  });
  it('finds the nearest node in a direction', () => {
    const boxes = new Map([['a', box(0, 0)], ['b', box(200, 10)], ['c', box(200, 300)], ['d', box(0, 300)]]);
    expect(nearestInDirection(boxes, 'a', 1, 0)).toBe('b');
    expect(nearestInDirection(boxes, 'a', 0, 1)).toBe('d');
    expect(nearestInDirection(boxes, 'a', -1, 0)).toBeUndefined();
    expect(nearestInDirection(boxes, 'c', 0, -1)).toBe('b');
    expect(nearestInDirection(boxes, 'missing', 1, 0)).toBeUndefined();
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
});

describe('layoutDiagram', () => {
  const spec: LayoutSpec = {
    dir: 'LR',
    nodes: [
      {id: 'api', w: 168, h: 40, group: 'srv'}, {id: 'auth', w: 168, h: 40, group: 'srv'}, {id: 'ui', w: 168, h: 40},
      {id: 'redis', w: 168, h: 28}, {id: 'pg', w: 168, h: 28},
    ],
    edges: [
      {key: '0', from: 'api', to: 'auth'}, {key: '1', from: 'auth', to: 'api'}, {key: '2', from: 'ui', to: 'api'},
      {key: '3', from: 'ui', to: 'auth', label: {w: 40, h: 16}}, {key: '4', from: 'auth', to: 'redis'}, {key: '5', from: 'ui', to: 'pg'},
      {key: '6', from: 'ui', to: 'ui'}, {key: '7', from: 'ui', to: 'nowhere'},
    ],
    groups: [{id: 'srv'}, {id: 'outer'}, {id: 'loop-a', parent: 'loop-b'}, {id: 'loop-b', parent: 'loop-a'}],
  };
  const laid = layoutDiagram(spec);

  it('places every node without overlap, ranked along the flow', () => {
    const boxes = [...laid.boxes.values()];
    expect(boxes).toHaveLength(5);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
      }
    }
    expect(laid.boxes.get('ui')!.x).toBeLessThan(laid.boxes.get('api')!.x);
    expect(laid.boxes.get('api')!.x).toBeLessThan(laid.boxes.get('auth')!.x);
    expect(laid.boxes.get('auth')!.x).toBeLessThan(laid.boxes.get('redis')!.x);
  });

  it('routes every edge orthogonally between the right sides', () => {
    expect([...laid.routes.keys()].sort()).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    for (const route of laid.routes.values()) expect(orthogonal(route.points)).toBe(true);
    const api = laid.boxes.get('api')!;
    const auth = laid.boxes.get('auth')!;
    const forth = laid.routes.get('0')!.points;
    expect(forth[0]!.x).toBe(api.x + api.w);
    expect(forth.at(-1)!.x).toBe(auth.x);
    const back = laid.routes.get('1')!.points;
    expect(back[0]!.x).toBe(auth.x);
    expect(back.at(-1)!.x).toBe(api.x + api.w);
    expect(back[0]!.y).not.toBe(forth.at(-1)!.y);
  });

  it('steers a long edge around the rank it crosses and places its label on it', () => {
    const route = laid.routes.get('3')!;
    const api = laid.boxes.get('api')!;
    const crossesApi = route.points.some((p, i) => {
      const q = route.points[i - 1];
      return q && Math.abs(p.y - q.y) < 0.5 && p.y > api.y && p.y < api.y + api.h && Math.min(p.x, q.x) < api.x + api.w && Math.max(p.x, q.x) > api.x;
    });
    expect(crossesApi).toBe(false);
    expect(route.label).toBeDefined();
    expect(nearestOn(route.points, route.label!)).toEqual(route.label);
    expect(laid.routes.get('0')!.label).toBeUndefined();
  });

  it('lays out top to bottom', () => {
    const tb = layoutDiagram({...spec, dir: 'TB'});
    expect(tb.boxes.get('ui')!.y).toBeLessThan(tb.boxes.get('api')!.y);
    for (const route of tb.routes.values()) expect(orthogonal(route.points)).toBe(true);
  });

  it('has one signature per layout input', () => {
    expect(signatureOf(spec)).toBe(signatureOf({...spec, nodes: [...spec.nodes]}));
    expect(signatureOf(spec)).not.toBe(signatureOf({...spec, dir: 'TB'}));
    expect(signatureOf(spec)).not.toBe(signatureOf({...spec, nodes: spec.nodes.slice(1)}));
    expect(signatureOf(spec)).not.toBe(signatureOf({...spec, edges: spec.edges.slice(1)}));
  });

  it('accepts an empty diagram and a single node', () => {
    expect(layoutDiagram({dir: 'LR', nodes: [], edges: []}).boxes.size).toBe(0);
    expect(layoutDiagram({dir: 'TB', nodes: [{id: 'a', w: 10, h: 10}], edges: []}).boxes.get('a')).toMatchObject({w: 10, h: 10});
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

describe('routeAround', () => {
  /** True when a segment of the route runs through the inside of the box. */
  const through = (points: readonly Point[], b: Box) => points.some((p, i) => {
    const q = points[i - 1];
    return q !== undefined && Math.max(p.x, q.x) > b.x + 1 && Math.min(p.x, q.x) < b.x + b.w - 1 && Math.max(p.y, q.y) > b.y + 1 && Math.min(p.y, q.y) < b.y + b.h - 1;
  });

  it('keeps the plain route when nothing is in the way', () => {
    const a = box(0, 0);
    const b = box(300, 100);
    expect(routeAround(a, b, {dir: 'LR'}, [box(150, 300)])).toEqual(routeEdge(a, b, {dir: 'LR'}));
  });

  it('takes a route round a node the person dropped across the plain one', () => {
    const a = box(0, 0);
    const b = box(400, 0);
    const wall = box(180, -20, 60, 80);
    expect(through(routeEdge(a, b, {dir: 'LR'}), wall)).toBe(true);
    const points = routeAround(a, b, {dir: 'LR'}, [wall]);
    expect(through(points, wall)).toBe(false);
    expect(orthogonal(points)).toBe(true);
    expect(points[0]!.x).toBe(100);
    expect(points.at(-1)!.x).toBe(400);
  });
});

describe('openingView', () => {
  const grid = (cols: number, rows: number) => Array.from({length: cols * rows}, (_, i) => box((i % cols) * 160, Math.floor(i / cols) * 70, 120, 40));

  it('shows everything when it is readable whole, never above 100%', () => {
    const boxes = grid(3, 2);
    const opened = openingView(boundsOf(boxes), 960, 600, 0.4, boxes, boxes[0]);
    expect(opened.whole).toBe(true);
    expect(opened.view.k).toBe(1);
  });

  it('opens at a readable zoom on the stretch with the most nodes, the anchor among them and clear of the overview', () => {
    // a dense block on the left, a sparse line on the right, the anchor in the dense block
    const dense = grid(6, 8);
    const sparse = Array.from({length: 6}, (_, i) => box(2400 + i * 900, 0, 120, 40));
    const boxes = [...dense, ...sparse];
    const anchor = dense[6 * 6 + 1]!;
    const {view, whole} = openingView(boundsOf(boxes), 960, 600, 0.4, boxes, anchor);
    expect(whole).toBe(false);
    expect(view.k).toBe(READABLE_ZOOM);
    const shown = (b: Box) => b.x * view.k + view.x >= 0 && (b.x + b.w) * view.k + view.x <= 960 && b.y * view.k + view.y >= 0 && (b.y + b.h) * view.k + view.y <= 600;
    expect(shown(anchor)).toBe(true);
    expect(boxes.filter(shown).length).toBeGreaterThanOrEqual(20);
    // the anchor is not under the overview inset in the bottom-left corner
    const left = anchor.x * view.k + view.x;
    const bottom = (anchor.y + anchor.h) * view.k + view.y;
    expect(left >= 150 || bottom <= 600 - 102).toBe(true);
  });
});

describe('text measurement', () => {
  it('measures r, t and f between an i and a letter, and full-width glyphs at an em', () => {
    const narrow = textWidth('i', UI_12);
    const slim = textWidth('r', UI_12);
    const letter = textWidth('a', UI_12);
    expect(slim).toBeGreaterThan(narrow);
    expect(slim).toBeLessThan(letter);
    expect(textWidth('模块', MONO_11)).toBeCloseTo(22);
  });
});
