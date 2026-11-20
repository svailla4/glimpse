// files.tree, files.list, files.langs: what is in the repository and how big it is.
import type {DirNode, LangRow, Rows} from '@glimpse/catalog';
import {repoModel, type RepoModel} from '../../analyze/index.ts';
import {baseName, dirName} from '../../analyze/languages.ts';
import {codeLines} from '../../analyze/model.ts';
import {SourceError, type FileEntry, type Source} from '../../contracts.ts';
import {readHistory, type History} from './history.ts';
import {byText, clampSummary, compact, define, inScope, plural, rowsResult, scopeOf, type SourceOptions} from './shared.ts';

const MAX_CHILDREN = 40;
/**
 * The directory the tree was asked for (the repository root when no path is given) shows ALL of its own entries, as
 * far as the node budget goes. A rollup row has to have somewhere to go, and drilling into the directory a rollup sits
 * in is the way to see what it hid: for the scope's own level that is the view the reader is already in, so a rollup
 * there could never be opened. Only a directory with more direct entries than the whole budget still gets one.
 */
const MAX_CHILDREN_OF_TARGET = Number.POSITIVE_INFINITY;
const SECONDS_PER_DAY = 86_400;

/** Files under `scope`; E_TARGET when the scope names nothing in the repository. */
export function filesIn(model: RepoModel, scope: string, source: string): FileEntry[] {
  if (scope === '') return model.files;
  const files = model.files.filter(file => inScope(file.path, scope));
  if (files.length === 0) throw new SourceError('E_TARGET', `${source}: no files under "${scope}"`);
  return files;
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

/**
 * Cuts the tree to the node budget, breadth first so the shallow levels always survive: each directory keeps its
 * largest children and reports the rest as `more`.
 */
function cutTree(root: Rollup, budget: number, rootChildren: number): {kept: number; rollups: number} {
  let left = budget - 1;
  let rollups = 0;
  const queue: Rollup[] = [root];
  for (let head = 0; head < queue.length; head++) {
    const entry = queue[head]!;
    const dirs = new Map(entry.dirs.map(dir => [dir.node, dir]));
    const children = [...dirs.keys(), ...entry.files].sort(bySize);
    const keep = Math.min(children.length, entry === root ? rootChildren : MAX_CHILDREN, left);
    left -= keep;
    if (keep > 0) entry.node.children = children.slice(0, keep);
    if (keep < children.length) {
      rollups++;
      const cut = children.slice(keep);
      entry.node.more = {files: cut.reduce((sum, child) => sum + child.files, 0), loc: cut.reduce((sum, child) => sum + child.loc, 0)};
    }
    for (const child of children.slice(0, keep)) {
      const dir = dirs.get(child);
      if (dir) queue.push(dir);
    }
  }
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
    // Commit counts and ages come from the shared history: what limits it (a shallow clone, the parsed window) is said.
    const warnings = [...model.warnings, ...(history?.warnings ?? [])];
    const {root, nodes} = rollUp(filesIn(model, scope, meta.name), scope, model, history, now);
    const {kept, rollups} = cutTree(root, meta.budget, MAX_CHILDREN_OF_TARGET);
    const generated = model.files.reduce((sum, file) => sum + (file.generated && inScope(file.path, scope) ? 1 : 0), 0);
    const summary = [
      `${plural(root.node.files, 'file')}, ${compact(root.node.loc)} loc`,
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
      ...(first ? {lead: `top ${String(first.path)} ${String(first.loc)} loc`} : {}),
      // Without history there is no commits column to show.
      ...(history ? {} : {fields: (meta.fields ?? []).filter(field => field.key !== 'commits')}),
      warnings: [...model.warnings, ...(history?.warnings ?? [])],
    });
  });

  const langs = define('files.langs', async (ctx, ref, _signal, meta) => {
    const model = await repoModel(ctx);
    const rows = languageMix(model);
    const kept: LangRow[] = rows.slice(0, meta.budget);
    if (rows.length > meta.budget) {
      // Past the budget the tail becomes one row, so the percentages still add up.
      const tail = rows.slice(meta.budget - 1);
      kept.length = meta.budget - 1;
      kept.push({lang: 'Other', files: tail.reduce((sum, row) => sum + row.files, 0), loc: tail.reduce((sum, row) => sum + row.loc, 0), pct: Math.round(tail.reduce((sum, row) => sum + row.pct, 0) * 10) / 10});
    }
    const lead = kept.slice(0, 4).map(row => `${row.lang} ${Math.round(row.pct)}%`).join(' ');
    const result = rowsResult(meta, ref, kept as unknown as Rows, {by: 'loc', lead});
    if (rows.length > kept.length) {
      result.total = rows.length;
      result.truncated = {total: rows.length, returned: result.data.length, strategy: 'topN', by: 'loc'};
    }
    return result;
  });

  return [tree, list, langs];
}

/** Lines of code per language, largest first: generated and binary files aside, unknown text files as 'Other'. */
export function languageMix(model: RepoModel): LangRow[] {
  const byLang = new Map<string, {files: number; loc: number}>();
  let total = 0;
  for (const file of model.files) {
    const loc = codeLines(file);
    if (loc === 0) continue;
    const lang = file.lang ?? 'Other';
    const entry = byLang.get(lang) ?? {files: 0, loc: 0};
    entry.files++;
    entry.loc += loc;
    byLang.set(lang, entry);
    total += loc;
  }
  return [...byLang]
    .map(([lang, entry]) => ({lang, files: entry.files, loc: entry.loc, pct: Math.round((entry.loc / total) * 1000) / 10}))
    .sort((a, b) => b.loc - a.loc || byText(a.lang, b.lang));
}
