// deps.modules, deps.files, deps.cycles, deps.external, deps.matrix: the import graph at module and file level.
import type {GraphData, GraphEdge, GraphGroup, GraphNode, Rows, SourceRef, Truncation} from '@glimpse/catalog';
import {cutModules, findCycles, parseModuleId, type ModuleCut} from '../../analyze/cluster.ts';
import {repoModel, type RepoModel} from '../../analyze/index.ts';
import {baseName, dirName, languageOf} from '../../analyze/languages.ts';
import {codeLines, sourceLines, targetKind} from '../../analyze/model.ts';
import {ecosystemOf} from '../../analyze/resolve.ts';
import {SourceError, type Source, type SourceResult} from '../../contracts.ts';
import {byText, clampSummary, compact, define, depthOf, inScope, plural, rowsResult, scopeOf} from './shared.ts';

const MAX_EDGES = 400;
const MAX_EXTERNAL_NODES = 8;
const MAX_OUTSIDE_NODES = 12;
/** A scope with at most this many source files is drawn file by file instead of as clusters. */
const FILE_LEVEL_FILES = 40;
const MAX_CYCLE_MEMBERS = 20;

interface DraftEdge {
  from: string;
  to: string;
  weight: number;
  typeOnly: boolean;
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
}

/** What a scope contains: the whole repository, a directory, or the files of one cluster of the repository cut. */
interface Scope {
  label: string;
  hasFile(path: string): boolean;
  hasDir(dir: string): boolean;
}

function scopeFor(model: RepoModel, target: string): Scope {
  if (target === '') return {label: '', hasFile: () => true, hasDir: () => true};
  // A rest cluster ('src/*', '(root)') is not a directory prefix: it is whatever the cut left in that directory.
  if (target === '(root)' || target.endsWith('/*')) {
    return {label: target, hasFile: path => model.cut.moduleOf(path) === target, hasDir: dir => model.cut.moduleOfDir(dir) === target};
  }
  return {label: target, hasFile: path => inScope(path, target), hasDir: dir => inScope(dir, target)};
}

function unparsedWarning(model: RepoModel): string[] {
  const unparsed = new Map<string, number>();
  let total = 0;
  for (const file of model.files) {
    const lines = sourceLines(file);
    if (lines === 0) continue;
    total += lines;
    if (!languageOf(file.path)?.scan && file.lang) unparsed.set(file.lang, (unparsed.get(file.lang) ?? 0) + lines);
  }
  const missed = [...unparsed].filter(([, lines]) => lines / total >= 0.1).sort((a, b) => b[1] - a[1]).map(([lang]) => lang);
  return missed.length > 0 ? [`imports are not analysed for ${missed.slice(0, 3).join(', ')}: those files appear without edges`] : [];
}

/** What a reader of a graph must know about its coverage. Inventory warnings belong to the files.* sources. */
function graphWarnings(model: RepoModel): string[] {
  const warnings = unparsedWarning(model);
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

function buildDraft(model: RepoModel, scope: Scope, cut: ModuleCut, level: 'module' | 'file'): Draft {
  const draft: Draft = {level, nodes: new Map(), outside: new Map(), externals: new Map(), edges: [], leaving: 0};
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
  const addEdge = (from: string, to: string, typeOnly: boolean) => {
    const key = `${from}\0${to}`;
    const edge = edges.get(key);
    if (edge) {
      edge.weight++;
      edge.typeOnly &&= typeOnly;
    } else edges.set(key, {from, to, weight: 1, typeOnly});
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
    addEdge(from, to, typeOnly);
  }

  // ---- the most connected outside clusters, and the most used external packages
  const outsideWeight = new Map<string, number>();
  for (const edge of edges.values()) {
    for (const end of [edge.from, edge.to]) if (!draft.nodes.has(end)) outsideWeight.set(end, (outsideWeight.get(end) ?? 0) + edge.weight);
  }
  const keptOutside = [...outsideWeight].sort((a, b) => b[1] - a[1] || byText(a[0], b[0])).slice(0, MAX_OUTSIDE_NODES);
  for (const [id] of keptOutside) draft.outside.set(id, {id, label: id, sub: 'outside', kind: 'cluster', slotKey: id, fanIn: 0, fanOut: 0});
  const externals = [...externalUse].map(([id, uses]) => ({id, uses, files: [...uses.values()].reduce((sum, n) => sum + n, 0)}))
    .sort((a, b) => b.files - a.files || byText(a.id, b.id)).slice(0, MAX_EXTERNAL_NODES);
  for (const external of externals) {
    draft.externals.set(external.id, {id: external.id, label: external.id.slice(4), kind: 'external', fanIn: external.uses.size, fanOut: 0});
    for (const [from, weight] of external.uses) edges.set(`${from}\0${external.id}`, {from, to: external.id, weight, typeOnly: false});
  }
  const known = (id: string) => draft.nodes.has(id) || draft.outside.has(id) || draft.externals.has(id);
  draft.edges = [...edges.values()].filter(edge => known(edge.from) && known(edge.to));

  // ---- module details: where a click on the cluster should land, and a line of size
  if (level === 'module') {
    for (const [id, node] of draft.nodes) {
      node.sub = `${plural(node.files ?? 0, 'file')}, ${compact(node.loc ?? 0)} loc`;
      const files = members.get(id) ?? [];
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

function finish(draft: Draft, model: RepoModel, scope: Scope, repoName: string, ref: SourceRef, budget: number): Finished {
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
    : findCycles(edges.filter(edge => !edge.typeOnly && draft.nodes.has(edge.from) && draft.nodes.has(edge.to)).map(edge => [edge.from, edge.to] as const));
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
    node.label = dir === '' ? (rest ? '(root)' : repoName) : rest ? `${short}/*` : short;
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
  edges.sort((a, b) => b.weight - a.weight || byText(a.from, b.from) || byText(a.to, b.to));
  if (edges.length > MAX_EDGES) {
    truncated ??= {total: edges.length, returned: MAX_EDGES, strategy: 'topN', by: 'weight'};
    edges = edges.slice(0, MAX_EDGES);
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
    ...(!edge.typeOnly && cycleOf.has(edge.from) && cycleOf.get(edge.from) === cycleOf.get(edge.to) ? {cycle: true} : {}),
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
    `${plural(graph.nodes.length, 'node')} ${plural(graph.edges.length, 'edge')}, ${plural(finished.cycles, 'cycle')}`,
    `level ${graph.level}`,
    ...(scope.label !== '' && draft.leaving > 0 ? [`${plural(draft.leaving, 'import')} out of ${scope.label}`] : []),
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

export function depsSources(): Source[] {
  const modules = define('deps.modules', async (ctx, ref, _signal, meta) => {
    const model = await repoModel(ctx);
    const target = scopeOf(ref);
    const scope = scopeFor(model, target);
    const files = target === '' ? model.files : model.files.filter(file => scope.hasFile(file.path));
    if (target !== '' && files.length === 0) throw new SourceError('E_TARGET', `${meta.name}: no files under "${target}"`);
    if (model.byPath.has(target)) throw new SourceError('E_TARGET', `${meta.name}: "${target}" is a file; use deps.files ${target}`);
    const sources = files.filter(file => sourceLines(file) > 0).length;
    const cut = target === ''
      ? model.cut
      : cutModules(files.map(file => ({path: file.path, weight: sourceLines(file)})), {root: parseModuleId(target).dir, manifestDirs: new Set(model.manifests.packages.map(pkg => pkg.dir))});
    // Clusters are for telling parts apart; a scope that is one cluster, or small, is clearer file by file.
    const level = cut.ids.length <= 1 || (target !== '' && sources <= FILE_LEVEL_FILES) ? 'file' : 'module';
    const draft = buildDraft(model, scope, cut, level);
    const finished = finish(draft, model, scope, ctx.name, ref, meta.budget);
    const warnings = graphWarnings(model);
    if (sources === 0 && files.length > 0) warnings.push(`no source files under "${target || '.'}": nothing to draw`);
    return graphResult(finished, draft, scope, warnings);
  });

  const filesGraph = define('deps.files', async (ctx, ref, _signal, meta) => {
    const model = await repoModel(ctx);
    const target = scopeOf(ref);
    if (target === '') throw new SourceError('E_TARGET', `${meta.name} needs a file path, e.g. ${meta.name} src/index.ts`);
    const focus = model.byPath.get(target);
    if (!focus) {
      const isDir = model.files.some(file => inScope(file.path, target));
      throw new SourceError('E_TARGET', isDir ? `${meta.name}: "${target}" is a directory; use deps.modules ${target}` : `${meta.name}: no such file "${target}"`);
    }
    const depth = depthOf(ref) ?? 1;
    // Hops over file-to-file imports in both directions. An import of a package reaches the package directory, and
    // every file importing the package of a reached file is an importer of that file.
    const reached = new Set<string>([target]);
    let frontier = new Set<string>([target]);
    let cappedAt: number | undefined;
    const externals = new Set<string>();
    for (let hop = 0; hop < depth && frontier.size > 0; hop++) {
      const next = new Set<string>();
      const packages = new Set([...frontier].filter(path => model.byPath.has(path)).map(dirName));
      for (const link of model.links) {
        const kind = targetKind(model, link);
        if (kind === 'ext') {
          if (link.from === target) externals.add(link.to);
          continue;
        }
        if (frontier.has(link.from) && !reached.has(link.to)) next.add(link.to);
        if ((frontier.has(link.to) || (kind === 'dir' && packages.has(link.to))) && !reached.has(link.from)) next.add(link.from);
      }
      const before = reached.size;
      for (const path of [...next].sort()) {
        if (reached.size >= meta.budget - MAX_EXTERNAL_NODES) {
          cappedAt ??= before + next.size;
          break;
        }
        reached.add(path);
      }
      frontier = next;
    }
    const scope: Scope = {label: '', hasFile: path => reached.has(path), hasDir: dir => reached.has(dir)};
    const draft: Draft = {level: 'file', nodes: new Map(), outside: new Map(), externals: new Map(), edges: [], leaving: 0};
    for (const id of reached) draft.nodes.set(id, model.byPath.has(id) ? fileNode(model, id) : packageNode(model, id));
    const home = dirName(target);
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
      // An import of the focus file's package is an import of the focus file.
      else if (kind === 'dir' && link.to === home) to = target;
      if (to === undefined || to === link.from || seen.has(`${link.from}\0${to}`)) continue;
      seen.add(`${link.from}\0${to}`);
      draft.edges.push({from: link.from, to, weight: 1, typeOnly: link.kind === 'type'});
    }
    const finished = finish(draft, model, scope, ctx.name, {...ref, args: {}}, meta.budget);
    // The focus file leads, so a reader of the data finds it first.
    finished.graph.nodes.sort((a, b) => Number(b.id === target) - Number(a.id === target));
    if (cappedAt !== undefined) finished.truncated = {total: cappedAt, returned: finished.graph.nodes.length, strategy: 'neighborhood', by: target};
    const imports = finished.graph.edges.filter(edge => edge.from === target).length;
    const importers = finished.graph.edges.filter(edge => edge.to === target).length;
    const warnings = graphWarnings(model);
    if (finished.graph.nodes.some(node => node.kind === 'package')) warnings.push('imports of a whole package are drawn to the package directory');
    return graphResult(finished, draft, scope, warnings, [`${baseName(target)} imports ${imports}, imported by ${importers}`]);
  });

  const cycles = define('deps.cycles', async (ctx, ref, _signal, meta) => {
    const model = await repoModel(ctx);
    const rows: Rows = model.cycles.map((members, index) => ({
      id: index + 1,
      size: members.length,
      members: members.slice(0, MAX_CYCLE_MEMBERS).join(', ') + (members.length > MAX_CYCLE_MEMBERS ? `, +${members.length - MAX_CYCLE_MEMBERS} more` : ''),
    }));
    const largest = model.cycles[0];
    const lead = largest ? `largest ${plural(largest.length, 'file')}: ${largest.slice(0, 3).join(', ')}` : 'no import cycles';
    return rowsResult(meta, ref, rows, {by: 'size', lead, warnings: unparsedWarning(model)});
  });

  const external = define('deps.external', async (ctx, ref, _signal, meta) => {
    const model = await repoModel(ctx);
    const packages = new Map<string, {package: string; ecosystem: string; importers: number}>();
    for (const link of model.links) {
      if (!link.to.startsWith('ext:')) continue;
      const ecosystem = ecosystemOf(model.byPath.get(link.from)?.lang);
      const key = `${ecosystem}\0${link.to}`;
      const entry = packages.get(key) ?? {package: link.to.slice(4), ecosystem, importers: 0};
      entry.importers++;
      packages.set(key, entry);
    }
    const rows: Rows = [...packages.values()].sort((a, b) => b.importers - a.importers || byText(a.package, b.package))
      .map(entry => ({package: entry.package, importers: entry.importers, ecosystem: entry.ecosystem}));
    const first = rows[0];
    return rowsResult(meta, ref, rows, {by: 'importers', ...(first ? {lead: `top ${String(first.package)} ${plural(Number(first.importers), 'importer')}`} : {}), warnings: unparsedWarning(model)});
  });

  const matrix = define('deps.matrix', async (ctx, ref, _signal, meta) => {
    const model = await repoModel(ctx);
    const modules = new Set(model.cut.ids);
    const weights = new Map<string, {from: string; to: string; weight: number}>();
    for (const link of model.links) {
      const kind = targetKind(model, link);
      if (kind === 'ext') continue;
      const from = model.cut.moduleOf(link.from);
      const to = kind === 'file' ? model.cut.moduleOf(link.to) : model.cut.moduleOfDir(link.to);
      if (from === to || !modules.has(from) || !modules.has(to)) continue;
      const key = `${from}\0${to}`;
      const entry = weights.get(key) ?? {from, to, weight: 0};
      entry.weight++;
      weights.set(key, entry);
    }
    const rows: Rows = [...weights.values()].sort((a, b) => b.weight - a.weight || byText(a.from, b.from) || byText(a.to, b.to));
    const first = rows[0];
    return rowsResult(meta, ref, rows, {
      by: 'weight',
      lead: first ? `${plural(modules.size, 'module')}; heaviest ${String(first.from)} -> ${String(first.to)} ${String(first.weight)}` : `${plural(modules.size, 'module')}, no imports between them`,
    });
  });

  return [modules, filesGraph, cycles, external, matrix];
}
