// files.tree, files.list, files.langs: what is in the repository and how big it is.
import type {DirNode, LangRow, Rows} from '@glimpse/catalog';
import {parseModuleId} from '../../analyze/cluster.ts';
import {repoModel, type RepoModel} from '../../analyze/index.ts';
import {baseName, dirName} from '../../analyze/languages.ts';
import {codeLines} from '../../analyze/model.ts';
import {SourceError, type FileEntry, type Source} from '../../contracts.ts';
import {scopedFiles} from './deps.ts';
import {readHistory, type History} from './history.ts';
import {byText, clampSummary, compact, define, inScope, leadOf, plural, rowsResult, scopeNote, scopeOf, type SourceOptions} from './shared.ts';

const MAX_CHILDREN = 40;
/**
 * The directory the tree was asked for (the repository root when no path is given) shows ALL of its own entries, as
 * far as the node budget goes. A rollup row has to have somewhere to go, and drilling into the directory a rollup sits
 * in is the way to see what it hid: for the scope's own level that is the view the reader is already in, so a rollup
 * there could never be opened. Only a directory with more direct entries than the whole budget still gets one.
 */
const MAX_CHILDREN_OF_TARGET = Number.POSITIVE_INFINITY;
const SECONDS_PER_DAY = 86_400;

/**
 * Files under `scope`: a directory, a file, or a module id of a graph ('src/*': the files of src/ outside its
 * sub-modules), read as deps.modules reads it (scopedFiles). E_TARGET when the scope names nothing in the repository.
 */
export function filesIn(model: RepoModel, scope: string, source: string): FileEntry[] {
  if (scope === '') return model.files;
  return [...scopedFiles(model, scope, source).files];
}

/**
 * A module id that is not a directory ('src/*', '(root)'): a tree is drawn from a directory, and the module holds only
 * part of one, so files.tree names the calls that do read it instead of drawing a directory it was not asked for.
 */
function refuseModuleTree(model: RepoModel, scope: string, source: string): void {
  const {dir, rest} = parseModuleId(scope);
  if (!rest || model.byPath.has(scope) || model.files.some(file => inScope(file.path, scope))) return;
  scopedFiles(model, scope, source);
  throw new SourceError('E_TARGET', `${source}: "${scope}" is a module of a graph (the files of ${dir || 'the root'} outside its sub-modules), not a directory: ${source} ${dir || '.'} draws the directory, files.list ${scope} lists the module's files`);
}

interface Rollup {
  node: DirNode;
  langs: Map<string, number>;
  dirs: Rollup[];
  files: DirNode[];
}

function ageInDays(last: number | undefined, now: number): number | undefined {
  return last === undefined ? undefined : Math.max(0, Math.floor((now / 1000 - last) / SECONDS_PER_DAY));
}

function fileNode(file: FileEntry, model: RepoModel, history: History | undefined, now: number): DirNode {
  const node: DirNode = {name: baseName(file.path), path: file.path, dir: false, files: 1, loc: codeLines(file), bytes: file.bytes};
  if (file.lang) node.lang = file.lang;
  node.complexity = model.facts.get(file.path)?.complexity ?? 0;
  const commits = history?.fileCommits.get(file.path);
  if (commits !== undefined) node.commits = commits;
  const age = ageInDays(history?.fileLast.get(file.path), now);
  if (age !== undefined) node.age = age;
  return node;
}

/** The directory tree under `scope`, uncut: every directory with its totals. */
function rollUp(files: readonly FileEntry[], scope: string, model: RepoModel, history: History | undefined, now: number): {root: Rollup; nodes: number} {
  const byDir = new Map<string, Rollup>();
  let nodes = 0;
  const rollup = (path: string): Rollup => {
    let entry = byDir.get(path);
    if (entry) return entry;
    nodes++;
    const node: DirNode = {name: path === '' ? '' : baseName(path), path, dir: true, files: 0, loc: 0, bytes: 0, complexity: 0};
    const commits = history?.dirCommits.get(path);
    if (commits !== undefined) node.commits = commits;
    const age = ageInDays(history?.dirLast.get(path), now);
    if (age !== undefined) node.age = age;
    entry = {node, langs: new Map(), dirs: [], files: []};
    byDir.set(path, entry);
    if (path !== scope) rollup(dirName(path)).dirs.push(entry);
    return entry;
  };
  const root = rollup(scope);
  for (const file of files) {
    const node = fileNode(file, model, history, now);
    nodes++;
    const home = rollup(dirName(file.path));
    home.files.push(node);
    for (let dir = home; ; dir = byDir.get(dirName(dir.node.path))!) {
      dir.node.files++;
      dir.node.loc += node.loc;
      dir.node.bytes += node.bytes;
      dir.node.complexity = (dir.node.complexity ?? 0) + (node.complexity ?? 0);
      if (node.lang && node.loc > 0) dir.langs.set(node.lang, (dir.langs.get(node.lang) ?? 0) + node.loc);
      if (dir === root) break;
    }
  }
  for (const entry of byDir.values()) {
    let dominant: string | undefined;
    let most = 0;
    for (const [lang, loc] of entry.langs) {
      if (loc > most || (loc === most && dominant !== undefined && lang < dominant)) {
        dominant = lang;
        most = loc;
      }
    }
    if (dominant) entry.node.lang = dominant;
  }
  return {root, nodes};
}

const bySize = (a: DirNode, b: DirNode) => b.loc - a.loc || b.bytes - a.bytes || byText(a.name, b.name);

/** A max-heap of tree entries by size (bySize order), for spending the node budget on the largest first. */
class SizeHeap<T extends {node: DirNode}> {
  private readonly items: T[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: T): void {
    const items = this.items;
    items.push(item);
    for (let at = items.length - 1; at > 0; ) {
      const up = (at - 1) >> 1;
      if (bySize(items[up]!.node, items[at]!.node) <= 0) break;
      [items[up], items[at]] = [items[at]!, items[up]!];
      at = up;
    }
  }
  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last) {
      items[0] = last;
      for (let at = 0; ; ) {
        const left = 2 * at + 1;
        const right = left + 1;
        let best = at;
        if (left < items.length && bySize(items[left]!.node, items[best]!.node) < 0) best = left;
        if (right < items.length && bySize(items[right]!.node, items[best]!.node) < 0) best = right;
        if (best === at) break;
        [items[best], items[at]] = [items[at]!, items[best]!];
        at = best;
      }
    }
    return top;
  }
}

/**
 * Cuts the tree to the node budget by size (V038): the largest entries anywhere in the tree are shown first, so the
 * busiest source folders open however deep they sit, and small files (a .gitignore of six lines) are what rolls up.
 * The directory asked for keeps up to `rootChildren` of its own entries (it is where a rollup's drill would land);
 * any other directory keeps at most MAX_CHILDREN. Each directory reports what it does not show as `more`.
 */
function cutTree(root: Rollup, budget: number, rootChildren: number): {kept: number; rollups: number} {
  let left = budget - 1;
  const kept = new Map<Rollup, DirNode[]>();
  const rollupOf = new Map<DirNode, Rollup>();
  const index = (entry: Rollup) => {
    for (const dir of entry.dirs) rollupOf.set(dir.node, dir);
  };
  type Candidate = {node: DirNode; parent: Rollup};
  const heap = new SizeHeap<Candidate>();
  const open = (entry: Rollup) => {
    index(entry);
    kept.set(entry, []);
    for (const node of [...entry.dirs.map(dir => dir.node), ...entry.files]) heap.push({node, parent: entry});
  };
  // The scope's own entries come first: all of them (largest first) as far as the budget goes.
  index(root);
  kept.set(root, []);
  const own = [...root.dirs.map(dir => dir.node), ...root.files].sort(bySize).slice(0, Math.min(rootChildren, left));
  for (const node of own) {
    kept.get(root)!.push(node);
    left--;
  }
  for (const node of own) {
    const dir = rollupOf.get(node);
    if (dir) open(dir);
  }
  while (left > 0 && heap.size > 0) {
    const {node, parent} = heap.pop()!;
    const siblings = kept.get(parent)!;
    if (siblings.length >= MAX_CHILDREN) continue;
    siblings.push(node);
    left--;
    const dir = rollupOf.get(node);
    if (dir) open(dir);
  }
  let rollups = 0;
  const finish = (entry: Rollup) => {
    const shown = kept.get(entry) ?? [];
    const all = entry.dirs.length + entry.files.length;
    shown.sort(bySize);
    if (shown.length > 0) entry.node.children = shown;
    if (shown.length < all) {
      rollups++;
      const visible = new Set(shown);
      const cut = [...entry.dirs.map(dir => dir.node), ...entry.files].filter(node => !visible.has(node));
      entry.node.more = {files: cut.reduce((sum, child) => sum + child.files, 0), loc: cut.reduce((sum, child) => sum + child.loc, 0)};
    }
    for (const node of shown) {
      const dir = rollupOf.get(node);
      if (dir) finish(dir);
    }
  };
  finish(root);
  return {kept: budget - left, rollups};
}

export function filesSources(options: SourceOptions): Source[] {
  const tree = define('files.tree', async (ctx, ref, signal, meta) => {
    const scope = scopeOf(ref);
    const [model, history] = await Promise.all([repoModel(ctx), readHistory(ctx, signal)]);
    signal.throwIfAborted();
    const now = options.now();
    const single = model.byPath.get(scope);
    if (single) {
      const node = fileNode(single, model, history, now);
      return {data: node, total: 1, ...(history && history.warnings.length > 0 ? {warnings: history.warnings} : {}), summary: `1 file, ${compact(node.loc)} loc`};
    }
    refuseModuleTree(model, scope, meta.name);
    // Commit counts and ages come from the shared history: what limits it (a shallow clone, the parsed window) is said.
    const warnings = [...model.warnings, ...(history?.warnings ?? [])];
    const {root, nodes} = rollUp(filesIn(model, scope, meta.name), scope, model, history, now);
    const {kept, rollups} = cutTree(root, meta.budget, MAX_CHILDREN_OF_TARGET);
    const generated = model.files.reduce((sum, file) => sum + (file.generated && inScope(file.path, scope) ? 1 : 0), 0);
    const summary = [
      `${plural(root.node.files, 'file')}, ${compact(root.node.loc)} loc${scopeNote(scope, ' ')}`,
      ...(rollups > 0 ? [`${plural(rollups, 'rollup')} (${kept} of ${nodes} nodes)`] : []),
      ...(generated > 0 ? [`${plural(generated, 'generated file')} not counted in loc`] : []),
    ].join(', ');
    return {
      data: root.node,
      total: nodes,
      ...(rollups > 0 ? {truncated: {total: nodes, returned: kept, strategy: 'treecut' as const, by: 'loc'}} : {}),
      ...(warnings.length > 0 ? {warnings} : {}),
      summary: clampSummary(summary),
    };
  });

  const list = define('files.list', async (ctx, ref, signal, meta) => {
    const scope = scopeOf(ref);
    const [model, history] = await Promise.all([repoModel(ctx), readHistory(ctx, signal)]);
    signal.throwIfAborted();
    const files = [...filesIn(model, scope, meta.name)].sort((a, b) => Number(a.generated) - Number(b.generated) || b.loc - a.loc || byText(a.path, b.path));
    const rows: Rows = files.map(file => ({
      path: file.path,
      ...(file.lang ? {lang: file.lang} : {}),
      loc: file.loc,
      bytes: file.bytes,
      ...(history ? {commits: history.fileCommits.get(file.path) ?? 0} : {}),
      complexity: model.facts.get(file.path)?.complexity ?? 0,
    }));
    const first = rows[0];
    return rowsResult(meta, ref, rows, {
      by: 'loc',
      lead: leadOf(scope, first ? `top ${String(first.path)} ${String(first.loc)} loc` : ''),
      // Without history there is no commits column to show.
      ...(history ? {} : {fields: (meta.fields ?? []).filter(field => field.key !== 'commits')}),
      warnings: [...model.warnings, ...(history?.warnings ?? [])],
    });
  });

  const langs = define('files.langs', async (ctx, ref, _signal, meta) => {
    const scope = scopeOf(ref);
    const model = await repoModel(ctx);
    const rows = languageMix(filesIn(model, scope, meta.name));
    const kept: LangRow[] = rows.slice(0, meta.budget);
    const total = rows.reduce((sum, row) => sum + row.loc, 0);
    if (rows.length > meta.budget) {
      // Past the budget the tail becomes one row, so the percentages still add up. It is named for what it holds,
      // so it is told apart from the catch-all of unknown files and from a chart's own "other (N)" fold.
      const tail = rows.slice(meta.budget - 1);
      const loc = tail.reduce((sum, row) => sum + row.loc, 0);
      kept.length = meta.budget - 1;
      kept.push({lang: `${tail.length} more languages`, files: tail.reduce((sum, row) => sum + row.files, 0), loc, pct: share(loc, total)});
    }
    // Rounded from the exact ratio, as the repo line of a show result rounds it: 5.47% is 5% in both (V032).
    const lead = leadOf(scope, kept.slice(0, 4).map(row => `${row.lang} ${total > 0 ? Math.round((row.loc / total) * 100) : 0}%`).join(' '));
    const result = rowsResult(meta, ref, kept as unknown as Rows, {by: 'loc', lead});
    if (rows.length > kept.length) {
      result.total = rows.length;
      result.truncated = {total: rows.length, returned: result.data.length, strategy: 'topN', by: 'loc'};
    }
    return result;
  });

  return [tree, list, langs];
}

/**
 * The row of text files whose language is not known. Not 'Other', which a chart writes for the categories it folds
 * ("other (17)"): this row is no language at all, so the Languages KPI leaves it out and counts every other row.
 */
export const UNCLASSIFIED = 'Unclassified';

/** Percent with one decimal, from the exact ratio. */
const share = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

/**
 * Lines of code per language of `files` (the repository's, or those under a path), largest first: generated and
 * binary files aside, unknown text files as 'Unclassified'.
 */
export function languageMix(files: readonly FileEntry[]): LangRow[] {
  const byLang = new Map<string, {files: number; loc: number}>();
  let total = 0;
  for (const file of files) {
    const loc = codeLines(file);
    if (loc === 0) continue;
    const lang = file.lang ?? UNCLASSIFIED;
    const entry = byLang.get(lang) ?? {files: 0, loc: 0};
    entry.files++;
    entry.loc += loc;
    byLang.set(lang, entry);
    total += loc;
  }
  return [...byLang]
    .map(([lang, entry]) => ({lang, files: entry.files, loc: entry.loc, pct: share(entry.loc, total)}))
    .sort((a, b) => b.loc - a.loc || byText(a.lang, b.lang));
}
