// packages/server/src/sources/git/diff.ts
// The diff.* sources: one change range ('wt' by default, 'staged', a ref, or A..B) seen as numbers, rows, a tree
// and a blast-radius graph. All four read the same change list (git/diff.ts).
import {
  SOURCE_BY_NAME, type DiffFileRow, type DirNode, type GraphData, type GraphEdge, type GraphNode, type SourceMeta, type StatItem,
} from '@glimpse/catalog';
import {langOfPath} from '../../code/langs.ts';
import type {FileEntry, RepoContext, Source, SourceResult} from '../../contracts.ts';
import {listChanges, type Change, type ChangeSet} from '../../git/diff.ts';
import {subtree} from '../../git/log.ts';
import {cutRows, requireGit, SHALLOW_WARNING, summarize, topOf} from './args.ts';

const MAX_CHILDREN = 40;
const MAX_EDGES = 400;

const meta = (name: string): SourceMeta => {
  const found = SOURCE_BY_NAME.get(name);
  if (!found) throw new Error(`source ${name} is not in the catalog`);
  return found;
};

/** The repository's rule for test files (design 4.8), for paths the index does not know: deleted, or on another branch. */
export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//.test(path) || /[._-](test|spec)\./.test(path) || /_test\.go$/.test(path) || /(^|\/)test_[^/]*\.py$/.test(path);
}

interface Loaded {
  changes: ChangeSet;
  /** Files of the working tree by path; empty when the index could not be read. */
  entries: ReadonlyMap<string, FileEntry>;
  warnings: string[];
}

async function load(ctx: RepoContext, target: string | undefined, signal: AbortSignal): Promise<Loaded> {
  const git = requireGit(ctx);
  const changes = await listChanges(ctx, target, signal);
  let entries: ReadonlyMap<string, FileEntry> = new Map();
  if (changes.files.length > 0) {
    try {
      entries = new Map((await ctx.index.files()).map(file => [file.path, file]));
    } catch (error) {
      // Languages and sizes are decoration here; the change list itself comes from git and stands without them.
      ctx.log(`glimpse: diff sources run without the file index: ${error instanceof Error ? error.message : String(error)}`);
    }
    signal.throwIfAborted();
  }
  const warnings = [...changes.warnings, ...(git.shallow && changes.range.kind === 'commits' ? [SHALLOW_WARNING] : [])];
  return {changes, entries, warnings};
}

const langOf = (file: Change, entries: ReadonlyMap<string, FileEntry>): string | undefined => entries.get(file.path)?.lang ?? langOfPath(file.path)?.name;
const testOf = (file: Change, entries: ReadonlyMap<string, FileEntry>): boolean => entries.get(file.path)?.isTest ?? isTestPath(file.path);
const bySize = (a: Change, b: Change): number => b.add + b.del - (a.add + a.del) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const withWarnings = (warnings: string[]): {warnings?: string[]} => (warnings.length > 0 ? {warnings} : {});
const totalsNote = (changes: ChangeSet): string =>
  `${changes.range.label}: ${changes.totals.files} ${changes.totals.files === 1 ? 'file' : 'files'} +${changes.totals.add} -${changes.totals.del}`;

// ---------------------------------------------------------------- diff.stats

const diffStats: Source = {
  meta: meta('diff.stats'),
  async run(ctx, ref, signal) {
    const {changes, entries, warnings} = await load(ctx, ref.target, signal);
    const {range, totals} = changes;
    let commits = 0;
    if (range.logArgs) {
      const counted = await ctx.runGit(['rev-list', '--count', '--no-merges', ...range.logArgs, ...(await subtree(ctx))], {signal});
      commits = Number(counted.toString('utf8').trim()) || 0;
    }
    const tests = changes.files.filter(file => testOf(file, entries)).length;
    const data: StatItem[] = [
      {label: 'Files changed', value: totals.files},
      {label: 'Added', value: totals.add, tone: 'good'},
      {label: 'Removed', value: totals.del, tone: 'bad'},
      {label: 'Commits', value: commits},
      {label: 'Tests touched', value: tests},
    ];
    return {
      data,
      total: data.length,
      ...withWarnings(warnings),
      summary: summarize(`${totalsNote(changes)}, ${commits} ${commits === 1 ? 'commit' : 'commits'}, ${tests} test ${tests === 1 ? 'file' : 'files'}; fields label value`),
    };
  },
};

// ---------------------------------------------------------------- diff.files

const diffFiles: Source = {
  meta: meta('diff.files'),
  async run(ctx, ref, signal) {
    const top = topOf(ref);
    const {changes, entries, warnings} = await load(ctx, ref.target, signal);
    const rows = [...changes.files].sort(bySize).map((file): DiffFileRow => {
      const lang = langOf(file, entries);
      return {
        path: file.path,
        ...(file.from ? {from: file.from} : {}),
        status: file.status,
        add: file.add,
        del: file.del,
        delta: {add: file.add, del: file.del},
        ...(lang ? {lang} : {}),
        isTest: testOf(file, entries),
      };
    });
    return cutRows(diffFiles.meta, rows, {
      top,
      by: 'changes',
      warnings,
      detail: shown => [totalsNote(changes), shown[0] ? `largest ${shown[0].path} +${shown[0].add} -${shown[0].del}` : 'no changes'].join('; '),
    });
  },
};

// ---------------------------------------------------------------- diff.tree

interface TreeDraft { node: DirNode; children: Map<string, TreeDraft>; langs: Map<string, number> }

const draftDir = (name: string, path: string): TreeDraft =>
  ({node: {name, path, dir: true, files: 0, loc: 0, bytes: 0, add: 0, del: 0}, children: new Map(), langs: new Map()});

/** Directory tree of the changed files with add/del summed upward, cut to `budget` nodes and 40 children per directory. */
export function changeTree(files: readonly Change[], entries: ReadonlyMap<string, FileEntry>, budget: number): {root: DirNode; nodes: number; total: number} {
  const root = draftDir('', '');
  let total = 1;
  for (const file of files) {
    const entry = entries.get(file.path);
    const lang = langOf(file, entries);
    const parts = file.path.split('/');
    let dir = root;
    for (let depth = 0; depth < parts.length; depth++) {
      const leaf = depth === parts.length - 1;
      dir.node.files++;
      dir.node.add = (dir.node.add ?? 0) + file.add;
      dir.node.del = (dir.node.del ?? 0) + file.del;
      dir.node.loc += entry?.loc ?? 0;
      dir.node.bytes += entry?.bytes ?? 0;
      if (lang) dir.langs.set(lang, (dir.langs.get(lang) ?? 0) + 1);
      const name = parts[depth]!;
      if (leaf) {
        dir.children.set(`f:${name}`, {
          node: {name, path: file.path, dir: false, files: 1, loc: entry?.loc ?? 0, bytes: entry?.bytes ?? 0, ...(lang ? {lang} : {}), add: file.add, del: file.del, status: file.status},
          children: new Map(),
          langs: new Map(),
        });
        total++;
        break;
      }
      let child = dir.children.get(`d:${name}`);
      if (!child) {
        child = draftDir(name, parts.slice(0, depth + 1).join('/'));
        dir.children.set(`d:${name}`, child);
        total++;
      }
      dir = child;
    }
  }

  // Breadth first, so the budget is spent on the upper levels and whole subtrees roll up below them.
  let nodes = 1;
  const queue: TreeDraft[] = [root];
  for (let at = 0; at < queue.length; at++) {
    const draft = queue[at]!;
    const dominant = [...draft.langs].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
    if (dominant) draft.node.lang = dominant;
    if (draft.children.size === 0) continue;
    const weight = (child: TreeDraft): number => (child.node.add ?? 0) + (child.node.del ?? 0);
    const ordered = [...draft.children.values()].sort((a, b) => weight(b) - weight(a) || (a.node.name < b.node.name ? -1 : 1));
    const kept = ordered.slice(0, Math.max(0, Math.min(MAX_CHILDREN, budget - nodes)));
    const cut = ordered.slice(kept.length);
    nodes += kept.length;
    kept.sort((a, b) => Number(b.node.dir) - Number(a.node.dir) || (a.node.name < b.node.name ? -1 : 1));
    if (kept.length > 0) draft.node.children = kept.map(child => child.node);
    if (cut.length > 0) draft.node.more = {files: cut.reduce((sum, child) => sum + child.node.files, 0), loc: cut.reduce((sum, child) => sum + child.node.loc, 0)};
    queue.push(...kept.filter(child => child.node.dir));
  }
  return {root: root.node, nodes, total};
}

const diffTree: Source = {
  meta: meta('diff.tree'),
  async run(ctx, ref, signal): Promise<SourceResult<DirNode>> {
    const {changes, entries, warnings} = await load(ctx, ref.target, signal);
    const tree = changeTree(changes.files, entries, diffTree.meta.budget);
    return {
      data: tree.root,
      total: tree.total,
      ...(tree.nodes < tree.total ? {truncated: {total: tree.total, returned: tree.nodes, strategy: 'treecut' as const, by: 'changes'}} : {}),
      ...withWarnings(warnings),
      summary: summarize(`${totalsNote(changes)}${tree.nodes < tree.total ? `; ${tree.nodes}/${tree.total} nodes, rest rolled up` : ''}`),
    };
  },
};

// ---------------------------------------------------------------- diff.impact

const STATUS: Readonly<Record<Change['status'], NonNullable<GraphNode['status']>>> = {A: 'added', M: 'modified', D: 'deleted', R: 'modified'};

const diffImpact: Source = {
  meta: meta('diff.impact'),
  async run(ctx, ref, signal): Promise<SourceResult<GraphData>> {
    const {changes, warnings} = await load(ctx, ref.target, signal);
    const budget = diffImpact.meta.budget;
    const changed = [...changes.files].sort(bySize);
    const shown = changed.slice(0, budget);
    const changedPaths = new Set(shown.map(file => file.path));

    // Importers: files that are not part of the change but import something that is.
    const edges = changes.files.length > 0 ? await ctx.index.edges() : [];
    signal.throwIfAborted();
    const hits = new Map<string, number>();
    for (const edge of edges) {
      if (changedPaths.has(edge.to) && !changedPaths.has(edge.from)) hits.set(edge.from, (hits.get(edge.from) ?? 0) + 1);
    }
    const importers = [...hits].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([path]) => path);
    const affected = importers.slice(0, Math.max(0, budget - shown.length));
    const inGraph = new Set([...changedPaths, ...affected]);

    const node = async (path: string, status: NonNullable<GraphNode['status']>): Promise<GraphNode> => {
      const slash = path.lastIndexOf('/');
      const slotKey = await ctx.index.moduleOf(path).catch(() => undefined);
      return {id: path, label: path.slice(slash + 1), ...(slash > 0 ? {sub: path.slice(0, slash)} : {}), kind: 'file', ...(slotKey ? {slotKey} : {}), status, file: path};
    };
    const nodes: GraphNode[] = [];
    for (const file of shown) nodes.push(await node(file.path, STATUS[file.status]));
    for (const path of affected) nodes.push(await node(path, 'affected'));

    const seen = new Set<string>();
    const links: GraphEdge[] = [];
    for (const edge of edges) {
      if (!changedPaths.has(edge.to) || !inGraph.has(edge.from) || edge.from === edge.to) continue;
      const key = `${edge.from}\0${edge.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({from: edge.from, to: edge.to});
    }
    const total = changed.length + importers.length;
    const cut = nodes.length < total || links.length > MAX_EDGES;
    if (changes.range.kind === 'commits' && changes.range.head !== changes.range.repoHead && importers.length > 0) {
      warnings.push('importers are read from the working tree, not from the head of the range');
    }
    return {
      data: {level: 'file', nodes, edges: links.slice(0, MAX_EDGES)},
      total,
      ...(cut ? {truncated: {total, returned: nodes.length, strategy: 'neighborhood' as const, by: 'changes'}} : {}),
      ...withWarnings(warnings),
      summary: summarize(`${changes.range.label}: ${changed.length} changed, ${importers.length} affected ${importers.length === 1 ? 'importer' : 'importers'}; ${nodes.length} nodes ${Math.min(links.length, MAX_EDGES)} edges`),
    };
  },
};

export function createDiffSources(): Source[] {
  return [diffStats, diffFiles, diffTree, diffImpact];
}
