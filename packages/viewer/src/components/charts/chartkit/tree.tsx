// What Treemap and Icicle share: the cleaned tree, size metrics with rollups, fills, the breadcrumb and legends.
import type {DataInput, DirNode, EntityRef, SurfaceMeta} from '@glimpse/catalog';
import {hierarchy, type HierarchyNode} from 'd3-hierarchy';
import {useMemo, type JSX, type ReactNode} from 'react';
import {DataGate, assignSlots, catVar, fmtNum, isOtherKey, matchSelection, seqVar, useDataset, type DataState} from '../../../kit/index.ts';
import {Legend, Ramp, ShapeError, reserve, type LegendItem, type Slotter} from './Chart.tsx';
import css from './chartkit.module.css';
import {num, OTHER, tintVar} from './data.ts';

export type Metric = 'loc' | 'bytes' | 'files' | 'commits';
export type ColorMode = 'lang' | 'churn' | 'age' | 'complexity' | 'depth' | 'none';
export const METRICS: readonly Metric[] = ['loc', 'bytes', 'files', 'commits'];
export const COLOR_MODES: readonly ColorMode[] = ['lang', 'churn', 'age', 'complexity', 'depth', 'none'];

/** A node of the cleaned tree. Files have no children; a rollup stands for the children a budget cut away. */
export interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  lang?: string;
  loc: number;
  bytes: number;
  files: number;
  commits?: number;
  age?: number;
  complexity?: number;
  children: TreeNode[];
  parent?: TreeNode;
  /** Set on the synthetic "(N more)" child. */
  rollup?: {files: number; loc: number};
}

export interface CleanTree {
  root: TreeNode;
  byPath: Map<string, TreeNode>;
  /** Languages of the whole tree in order of first appearance: the order in which those without a session slot take a free ink. */
  langs: string[];
  /** Nodes left out: repeated paths, cycles, entries that are not objects, anything past the node cap. */
  dropped: number;
}

const MAX_NODES = 20_000;
const MAX_DEPTH = 64;
const size = (value: unknown) => Math.max(0, num(value) ?? 0);
const optional = (value: unknown) => {
  const n = num(value);
  return n === undefined ? undefined : Math.max(0, n);
};

/** Copies a DirNode tree into TreeNodes, dropping what cannot be drawn. Undefined when the value is not a tree node. */
export function cleanTree(input: unknown): CleanTree | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const seen = new Set<object>();
  const byPath = new Map<string, TreeNode>();
  const langs = new Set<string>();
  let dropped = 0;
  const visit = (raw: Record<string, unknown>, parent: TreeNode | undefined, depth: number): TreeNode | undefined => {
    const name = typeof raw.name === 'string' ? raw.name : typeof raw.path === 'string' ? (raw.path.split('/').pop() ?? '') : '';
    const path = typeof raw.path === 'string' ? raw.path : parent ? (parent.path ? `${parent.path}/${name}` : name) : '';
    if (seen.has(raw) || byPath.has(path) || byPath.size >= MAX_NODES || depth > MAX_DEPTH) {
      dropped++;
      return undefined;
    }
    seen.add(raw);
    const kids = Array.isArray(raw.children) ? raw.children : [];
    const node: TreeNode = {
      name,
      path,
      dir: typeof raw.dir === 'boolean' ? raw.dir : kids.length > 0,
      lang: typeof raw.lang === 'string' ? raw.lang : undefined,
      loc: size(raw.loc),
      bytes: size(raw.bytes),
      files: size(raw.files),
      commits: optional(raw.commits),
      age: optional(raw.age),
      complexity: optional(raw.complexity),
      children: [],
      parent,
    };
    byPath.set(path, node);
    if (node.lang) langs.add(node.lang);
    for (const kid of kids) {
      if (typeof kid !== 'object' || kid === null || Array.isArray(kid)) {
        dropped++;
        continue;
      }
      const child = visit(kid as Record<string, unknown>, node, depth + 1);
      if (child) node.children.push(child);
    }
    const more = raw.more;
    if (typeof more === 'object' && more !== null) {
      const files = size((more as {files?: unknown}).files);
      const loc = size((more as {loc?: unknown}).loc);
      if (files > 0 || loc > 0) {
        node.children.push({name: `(${fmtNum(files)} more)`, path, dir: false, loc, bytes: 0, files, children: [], parent: node, rollup: {files, loc}});
      }
    }
    return node;
  };
  const root = visit(input as Record<string, unknown>, undefined, 0);
  return root ? {root, byPath, langs: [...langs], dropped} : undefined;
}

/**
 * Size of a node for a metric. A directory's own figure wins (the server computed it before any cut); when it has
 * none the children are summed. A rollup takes what its parent has beyond the children that are listed.
 */
export function createSizer(metric: Metric): (node: TreeNode) => number {
  const memo = new Map<TreeNode, number>();
  const own = (node: TreeNode) => (metric === 'commits' ? (node.commits ?? 0) : node[metric]);
  const total = (node: TreeNode): number => {
    const known = memo.get(node);
    if (known !== undefined) return known;
    let value: number;
    if (node.rollup) {
      if (metric === 'loc') value = node.rollup.loc;
      else if (metric === 'files') value = node.rollup.files;
      else {
        const parent = node.parent!;
        let listed = 0;
        for (const sibling of parent.children) if (!sibling.rollup) listed += total(sibling);
        value = Math.max(0, own(parent) - listed);
      }
    } else if (node.children.length === 0) value = own(node);
    else {
      value = own(node);
      if (value <= 0) for (const child of node.children) value += total(child);
    }
    memo.set(node, value);
    return value;
  };
  return total;
}

export function nodeEntity(node: TreeNode): EntityRef {
  const dir = node.dir || node.rollup !== undefined;
  return {type: dir ? 'dir' : 'file', id: node.path, path: node.path, label: node.name || node.path};
}

/** Selection test for tree cells: the kit's rule, plus a directory cell that holds the selection (a rollup holds nothing). */
export function nodeMatches(selected: EntityRef | null, node: TreeNode): boolean {
  const match = matchSelection(selected, nodeEntity(node));
  return match === 'exact' || match === 'within' || (match === 'contains' && node.dir);
}

const COLOR_FIELD: Partial<Record<ColorMode, 'commits' | 'age' | 'complexity'>> = {churn: 'commits', age: 'age', complexity: 'complexity'};
const NEUTRAL = 'color-mix(in oklab, var(--gl-ink) 7%, var(--gl-surface))';

export interface Painter {
  /** Fill of a cell and whether text on it needs the light-on-dark ink. */
  fill(node: TreeNode, depth: number): {color: string; strong: boolean};
  legend(): JSX.Element | null;
}

/**
 * Ink slots for the languages of a tree, from the kit's assignment (design D6). A language the session gave a slot
 * keeps it; the others take the lowest free slots in order of first appearance in the WHOLE tree, so zooming or
 * switching the metric repaints nothing; only a ninth language is `other`, and so is a language the server could
 * not name ('Other'), which never takes a hue.
 */
export function langSlots(langs: readonly string[], known: Record<string, number> | undefined, assign: Slotter = assignSlots): Map<string, number> {
  return assign(langs, known);
}

/**
 * The value a metric fill compares cells by. Commits and complexity of a directory grow with its size, which the
 * area already shows, so a directory cell is read per file; a file is its own figure. Age is a date, not a sum.
 */
function density(node: TreeNode, field: 'commits' | 'age' | 'complexity'): number | undefined {
  const value = node[field];
  if (value === undefined || field === 'age' || !node.dir) return value;
  return value / Math.max(1, node.files);
}

/**
 * Six cuts that split the drawn AREA into seven equal parts by value. Quantiles by cell count let hundreds of small
 * files take the low steps and paint every large cell with the top one; by area the ramp spreads over what the eye
 * sees.
 */
export function areaCuts(entries: ReadonlyArray<{value: number; weight: number}>): number[] {
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  let total = 0;
  for (const entry of sorted) total += entry.weight;
  const even = !(total > 0);
  if (even) total = sorted.length;
  const cuts: number[] = [];
  let acc = 0;
  for (const entry of sorted) {
    acc += even ? 1 : entry.weight;
    while (cuts.length < 6 && acc >= (total * (cuts.length + 1)) / 7) cuts.push(entry.value);
  }
  return cuts;
}

/**
 * Fills for one colour mode over the cells that are drawn. `lang` tints the surface with the language's ink (the
 * legend shows the ink itself: a swatch is a key, not a fill); the metric modes spread the cells over the seven
 * sequential steps by area-weighted quantile, so neither a few hot files nor a few large directories flatten the rest.
 */
export function createPainter(
  mode: ColorMode,
  cells: ReadonlyArray<{node: TreeNode; weight: number}>,
  slots: SurfaceMeta['slots'] | undefined,
  langs: readonly string[] = [],
  assign: Slotter = assignSlots,
): Painter {
  if (mode === 'lang') {
    // a rollup wears the dominant language of the directory it stands for
    const langOf = (node: TreeNode) => (node.rollup ? node.parent?.lang : node.lang);
    const assigned = langSlots(langs, slots?.lang, assign);
    const slotOf = (node: TreeNode) => {
      const lang = langOf(node);
      return lang === undefined || isOtherKey(lang) ? 0 : (assigned.get(lang) ?? 0);
    };
    return {
      fill: node => ({color: tintVar(catVar(slotOf(node))), strong: false}),
      legend() {
        const weights = new Map<string, {slot: number; weight: number}>();
        for (const {node, weight} of cells) {
          const slot = slotOf(node);
          const key = slot > 0 ? langOf(node)! : OTHER;
          const entry = weights.get(key);
          if (entry) entry.weight += weight;
          else weights.set(key, {slot, weight});
        }
        const items: LegendItem[] = [...weights]
          .sort((a, b) => (a[0] === OTHER ? 1 : b[0] === OTHER ? -1 : b[1].weight - a[1].weight))
          .map(([name, entry]) => ({key: name, label: name, color: catVar(entry.slot)}));
        return items.length > 1 || items[0]?.key !== OTHER ? <Legend items={items} /> : null;
      },
    };
  }
  const field = COLOR_FIELD[mode];
  if (field) {
    const entries: Array<{value: number; weight: number}> = [];
    let lo = Infinity;
    let hi = -Infinity;
    let perFile = false;
    for (const {node, weight} of cells) {
      const value = density(node, field);
      if (value === undefined) continue;
      entries.push({value, weight});
      lo = Math.min(lo, value);
      hi = Math.max(hi, value);
      perFile ||= field !== 'age' && node.dir;
    }
    const cuts = areaCuts(entries);
    const stepOf = (value: number) => {
      let step = 1;
      for (const cut of cuts) if (value > cut) step++;
      return step;
    };
    const unit = `${field}${perFile ? ' per file' : ''}`;
    return {
      fill(node) {
        const value = density(node, field);
        if (value === undefined) return {color: 'var(--gl-grid)', strong: false};
        const step = lo === hi ? 4 : stepOf(value);
        return {color: seqVar(step), strong: step >= 5};
      },
      legend: () => (entries.length > 0
        ? <Legend items={[]} end={<Ramp steps={[1, 2, 3, 4, 5, 6, 7].map(seqVar)} low={`${unit} ${fmtNum(lo, 'compact')}`} high={fmtNum(hi, 'compact')} />} />
        : null),
    };
  }
  if (mode === 'depth') {
    return {
      fill: (_, depth) => {
        const step = Math.min(7, Math.max(1, depth));
        return {color: seqVar(step), strong: step >= 5};
      },
      legend: () => null,
    };
  }
  return {fill: () => ({color: NEUTRAL, strong: false}), legend: () => null};
}

/**
 * What to call the root of a tree. The whole repository goes by its name. A tree that starts further down (the
 * spec asked for a directory) goes by its path. While a drill has re-scoped the dataset the kit's scope row already
 * spells that path out above the chart, so the root is just the directory's own name.
 */
export function rootLabel(tree: CleanTree, repo: string | undefined, drilled: boolean): string {
  const path = tree.root.path;
  if (!path) return repo || tree.root.name || 'root';
  return drilled ? (path.split('/').filter(Boolean).pop() ?? path) : path;
}

/** Path from the tree root to the zoomed directory; every crumb but the last zooms back out to its level. */
export function Crumbs(p: {root: string; node: TreeNode; onZoom: (path: string) => void}): JSX.Element {
  const trail: TreeNode[] = [];
  for (let node: TreeNode | undefined = p.node; node; node = node.parent) trail.unshift(node);
  return (
    <nav className={css.crumbs} aria-label="Zoom path" data-chart-crumbs="">
      {trail.map((node, i) => (
        <span key={node.path} className={css.crumbStep}>
          {i > 0 ? <span aria-hidden="true">/</span> : null}
          <button type="button" tabIndex={-1} className={css.crumb} aria-current={i === trail.length - 1 ? 'location' : undefined} onClick={() => p.onZoom(node.path)}>
            {i === 0 ? p.root : node.name}
          </button>
        </span>
      ))}
    </nav>
  );
}

export const METRIC_FORMAT: Record<Metric, 'num' | 'bytes'> = {loc: 'num', bytes: 'bytes', files: 'num', commits: 'num'};

function Cleaned(p: {name: string; id: string; data: unknown; children: (tree: CleanTree) => ReactNode}): ReactNode {
  const tree = useMemo(() => cleanTree(p.data), [p.data]);
  return tree ? p.children(tree) : <ShapeError name={p.name} id={p.id} expected="a tree node {name, path, children}" value={p.data} />;
}

/** The first lines of a tree chart: dataset states through DataGate, then the shape check and the cleaned tree. */
export function TreeGate(p: {
  name: string;
  id: string;
  input: DataInput<DirNode>;
  /** The cell's `size` prop and the height the chart takes without one: a pending tree holds that height (see reserve). */
  size?: string;
  height?: number;
  children: (tree: CleanTree, state: DataState<DirNode>) => ReactNode;
}): JSX.Element {
  const state = useDataset<DirNode>(p.input);
  return reserve(state, p.size, (
    <DataGate state={state} id={`${p.name}#${p.id}`}>
      {(data, ready) => <Cleaned name={p.name} id={p.id} data={data}>{tree => p.children(tree, ready)}</Cleaned>}
    </DataGate>
  ), p.height);
}

/** Next option of a toolbar cycle. */
export function cycle<T>(list: readonly T[], current: T): T {
  return list[(list.indexOf(current) + 1) % list.length]!;
}

/**
 * The part of the tree a chart draws: `levels` levels under `root`, deeper directories collapsed into one cell,
 * nodes without size left out, siblings largest first. `value` is the summed size of the drawn leaves.
 */
export function viewTree(root: TreeNode, metric: Metric, levels: number): HierarchyNode<TreeNode> {
  const sizer = createSizer(metric);
  const depthOf = (node: TreeNode) => {
    let depth = 0;
    for (let at: TreeNode | undefined = node; at && at !== root; at = at.parent) depth++;
    return depth;
  };
  const open = (node: TreeNode) => node.children.length > 0 && depthOf(node) < levels;
  return hierarchy<TreeNode>(root, node => (open(node) ? node.children.filter(child => sizer(child) > 0) : null))
    .sum(node => (open(node) ? 0 : sizer(node)))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
}
