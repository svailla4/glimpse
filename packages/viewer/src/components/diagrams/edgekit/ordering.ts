// The two steps of dagre's layered layout that layout.ts does itself, through dagre's hooks:
//   keepRanks     the ranks layout.ts chose, instead of dagre's network simplex. The simplex only finds the ranks
//                 again (every edge is already as short as its minimum length), at a cost that grows with the square
//                 of the graph: seconds at the 150-node cap.
//   clusterOrder  the order within each rank. dagre 3's own ordering of a graph with clusters drops nodes from
//                 some ranks, which leaves two nodes on one place and the layout without coordinates; layout.ts then
//                 fell back to a layout without clusters, where group frames overlap and edges seem to enter
//                 frames they have nothing to do with. This one keeps every cluster in one piece in every rank and
//                 sibling clusters in the same order in every rank, so frames never interleave.
import type {Edge, Graph, GraphLabel} from '@dagrejs/dagre';

// dagre's internal graph, as the hooks receive it. Only what is read here is typed.
interface Label { rank?: number; order?: number; borderType?: string; weight?: number; minlen?: number }
type Layered = Graph<GraphLabel, Label, Label>;

/**
 * A dagre ranker that gives every node whose rank `fixed` knows that rank (scaled to dagre's internal rank units)
 * and places the border nodes of the cluster nesting graph as close to their members as they may be. Linear in the
 * size of the graph.
 */
export function keepRanks(fixed: (id: string) => number | undefined): (graph: Layered) => void {
  return graph => {
    const nodes = graph.nodes();
    const edges = graph.edges();
    const minlen = (e: Edge) => graph.edge(e)?.minlen ?? 1;
    // dagre stretches every edge (room for labels, room for cluster borders): one of our ranks is `scale` of its.
    let scale = 1;
    for (const e of edges) {
      const a = fixed(e.v);
      const b = fixed(e.w);
      if (a !== undefined && b !== undefined && b > a) scale = Math.max(scale, Math.ceil(minlen(e) / (b - a)));
    }
    const rank = new Map<string, number>();
    const free: string[] = [];
    for (const v of nodes) {
      const r = fixed(v);
      if (r === undefined) free.push(v);
      else rank.set(v, r * scale);
    }
    // A border bottom (and anything else with only incoming edges) sits right after what leads to it; a border top,
    // the nesting root and the rest right before what they lead to. The nesting graph is a tree: this settles in a
    // few passes.
    for (let pass = 0, changed = free.length > 0; changed && pass <= free.length + 1; pass++) {
      changed = false;
      for (const v of free) {
        const outs = graph.outEdges(v) ?? [];
        const ins = graph.inEdges(v) ?? [];
        let value: number | undefined;
        if (outs.length === 0) {
          for (const e of ins) {
            const r = rank.get(e.v);
            if (r !== undefined) value = Math.max(value ?? -Infinity, r + minlen(e));
          }
        } else {
          for (const e of outs) {
            const r = rank.get(e.w);
            if (r !== undefined) value = Math.min(value ?? Infinity, r - minlen(e));
          }
        }
        if (value !== undefined && value !== rank.get(v)) {
          rank.set(v, value);
          changed = true;
        }
      }
    }
    // Whatever is still shorter than its minimum length is pushed later, in topological order (the graph is acyclic
    // by now), so dagre always gets a feasible ranking.
    const waiting = new Map(nodes.map(v => [v, (graph.inEdges(v) ?? []).length]));
    const queue = nodes.filter(v => waiting.get(v) === 0);
    for (let i = 0; i < queue.length; i++) {
      const v = queue[i]!;
      const at = rank.get(v) ?? 0;
      rank.set(v, at);
      for (const e of graph.outEdges(v) ?? []) {
        if ((rank.get(e.w) ?? -Infinity) < at + minlen(e)) rank.set(e.w, at + minlen(e));
        const left = waiting.get(e.w)! - 1;
        waiting.set(e.w, left);
        if (left === 0) queue.push(e.w);
      }
    }
    for (const v of nodes) graph.node(v).rank = rank.get(v) ?? 0;
  };
}

/**
 * Which passing chain a node belongs to: the nodes one edge (or one bundle of edges) passes the ranks through, which
 * should stay on one side of a cluster. `edge` is the layout edge a dagre dummy node stands in for.
 */
export type ChainOf = (id: string, edge: Edge | undefined) => string | undefined;
const dummyChain: ChainOf = (_id, edge) => (edge ? `${edge.v}\u0001${edge.w}\u0001${edge.name ?? ''}` : undefined);
export interface OrderHooks {
  chainOf?: ChainOf;
  /** A node that must stand right beside another of its rank (a side junction beside its node): that node's id. */
  anchorOf?: (id: string) => string | undefined;
}

/** Sweeps of barycentre ordering; the order with the fewest crossings is kept. */
const SWEEPS = 8;

/**
 * Orders every rank of dagre's layered graph: barycentre sweeps, alternately down and up, where a cluster is sorted
 * as one item (by the mean place of all its members in all ranks, so sibling clusters keep one order everywhere) and
 * a cluster's left and right border nodes stay at its ends. Sets `order` on every node that has a rank.
 */
export function clusterOrder(graph: Layered, hooks: OrderHooks = {}): void {
  const chainOf = hooks.chainOf ?? dummyChain;
  const ids = graph.nodes();
  const leaves = ids.filter(v => graph.children(v).length === 0 && typeof graph.node(v).rank === 'number');
  const n = leaves.length;
  if (n === 0) return;
  const index = new Map(leaves.map((v, i) => [v, i]));
  const rank = new Int32Array(n);
  let maxRank = 0;
  let minRank = Infinity;
  leaves.forEach((v, i) => {
    rank[i] = graph.node(v).rank!;
    maxRank = Math.max(maxRank, rank[i]!);
    minRank = Math.min(minRank, rank[i]!);
  });
  for (let i = 0; i < n; i++) rank[i] = rank[i]! - minRank;
  maxRank -= minRank;

  // Clusters as numbers; each leaf knows its innermost cluster, each cluster its parent (-1: none).
  const clusters = ids.filter(v => graph.children(v).length > 0);
  const clusterIndex = new Map(clusters.map((v, i) => [v, i]));
  const clusterOf = (v: string) => {
    const parent = graph.parent(v);
    return parent !== undefined ? (clusterIndex.get(parent) ?? -1) : -1;
  };
  const parentOf = clusters.map(clusterOf);
  const home = Int32Array.from(leaves, clusterOf);
  /** -1 first in its cluster (a left border), 1 last (a right border), 0 anywhere. */
  const pin = Int8Array.from(leaves, v => (graph.node(v).borderType === 'borderLeft' ? -1 : graph.node(v).borderType === 'borderRight' ? 1 : 0));
  const ins: Array<Array<[number, number]>> = leaves.map(() => []);
  const outs: Array<Array<[number, number]>> = leaves.map(() => []);
  leaves.forEach((v, i) => {
    for (const e of graph.outEdges(v) ?? []) {
      const j = index.get(e.w);
      if (j === undefined) continue;
      const weight = graph.edge(e)?.weight ?? 1;
      outs[i]!.push([j, weight]);
      ins[j]!.push([i, weight]);
    }
  });

  // First order: depth first along the edges, as dagre starts.
  const layers: number[][] = Array.from({length: maxRank + 1}, () => []);
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  for (const start of [...leaves.keys()].sort((a, b) => rank[a]! - rank[b]!)) {
    stack.push(start);
    while (stack.length > 0) {
      const v = stack.pop()!;
      if (seen[v]) continue;
      seen[v] = 1;
      layers[rank[v]!]!.push(v);
      const next = outs[v]!;
      for (let k = next.length - 1; k >= 0; k--) if (!seen[next[k]![0]]) stack.push(next[k]![0]);
    }
  }
  const pos = new Float64Array(n);
  const place = (layer: readonly number[]) => layer.forEach((v, i) => { pos[v] = i; });
  layers.forEach(place);
  const spread = (layer: readonly number[]) => Math.max(1, layer.length - 1);

  // Every cluster's key: the mean relative place of its members (at any depth) in their ranks.
  const key = new Float64Array(clusters.length);
  const clusterKeys = () => {
    const sum = new Float64Array(clusters.length);
    const count = new Float64Array(clusters.length);
    for (let v = 0; v < n; v++) {
      const at = pos[v]! / spread(layers[rank[v]!]!);
      for (let c = home[v]!; c !== -1; c = parentOf[c]!) {
        sum[c] = sum[c]! + at;
        count[c] = count[c]! + 1;
      }
    }
    for (let c = 0; c < clusters.length; c++) key[c] = count[c] ? sum[c]! / count[c]! : 0.5;
  };

  const bary = new Float64Array(n);
  interface Item { key: number; pin: number; leaf: number; items?: Item[] }
  const sortLayer = (layer: number[]) => {
    const roots: Item[] = [];
    const groups = new Map<number, Item>();
    const groupOf = (c: number): Item => {
      let item = groups.get(c);
      if (!item) {
        item = {key: key[c]!, pin: 0, leaf: -1, items: []};
        groups.set(c, item);
        (parentOf[c] === -1 ? roots : groupOf(parentOf[c]!).items!).push(item);
      }
      return item;
    };
    for (const v of layer) (home[v] === -1 ? roots : groupOf(home[v]!).items!).push({key: bary[v]!, pin: pin[v]!, leaf: v});
    layer.length = 0;
    const flatten = (items: Item[]) => {
      items.sort((a, b) => a.pin - b.pin || a.key - b.key);
      for (const item of items) {
        if (item.items) flatten(item.items);
        else layer.push(item.leaf);
      }
    };
    flatten(roots);
    place(layer);
  };

  const sweep = (down: boolean) => {
    for (let step = 1; step <= maxRank; step++) {
      const r = down ? step : maxRank - step;
      const layer = layers[r]!;
      const fixed = spread(layers[down ? r - 1 : r + 1]!);
      for (const v of layer) {
        let sum = 0;
        let weight = 0;
        for (const [u, w] of down ? ins[v]! : outs[v]!) {
          sum += w * pos[u]!;
          weight += w;
        }
        bary[v] = weight > 0 ? sum / weight / fixed : pos[v]! / spread(layer);
      }
      sortLayer(layer);
    }
  };

  /** Weighted crossings between neighbouring ranks (Barth, Jünger and Mutzel's accumulator tree). */
  const crossings = (): number => {
    let total = 0;
    for (let r = 1; r <= maxRank; r++) {
      let first = 1;
      while (first < layers[r]!.length) first <<= 1;
      const tree = new Float64Array(2 * first - 1);
      first -= 1;
      for (const v of layers[r - 1]!) {
        const ends = outs[v]!.filter(([w]) => rank[w] === r).sort((a, b) => pos[a[0]]! - pos[b[0]]!);
        for (const [w, weight] of ends) {
          let at = pos[w]! + first;
          tree[at] = tree[at]! + weight;
          let sum = 0;
          while (at > 0) {
            if (at % 2) sum += tree[at + 1]!;
            at = (at - 1) >> 1;
            tree[at] = tree[at]! + weight;
          }
          total += weight * sum;
        }
      }
    }
    return total;
  };

  // Clusters in one piece before the first sweep.
  clusterKeys();
  for (const layer of layers) {
    for (const v of layer) bary[v] = pos[v]! / spread(layer);
    sortLayer(layer);
  }
  let best = layers.map(layer => [...layer]);
  let fewest = crossings();
  for (let i = 0; i < SWEEPS && fewest > 0; i++) {
    clusterKeys();
    sweep(i % 2 === 0);
    const count = crossings();
    if (count < fewest) {
      fewest = count;
      best = layers.map(layer => [...layer]);
    }
  }
  if (hooks.anchorOf) besideAnchors(best, hooks.anchorOf);
  keepChainsBeside(best);

  /**
   * Every anchored node moves next to its anchor, on the side it was sorted to; several keep their order. The
   * anchored nodes of one chain (the two ends of a side loop) all take the side most of them were sorted to, so the
   * loop goes round one side instead of crossing over.
   */
  function besideAnchors(order: number[][], anchorOf: (id: string) => string | undefined): void {
    const byAnchor = new Map<number, number[]>();
    const vote = new Map<string, number>();
    const where = new Float64Array(n);
    for (const layer of order) layer.forEach((v, i) => { where[v] = i; });
    for (let v = 0; v < n; v++) {
      const anchor = anchorOf(leaves[v]!);
      const a = anchor !== undefined ? index.get(anchor) : undefined;
      if (a === undefined || rank[a] !== rank[v]) continue;
      const chain = chainOf(leaves[v]!, undefined) ?? leaves[v]!;
      vote.set(chain, (vote.get(chain) ?? 0) + (where[v]! < where[a]! ? -1 : 1));
      const list = byAnchor.get(a);
      if (list) list.push(v);
      else byAnchor.set(a, [v]);
    }
    const sideOf = (v: number) => ((vote.get(chainOf(leaves[v]!, undefined) ?? leaves[v]!) ?? 1) < 0 ? -1 : 1);
    for (const [a, list] of byAnchor) {
      const layer = order[rank[a]!]!;
      const at = (v: number) => layer.indexOf(v);
      const before = list.filter(v => sideOf(v) < 0).sort((x, y) => at(x) - at(y));
      const after = list.filter(v => sideOf(v) > 0).sort((x, y) => at(x) - at(y));
      for (const v of list) layer.splice(at(v), 1);
      layer.splice(at(a), 0, ...before);
      layer.splice(at(a) + 1, 0, ...after);
    }
  }
  for (const layer of best) layer.forEach((v, i) => { graph.node(leaves[v]!).order = i; });

  /**
   * An edge that only passes a cluster stays on one side of it for every rank the cluster spans: switching sides
   * there would draw it through the frame, as if it entered the cluster. Each passing chain of dummy nodes keeps the
   * side most of it is on.
   */
  function keepChainsBeside(order: number[][]): void {
    const chains = new Map<string, number[]>();
    for (let v = 0; v < n; v++) {
      const label = graph.node(leaves[v]!) as Label & {dummy?: string; edgeObj?: Edge};
      const edge = label.dummy === 'edge' || label.dummy === 'edge-label' ? label.edgeObj : undefined;
      const key = chainOf(leaves[v]!, edge);
      if (key === undefined) continue;
      const chain = chains.get(key);
      if (chain) chain.push(v);
      else chains.set(key, [v]);
    }
    if (chains.size === 0 || clusters.length === 0) return;
    // Where each cluster sits in each rank: its first and last index there.
    const at = new Float64Array(n);
    const indexAll = () => { for (const layer of order) layer.forEach((v, i) => { at[v] = i; }); };
    indexAll();
    const spanOf = (c: number, r: number): [number, number] | undefined => {
      let first = Infinity;
      let last = -Infinity;
      for (const v of order[r]!) {
        let inside = false;
        for (let k = home[v]!; k !== -1; k = parentOf[k]!) if (k === c) inside = true;
        if (!inside) continue;
        first = Math.min(first, at[v]!);
        last = Math.max(last, at[v]!);
      }
      return first === Infinity ? undefined : [first, last];
    };
    for (let c = 0; c < clusters.length; c++) {
      const ranks = new Map<number, [number, number]>();
      for (let r = 0; r <= maxRank; r++) {
        const span = spanOf(c, r);
        if (span) ranks.set(r, span);
      }
      if (ranks.size < 2) continue;
      for (const chain of chains.values()) {
        const beside = chain.filter(v => home[v] === parentOf[c] && ranks.has(rank[v]!));
        if (beside.length < 2) continue;
        const before = beside.filter(v => at[v]! < ranks.get(rank[v]!)![0]).length;
        const side = before * 2 >= beside.length ? -1 : 1;
        for (const v of beside) {
          const r = rank[v]!;
          const [first, last] = ranks.get(r)!;
          if (side < 0 ? at[v]! < first : at[v]! > last) continue;
          const layer = order[r]!;
          layer.splice(at[v]!, 1);
          // Just outside the block (whose indices shift by one once v is gone from before it).
          layer.splice(side < 0 ? first : last, 0, v);
          layer.forEach((u, i) => { at[u] = i; });
          ranks.set(r, side < 0 ? [first + 1, last + 1] : [first - 1, last - 1]);
        }
      }
    }
  }
}
