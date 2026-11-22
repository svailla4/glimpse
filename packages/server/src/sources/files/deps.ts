// deps.modules, deps.files, deps.cycles, deps.external, deps.matrix: the import graph at module and file level.
import type {GraphData, GraphEdge, GraphGroup, GraphNode, Rows, SourceRef, Truncation} from '@glimpse/catalog';
import {cutModules, DEFAULT_MODULES, findCycles, MAX_MODULES, parseModuleId, type ModuleCut} from '../../analyze/cluster.ts';
import {repoModel, type RepoModel} from '../../analyze/index.ts';
import {baseName, dirName, languageOf} from '../../analyze/languages.ts';
import {codeLines, countModules, isPackageImport, manifestDirsOf, packageMember, sourceLines, targetKind} from '../../analyze/model.ts';
import {ecosystemOf} from '../../analyze/resolve.ts';
import {SourceError, type FileEntry, type Source, type SourceResult} from '../../contracts.ts';
import {byText, clampSummary, compact, define, depthOf, inScope, leadOf, plural, rowsResult, scopeNote, scopeOf, topOf} from './shared.ts';

const MAX_EDGES = 400;
const MAX_EXTERNAL_NODES = 8;
const MAX_OUTSIDE_NODES = 12;
/**
 * Nodes of a module graph nobody asked to be larger: what a plate shows with every label readable. `top=N` raises
 * it, up to the hard cap of MAX_MODULES clusters plus the external packages.
 */
const DEFAULT_MODULE_NODES = DEFAULT_MODULES + 4;
const MAX_MODULE_NODES = MAX_MODULES + MAX_EXTERNAL_NODES;

interface NodeLimits {
  /** Clusters of the scope. */
  clusters: number;
  externals: number;
  /** Clusters of the rest of the repository, drawn around a scope. */
  outside: number;
}

/** How a module graph of `total` nodes is shared out between the scope, its surroundings and external packages. */
function moduleLimits(total: number, scoped: boolean): NodeLimits {
  const nodes = Math.min(MAX_MODULE_NODES, Math.max(4, total));
  const externals = Math.min(MAX_EXTERNAL_NODES, Math.round(nodes / 6));
  const outside = scoped ? Math.min(MAX_OUTSIDE_NODES, Math.round(nodes / 4)) : 0;
  return {clusters: Math.min(MAX_MODULES, Math.max(2, nodes - externals - outside)), externals, outside};
}
const FILE_LIMITS: NodeLimits = {clusters: Number.POSITIVE_INFINITY, externals: MAX_EXTERNAL_NODES, outside: MAX_OUTSIDE_NODES};
/** A scope with at most this many source files is drawn file by file instead of as clusters. */
const FILE_LEVEL_FILES = 40;
const MAX_CYCLE_MEMBERS = 20;

interface DraftEdge {
  from: string;
  to: string;
  weight: number;
  typeOnly: boolean;
  /** False while every import behind the edge is type-only or a lazy import(): such an edge closes no cycle. */
  eager: boolean;
}
interface Draft {
  level: 'module' | 'file';
  /** Nodes inside the scope, by id. */
  nodes: Map<string, GraphNode>;
  outside: Map<string, GraphNode>;
  externals: Map<string, GraphNode>;
  edges: DraftEdge[];
  /** Imports from the scope to the rest of the repository. */
  leaving: number;
  /** Rest clusters that hold folded directories, not only the files directly in theirs. */
  folded: Set<string>;
}

/** What a scope contains: the whole repository, a directory, or the files of one cluster of the repository cut. */
export interface Scope {
  label: string;
  hasFile(path: string): boolean;
  hasDir(dir: string): boolean;
}

const cutFiles = (files: readonly FileEntry[]) => files.map(file => ({path: file.path, weight: sourceLines(file)}));

/** The cut a module graph of `scope` draws: what deps.modules computes for that target and `top`. */
export function cutFor(model: RepoModel, scope: string, files: readonly FileEntry[], top: number | undefined): ModuleCut {
  const limits = moduleLimits(top ?? DEFAULT_MODULE_NODES, scope !== '');
  if (scope === '' && limits.clusters === DEFAULT_MODULES) return model.cut;
  return cutModules(cutFiles(files), {root: parseModuleId(scope).dir, max: limits.clusters, manifestDirs: manifestDirsOf(model.manifests)});
}

/**
 * What a scope contains. A rest cluster ('src/*', '(root)') is not a directory prefix: it is whatever a cut left in
 * that directory, and the cut that made it may be the repository's or that of a scoped graph (drilling a rest node
 * of `deps.modules typescript` sends an id the repository cut never produces). The cut is found again: the
 * repository's, else that of the nearest enclosing directory whose graph has the id. An id no cut produces is read
 * as its directory, so every node id a module graph draws is a target it accepts (V059).
 */
function scopeFor(model: RepoModel, target: string, top?: number): Scope {
  if (target === '') return {label: '', hasFile: () => true, hasDir: () => true};
  const {dir, rest} = parseModuleId(target);
  if (rest) {
    const of = (cut: ModuleCut): Scope => ({label: target, hasFile: path => cut.moduleOf(path) === target, hasDir: sub => cut.moduleOfDir(sub) === target});
    if (model.cut.ids.includes(target)) return of(model.cut);
    for (let scope = dir; ; scope = dirName(scope)) {
      const files = model.files.filter(file => inScope(file.path, scope));
      if (files.length > 0) {
        const cut = cutFor(model, scope, files, top);
        if (cut.ids.includes(target)) return of(cut);
      }
      if (scope === '') break;
    }
    return {label: target, hasFile: path => inScope(path, dir), hasDir: sub => inScope(sub, dir)};
  }
  return {label: target, hasFile: path => inScope(path, target), hasDir: sub => inScope(sub, target)};
}

/**
 * The files a path target names, read as deps.modules reads it: '' for the repository, a directory, a file, or a module
 * id of a graph ('src/*'). E_TARGET when it names nothing, so a mistyped path is never the whole repository.
 */
export function scopedFiles(model: RepoModel, target: string, name: string): {files: readonly FileEntry[]; where: Scope} {
  const where = scopeFor(model, target);
  if (target === '') return {files: model.files, where};
  const files = model.files.filter(file => where.hasFile(file.path));
  if (files.length === 0) throw new SourceError('E_TARGET', `${name}: no files under "${target}"`);
  return {files, where};
}

/**
 * The modules a path target holds, as deps.modules cuts them before a graph folds the smaller ones ("20 of N"): the
 * repository's count, that of a directory or module id, and 1 for a file, which lies in one module.
 */
export function modulesIn(model: RepoModel, target: string, files: readonly FileEntry[]): number {
  if (target === '') return model.modules;
  if (model.byPath.has(target)) return 1;
  return countModules(files, model.manifests, parseModuleId(target).dir);
}

/** The file cycles with a member among `files` (all of them when undefined): the rows of deps.cycles for a path. */
export function cyclesThrough(model: RepoModel, files: readonly FileEntry[] | undefined): string[][] {
  if (!files) return model.cycles;
  const inside = new Set(files.map(file => file.path));
  return model.cycles.filter(members => members.some(member => inside.has(member)));
}

/** `files`: those the result is about (the repository's, or those under a path). */
function unparsedWarning(files: readonly FileEntry[]): string[] {
  const unparsed = new Map<string, number>();
  let total = 0;
  for (const file of files) {
    const lines = sourceLines(file);
    if (lines === 0) continue;
    total += lines;
    if (!languageOf(file.path)?.scan && file.lang) unparsed.set(file.lang, (unparsed.get(file.lang) ?? 0) + lines);
  }
  const missed = [...unparsed].filter(([, lines]) => lines / total >= 0.1).sort((a, b) => b[1] - a[1]).map(([lang]) => lang);
  return missed.length > 0 ? [`imports are not analysed for ${missed.slice(0, 3).join(', ')}: those files appear without edges`] : [];
}

/**
 * What a reader of a graph must know about its coverage. Inventory warnings belong to the files.* sources. `files`:
 * those the graph is drawn from, when it is scoped to a path.
 */
function graphWarnings(model: RepoModel, files: readonly FileEntry[] = model.files): string[] {
  const warnings = unparsedWarning(files);
  if (model.imports && model.unresolved && model.unresolved / model.imports > 0.1) {
    warnings.push(`${model.unresolved} of ${model.imports} imports matched no file (aliases or generated code)`);
  }
  return warnings;
}

/** Shortest path suffix that tells each directory apart from the others. */
function shortLabels(dirs: readonly string[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const dir of dirs) {
    const parts = dir.split('/');
    let label = dir;
    for (let take = 1; take <= parts.length; take++) {
      const suffix = parts.slice(-take).join('/');
      if (!dirs.some(other => other !== dir && (other === suffix || other.endsWith(`/${suffix}`)))) {
        label = suffix;
        break;
      }
    }
    labels.set(dir, label);
  }
  return labels;
}

function fileNode(model: RepoModel, path: string): GraphNode {
  const file = model.byPath.get(path);
  return {
    id: path, label: baseName(path), sub: dirName(path) || '.', kind: 'file', slotKey: model.cut.moduleOf(path),
    loc: file ? codeLines(file) : 0, fanIn: 0, fanOut: 0, file: path,
  };
}

/** A directory imported as a whole (a Go package, a C# namespace, a Swift module). */
function packageNode(model: RepoModel, dir: string): GraphNode {
  return {id: dir, label: baseName(dir) || '.', sub: `package in ${dirName(dir) || '.'}`, kind: 'package', slotKey: model.cut.moduleOfDir(dir), fanIn: 0, fanOut: 0};
}

function buildDraft(model: RepoModel, scope: Scope, cut: ModuleCut, level: 'module' | 'file', limits: NodeLimits): Draft {
  const draft: Draft = {level, nodes: new Map(), outside: new Map(), externals: new Map(), edges: [], leaving: 0, folded: new Set()};
  const members = new Map<string, string[]>();

  // ---- nodes of the scope
  const nodeOfFile = (path: string): string | undefined => {
    if (level === 'file') {
      // Imported stylesheets, data files and the like are not source, but they are ends of edges.
      if (!draft.nodes.has(path)) draft.nodes.set(path, fileNode(model, path));
      return path;
    }
    const id = cut.moduleOf(path);
    return draft.nodes.has(id) ? id : undefined;
  };
  for (const file of model.files) {
    const lines = sourceLines(file);
    if (lines === 0 || !scope.hasFile(file.path)) continue;
    if (level === 'file') {
      draft.nodes.set(file.path, fileNode(model, file.path));
      continue;
    }
    const id = cut.moduleOf(file.path);
    const node: GraphNode = draft.nodes.get(id) ?? {id, label: id, kind: 'cluster', slotKey: id, files: 0, loc: 0, fanIn: 0, fanOut: 0};
    node.files = (node.files ?? 0) + 1;
    node.loc = (node.loc ?? 0) + lines;
    draft.nodes.set(id, node);
    const list = members.get(id);
    if (list) list.push(file.path);
    else members.set(id, [file.path]);
  }

  // ---- edges
  const edges = new Map<string, DraftEdge>();
  const addEdge = (from: string, to: string, typeOnly: boolean, eager: boolean) => {
    const key = `${from}\0${to}`;
    const edge = edges.get(key);
    if (edge) {
      edge.weight++;
      edge.typeOnly &&= typeOnly;
      edge.eager ||= eager;
    } else edges.set(key, {from, to, weight: 1, typeOnly, eager});
  };
  // The rest of the repository appears as the clusters of the repository cut.
  const outsideNode = (id: string): string | undefined => (draft.nodes.has(id) ? undefined : id);
  const externalUse = new Map<string, Map<string, number>>();
  const inbound = new Map<string, number>();
  for (const link of model.links) {
    const kind = targetKind(model, link);
    const fromInside = scope.hasFile(link.from);
    const typeOnly = link.kind === 'type';
    if (kind === 'ext') {
      const from = fromInside ? nodeOfFile(link.from) : undefined;
      if (!from) continue;
      const uses = externalUse.get(link.to) ?? new Map<string, number>();
      uses.set(from, (uses.get(from) ?? 0) + 1);
      externalUse.set(link.to, uses);
      continue;
    }
    const toInside = kind === 'file' ? scope.hasFile(link.to) : scope.hasDir(link.to);
    if (!fromInside && !toInside) continue;
    let to: string | undefined;
    if (toInside) {
      if (kind === 'file') to = nodeOfFile(link.to);
      else if (level === 'module') {
        const id = cut.moduleOfDir(link.to);
        to = draft.nodes.has(id) ? id : undefined;
      } else {
        to = link.to;
        if (!draft.nodes.has(to)) draft.nodes.set(to, packageNode(model, to));
      }
    } else to = outsideNode(kind === 'file' ? model.cut.moduleOf(link.to) : model.cut.moduleOfDir(link.to));
    const from = fromInside ? nodeOfFile(link.from) : outsideNode(model.cut.moduleOf(link.from));
    if (!from || !to || from === to) continue;
    if (fromInside && !toInside) draft.leaving++;
    if (toInside && kind === 'file') inbound.set(link.to, (inbound.get(link.to) ?? 0) + 1);
    addEdge(from, to, typeOnly, !typeOnly && link.kind !== 'dynamic');
  }

  // ---- the most connected outside clusters, and the most used external packages
  const outsideWeight = new Map<string, number>();
  for (const edge of edges.values()) {
    for (const end of [edge.from, edge.to]) if (!draft.nodes.has(end)) outsideWeight.set(end, (outsideWeight.get(end) ?? 0) + edge.weight);
  }
  const keptOutside = [...outsideWeight].sort((a, b) => b[1] - a[1] || byText(a[0], b[0])).slice(0, limits.outside);
  for (const [id] of keptOutside) draft.outside.set(id, {id, label: id, sub: 'outside', kind: 'cluster', slotKey: id, fanIn: 0, fanOut: 0});
  const externals = [...externalUse].map(([id, uses]) => ({id, uses, files: [...uses.values()].reduce((sum, n) => sum + n, 0)}))
    .sort((a, b) => b.files - a.files || byText(a.id, b.id)).slice(0, limits.externals);
  for (const external of externals) {
    draft.externals.set(external.id, {id: external.id, label: external.id.slice(4), kind: 'external', fanIn: external.uses.size, fanOut: 0});
    for (const [from, weight] of external.uses) edges.set(`${from}\0${external.id}`, {from, to: external.id, weight, typeOnly: false, eager: true});
  }
  const known = (id: string) => draft.nodes.has(id) || draft.outside.has(id) || draft.externals.has(id);
  draft.edges = [...edges.values()].filter(edge => known(edge.from) && known(edge.to));

  // ---- module details: where a click on the cluster should land, and a line of size
  if (level === 'module') {
    for (const [id, node] of draft.nodes) {
      const files = members.get(id) ?? [];
      const {dir, rest} = parseModuleId(id);
      // A rest cluster is the files directly in its directory plus the smaller directories folded into it.
      const below = dir === '' ? 0 : dir.length + 1;
      const folded = rest ? new Set(files.map(dirName).filter(home => home !== dir).map(home => home.slice(below).split('/')[0])).size : 0;
      if (folded > 0) draft.folded.add(id);
      node.sub = `${folded > 0 ? `${plural(folded, 'smaller directory', 'smaller directories')} of ${dir || 'the repository'}: ` : ''}${plural(node.files ?? 0, 'file')}, ${compact(node.loc ?? 0)} loc`;
      const loc = (path: string) => model.byPath.get(path)?.loc ?? 0;
      const entry = files.reduce<string | undefined>((best, path) => {
        if (best === undefined) return path;
        const diff = (inbound.get(path) ?? 0) - (inbound.get(best) ?? 0) || loc(path) - loc(best);
        return diff > 0 || (diff === 0 && path < best) ? path : best;
      }, undefined);
      if (entry) node.file = entry;
    }
  }
  return draft;
}

interface Finished {
  graph: GraphData;
  total: number;
  truncated?: Truncation;
  cycles: number;
}

/** `anchor`: a node whose own edges survive the edge budget first (the file of deps.files). */
function finish(draft: Draft, model: RepoModel, scope: Scope, repoName: string, ref: SourceRef, budget: number, anchor?: string): Finished {
  let truncated: Truncation | undefined;
  const total = draft.nodes.size + draft.outside.size + draft.externals.size;

  // ---- node budget: the scope keeps its best connected nodes
  const room = Math.max(1, budget - draft.outside.size - draft.externals.size);
  if (draft.nodes.size > room) {
    const degree = new Map<string, number>();
    for (const edge of draft.edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + edge.weight);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + edge.weight);
    }
    const ranked = [...draft.nodes.values()].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || (b.loc ?? 0) - (a.loc ?? 0) || byText(a.id, b.id));
    draft.nodes = new Map(ranked.slice(0, room).map(node => [node.id, node]));
    truncated = {total, returned: room + draft.outside.size + draft.externals.size, strategy: 'topN', by: 'degree'};
  }
  let nodes = [...draft.nodes.values(), ...draft.outside.values(), ...draft.externals.values()];
  const kept = new Set(nodes.map(node => node.id));
  let edges = draft.edges.filter(edge => kept.has(edge.from) && kept.has(edge.to));

  // ---- cycles
  const cycleOf = new Map<string, number>();
  const cycles = draft.level === 'file'
    ? model.cycles
    : findCycles(edges.filter(edge => edge.eager && draft.nodes.has(edge.from) && draft.nodes.has(edge.to)).map(edge => [edge.from, edge.to] as const));
  let cycleCount = 0;
  cycles.forEach((members, index) => {
    // A file is in its cycle even when the other members lie outside what is drawn.
    const present = members.filter(member => draft.nodes.has(member));
    if (present.length === 0) return;
    cycleCount++;
    for (const member of present) cycleOf.set(member, index);
  });

  // ---- labels: the shortest directory suffix that is unique among the clusters drawn
  const labels = shortLabels([...new Set(nodes.filter(node => node.kind === 'cluster').map(node => parseModuleId(node.id).dir))]);
  for (const node of nodes) {
    if (node.kind !== 'cluster') continue;
    const {dir, rest} = parseModuleId(node.id);
    const short = labels.get(dir) ?? dir;
    // The root's rest cluster is named for what it holds: the files at the root, or those plus folded directories.
    node.label = dir === '' ? (rest ? (draft.folded.has(node.id) ? '(other)' : '(root)') : repoName) : rest ? `${short}/*` : short;
  }

  // ---- degrees, over the whole graph of the scope: a neighbourhood keeps the numbers of its nodes
  const neighbours = (direction: 'from' | 'to') => {
    const sets = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (draft.externals.has(edge.to)) continue;
      const [node, other] = direction === 'from' ? [edge.from, edge.to] : [edge.to, edge.from];
      const set = sets.get(node) ?? new Set<string>();
      set.add(other);
      sets.set(node, set);
    }
    return sets;
  };
  const outgoing = neighbours('from');
  const incoming = neighbours('to');
  for (const node of nodes) {
    if (node.kind !== 'external') {
      node.fanOut = outgoing.get(node.id)?.size ?? 0;
      node.fanIn = incoming.get(node.id)?.size ?? 0;
    }
    if (cycleOf.has(node.id)) node.cycle = true;
  }

  // ---- focus: a neighbourhood of one node
  const focus = ref.args.focus;
  if (focus !== undefined) {
    const wanted = focus.toLowerCase();
    const centre = nodes.find(node => node.id === focus) ?? nodes.find(node => node.id.toLowerCase() === wanted || node.label.toLowerCase() === wanted);
    if (!centre) {
      throw new SourceError('E_ARGS', `${ref.source}: focus "${focus}" is not a node. Nodes: ${nodes.slice(0, 8).map(node => node.id).join(', ')}${nodes.length > 8 ? ', …' : ''}`);
    }
    const reached = new Set([centre.id]);
    let frontier = [centre.id];
    for (let hop = 0; hop < (depthOf(ref) ?? 1) && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const edge of edges) {
        for (const [near, far] of [[edge.from, edge.to], [edge.to, edge.from]] as const) {
          if (frontier.includes(near) && !reached.has(far)) {
            reached.add(far);
            next.push(far);
          }
        }
      }
      frontier = next;
    }
    if (reached.size < nodes.length) truncated = {total, returned: reached.size, strategy: 'neighborhood', by: centre.id};
    nodes = nodes.filter(node => reached.has(node.id));
    edges = edges.filter(edge => reached.has(edge.from) && reached.has(edge.to));
  }

  // ---- edge budget
  const byWeight = (a: DraftEdge, b: DraftEdge) => b.weight - a.weight || byText(a.from, b.from) || byText(a.to, b.to);
  edges.sort(byWeight);
  if (edges.length > MAX_EDGES) {
    truncated ??= {total: edges.length, returned: MAX_EDGES, strategy: 'topN', by: 'weight'};
    // The anchor's own imports and importers are kept first: the edges the summary counts are the ones drawn.
    const own = (edge: DraftEdge) => Number(anchor !== undefined && (edge.from === anchor || edge.to === anchor));
    edges = [...edges].sort((a, b) => own(b) - own(a) || byWeight(a, b)).slice(0, MAX_EDGES).sort(byWeight);
  }

  // ---- groups
  const groups: GraphGroup[] = [];
  if (scope.label !== '' && (draft.outside.size > 0 || draft.externals.size > 0)) {
    groups.push({id: 'scope', label: scope.label});
    for (const node of nodes) if (draft.nodes.has(node.id)) node.group = 'scope';
  } else if (draft.level === 'module') {
    const byTop = new Map<string, GraphNode[]>();
    let loose = 0;
    for (const node of nodes) {
      if (node.kind !== 'cluster') continue;
      const {dir, rest} = parseModuleId(node.id);
      // 'src/api' and the rest cluster 'src/*' both sit under 'src'; a top-level directory stands alone.
      if (dir === '' || !(rest || dir.includes('/'))) {
        loose++;
        continue;
      }
      const top = dir.split('/')[0]!;
      const list = byTop.get(top);
      if (list) list.push(node);
      else byTop.set(top, [node]);
    }
    const shared = [...byTop].filter(([, list]) => list.length >= 2);
    // One box around every cluster says nothing.
    if (shared.length > 1 || (shared.length === 1 && loose > 0)) {
      for (const [top, list] of shared) {
        groups.push({id: `dir:${top}`, label: top});
        for (const node of list) node.group = `dir:${top}`;
      }
    }
  }

  const wire: GraphEdge[] = edges.map(edge => ({
    from: edge.from,
    to: edge.to,
    ...(draft.level === 'module' || edge.weight > 1 ? {weight: edge.weight} : {}),
    ...(edge.typeOnly ? {kind: 'dashed' as const} : {}),
    ...(edge.eager && cycleOf.has(edge.from) && cycleOf.get(edge.from) === cycleOf.get(edge.to) ? {cycle: true} : {}),
  }));
  return {
    graph: {nodes, edges: wire, ...(groups.length > 0 ? {groups} : {}), level: draft.level},
    total,
    ...(truncated ? {truncated} : {}),
    cycles: cycleCount,
  };
}

function graphResult(finished: Finished, draft: Draft, scope: Scope, warnings: string[], extra: string[] = []): SourceResult<GraphData> {
  const {graph} = finished;
  const parts = [
    // Cycles between clusters and cycles between files are different counts: each is named for what it counts.
    `${plural(graph.nodes.length, 'node')} ${plural(graph.edges.length, 'edge')}, ${plural(finished.cycles, graph.level === 'module' ? 'module cycle' : 'file cycle')}`,
    `level ${graph.level}`,
    ...(scope.label !== '' ? [`in ${scope.label}${draft.leaving > 0 ? `, ${plural(draft.leaving, 'import')} out of it` : ''}`] : []),
    ...extra,
  ];
  return {
    data: graph,
    total: finished.total,
    ...(finished.truncated ? {truncated: finished.truncated} : {}),
    ...(warnings.length > 0 ? {warnings} : {}),
    summary: clampSummary(parts.join('; ')),
  };
}

/** The module graph of `target` ('' for the repository, a directory, or a cluster id): deps.modules. */
function moduleGraph(model: RepoModel, repoName: string, ref: SourceRef, target: string, budget: number, name: string): SourceResult<GraphData> {
  const top = topOf(ref);
  const scope = scopeFor(model, target, top);
  const files = target === '' ? model.files : model.files.filter(file => scope.hasFile(file.path));
  if (target !== '' && files.length === 0) throw new SourceError('E_TARGET', `${name}: no files under "${target}"`);
  const sources = files.filter(file => sourceLines(file) > 0).length;
  // A module graph is legible by default: about two dozen nodes, the smaller directories folded into rest clusters.
  // `top=N` asks for more (a finer cut), up to the hard cap.
  const limits = moduleLimits(top ?? DEFAULT_MODULE_NODES, target !== '');
  const cut = cutFor(model, target, files, top);
  // Clusters are for telling parts apart; a scope that is one cluster, or small, is clearer file by file.
  const level = cut.ids.length <= 1 || (target !== '' && sources <= FILE_LEVEL_FILES) ? 'file' : 'module';
  const draft = buildDraft(model, scope, cut, level, level === 'module' ? limits : FILE_LIMITS);
  const finished = finish(draft, model, scope, repoName, ref, level === 'module' ? budget : Math.min(top ?? budget, budget));
  const extra: string[] = [];
  if (level === 'module') {
    // The cut folds the smaller directories into rest clusters: the graph shows `drawn` of the scope's modules, the
    // number the Modules KPI gives for the repository (decision numbers-on-a-page-agree). A focus or a degree cut says more and wins.
    const all = target === '' ? model.modules : countModules(files, model.manifests, parseModuleId(target).dir);
    const drawn = finished.graph.nodes.filter(node => node.kind === 'cluster' && draft.nodes.has(node.id)).length;
    if (all > drawn) {
      extra.push(`${drawn} of ${plural(all, 'module')}, smaller ones folded`);
      if (!finished.truncated || finished.truncated.strategy !== 'neighborhood') finished.truncated = {total: all, returned: drawn, strategy: 'treecut', by: 'loc'};
    }
  }
  const warnings = graphWarnings(model, files);
  if (sources === 0 && files.length > 0) warnings.push(`no source files under "${target || '.'}": nothing to draw`);
  return graphResult(finished, draft, scope, warnings, extra);
}

export function depsSources(): Source[] {
  const modules = define('deps.modules', async (ctx, ref, _signal, meta) => {
    const model = await repoModel(ctx);
    const target = scopeOf(ref);
    if (model.byPath.has(target)) throw new SourceError('E_TARGET', `${meta.name}: "${target}" is a file; use deps.files ${target}`);
    return moduleGraph(model, ctx.name, ref, target, meta.budget, meta.name);
  });

  const filesGraph = define('deps.files', async (ctx, ref, _signal, meta) => {
    const model = await repoModel(ctx);
    const target = scopeOf(ref);
    if (target === '') throw new SourceError('E_TARGET', `${meta.name} needs a file path, e.g. ${meta.name} src/index.ts (for a directory: deps.modules <dir>)`);
    const focus = model.byPath.get(target);
    if (!focus) {
      // A directory, or a cluster of a module graph (a drill from one), is drawn as its module graph: that is what
      // was meant, and it costs no round trip (V006). The summary says so.
      const isDir = model.files.some(file => inScope(file.path, target));
      const isModule = !isDir && parseModuleId(target).rest;
      if (!isDir && !isModule) throw new SourceError('E_TARGET', `${meta.name}: no such file "${target}"`);
      const result = moduleGraph(model, ctx.name, {...ref, source: 'deps.modules', args: {}}, target, meta.budget, meta.name);
      return {...result, summary: clampSummary(`${isModule ? 'a module' : 'a directory'}: drawn as deps.modules ${target}; ${result.summary}`)};
    }
    const depth = depthOf(ref) ?? 1;
    // Hops over file-to-file imports in both directions. An import of a package reaches the package directory, and
    // every file importing a package that a reached file belongs to is an importer of that file: the files directly
    // in a Go or C# package, every file beneath a Swift module (the rule RepoIndex.edges and diff.impact apply).
    const hop = (frontier: ReadonlySet<string>, reached: ReadonlySet<string>): Set<string> => {
      const next = new Set<string>();
      const members = [...frontier].flatMap(path => model.byPath.get(path) ?? []);
      for (const link of model.links) {
        const kind = targetKind(model, link);
        if (kind === 'ext') continue;
        if (frontier.has(link.from) && !reached.has(link.to)) next.add(link.to);
        if (reached.has(link.from)) continue;
        if (frontier.has(link.to) || (kind === 'dir' && members.some(file => packageMember(model, link, file)))) next.add(link.from);
      }
      return next;
    };
    // The focus file's own imports and importers, counted before any node budget: the numbers the summary gives
    // are the file's, never those of a cut graph (V024), and diff.impact counts the same importers.
    const importsAll = new Set<string>();
    const importersAll = new Set<string>();
    const byName = new Set<string>();
    for (const link of model.links) {
      if (link.from === target) {
        if (link.to !== target) importsAll.add(link.to);
        continue;
      }
      if (link.to === target) {
        importersAll.add(link.from);
        if (!isPackageImport(link)) byName.add(link.from);
      } else if (targetKind(model, link) === 'dir' && packageMember(model, link, focus)) importersAll.add(link.from);
    }
    // What the cut keeps: what the file imports and who imports it by name, before files that only import the whole
    // package it belongs to; then by path.
    const near = (path: string) => Number(byName.has(path) || importsAll.has(path) || !importersAll.has(path));
    const order = (paths: Iterable<string>) => [...paths].sort((a, b) => near(b) - near(a) || byText(a, b));
    const room = meta.budget - MAX_EXTERNAL_NODES;
    const reached = new Set<string>([target]);
    const everything = new Set<string>([target]);
    let frontier: Set<string> = new Set([target]);
    let wide: Set<string> = new Set([target]);
    for (let step = 0; step < depth && (frontier.size > 0 || wide.size > 0); step++) {
      const next = hop(frontier, reached);
      for (const path of order(next)) {
        if (reached.size >= room) break;
        reached.add(path);
      }
      frontier = new Set([...next].filter(path => reached.has(path)));
      const further = hop(wide, everything);
      for (const path of further) everything.add(path);
      wide = further;
    }
    const cappedAt = everything.size > reached.size ? everything.size : undefined;
    const scope: Scope = {label: '', hasFile: path => reached.has(path), hasDir: dir => reached.has(dir)};
    const draft: Draft = {level: 'file', nodes: new Map(), outside: new Map(), externals: new Map(), edges: [], leaving: 0, folded: new Set()};
    for (const id of reached) draft.nodes.set(id, model.byPath.has(id) ? fileNode(model, id) : packageNode(model, id));
    const seen = new Set<string>();
    for (const link of model.links) {
      if (!reached.has(link.from)) continue;
      const kind = targetKind(model, link);
      let to: string | undefined;
      if (kind === 'ext') {
        if (link.from !== target || draft.externals.size >= MAX_EXTERNAL_NODES) continue;
        draft.externals.set(link.to, {id: link.to, label: link.to.slice(4), kind: 'external', fanIn: 1, fanOut: 0});
        to = link.to;
      } else if (reached.has(link.to)) to = link.to;
      // An import of a package the focus file belongs to is an import of the focus file.
      else if (kind === 'dir' && packageMember(model, link, focus)) to = target;
      if (to === undefined || to === link.from || seen.has(`${link.from}\0${to}`)) continue;
      seen.add(`${link.from}\0${to}`);
      draft.edges.push({from: link.from, to, weight: 1, typeOnly: link.kind === 'type', eager: link.kind !== 'type' && link.kind !== 'dynamic'});
    }
    const finished = finish(draft, model, scope, ctx.name, {...ref, args: {}}, meta.budget, target);
    // The focus file leads, so a reader of the data finds it first.
    finished.graph.nodes.sort((a, b) => Number(b.id === target) - Number(a.id === target));
    const nodesShown = finished.graph.nodes.length;
    const nodesAll = cappedAt === undefined ? nodesShown : cappedAt + finished.graph.nodes.filter(node => node.kind === 'external').length;
    if (cappedAt !== undefined) {
      finished.total = nodesAll;
      finished.truncated = {total: nodesAll, returned: nodesShown, strategy: 'neighborhood', by: target};
    }
    const drawnImports = finished.graph.edges.filter(edge => edge.from === target).length;
    const drawnImporters = finished.graph.edges.filter(edge => edge.to === target).length;
    const imports = Math.max(importsAll.size, drawnImports);
    const importers = importersAll.size;
    const counted = (n: number, drawn: number) => `${n.toLocaleString('en-US')}${drawn < n ? ` (${drawn.toLocaleString('en-US')} drawn)` : ''}`;
    const warnings = graphWarnings(model);
    if (cappedAt !== undefined) warnings.push(`graph cut to ${nodesShown} of ${nodesAll.toLocaleString('en-US')} nodes, importers by name first`);
    if (finished.graph.nodes.some(node => node.kind === 'package')) warnings.push('imports of a whole package are drawn to the package directory');
    const wholePackage = [...importersAll].filter(id => !byName.has(id)).length;
    if (wholePackage > 0) warnings.push(`${wholePackage} of ${plural(importers, 'importer')} import the whole package or module ${baseName(target)} belongs to, not this file by name`);
    return graphResult(finished, draft, scope, warnings, [`${baseName(target)} imports ${counted(imports, drawnImports)}, imported by ${counted(importers, drawnImporters)}`]);
  });

  // deps.cycles, deps.external and deps.matrix read a path as what lies under it (a directory, a file or a module
  // id such as 'src/*'): the cycles through it, the packages its files import, the imports between its modules.
  const cycles = define('deps.cycles', async (ctx, ref, _signal, meta) => {
    const model = await repoModel(ctx);
    const scope = scopeOf(ref);
    const {files} = scopedFiles(model, scope, meta.name);
    const found = cyclesThrough(model, scope === '' ? undefined : files);
    const rows: Rows = found.map((members, index) => ({
      id: index + 1,
      size: members.length,
      members: members.slice(0, MAX_CYCLE_MEMBERS).join(', ') + (members.length > MAX_CYCLE_MEMBERS ? `, +${members.length - MAX_CYCLE_MEMBERS} more` : ''),
    }));
    const largest = found[0];
    // Nothing to list reads as one phrase, as the empty plate shows it: 'no import cycles in web'.
    const lead = largest ? leadOf(scope, `largest ${plural(largest.length, 'file')}: ${largest.slice(0, 3).join(', ')}`) : `no import cycles${scopeNote(scope, ' ')}`;
    return rowsResult(meta, ref, rows, {by: 'size', lead, warnings: unparsedWarning(files)});
  });

  const external = define('deps.external', async (ctx, ref, _signal, meta) => {
    const model = await repoModel(ctx);
    const scope = scopeOf(ref);
    const {files, where} = scopedFiles(model, scope, meta.name);
    // Only the importers under the path count: 'deps.external web' lists what the files of web/ import, not the
    // packages of the whole repository.
    const packages = new Map<string, {package: string; ecosystem: string; importers: number}>();
    for (const link of model.links) {
      if (!link.to.startsWith('ext:') || !where.hasFile(link.from)) continue;
      const ecosystem = ecosystemOf(model.byPath.get(link.from)?.lang);
      const key = `${ecosystem}\0${link.to}`;
      const entry = packages.get(key) ?? {package: link.to.slice(4), ecosystem, importers: 0};
      entry.importers++;
      packages.set(key, entry);
    }
    const rows: Rows = [...packages.values()].sort((a, b) => b.importers - a.importers || byText(a.package, b.package))
      .map(entry => ({package: entry.package, importers: entry.importers, ecosystem: entry.ecosystem}));
    const first = rows[0];
    const lead = first ? leadOf(scope, `top ${String(first.package)} ${plural(Number(first.importers), 'importer')}`) : scope ? `no external imports ${scopeNote(scope)}` : '';
    return rowsResult(meta, ref, rows, {by: 'importers', ...(lead ? {lead} : {}), warnings: unparsedWarning(files)});
  });

  const matrix = define('deps.matrix', async (ctx, ref, _signal, meta) => {
    const model = await repoModel(ctx);
    const scope = scopeOf(ref);
    const {files, where} = scopedFiles(model, scope, meta.name);
    // The modules deps.modules draws for the same path: the repository cut, or the cut of the scope.
    const cut = cutFor(model, scope, files, undefined);
    const modules = new Set(cut.ids);
    const weights = new Map<string, {from: string; to: string; weight: number}>();
    for (const link of model.links) {
      const kind = targetKind(model, link);
      if (kind === 'ext') continue;
      // Imports between modules of the scope: both ends lie under the path.
      if (!where.hasFile(link.from) || !(kind === 'file' ? where.hasFile(link.to) : where.hasDir(link.to))) continue;
      const from = cut.moduleOf(link.from);
      const to = kind === 'file' ? cut.moduleOf(link.to) : cut.moduleOfDir(link.to);
      if (from === to || !modules.has(from) || !modules.has(to)) continue;
      const key = `${from}\0${to}`;
      const entry = weights.get(key) ?? {from, to, weight: 0};
      entry.weight++;
      weights.set(key, entry);
    }
    const rows: Rows = [...weights.values()].sort((a, b) => b.weight - a.weight || byText(a.from, b.from) || byText(a.to, b.to));
    const first = rows[0];
    // The clusters of the graph: "20 of 495 modules" when the cut folds smaller ones, as deps.modules says. A file lies
    // in one module, and has no imports between modules.
    const all = modulesIn(model, scope, files);
    const drawn = model.byPath.has(scope) ? 1 : modules.size;
    const counted = all > drawn ? `${drawn} of ${plural(all, 'module')}` : plural(drawn, 'module');
    return rowsResult(meta, ref, rows, {
      by: 'weight',
      lead: leadOf(scope, first ? `${counted}; heaviest ${String(first.from)} -> ${String(first.to)} ${String(first.weight)}` : `${counted}, no imports between them`),
    });
  });

  return [modules, filesGraph, cycles, external, matrix];
}
