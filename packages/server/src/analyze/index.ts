// The repository index: inventory, facts, import edges and the module cut, memoized until invalidate().
// Frozen signature (contracts.ts): createRepoIndex(root, runGit, log): RepoIndex.
import {basename} from 'node:path';
import type {FileEntry, FileFacts, ImportEdge, RepoContext, RepoIndex, RunGit} from '../contracts.ts';
import type {ScannedFacts} from './facts.ts';
import {isListed, listFiles, scanFiles, type Scan, type ScanRecord} from './inventory.ts';
import {isTestPath, languageOf} from './languages.ts';
import {buildModel, expandLinks, manifestsOf, type RepoModel} from './model.ts';
import {resolveImports} from './resolve.ts';

export type {RepoModel} from './model.ts';

interface Revision {
  scan: Promise<Scan>;
  paths?: Promise<ReadonlySet<string>>;
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
    has: async path => {
      const clean = normalize(path);
      const mine = current();
      mine.paths ??= mine.scan.then(scan => new Set(scan.entries.map(entry => entry.path)));
      if ((await mine.paths).has(clean)) return true;
      // Not in the scan: either not a file of the project, or one created since. Git (or the walk's rules) decides.
      return isListed(root, runGit, (await mine.scan).source, clean);
    },
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
