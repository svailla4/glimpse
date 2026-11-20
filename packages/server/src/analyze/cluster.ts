// Module clustering (an adaptive cut of the directory tree with a hard cap) and cycle detection (iterative Tarjan).
import {dirName} from './languages.ts';

export interface CutFile {
  path: string;
  /** Lines of source code; 0 for files that are not source (docs, config, generated, binary). */
  weight: number;
}
export interface ModuleCut {
  /** Ids of the clusters that hold source code, heaviest first. Never more than the cap. */
  ids: string[];
  /** Cluster of a file path (any path: files that do not exist yet resolve by their directory). */
  moduleOf(path: string): string;
  /** Cluster that holds the files directly inside a directory. */
  moduleOfDir(dir: string): string;
}
export interface CutOptions {
  /** Directory to cut beneath; '' (default) is the repository root. */
  root?: string;
  /** Cap on the number of clusters. Default DEFAULT_MODULES; never more than MAX_MODULES. */
  max?: number;
  /** Directories holding a package manifest: preferred as cluster boundaries. */
  manifestDirs?: ReadonlySet<string>;
  /**
   * No cap: split until the structural rules alone stop (a directory under eight source files, or with one part, is
   * one module). The modules a repository has before any display cut: what a capped cut folds into rest clusters.
   */
  unbounded?: boolean;
}

/** The most clusters any cut may have, however many are asked for. */
export const MAX_MODULES = 40;
/**
 * Clusters of the repository cut, and of a module graph nobody asked to be larger: few enough that a graph of them
 * is legible in its plate without zooming, with the smaller directories folded into their parent's rest cluster.
 */
export const DEFAULT_MODULES = 20;
/** A directory with fewer source files than this is one module however it is laid out inside. */
const MIN_SPLIT_FILES = 8;

/** Id of the cluster holding a split directory's own files and its folded small subdirectories. */
export function restId(dir: string): string {
  return dir === '' ? '(root)' : `${dir}/*`;
}
/** Directory a cluster id stands for, and whether it is that directory's rest cluster. */
export function parseModuleId(id: string): {dir: string; rest: boolean} {
  if (id === '(root)') return {dir: '', rest: true};
  if (id === '.') return {dir: '', rest: false};
  return id.endsWith('/*') ? {dir: id.slice(0, -2), rest: true} : {dir: id, rest: false};
}

interface DirStat {
  weight: number;
  sources: number;
  directWeight: number;
  children: string[];
}

/**
 * Starts with the root as one cluster and keeps splitting the heaviest cluster into its child directories while fewer
 * than `max` clusters exist: first whatever lies outside every package (so packages become clusters), then by weight
 * inside them. A split that would exceed the cap keeps the heaviest children and folds the smallest siblings into the
 * parent's rest cluster, so the cap always holds. Small directories (under eight source files) are left whole unless
 * a package lies beneath them.
 */
export function cutModules(files: readonly CutFile[], options: CutOptions = {}): ModuleCut {
  const root = options.root ?? '';
  const max = options.unbounded ? Number.POSITIVE_INFINITY : Math.min(MAX_MODULES, Math.max(1, options.max ?? DEFAULT_MODULES));
  const manifestDirs = options.manifestDirs ?? new Set<string>();
  const inScope = (path: string) => root === '' || path.startsWith(root + '/');

  const stats = new Map<string, DirStat>();
  const stat = (dir: string): DirStat => {
    let entry = stats.get(dir);
    if (!entry) {
      entry = {weight: 0, sources: 0, directWeight: 0, children: []};
      stats.set(dir, entry);
      if (dir !== root) stat(dirName(dir)).children.push(dir);
    }
    return entry;
  };
  stat(root);
  for (const file of files) {
    if (!inScope(file.path) || file.weight <= 0) continue;
    const home = dirName(file.path);
    stat(home).directWeight += file.weight;
    for (let dir = home; ; dir = dirName(dir)) {
      const entry = stat(dir);
      entry.weight += file.weight;
      entry.sources++;
      if (dir === root) break;
    }
  }

  // A directory above a package is split however small it is: packages are modules.
  const abovePackage = new Set<string>();
  for (const dir of manifestDirs) {
    if (dir === root || !inScope(`${dir}/`)) continue;
    for (let parent = dirName(dir); ; parent = dirName(parent)) {
      abovePackage.add(parent);
      if (parent === root || parent === '') break;
    }
  }

  const clusters = new Set<string>([root]);
  const split = new Set<string>();
  const rests = new Set<string>();
  const size = () => clusters.size + rests.size;

  const splitDir = (dir: string, room: number): boolean => {
    const entry = stats.get(dir)!;
    const children = [...entry.children].sort((a, b) => stats.get(b)!.weight - stats.get(a)!.weight || (a < b ? -1 : 1));
    const hasRest = entry.directWeight > 0;
    // `room` is how many clusters this directory may become.
    const keep = children.length + (hasRest ? 1 : 0) <= room ? children.length : room - 1;
    if (keep < 1) return false;
    clusters.delete(dir);
    split.add(dir);
    for (const child of children.slice(0, keep)) clusters.add(child);
    if (hasRest || keep < children.length) rests.add(dir);
    return true;
  };

  const isPackage = (dir: string) => dir !== root && manifestDirs.has(dir);
  /** True for a package directory and everything beneath one. */
  const insidePackage = (dir: string): boolean => {
    for (let at = dir; at !== root && at !== ''; at = dirName(at)) if (manifestDirs.has(at)) return true;
    return false;
  };
  /** The end of a chain of wrapper directories (one child directory, no source of their own) starting at `dir`. */
  const chainEnd = (dir: string, stopAtPackage: boolean): string => {
    for (let at = dir; ; ) {
      const entry = stats.get(at)!;
      if (entry.children.length !== 1 || entry.directWeight > 0 || (stopAtPackage && isPackage(at))) return at;
      at = entry.children[0]!;
    }
  };
  /** Moves a cluster down a chain: the directories passed through count as split. */
  const descend = (from: string, to: string) => {
    if (from === to) return;
    clusters.delete(from);
    for (let at = dirName(to); ; at = dirName(at)) {
      split.add(at);
      if (at === from) break;
    }
    clusters.add(to);
  };

  for (;;) {
    // Wrappers are stepped through for free, down to the first directory with content or a package of its own.
    for (const dir of [...clusters]) descend(dir, chainEnd(dir, true));
    if (size() >= max) break;
    let pick: string | undefined;
    for (const dir of clusters) {
      // A package directory that only wraps (packages/x holding just src/) is split where its content branches.
      const entry = stats.get(chainEnd(dir, false))!;
      const parts = entry.children.length + (entry.directWeight > 0 ? 1 : 0);
      if (parts < 2 || (entry.sources < MIN_SPLIT_FILES && !abovePackage.has(dir))) continue;
      if (pick === undefined) {
        pick = dir;
        continue;
      }
      // What lies outside every package is split first, so the cut reaches the package boundaries before the
      // budget goes into the inside of the heaviest packages; within each tier the heaviest goes first.
      const best = stats.get(pick)!;
      const preferred = Number(insidePackage(dir)) - Number(insidePackage(pick));
      if (preferred < 0 || (preferred === 0 && (entry.weight > best.weight || (entry.weight === best.weight && dir < pick)))) pick = dir;
    }
    if (pick === undefined) break;
    const end = chainEnd(pick, false);
    descend(pick, end);
    if (!splitDir(end, max - size() + 1)) break;
  }

  const idOf = (dir: string) => (dir === '' ? '.' : dir);
  const moduleOfDir = (start: string): string => {
    if (!inScope(`${start}/`) && start !== root) return idOf(root);
    for (let dir = start; ; dir = dirName(dir)) {
      if (clusters.has(dir)) return idOf(dir);
      if (split.has(dir)) return restId(dir);
      if (dir === root || dir === '') return idOf(root);
    }
  };
  const weightOf = (id: string) => {
    const {dir, rest} = parseModuleId(id);
    const entry = stats.get(dir);
    if (!entry) return 0;
    if (!rest) return entry.weight;
    let weight = entry.weight;
    for (const child of entry.children) if (clusters.has(child) || split.has(child)) weight -= stats.get(child)!.weight;
    return weight;
  };
  const ids = [...[...clusters].map(idOf), ...[...rests].map(restId)].filter(id => weightOf(id) > 0);
  ids.sort((a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : 1));
  return {ids, moduleOf: path => moduleOfDir(dirName(path)), moduleOfDir};
}

/**
 * Strongly connected components with more than one node, largest first; members sorted. Iterative, so depth is
 * bounded by memory, not by the call stack.
 */
export function findCycles(edges: ReadonlyArray<readonly [string, string]>): string[][] {
  const index = new Map<string, number>();
  const names: string[] = [];
  const adjacency: number[][] = [];
  const idOf = (name: string) => {
    let id = index.get(name);
    if (id === undefined) {
      id = names.length;
      index.set(name, id);
      names.push(name);
      adjacency.push([]);
    }
    return id;
  };
  for (const [from, to] of edges) {
    const a = idOf(from);
    const b = idOf(to);
    if (a !== b) adjacency[a]!.push(b);
  }

  const n = names.length;
  const order = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const cycles: string[][] = [];
  let counter = 0;
  for (let start = 0; start < n; start++) {
    if (order[start] !== -1) continue;
    const work: Array<[number, number]> = [[start, 0]];
    order[start] = low[start] = counter++;
    stack.push(start);
    onStack[start] = 1;
    while (work.length > 0) {
      const frame = work.at(-1)!;
      const node = frame[0];
      const next = adjacency[node]![frame[1]];
      if (next !== undefined) {
        frame[1]++;
        if (order[next] === -1) {
          order[next] = low[next] = counter++;
          stack.push(next);
          onStack[next] = 1;
          work.push([next, 0]);
        } else if (onStack[next]) low[node] = Math.min(low[node]!, order[next]!);
        continue;
      }
      work.pop();
      const parent = work.at(-1)?.[0];
      if (parent !== undefined) low[parent] = Math.min(low[parent]!, low[node]!);
      if (low[node] !== order[node]) continue;
      const component: string[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack[member] = 0;
        component.push(names[member]!);
        if (member === node) break;
      }
      if (component.length > 1) cycles.push(component.sort());
    }
  }
  return cycles.sort((a, b) => b.length - a.length || (a[0]! < b[0]! ? -1 : 1));
}
