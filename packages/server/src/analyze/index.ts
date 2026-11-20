// The repository index: inventory, facts, import edges and the module cut, memoized until invalidate().
// Frozen signature (contracts.ts): createRepoIndex(root, runGit, log): RepoIndex.
import {basename} from 'node:path';
import type {FileFacts, ImportEdge, RepoContext, RepoIndex, RunGit} from '../contracts.ts';
import type {ScannedFacts} from './facts.ts';
import {listFiles, scanFiles, type Scan, type ScanRecord} from './inventory.ts';
import {buildModel, expandLinks, manifestsOf, type RepoModel} from './model.ts';
import {resolveImports} from './resolve.ts';

export type {RepoModel} from './model.ts';

interface Revision {
  scan: Promise<Scan>;
  model?: Promise<RepoModel>;
  edges?: Promise<ImportEdge[]>;
}

/** Models of indexes built here, so the sources reuse them instead of deriving their own. */
const OWN = new WeakMap<RepoIndex, () => Promise<RepoModel>>();
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
    invalidate: () => {
      revision = undefined;
    },
  };
  OWN.set(index, model);
  return index;
}

/**
 * The derived model for a context. With an index from createRepoIndex this is the memoized model behind it; with any
 * other RepoIndex it is rebuilt from files(), facts() and edges() whenever files() returns a new array.
 */
export async function repoModel(ctx: Pick<RepoContext, 'index' | 'root' | 'name'>): Promise<RepoModel> {
  const own = OWN.get(ctx.index);
  if (own) return own();
  const files = await ctx.index.files();
  const cached = DERIVED.get(ctx.index);
  if (cached && cached.files === files) return cached.model;
  const model = Promise.all([ctx.index.facts(), ctx.index.edges()]).then(([facts, links]: [ReadonlyMap<string, FileFacts>, ImportEdge[]]) =>
    buildModel({files, facts, links, manifests: manifestsOf(ctx.root, ctx.name, files), warnings: []}));
  DERIVED.set(ctx.index, {files, model});
  return model;
}
