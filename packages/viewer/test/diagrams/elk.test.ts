// The page side of the ELK layout (flowkit/elk.ts, decision diagram-engine-in-worker): one worker shared by every diagram, one promise per
// request, failures that reach only the requests they concern. ELK itself runs in-process here (test/diagrams/elk.ts).
import type {ElkExtendedEdge, ElkNode} from 'elkjs/lib/elk-api.js';
import {afterEach, describe, expect, it} from 'vitest';
import {configureElkWorker, layoutElk, prewarmElk, type ElkWorker} from '../../src/components/diagrams/flowkit/index.ts';
import {inProcessElk} from './elk.ts';

afterEach(() => configureElkWorker(undefined));

/** Two groups, a cross-group edge with a label, and a table whose columns are fixed ports (the diagram-engine-in-worker options). */
function sample(): ElkNode {
  const box = (id: string) => ({id, width: 120, height: 32});
  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.json.edgeCoords': 'ROOT',
    },
    children: [
      {id: 'g1', layoutOptions: {'elk.padding': '[top=26,left=12,bottom=12,right=12]'}, children: [box('a'), box('b')]},
      {id: 'g2', layoutOptions: {'elk.padding': '[top=26,left=12,bottom=12,right=12]'}, children: [box('c')]},
      {
        id: 't', width: 160, height: 80, layoutOptions: {'elk.portConstraints': 'FIXED_POS'},
        ports: [{id: 't.id.w', x: 0, y: 40, width: 1, height: 1, layoutOptions: {'elk.port.side': 'WEST'}}],
      },
    ],
    edges: [
      {id: 'a-b', sources: ['a'], targets: ['b']},
      {id: 'b-c', sources: ['b'], targets: ['c'], labels: [{text: ' ', width: 40, height: 14, layoutOptions: {'elk.edgeLabels.inline': 'true'}}]},
      {id: 'c-t', sources: ['c'], targets: ['t.id.w']},
    ],
  };
}

const find = (node: ElkNode, id: string): ElkNode | undefined => node.id === id ? node : node.children?.reduce<ElkNode | undefined>((hit, child) => hit ?? find(child, id), undefined);
const edge = (node: ElkNode, id: string) => node.edges?.find(e => e.id === id) as ElkExtendedEdge;

describe('layoutElk', () => {
  it('lays a graph out in the worker: groups sized around their children, edges routed in root coordinates', async () => {
    const worker = inProcessElk();
    configureElkWorker(() => worker);
    const graph = sample();
    const {laid, ms} = await layoutElk(graph);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(worker.requests).toHaveLength(1);
    // the caller's graph is not laid out in place (a worker gets a copy)
    expect(find(graph, 'a')!.x).toBeUndefined();

    const g1 = find(laid, 'g1')!;
    for (const id of ['a', 'b']) {
      const child = find(g1, id)!;
      // children are relative to their group and inside it, under the 26 px label band
      expect(child.y!).toBeGreaterThanOrEqual(26);
      expect(child.x! + child.width!).toBeLessThanOrEqual(g1.width! - 12 + 0.5);
      expect(child.y! + child.height!).toBeLessThanOrEqual(g1.height! - 12 + 0.5);
    }
    // the cross-group edge runs from b to c in root coordinates, with orthogonal segments
    const b = find(g1, 'b')!;
    const route = edge(laid, 'b-c').sections![0]!;
    const points = [route.startPoint, ...(route.bendPoints ?? []), route.endPoint];
    // (within a pixel: ELK puts implicit and 1 px ports just outside the border)
    expect(Math.abs(route.startPoint.x - (g1.x! + b.x! + b.width!))).toBeLessThanOrEqual(1);
    for (let i = 1; i < points.length; i++) expect(points[i]!.x === points[i - 1]!.x || points[i]!.y === points[i - 1]!.y).toBe(true);
    // the label was placed, and the port edge ends on the port
    const label = edge(laid, 'b-c').labels![0]!;
    expect(Number.isFinite(label.x) && Number.isFinite(label.y)).toBe(true);
    const t = find(laid, 't')!;
    const end = edge(laid, 'c-t').sections![0]!.endPoint;
    expect(Math.abs(end.x - t.x!)).toBeLessThanOrEqual(1);
    expect(Math.abs(end.y - (t.y! + 40))).toBeLessThanOrEqual(1);
  });

  it('shares one worker; a graph ELK refuses fails alone and the next layout still works', async () => {
    let made = 0;
    configureElkWorker(() => { made++; return inProcessElk(); });
    expect(prewarmElk()).toBe(true);
    expect(made).toBe(1);
    const bad: ElkNode = {id: 'root', children: [{id: 'a', width: 10, height: 10}], edges: [{id: 'e', sources: ['a'], targets: ['missing']}]};
    const [good, refused] = await Promise.allSettled([layoutElk(sample()), layoutElk(bad)]);
    expect(good.status).toBe('fulfilled');
    expect(refused.status).toBe('rejected');
    expect(String((refused as PromiseRejectedResult).reason?.message)).toMatch(/missing/);
    await expect(layoutElk(sample())).resolves.toBeDefined();
    expect(made).toBe(1);
  });

  it('a worker that fails rejects what it owes; the next request starts a new one', async () => {
    const workers: ElkWorker[] = [];
    configureElkWorker(() => {
      const silent: ElkWorker = {onmessage: null, onerror: null, postMessage() {}};
      const next = workers.length === 0 ? silent : inProcessElk();
      workers.push(next);
      return next;
    });
    const owed = layoutElk(sample());
    workers[0]!.onerror?.({message: 'blocked by policy'});
    await expect(owed).rejects.toThrow('the layout worker failed: blocked by policy');
    await expect(layoutElk(sample())).resolves.toBeDefined();
    expect(workers).toHaveLength(2);
  });

  it('without a worker it rejects at once (there is no main-thread fallback)', async () => {
    configureElkWorker(null);
    expect(prewarmElk()).toBe(false);
    await expect(layoutElk(sample())).rejects.toThrow('no layout worker in this environment');
    // jsdom has no Worker, so the browser default is "none" here too
    configureElkWorker(undefined);
    await expect(layoutElk(sample())).rejects.toThrow('no layout worker in this environment');
  });

  it('replacing the worker ends the old one and fails its pending requests', async () => {
    const first = inProcessElk();
    configureElkWorker(() => first);
    const pending = layoutElk(sample());
    configureElkWorker(() => inProcessElk());
    await expect(pending).rejects.toThrow('the layout worker was replaced');
    expect(first.terminated).toBe(true);
  });

  it('a graph that cannot be sent fails alone', async () => {
    configureElkWorker(() => inProcessElk());
    const unclonable = {...sample(), layoutOptions: {nope: (() => 'x') as unknown as string}};
    await expect(layoutElk(unclonable)).rejects.toThrow();
    await expect(layoutElk(sample())).resolves.toBeDefined();
  });
});
