// The repository index: inventory, facts, import edges and the module cut, memoized until invalidate().
// Frozen signature (contracts.ts): createRepoIndex(root, runGit, log): RepoIndex.
import {realpathSync} from 'node:fs';
import {basename, sep} from 'node:path';
import type {FileEntry, FileFacts, ImportEdge, RepoContext, RepoIndex, RunGit} from '../contracts.ts';
import type {ScannedFacts} from './facts.ts';
import {isListed, listFiles, scanFiles, type Scan, type ScanRecord} from './inventory.ts';
import {isTestPath, languageOf} from './languages.ts';
import {buildModel, expandLinks, manifestsOf, type RepoModel} from './model.ts';
import {resolveImports} from './resolve.ts';

export type {RepoModel} from './model.ts';

/** The names of the scan: its files, and every directory that holds one ('' for the root). */
interface Names {
  files: ReadonlySet<string>;
  dirs: ReadonlySet<string>;
}

interface Revision {
  scan: Promise<Scan>;
  names?: Promise<Names>;
  model?: Promise<RepoModel>;
  edges?: Promise<ImportEdge[]>;
}

interface Own {
  model(): Promise<RepoModel>;
  /** Imports that would resolve to paths which are no longer files of the repository (see importersOfGone). */
  towards(gone: readonly string[]): Promise<ImportEdge[]>;
}

/** Models of indexes built here, so the sources reuse them instead of deriving their own. */
const OWN = new WeakMap<RepoIndex, Own>();
/** Models derived for an index built elsewhere (a test fake), keyed by the identity of its file list. */
const DERIVED = new WeakMap<RepoIndex, {files: unknown; model: Promise<RepoModel>}>();

const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');

/**
 * The repo-relative path as the file system spells it: the same path on a case-sensitive system, the stored case
 * of each segment on a case-insensitive one. Undefined when nothing is there, or when the path only reaches a file
 * through a symbolic link (its real path then differs by more than case): such a path is never a file of the project.
 */
export function canonicalCase(root: string, path: string): string | undefined {
  if (path === '' || path.includes('\0') || path.startsWith('/') || path.split('/').some(part => part === '..')) return undefined;
  let real: string;
  try {
    real = realpathSync.native(`${root}/${path}`);
  } catch {
    return undefined;
  }
  const base = realpathSync.native(root);
  if (!real.startsWith(`${base}/`)) return undefined;
  const named = real.slice(base.length + 1).split(sep).join('/');
  return named.toLowerCase() === path.toLowerCase() ? named : undefined;
}

export function createRepoIndex(root: string, runGit: RunGit, log: (message: string) => void): RepoIndex {
  const name = basename(root);
  // Per-file records outlive invalidate(): a rescan re-reads only the files whose size or times changed.
  const records = new Map<string, ScanRecord>();
  let revision: Revision | undefined;

  const current = (): Revision => {
    if (revision) return revision;
    const started = performance.now();
    const mine: Revision = {
      scan: listFiles(root, runGit, log).then(async listing => {
        const scan = await scanFiles(root, listing, records);
        log(`glimpse: indexed ${scan.entries.length} files in ${Math.round(performance.now() - started)} ms (${listing.source}, ${scan.reused} unchanged)`);
        return scan;
      }),
    };
    // A failed scan must not be remembered: the next call starts over.
    mine.scan.catch(() => {
      if (revision === mine) revision = undefined;
    });
    revision = mine;
    return mine;
  };

  const model = (): Promise<RepoModel> => {
    const mine = current();
    mine.model ??= mine.scan.then(scan => {
      const manifests = manifestsOf(root, name, scan.entries);
      const facts: ReadonlyMap<string, ScannedFacts> = scan.facts;
      const resolution = resolveImports(scan.entries, facts, manifests);
      return buildModel({files: scan.entries, facts, links: resolution.edges, manifests, warnings: scan.warnings, imports: resolution.imports, unresolved: resolution.unresolved});
    });
    return mine.model;
  };

  const namesOf = (mine: Revision): Promise<Names> => {
    mine.names ??= mine.scan.then(scan => {
      const files = new Set<string>();
      const dirs = new Set<string>(['']);
      for (const {path} of scan.entries) {
        files.add(path);
        for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
          const dir = path.slice(0, cut);
          if (dirs.has(dir)) break;
          dirs.add(dir);
        }
      }
      return {files, dirs};
    });
    return mine.names;
  };

  /** The inventory's name for a path and whether it is a file there; undefined when it names nothing of the project. */
  const lookup = async (path: string): Promise<{name: string; file: boolean} | undefined> => {
    const clean = normalize(path);
    const mine = current();
    const names = await namesOf(mine);
    if (names.files.has(clean)) return {name: clean, file: true};
    if (names.dirs.has(clean)) return {name: clean, file: false};
    // On a case-insensitive file system '.IDEA/x' and 'readme.md' name '.idea/x' and 'README.md': the question is
    // asked of the name the file has on disk, so a skipped directory stays skipped and a real file is found, and that
    // name is the one handed back (V071).
    const named = canonicalCase(root, clean);
    if (named === undefined) return undefined;
    if (names.files.has(named)) return {name: named, file: true};
    if (names.dirs.has(named)) return {name: named, file: false};
    // Not in the scan: either not a file of the project, or one created since. Git (or the walk's rules) decides.
    return (await isListed(root, runGit, (await mine.scan).source, named)) ? {name: named, file: true} : undefined;
  };

  const index: RepoIndex = {
    files: async () => (await current().scan).entries,
    facts: async () => (await current().scan).facts,
    edges: () => {
      const mine = current();
      mine.edges ??= model().then(built => {
        const {edges, sampled} = expandLinks(built);
        if (sampled > 0) log(`glimpse: ${sampled} package imports are represented by one file each (edge budget reached)`);
        return edges;
      });
      return mine.edges;
    },
    moduleOf: async path => (await model()).cut.moduleOf(normalize(path)),
    has: async path => (await lookup(path))?.file === true,
    canonical: async path => (await lookup(path))?.name,
    invalidate: () => {
      revision = undefined;
    },
  };
  OWN.set(index, {
    model,
    towards: async gone => {
      const [scan, built] = await Promise.all([current().scan, model()]);
      const wanted = new Set(gone.filter(path => !built.byPath.has(path)));
      if (wanted.size === 0) return [];
      // The scan's import statements are resolved again as if the vanished files were still there: whatever now
      // lands on one of them is an import that the change broke (or one that silently moved to another file).
      const ghosts: FileEntry[] = [...wanted].map(path => {
        const language = languageOf(path);
        return {path, ...(language ? {lang: language.name} : {}), loc: 0, sloc: 0, bytes: 0, binary: false, tracked: false, isTest: isTestPath(path), generated: false};
      });
      const files = [...scan.entries, ...ghosts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return resolveImports(files, scan.facts, built.manifests).edges.filter(edge => wanted.has(edge.to));
    },
  });
  return index;
}

/**
 * Imports that point at files which no longer exist: for each path in `gone` (deleted, or the old name of a renamed
 * file), the files of the working tree whose import statements would resolve to it. The current index has no such
 * edges (an import of a missing file resolves to nothing), yet these are the importers a deletion breaks. Empty for
 * an index that was not built by createRepoIndex.
 */
export async function importersOfGone(ctx: Pick<RepoContext, 'index'>, gone: readonly string[]): Promise<ImportEdge[]> {
  return gone.length === 0 ? [] : ((await OWN.get(ctx.index)?.towards(gone)) ?? []);
}

/**
 * The derived model for a context. With an index from createRepoIndex this is the memoized model behind it; with any
 * other RepoIndex it is rebuilt from files(), facts() and edges() whenever files() returns a new array.
 */
export async function repoModel(ctx: Pick<RepoContext, 'index' | 'root' | 'name'>): Promise<RepoModel> {
  const own = OWN.get(ctx.index);
  if (own) return own.model();
  const files = await ctx.index.files();
  const cached = DERIVED.get(ctx.index);
  if (cached && cached.files === files) return cached.model;
  const model = Promise.all([ctx.index.facts(), ctx.index.edges()]).then(([facts, links]: [ReadonlyMap<string, FileFacts>, ImportEdge[]]) =>
    buildModel({files, facts, links, manifests: manifestsOf(ctx.root, ctx.name, files), warnings: []}));
  DERIVED.set(ctx.index, {files, model});
  return model;
}
