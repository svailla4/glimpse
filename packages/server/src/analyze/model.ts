// Everything the sources derive from the index, computed once per working-tree revision: manifests, the module cut,
// cycles and lookup maps. Built by the real index (analyze/index.ts), or from any RepoIndex through its contract.
import {readFileSync} from 'node:fs';
import type {FileEntry, FileFacts, ImportEdge} from '../contracts.ts';
import {cutModules, findCycles, type ModuleCut} from './cluster.ts';
import {MAX_READ_BYTES} from './inventory.ts';
import {dirName, languageOf} from './languages.ts';
import {readManifests, type Manifests} from './manifests.ts';

export interface RepoModel {
  files: FileEntry[];
  byPath: ReadonlyMap<string, FileEntry>;
  facts: ReadonlyMap<string, FileFacts>;
  /**
   * Import edges as resolved: `to` is a file, 'ext:<package>', or a directory for imports that name a whole package
   * (Go, C#, Swift, JVM wildcards). RepoIndex.edges() is this list with the directory targets expanded to files.
   */
  links: ImportEdge[];
  manifests: Manifests;
  cut: ModuleCut;
  /**
   * File-level import cycles, largest first. Only imports that run when a file loads make a cycle: type-only imports,
   * lazy `import()` calls (the way code is split on purpose) and package-level imports do not.
   */
  cycles: string[][];
  /**
   * How many modules the repository has: the clusters of the same cut deps.modules and deps.matrix draw, before any
   * cap on how many a plate shows (`cut` folds the smaller ones into rest clusters; this count does not). A module
   * graph of the repository says "20 of <modules>", and the Modules KPI is this number.
   */
  modules: number;
  /** Import statements seen and how many of them matched nothing; undefined when the index was not built here. */
  imports?: number;
  unresolved?: number;
  warnings: string[];
}

/** Lines that count as code: generated and binary files contribute none. */
export function codeLines(file: FileEntry): number {
  return file.generated || file.binary ? 0 : file.loc;
}

/** Lines that count toward module weight: code lines of programming-language files. */
export function sourceLines(file: FileEntry): number {
  return languageOf(file.path)?.kind === 'code' ? codeLines(file) : 0;
}

/** What an edge points at. */
export function targetKind(model: Pick<RepoModel, 'byPath'>, edge: ImportEdge): 'file' | 'dir' | 'ext' {
  return edge.to.startsWith('ext:') ? 'ext' : model.byPath.has(edge.to) ? 'file' : 'dir';
}

export function manifestsOf(root: string, name: string, files: readonly FileEntry[]): Manifests {
  const sizes = new Map(files.map(file => [file.path, file.bytes]));
  return readManifests(files.map(file => file.path), path => {
    if ((sizes.get(path) ?? 0) > MAX_READ_BYTES) return undefined;
    try {
      return readFileSync(`${root}/${path}`, 'utf8');
    } catch {
      return undefined;
    }
  }, name);
}

/** Packages that are projects of their own: a Makefile declares scripts, not a package. */
export function declaredPackages(manifests: Manifests): Manifests['packages'] {
  return manifests.packages.filter(pkg => pkg.ecosystem !== 'make');
}

/**
 * The packages of a path scope ('' for the repository): those whose manifest lies under it; when it holds none, the
 * nearest enclosing ones, i.e. the package the path belongs to (`enclosing` is then true). repo.packages,
 * repo.scripts and repo.stack read a path this way.
 */
export function packagesOf<T extends {dir: string}>(packages: readonly T[], scope: string): {packages: T[]; enclosing: boolean} {
  if (scope === '') return {packages: [...packages], enclosing: false};
  const inside = packages.filter(pkg => pkg.dir === scope || pkg.dir.startsWith(`${scope}/`));
  if (inside.length > 0) return {packages: inside, enclosing: false};
  const encloses = (dir: string) => dir === '' || scope.startsWith(`${dir}/`);
  const nearest = Math.max(-1, ...packages.filter(pkg => encloses(pkg.dir)).map(pkg => pkg.dir.length));
  return {packages: packages.filter(pkg => encloses(pkg.dir) && pkg.dir.length === nearest), enclosing: true};
}

/** Directories with a manifest: the boundaries every module cut prefers. */
export function manifestDirsOf(manifests: Manifests): ReadonlySet<string> {
  return new Set(manifests.packages.map(pkg => pkg.dir));
}

/**
 * The modules under `root` ('' for the repository) as every module cut groups them, with no cap on their number: the
 * count a capped graph of that scope is a cut of.
 */
export function countModules(files: readonly FileEntry[], manifests: Manifests, root = ''): number {
  return cutModules(files.map(file => ({path: file.path, weight: sourceLines(file)})), {root, manifestDirs: manifestDirsOf(manifests), unbounded: true}).ids.length;
}

export function buildModel(
  parts: {files: FileEntry[]; facts: ReadonlyMap<string, FileFacts>; links: ImportEdge[]; manifests: Manifests; warnings: string[]; imports?: number; unresolved?: number},
): RepoModel {
  const {files, facts, links, manifests} = parts;
  const byPath = new Map(files.map(file => [file.path, file]));
  const cut = cutModules(files.map(file => ({path: file.path, weight: sourceLines(file)})), {manifestDirs: manifestDirsOf(manifests)});
  const runtime: Array<[string, string]> = [];
  for (const edge of links) if (edge.kind !== 'type' && edge.kind !== 'dynamic' && !isPackageImport(edge) && byPath.has(edge.to)) runtime.push([edge.from, edge.to]);
  return {
    files, byPath, facts, links, manifests, cut, cycles: findCycles(runtime), modules: countModules(files, manifests),
    ...(parts.imports !== undefined ? {imports: parts.imports, unresolved: parts.unresolved ?? 0} : {}),
    warnings: [...parts.warnings, ...manifests.warnings],
  };
}

/** True for an edge that names a whole package (Go, C#, JVM wildcards) or module tree (Swift) instead of one file. */
export function isPackageImport(edge: Pick<ImportEdge, 'kind'>): boolean {
  return edge.kind === 'package' || edge.kind === 'module';
}

/**
 * Whether an import of a package reaches `file`: a source file of the importer's language (tests and generated
 * files aside) directly in the package directory, or anywhere beneath it when the import names a module tree.
 * This is the one rule: expandLinks (RepoIndex.edges, diff.impact) and deps.files both apply it.
 */
export function packageMember(model: Pick<RepoModel, 'byPath'>, link: ImportEdge, file: FileEntry): boolean {
  if (file.isTest || file.generated || file.binary || file.path === link.from) return false;
  if (file.lang !== model.byPath.get(link.from)?.lang) return false;
  return link.kind === 'module' ? file.path.startsWith(`${link.to}/`) : dirName(file.path) === link.to;
}

/** Cap on edges produced by expanding package imports; past it a package is represented by its largest file. */
const MAX_EXPANDED_EDGES = 300_000;

/**
 * File-to-file form of the links, for consumers that match edges by file path: an import of a package becomes one
 * edge to every source file of that package in the importer's language (tests and generated files aside).
 */
export function expandLinks(model: Pick<RepoModel, 'links' | 'files' | 'byPath'>): {edges: ImportEdge[]; sampled: number} {
  const direct = new Map<string, FileEntry[]>();
  for (const file of model.files) {
    if (file.isTest || file.generated || file.binary) continue;
    const dir = dirName(file.path);
    const list = direct.get(dir);
    if (list) list.push(file);
    else direct.set(dir, [file]);
  }
  const trees = new Map<string, FileEntry[]>();
  const tree = (dir: string) => {
    let list = trees.get(dir);
    if (!list) {
      list = model.files.filter(file => !file.isTest && !file.generated && !file.binary && file.path.startsWith(`${dir}/`));
      trees.set(dir, list);
    }
    return list;
  };
  const edges: ImportEdge[] = [];
  let expanded = 0;
  let sampled = 0;
  for (const link of model.links) {
    if (targetKind(model, link) !== 'dir') {
      edges.push(link);
      continue;
    }
    const lang = model.byPath.get(link.from)?.lang;
    const members = (link.kind === 'module' ? tree(link.to) : (direct.get(link.to) ?? [])).filter(file => file.lang === lang && file.path !== link.from);
    if (members.length === 0) continue;
    if (expanded + members.length > MAX_EXPANDED_EDGES) {
      const largest = members.reduce((a, b) => (b.loc > a.loc ? b : a));
      edges.push({from: link.from, to: largest.path, kind: link.kind === 'module' ? 'module' : 'package'});
      sampled++;
      continue;
    }
    expanded += members.length;
    // The kind stays 'package' or 'module', so a consumer can tell "imports this file" from "imports its package".
    const kind = link.kind === 'module' ? 'module' : 'package';
    for (const member of members) edges.push({from: link.from, to: member.path, kind});
  }
  return {edges, sampled};
}
