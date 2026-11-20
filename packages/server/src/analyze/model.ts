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
  /** File-level import cycles, largest first. Type-only imports and package-level imports do not make a cycle. */
  cycles: string[][];
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

export function buildModel(
  parts: {files: FileEntry[]; facts: ReadonlyMap<string, FileFacts>; links: ImportEdge[]; manifests: Manifests; warnings: string[]; imports?: number; unresolved?: number},
): RepoModel {
  const {files, facts, links, manifests} = parts;
  const byPath = new Map(files.map(file => [file.path, file]));
  const cut = cutModules(files.map(file => ({path: file.path, weight: sourceLines(file)})), {manifestDirs: new Set(manifests.packages.map(pkg => pkg.dir))});
  const runtime: Array<[string, string]> = [];
  for (const edge of links) if (edge.kind !== 'type' && byPath.has(edge.to)) runtime.push([edge.from, edge.to]);
  return {
    files, byPath, facts, links, manifests, cut, cycles: findCycles(runtime),
    ...(parts.imports !== undefined ? {imports: parts.imports, unresolved: parts.unresolved ?? 0} : {}),
    warnings: [...parts.warnings, ...manifests.warnings],
  };
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
      edges.push({from: link.from, to: largest.path, kind: 'import'});
      sampled++;
      continue;
    }
    expanded += members.length;
    for (const member of members) edges.push({from: link.from, to: member.path, kind: 'import'});
  }
  return {edges, sampled};
}
