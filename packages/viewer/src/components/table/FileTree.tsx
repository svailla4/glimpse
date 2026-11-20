import type * as C from '@glimpse/catalog';
import type {DirNode, EntityRef} from '@glimpse/catalog';
import {memo, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent, type RefObject} from 'react';
import {
  DataGate, Empty, PathText, PlateAside, Redline, fmtNum, seqVar, useDataset, useHostActions, useSelection,
  type GlView, type GlViewProps,
} from '../../kit/index.ts';
import s from './FileTree.module.css';
import {useListNav, useScrollFade} from './nav.ts';
import {copyText, describeType, isRecord, num, selectionMark, type SelectionMark} from './rows.ts';
import {Shell} from './shell.tsx';

type Props = GlViewProps<typeof C.FileTree>['props'];
type Metric = NonNullable<Props['metric']>;
type Heat = NonNullable<Props['heat']>;

const ROW = 24;
const MINUS = '−';
const FIND_IDLE_MS = 900;
const STATUS_WORDS: Readonly<Record<string, string>> = {A: 'added', M: 'modified', D: 'deleted', R: 'renamed'};

// ---------------------------------------------------------------- model
interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  parent: string | undefined;
  files?: number;
  loc?: number;
  bytes?: number;
  commits?: number;
  age?: number;
  complexity?: number;
  add?: number;
  del?: number;
  status?: string;
  children: TreeNode[];
  more?: {files?: number; loc?: number};
}

interface Tree {
  root: TreeNode;
  byPath: Map<string, TreeNode>;
  /** Nodes left out: duplicate paths, cycles, entries that are not objects or have no name. */
  dropped: number;
  /** Largest heat inputs among files and among directories (directories aggregate, so they scale apart). */
  peak: Record<'file' | 'dir', {commits: number; complexity: number}>;
}

function toNode(raw: Record<string, unknown>, parent: TreeNode | undefined): TreeNode | undefined {
  const rawPath = typeof raw.path === 'string' ? raw.path.replace(/\/+$/, '') : undefined;
  const rawName = typeof raw.name === 'string' && raw.name !== '' ? raw.name : undefined;
  const name = rawName ?? rawPath?.slice(rawPath.lastIndexOf('/') + 1) ?? '';
  if (parent && name === '') return undefined;
  const path = rawPath ?? (parent?.path ? `${parent.path}/${name}` : name);
  const more = isRecord(raw.more) ? {files: num(raw.more.files), loc: num(raw.more.loc)} : undefined;
  return {
    name,
    path,
    dir: typeof raw.dir === 'boolean' ? raw.dir : Array.isArray(raw.children),
    parent: parent?.path,
    files: num(raw.files), loc: num(raw.loc), bytes: num(raw.bytes), commits: num(raw.commits), age: num(raw.age),
    complexity: num(raw.complexity), add: num(raw.add), del: num(raw.del),
    status: typeof raw.status === 'string' ? raw.status : undefined,
    children: [],
    ...(more && (more.files ?? 0) > 0 ? {more} : {}),
  };
}

/** A checked copy of the tree: numbers coerced, duplicate paths and cycles dropped and counted. Iterative, so depth is not a limit. */
function buildTree(data: unknown): Tree | undefined {
  if (!isRecord(data)) return undefined;
  const root = toNode(data, undefined);
  if (!root) return undefined;
  const byPath = new Map<string, TreeNode>([[root.path, root]]);
  const peak: Tree['peak'] = {file: {commits: 0, complexity: 0}, dir: {commits: 0, complexity: 0}};
  let dropped = 0;
  // `open` holds the raw objects on the path from the root, to catch a node that contains itself.
  const open = new Set<object>([data]);
  const stack: Array<{raw: Record<string, unknown>; node: TreeNode; next: number}> = [{raw: data, node: root, next: 0}];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const children = Array.isArray(frame.raw.children) ? frame.raw.children : [];
    if (frame.next >= children.length) {
      open.delete(frame.raw);
      stack.pop();
      continue;
    }
    const raw: unknown = children[frame.next++];
    const node = isRecord(raw) && !open.has(raw) ? toNode(raw, frame.node) : undefined;
    if (!node || !isRecord(raw) || byPath.has(node.path)) {
      dropped++;
      continue;
    }
    byPath.set(node.path, node);
    frame.node.children.push(node);
    const scale = peak[node.dir ? 'dir' : 'file'];
    scale.commits = Math.max(scale.commits, node.commits ?? 0);
    scale.complexity = Math.max(scale.complexity, node.complexity ?? 0);
    if (Array.isArray(raw.children) && raw.children.length > 0) {
      open.add(raw);
      stack.push({raw, node, next: 0});
    }
  }
  return {root, byPath, dropped, peak};
}

function metricValue(node: TreeNode, metric: Metric): number | undefined {
  switch (metric) {
    case 'loc': return node.loc;
    case 'bytes': return node.bytes;
    case 'files': return node.files;
    case 'commits': return node.commits;
    case 'changes': return node.add === undefined && node.del === undefined ? undefined : (node.add ?? 0) + (node.del ?? 0);
    default: return undefined;
  }
}

function metricText(node: TreeNode, metric: Metric): string {
  const value = metricValue(node, metric);
  if (value === undefined) return '';
  if (metric === 'bytes') return fmtNum(value, 'bytes');
  return fmtNum(value, value >= 10_000 ? 'compact' : 'num');
}

/** Heat step 1..7, or undefined when the node has no value for the chosen heat. */
function heatStep(node: TreeNode, heat: Heat, peak: Tree['peak']): number | undefined {
  const scale = peak[node.dir ? 'dir' : 'file'];
  const share = (value: number | undefined, max: number) => (value === undefined || max <= 0 ? undefined : Math.sqrt(Math.min(1, Math.max(0, value / max))));
  let level: number | undefined;
  if (heat === 'churn') level = share(node.commits, scale.commits);
  else if (heat === 'complexity') level = share(node.complexity, scale.complexity);
  else if (heat === 'age') level = node.age === undefined ? undefined : 1 - Math.min(1, Math.max(0, node.age) / 365);
  return level === undefined ? undefined : 1 + Math.round(level * 6);
}

interface Line {
  kind: 'node' | 'more';
  /** The node itself (the innermost directory of a folded chain), or the directory a rollup belongs to. */
  node: TreeNode;
  /**
   * Directories folded into this row, outermost first: a directory whose only entry is another directory shares
   * its row ('a2ui_agent/lib/src'), so a deep path does not spend a level of indentation per segment.
   */
  chain: TreeNode[];
  depth: number;
  open: boolean;
  /** Largest metric value at the top level of the tree: every bar is relative to it, so bars compare across levels. */
  scale: number;
}

/** A directory that holds nothing but one directory: its row is shared with that child. */
const onlyDir = (node: TreeNode): TreeNode | undefined =>
  node.dir && node.more === undefined && node.children.length === 1 && node.children[0]!.dir ? node.children[0] : undefined;

/** The rows on screen order: every node whose ancestors are open, plus one rollup line per cut directory. */
function flatten(tree: Tree, isOpen: (node: TreeNode, depth: number) => boolean, metric: Metric): Line[] {
  const lines: Line[] = [];
  const top = tree.root.children.length > 0 || tree.root.more ? tree.root : undefined;
  if (!top) return tree.root.dir ? lines : [{kind: 'node', node: tree.root, chain: [], depth: 0, open: false, scale: metricValue(tree.root, metric) ?? 0}];
  let scale = 0;
  for (const child of top.children) scale = Math.max(scale, metricValue(child, metric) ?? 0);
  const stack: Array<{parent: TreeNode; depth: number; next: number}> = [{parent: top, depth: 0, next: 0}];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.next >= frame.parent.children.length) {
      if (frame.parent.more) lines.push({kind: 'more', node: frame.parent, chain: [], depth: frame.depth, open: false, scale});
      stack.pop();
      continue;
    }
    let node = frame.parent.children[frame.next++]!;
    const chain: TreeNode[] = [];
    for (let only = onlyDir(node); only; only = onlyDir(node)) {
      chain.push(node);
      node = only;
    }
    const expandable = node.dir && (node.children.length > 0 || node.more !== undefined);
    const open = expandable && isOpen(node, frame.depth);
    lines.push({kind: 'node', node, chain, depth: frame.depth, open, scale});
    if (open) stack.push({parent: node, depth: frame.depth + 1, next: 0});
  }
  return lines;
}

/**
 * Bar length for a value against the tree's scale. Square root: a repository's sizes span four orders of magnitude,
 * and on a linear scale every row below the largest directories would be an empty track. The order is kept, so a
 * directory's bar is never shorter than the bar of anything inside it.
 */
const barShare = (value: number | undefined, scale: number): number =>
  value !== undefined && value > 0 && scale > 0 ? Math.sqrt(Math.min(1, value / scale)) : 0;

// ---------------------------------------------------------------- view
export const FileTreeView: GlView<typeof C.FileTree> = ({id, props}) => {
  const state = useDataset<DirNode>(props.data);
  const host = useHostActions(id);
  // A drill only asks the server to re-scope the dataset. Where the dataset stands, and the way back up, is on its
  // envelope (`dataset.drill`), which the kit shows as a scope crumb on every component bound to it: the tree keeps
  // no drilled state of its own, so a reload or a drill made by another component cannot leave it without a way out.
  const key = state.ds?.$ds;
  // Kept above the gate: the tree unmounts while the drilled dataset is pending, and focus must find its way back.
  const refocus = useRef(false);
  const drill = key
    ? (to: string) => {
        refocus.current = true;
        host.drill(key, to);
      }
    : undefined;
  const tree = useMemo(() => (state.status === 'ready' ? buildTree(state.data) : undefined), [state]);
  return (
    <Shell sized={props.size !== undefined}>
      <DataGate state={state} id={`FileTree#${id}`}>
        {data =>
          tree ? (
            <TreeBody id={id} props={props} tree={tree} drill={drill} refocus={refocus} drilled={state.ds?.drill !== undefined} />
          ) : (
            <Redline code="E_SHAPE" id={`FileTree#${id}`} message={`expected a directory node {name, path, dir, children}, received ${describeType(data)}`} />
          )
        }
      </DataGate>
    </Shell>
  );
};

interface RowProps {
  index: number;
  top: number;
  line: Line;
  metric: Metric;
  heat: number | undefined;
  mark: SelectionMark;
  active: boolean;
  canDrill: boolean;
}

const TreeRow = memo(function TreeRow({index, top, line, metric, heat, mark, active, canDrill}: RowProps): JSX.Element {
  const {node, depth} = line;
  const style = {transform: `translateY(${top}px)`};
  const guides = depth > 0 ? <span className={s.guides} style={{width: depth * 16}} aria-hidden="true" /> : null;
  if (line.kind === 'more') {
    const count = node.more?.files ?? 0;
    // A rollup of the directory the tree is already scoped to has nowhere to drill: it only says what was left out.
    const title = canDrill ? `Show all of ${node.path || 'the tree'}` : `${fmtNum(count)} more ${count === 1 ? 'entry is' : 'entries are'} not listed at this level`;
    return (
      <div className={s.row} role="treeitem" aria-level={depth + 1} aria-selected={false} aria-disabled={!canDrill || undefined} data-index={index} data-more={node.path} tabIndex={active ? 0 : -1} style={style} title={title}>
        {guides}
        <span className={s.twist} aria-hidden="true" />
        <span className={s.more}>({fmtNum(count)} more)</span>
        {metric === 'loc' && node.more?.loc !== undefined ? <span className={s.value}>{fmtNum(node.more.loc, node.more.loc >= 10_000 ? 'compact' : 'num')}</span> : null}
      </div>
    );
  }
  const expandable = node.dir && (node.children.length > 0 || node.more !== undefined);
  const value = metricValue(node, metric);
  const share = barShare(value, line.scale);
  const changes = metric === 'changes';
  const total = (node.add ?? 0) + (node.del ?? 0);
  return (
    <div
      className={s.row}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={expandable ? line.open : undefined}
      aria-selected={mark === 'exact'}
      data-index={index}
      data-path={node.path}
      data-dir={node.dir || undefined}
      data-selected={mark}
      tabIndex={active ? 0 : -1}
      style={style}
    >
      {heat !== undefined ? <span className={s.heat} style={{background: seqVar(heat)}} data-heat={heat} aria-hidden="true" /> : null}
      {guides}
      <span className={s.twist} data-twist={expandable ? '' : undefined} aria-hidden="true">
        {expandable ? (
          <svg className={s.chevron} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" data-open={line.open || undefined}>
            <path d="M4.5 2.5 8 6l-3.5 3.5" />
          </svg>
        ) : null}
      </span>
      <span className={s.label} title={node.dir ? node.path : undefined}>
        {node.dir ? (
          <span className={s.dir}>
            {line.chain.map(up => <span key={up.path} className={s.chain}>{up.name}/</span>)}
            <span className={s.dirName}>{node.name}</span>
          </span>
        ) : (
          <PathText file={node.path} label={node.name} />
        )}
      </span>
      {node.status ? (
        <span className={s.status} data-status={node.status} title={STATUS_WORDS[node.status] ?? node.status}>
          <span className={s.statusDot} aria-hidden="true" />
          <span aria-hidden="true">{node.status}</span>
          <span className={s.hidden}>{STATUS_WORDS[node.status] ?? node.status}</span>
        </span>
      ) : null}
      {metric !== 'none' && value !== undefined ? (
        <>
          <span className={s.bar} data-metric={metric} aria-hidden="true">
            {changes && total > 0 ? (
              <>
                <span className={s.barAdd} style={{width: `${((share * (node.add ?? 0)) / total) * 100}%`}} />
                <span className={s.barDel} style={{width: `${((share * (node.del ?? 0)) / total) * 100}%`}} />
              </>
            ) : (
              <span className={s.barFill} style={{width: `${share * 100}%`}} />
            )}
          </span>
          <span className={s.value}>
            {changes ? (
              <>
                <span className={node.add ? s.add : s.zero}>+{fmtNum(node.add ?? 0)}</span> <span className={node.del ? s.del : s.zero}>{MINUS}{fmtNum(node.del ?? 0)}</span>
              </>
            ) : metricText(node, metric)}
          </span>
        </>
      ) : null}
    </div>
  );
});

interface BodyProps {
  id: string;
  props: Props;
  tree: Tree;
  drill: ((target: string) => void) | undefined;
  /** Set by a drill made from this tree: the next tree takes the keyboard focus the drilled row had. */
  refocus: RefObject<boolean>;
  /** The dataset is drilled: the kit's scope crumb already names the directory, so the tree does not repeat it. */
  drilled: boolean;
}

function TreeBody({id, props, tree, drill, refocus, drilled}: BodyProps): JSX.Element {
  const metric: Metric = props.metric ?? 'loc';
  const heat: Heat = props.heat ?? 'none';
  const initialDepth = props.depth ?? 2;
  const scrollRef = useRef<HTMLDivElement>(null);
  const {selected, select} = useSelection(id);
  const host = useHostActions(id);

  // Directories open to `depth` levels until the reader says otherwise, per directory.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const lines = useMemo(
    () => flatten(tree, (node, depth) => toggled.get(node.path) ?? depth < initialDepth, metric),
    [tree, toggled, initialDepth, metric],
  );
  const nav = useListNav({count: lines.length, rowHeight: ROW, scrollRef});
  useScrollFade(scrollRef, lines.length);

  // After a drill the tree is a different one and the row that was focused is gone: focus goes to its first row.
  const setActive = nav.setActive;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per tree, which is what a drill replaces
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    setActive(0, true);
  }, [tree]);

  const setOpen = (node: TreeNode, open: boolean) => setToggled(prev => new Map(prev).set(node.path, open));
  const entityOf = (node: TreeNode): EntityRef => ({type: node.dir ? 'dir' : 'file', id: node.path, path: node.path});

  // A selection made elsewhere (a table row, a chart mark) is revealed here: ancestors open, row scrolled into view.
  const ownSelection = useRef<string | undefined>(undefined);
  const [pendingReveal, setPendingReveal] = useState<string>();
  useEffect(() => {
    if (!selected || (selected.type !== 'file' && selected.type !== 'dir')) return;
    const path = selected.path ?? selected.id;
    if (path === ownSelection.current) return;
    ownSelection.current = undefined;
    const target = tree.byPath.get(path);
    if (!target || target === tree.root) return;
    setToggled(prev => {
      const next = new Map(prev);
      for (let up = target.parent; up !== undefined && up !== tree.root.path; up = tree.byPath.get(up)?.parent) next.set(up, true);
      return next.size === prev.size && [...next].every(([path, open]) => prev.get(path) === open) ? prev : next;
    });
    setPendingReveal(path);
  }, [selected, tree]);
  const reveal = nav.reveal;
  useEffect(() => {
    if (pendingReveal === undefined) return;
    const index = lines.findIndex(line => line.kind === 'node' && (line.node.path === pendingReveal || line.chain.some(up => up.path === pendingReveal)));
    if (index < 0) return;
    reveal(index);
    setPendingReveal(undefined);
  }, [pendingReveal, lines, reveal]);

  const activate = (index: number, viaModifier: boolean, onTwist = false) => {
    const line = lines[index];
    if (!line) return;
    const {node} = line;
    if (line.kind === 'more') {
      if (canDrillInto(node)) drill?.(node.path);
      return;
    }
    if (node.dir && (node.children.length > 0 || node.more)) setOpen(node, !line.open);
    if (onTwist) return;
    if (viaModifier) {
      if (!node.dir) host.open(node.path);
      return;
    }
    ownSelection.current = node.path;
    select(entityOf(node));
  };

  // Drilling into the directory the tree is already scoped to would ask for the same tree again.
  const canDrillInto = (node: TreeNode) => drill !== undefined && node.path !== tree.root.path;

  const indexOf = (target: EventTarget): number | undefined => {
    const element = (target as HTMLElement).closest?.('[data-index]');
    const index = element ? Number(element.getAttribute('data-index')) : Number.NaN;
    return Number.isInteger(index) ? index : undefined;
  };
  // Whatever puts focus or the pointer on a row (a click, assistive technology) makes it the tab stop.
  const onReach = (event: {target: EventTarget}) => {
    const index = indexOf(event.target);
    if (index !== undefined && index !== nav.active) nav.setActive(index);
  };
  const onClick = (event: MouseEvent) => {
    const index = indexOf(event.target);
    if (index !== undefined) activate(index, event.metaKey || event.ctrlKey, (event.target as HTMLElement).closest('[data-twist]') !== null);
  };

  // Type-ahead: letters jump to the next visible name with that prefix. `o` and `c` keep their entity meaning
  // (open, copy) unless a find is under way; `/` starts one explicitly so any name can be reached.
  const [find, setFind] = useState<string | null>(null);
  const findTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(findTimer.current), []);
  const updateFind = (text: string | null) => {
    clearTimeout(findTimer.current);
    setFind(text);
    if (text !== null) findTimer.current = setTimeout(() => setFind(null), FIND_IDLE_MS);
  };
  const seek = (prefix: string) => {
    if (!prefix) return;
    const start = prefix.length === 1 ? nav.active + 1 : nav.active;
    for (let i = 0; i < lines.length; i++) {
      const index = (start + i) % lines.length;
      const line = lines[index]!;
      if (line.kind === 'node' && (line.node.name.toLowerCase().startsWith(prefix) || line.chain[0]?.name.toLowerCase().startsWith(prefix))) {
        nav.setActive(index, true);
        return;
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (nav.handleKey(event)) return;
    const line = lines[nav.active];
    if (!line) return;
    const {node} = line;
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey;
    if (event.key === 'Enter' || (event.key === ' ' && find === null)) {
      updateFind(null);
      activate(nav.active, event.metaKey || event.ctrlKey);
    } else if (!plain) {
      return;
    } else if (event.key === 'Escape') {
      if (find !== null) updateFind(null);
      else select(null);
    } else if (event.key === 'ArrowRight') {
      if (line.kind !== 'node' || !node.dir) return;
      if (!line.open) setOpen(node, true);
      else if (lines[nav.active + 1] && lines[nav.active + 1]!.depth > line.depth) nav.setActive(nav.active + 1, true);
    } else if (event.key === 'ArrowLeft') {
      if (line.kind === 'node' && line.open) setOpen(node, false);
      else {
        for (let i = nav.active - 1; i >= 0; i--) {
          if (lines[i]!.depth < line.depth) {
            nav.setActive(i, true);
            break;
          }
        }
      }
    } else if (event.key === 'Backspace' && find !== null) {
      updateFind(find.slice(0, -1));
    } else if (event.key === '/' && find === null) {
      updateFind('');
    } else if (event.key.length === 1 && event.key !== ' ') {
      if (find === null && line.kind === 'node' && (event.key === 'o' || event.key === 'c')) {
        if (event.key === 'c') copyText(node.path);
        else if (!node.dir) host.open(node.path);
      } else {
        const next = (find ?? '') + event.key.toLowerCase();
        updateFind(next);
        seek(next);
      }
    } else {
      return;
    }
    event.preventDefault();
  };

  if (lines.length === 0) return <Empty message={tree.root.path ? `${tree.root.path} is an empty directory` : 'empty directory'} />;
  const scope = tree.root.path;
  return (
    <div className={s.root} data-sized={props.size ? '' : undefined} data-gl-tree="">
      {tree.dropped > 0 ? (
        <PlateAside>
          <span className={s.note} data-gl-tree-note="">{fmtNum(tree.dropped)} malformed {tree.dropped === 1 ? 'entry' : 'entries'} dropped</span>
        </PlateAside>
      ) : null}
      {scope && !drilled ? <div className={s.scope} title={scope}><PathText file={scope} /></div> : null}
      <div
        className={s.scroll}
        ref={scrollRef}
        role="tree"
        aria-label={props.title || (scope ? `Files in ${scope}` : 'Files')}
        onKeyDown={onKeyDown}
        onMouseDown={onReach}
        onFocus={onReach}
        onClick={onClick}
      >
        <div className={s.body} style={{height: nav.totalSize}}>
          {nav.items.map(virtual => {
            const line = lines[virtual.index];
            if (!line) return null;
            return (
              <TreeRow
                key={`${line.kind}:${line.node.path}`}
                index={virtual.index}
                top={virtual.start}
                line={line}
                metric={metric}
                heat={line.kind === 'node' && heat !== 'none' ? heatStep(line.node, heat, tree.peak) : undefined}
                mark={line.kind === 'node' ? selectionMark(selected, entityOf(line.node)) : undefined}
                active={virtual.index === nav.active}
                canDrill={line.kind === 'more' && canDrillInto(line.node)}
              />
            );
          })}
        </div>
      </div>
      {find !== null ? <div className={s.find} role="status">find: {find}<span className={s.caret} aria-hidden="true" /></div> : null}
    </div>
  );
}
