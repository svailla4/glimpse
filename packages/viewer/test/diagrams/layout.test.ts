// The layered layout under load and in the cases flowcharts are made of (design rule D18): clusters stay whole, a
// dense graph at the 150-node cap lays out in well under a second, loops back go round the side in a corridor of
// their own, parallel edges and self-loops keep apart, and no label lands on a node or on another label.
import {describe, expect, it} from 'vitest';
import {labelPlate, layoutDiagram, nearestOn, type Box, type Laid, type LayoutSpec, type Point} from '../../src/components/diagrams/edgekit/index.ts';
import {runsAlong} from './util.tsx';

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** Files in `dirs` directories, each importing a few earlier ones, a third of them hubs: how a codebase looks. */
function codebase(n: number, perFile: number, dirs: number, seed = 3): LayoutSpec {
  const rnd = rng(seed);
  const nodes = Array.from({length: n}, (_, i) => ({id: `src/d${i % dirs}/f${i}.ts`, w: 152, h: 28, group: `dir:src/d${i % dirs}`}));
  const edges: LayoutSpec['edges'][number][] = [];
  const seen = new Set<string>();
  for (let i = 1; i < n; i++) {
    const k = 1 + Math.floor(rnd() * perFile * 2);
    for (let j = 0; j < k; j++) {
      const t = rnd() < 0.4 ? Math.floor(rnd() * Math.min(i, 8)) : Math.floor(rnd() * i);
      if (seen.has(`${i}>${t}`)) continue;
      seen.add(`${i}>${t}`);
      edges.push({key: String(edges.length), from: nodes[i]!.id, to: nodes[t]!.id});
    }
  }
  return {aspect: 1.6, wrap: true, nodesep: 16, ranksep: 40, nodes, edges, groups: Array.from({length: dirs}, (_, g) => ({id: `dir:src/d${g}`}))};
}

/** A random graph with `m` edges: the worst a model can bind inline (MAX_EDGES is 600). */
function random(n: number, m: number, seed = 7): LayoutSpec {
  const rnd = rng(seed);
  const nodes = Array.from({length: n}, (_, i) => ({id: `src/pkg${i % 10}/module_${i}.ts`, w: 168, h: 28, group: `dir:src/pkg${i % 10}`}));
  const edges: LayoutSpec['edges'][number][] = [];
  const seen = new Set<string>();
  while (edges.length < m) {
    const a = Math.floor(rnd() * n);
    const b = rnd() < 0.7 ? Math.floor(rnd() * n) : (a + 1 + Math.floor(rnd() * 5)) % n;
    if (a === b || seen.has(`${a}>${b}`)) continue;
    seen.add(`${a}>${b}`);
    edges.push({key: String(edges.length), from: nodes[a]!.id, to: nodes[b]!.id});
  }
  return {aspect: 1.6, wrap: true, nodesep: 16, ranksep: 40, nodes, edges, groups: Array.from({length: 10}, (_, g) => ({id: `dir:src/pkg${g}`}))};
}

const overlap = (a: Box, b: Box, clear = 0) => a.x < b.x + b.w + clear && b.x < a.x + a.w + clear && a.y < b.y + b.h + clear && b.y < a.y + a.h + clear;
/** True when a segment of the route runs through the inside of the box. */
const through = (points: readonly Point[], b: Box) => points.some((p, i) => {
  const q = points[i - 1];
  return q !== undefined && Math.max(p.x, q.x) > b.x + 1 && Math.min(p.x, q.x) < b.x + b.w - 1 && Math.max(p.y, q.y) > b.y + 1 && Math.min(p.y, q.y) < b.y + b.h - 1;
});

/** Per rank (nodes that share an x), the groups top to bottom: a group may not come back after another one. */
function interleaved(spec: LayoutSpec, laid: Laid): string[] {
  const groupOf = new Map(spec.nodes.map(node => [node.id, node.group ?? '']));
  const ranks = new Map<number, Array<[number, string]>>();
  for (const [id, box] of laid.boxes) {
    const list = ranks.get(box.x) ?? [];
    list.push([box.y, groupOf.get(id)!]);
    ranks.set(box.x, list);
  }
  const broken: string[] = [];
  for (const [x, list] of ranks) {
    const order = list.sort((a, b) => a[0] - b[0]).map(([, group]) => group);
    const done = new Set<string>();
    order.forEach((group, i) => {
      if (i > 0 && order[i - 1] !== group) done.add(order[i - 1]!);
      if (done.has(group)) broken.push(`${group} at x=${x}`);
    });
  }
  return broken;
}

const time = (run: () => unknown) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe('layoutDiagram at the 150-node cap', () => {
  it('keeps every directory group in one piece in every rank', () => {
    for (const spec of [codebase(150, 3, 12), codebase(80, 2, 6), random(150, 450)]) {
      const laid = layoutDiagram(spec);
      expect(laid.boxes.size).toBe(spec.nodes.length);
      for (const box of laid.boxes.values()) expect(Number.isFinite(box.x) && Number.isFinite(box.y)).toBe(true);
      expect(interleaved(spec, laid)).toEqual([]);
    }
  });

  it('lays a dense graph out in well under a second (it took 2 to 21 s before)', () => {
    // Warm the JIT on a small graph, as a page has by the time it draws a large one.
    layoutDiagram(codebase(20, 2, 4));
    const dense = random(150, 600);
    const elapsed = time(() => layoutDiagram(dense));
    expect(elapsed).toBeLessThan(3000);
    expect(time(() => layoutDiagram(codebase(150, 3, 12)))).toBeLessThan(1000);
  }, 60_000);
});

describe('layoutDiagram: flowcharts (design rule D18)', () => {
  const size = (label: string) => ({w: Math.ceil(label.length * 6.6) + 10, h: 16});
  const node = (id: string, w = 120, h = 36) => ({id, w, h});

  it('takes a loop back round the side, in a corridor of its own', () => {
    const spec: LayoutSpec = {
      dir: 'TB', nodesep: 32, ranksep: 44,
      nodes: [node('A'), node('B', 96, 56), node('C'), node('D')],
      edges: [
        {key: 'ab', from: 'A', to: 'B'}, {key: 'bc', from: 'B', to: 'C', label: size('yes')},
        {key: 'bd', from: 'B', to: 'D', label: size('no')}, {key: 'da', from: 'D', to: 'A', label: size('retry')},
      ],
    };
    const laid = layoutDiagram(spec);
    const a = laid.boxes.get('A')!;
    const d = laid.boxes.get('D')!;
    const back = laid.routes.get('da')!.points;
    // Out of a side of D, into a side of A (top to bottom: the left or the right).
    expect([d.x, d.x + d.w]).toContain(back[0]!.x);
    expect(back[0]!.y).toBeGreaterThan(d.y);
    expect(back[0]!.y).toBeLessThan(d.y + d.h);
    expect([a.x, a.x + a.w]).toContain(back.at(-1)!.x);
    // Through no node, and along no other edge's line.
    for (const [id, box] of laid.boxes) if (id !== 'A' && id !== 'D') expect(through(back, box)).toBe(false);
    for (const key of ['ab', 'bc', 'bd']) expect(runsAlong(back, laid.routes.get(key)!.points), `the loop back runs along ${key}`).toBe(false);
  });

  it.each(['LR', 'TB'] as const)('puts no label on a node or on another label (%s)', dir => {
    // A state machine a model wrote: long labels, a self-loop, edges both ways between two nodes.
    const labels: Array<[string, string, string]> = [
      ['Start', 'Created', 'show with root='], ['Created', 'Patched', 'show without root='], ['Patched', 'Patched', 'show without root='],
      ['Created', 'Replaced', 'show with root='], ['Patched', 'Replaced', 'show with root='], ['Replaced', 'Patched', 'show without root='],
      ['Created', 'Deleted', 'removed'], ['Patched', 'Deleted', 'removed'], ['Replaced', 'Deleted', 'removed'],
    ];
    const spec: LayoutSpec = {
      dir, nodesep: 32, ranksep: 44,
      nodes: [node('Start', 52, 52), node('Created', 84), node('Patched', 84), node('Replaced', 92), node('Deleted', 84)],
      edges: labels.map(([from, to, label], i) => ({key: String(i), from, to, label: size(label)})),
    };
    const laid = layoutDiagram(spec);
    const plates = spec.edges.map(edge => {
      const at = laid.routes.get(edge.key)!.label!;
      return {x: at.x - edge.label!.w / 2, y: at.y - edge.label!.h / 2, w: edge.label!.w, h: edge.label!.h};
    });
    for (const plate of plates) for (const box of laid.boxes.values()) expect(overlap(plate, box)).toBe(false);
    for (let i = 0; i < plates.length; i++) for (let j = i + 1; j < plates.length; j++) expect(overlap(plates[i]!, plates[j]!), `labels ${i} and ${j}`).toBe(false);
  });

  it('gives two edges between the same nodes a lane each, and a self-loop room beside its node', () => {
    const spec: LayoutSpec = {
      dir: 'LR', nodesep: 32, ranksep: 44,
      nodes: [node('A'), node('B'), node('C')],
      edges: [{key: '1', from: 'A', to: 'B', label: size('first')}, {key: '2', from: 'A', to: 'B', label: size('second')}, {key: '3', from: 'B', to: 'B', label: size('again')}, {key: '4', from: 'A', to: 'C'}],
    };
    const laid = layoutDiagram(spec);
    const first = laid.routes.get('1')!.points;
    const second = laid.routes.get('2')!.points;
    expect(Math.abs(first[0]!.y - second[0]!.y)).toBeGreaterThanOrEqual(8);
    const loop = laid.routes.get('3')!.points;
    for (const [id, box] of laid.boxes) if (id !== 'B') expect(through(loop, box)).toBe(false);
    const at = laid.routes.get('3')!.label!;
    for (const box of laid.boxes.values()) expect(overlap({x: at.x - 20, y: at.y - 8, w: 40, h: 16}, box)).toBe(false);
  });
});

// V005, after the second round: the session model's state charts, as the viewer sizes them.
describe('layoutDiagram: self-loops and labels of shared stretches (V005)', () => {
  const node = (id: string, w = 84, h = 36) => ({id, w, h});
  const STATES: Array<[string, string, string]> = [
    ['Start', 'Created', 'show with root='], ['Created', 'Patched', 'show without root='], ['Patched', 'Patched', 'show without root='],
    ['Created', 'Replaced', 'show with root='], ['Patched', 'Replaced', 'show with root='], ['Replaced', 'Patched', 'show without root='],
    ['Created', 'Deleted', 'removed'], ['Patched', 'Deleted', 'removed'], ['Replaced', 'Deleted', 'removed'],
  ];
  const LIFECYCLE: Array<[string, string, string]> = [
    ['C', 'P', 'show with id and spec'], ['P', 'P', 'show with id and spec, no root'], ['C', 'R', 'show with root'],
    ['P', 'R', 'show with root'], ['R', 'X', 'delete'], ['P', 'X', 'delete'],
  ];
  const specOf = (dir: 'LR' | 'TB', edges: Array<[string, string, string]>, nodes: LayoutSpec['nodes']): LayoutSpec => ({
    dir, nodesep: 32, ranksep: 44, nodes,
    edges: edges.map(([from, to, label], i) => ({key: String(i), from, to, label: labelPlate(label)})),
  });
  const plateOf = (spec: LayoutSpec, laid: Laid, key: string): Box => {
    const at = laid.routes.get(key)!.label!;
    const {w, h} = spec.edges.find(edge => edge.key === key)!.label!;
    return {x: at.x - w / 2, y: at.y - h / 2, w, h};
  };
  /** Segments of the two routes that run side by side closer than `gap` px, over more than 2 px. */
  const alongside = (a: readonly Point[], b: readonly Point[], gap: number) => {
    let found = 0;
    for (let i = 1; i < a.length; i++) {
      for (let j = 1; j < b.length; j++) {
        const [p, q, r, t] = [a[i - 1]!, a[i]!, b[j - 1]!, b[j]!];
        const overlapOf = (u: number, v: number, w: number, z: number) => Math.min(Math.max(u, v), Math.max(w, z)) - Math.max(Math.min(u, v), Math.min(w, z));
        if (Math.abs(p.y - q.y) < 0.5 && Math.abs(r.y - t.y) < 0.5 && Math.abs(p.y - r.y) < gap && overlapOf(p.x, q.x, r.x, t.x) > 2) found++;
        if (Math.abs(p.x - q.x) < 0.5 && Math.abs(r.x - t.x) < 0.5 && Math.abs(p.x - r.x) < gap && overlapOf(p.y, q.y, r.y, t.y) > 2) found++;
      }
    }
    return found;
  };
  /** True when `p` lies on the line through `points`. */
  const onLine = (points: readonly Point[], p: Point) => points.some((a, i) => {
    const b = points[i + 1];
    return b !== undefined && p.x >= Math.min(a.x, b.x) - 1.5 && p.x <= Math.max(a.x, b.x) + 1.5 && p.y >= Math.min(a.y, b.y) - 1.5 && p.y <= Math.max(a.y, b.y) + 1.5;
  });

  it('draws a self-loop beside its node, not along the edges that turn below it (m-t19)', () => {
    // Top to bottom: the loop on Patched left its bottom and ran 5 px above Patched -> Replaced, its label between the two.
    const spec = specOf('TB', LIFECYCLE, [node('C'), node('P'), node('R', 92), node('X')]);
    const laid = layoutDiagram(spec);
    const p = laid.boxes.get('P')!;
    const loop = laid.routes.get('1')!.points;
    // Beside Patched, within its height: never in the gap between the ranks, where the other edges turn.
    for (const point of loop) {
      expect(point.y).toBeGreaterThanOrEqual(p.y);
      expect(point.y).toBeLessThanOrEqual(p.y + p.h);
    }
    for (const [key, route] of laid.routes) if (key !== '1') expect(alongside(loop, route.points, 8), `the loop runs along edge ${key}`).toBe(0);
    // Its label crosses no other edge and covers no node.
    const label = plateOf(spec, laid, '1');
    for (const box of laid.boxes.values()) expect(overlap(label, box)).toBe(false);
    for (const [key, route] of laid.routes) if (key !== '1') expect(through(route.points, label), `edge ${key} runs under the loop's label`).toBe(false);
  });

  it.each(['LR', 'TB'] as const)('names each branch of a fan-out on its own stretch, not on the stem they share (s-t19, %s)', dir => {
    const spec = specOf(dir, STATES, [node('Start', 52, 52), node('Created'), node('Patched'), node('Replaced', 92), node('Deleted')]);
    const laid = layoutDiagram(spec);
    for (const edge of spec.edges) {
      if (edge.from === edge.to) continue;
      const route = laid.routes.get(edge.key)!;
      const at = route.label!;
      // The point of its own line the label sits on (or beside) is a point no other edge runs through.
      const named = nearestOn(route.points, at);
      expect(Math.hypot(named.x - at.x, named.y - at.y), `label ${edge.key} is off its line`).toBeLessThanOrEqual(Math.max(edge.label!.w, edge.label!.h) / 2 + 4);
      for (const [key, other] of laid.routes) {
        if (key !== edge.key) expect(onLine(other.points, named), `label ${edge.key} (${edge.from} -> ${edge.to}) names a stretch edge ${key} shares`).toBe(false);
      }
    }
  });
});
