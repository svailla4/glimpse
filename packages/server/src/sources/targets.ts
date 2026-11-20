// The spelling of a path a ref names. A model may write 'readme.md' for README.md; on a case-insensitive file system
// that is the same file, yet the inventory, the import graph and git's pathspecs know it only as README.md. Every
// source whose positional target is a path therefore reads the target under the inventory's name (V071).
import {formatFileLoc, parseFileLoc, type ParsedFileLoc, type SourceRef} from '@glimpse/catalog';
import {canonicalCase} from '../analyze/index.ts';
import type {RepoContext, Source} from '../contracts.ts';

/**
 * The file system answers first, and synchronously: a path spelled as on disk, or one that is not there (a range, a
 * deleted file, a module id), is no case variant and never waits for the index. Only a case variant is returned,
 * with its parsed anchor, for the inventory to name.
 */
function onDiskVariant(root: string, target: string): {loc: ParsedFileLoc; path: string} | undefined {
  const text = target.trim();
  if (!text) return undefined;
  const loc = parseFileLoc(text.replace(/\\/g, '/'));
  const path = loc.path.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (path === '' || path === '.') return undefined;
  const onDisk = canonicalCase(root, path);
  return onDisk === undefined || onDisk === path ? undefined : {loc, path};
}

/** True when `target` ('path' or 'path#L10-20') is spelled in another case than the file system has it. Synchronous. */
export function isCaseVariant(root: string, target: string): boolean {
  return onDiskVariant(root, target) !== undefined;
}

/**
 * `target` ('path' or 'path#L10-20') with its path under the name the inventory has for it, anchor kept. The text as
 * written when it already is that name, when it names nothing of the project (whoever reads it reports that as it
 * always has), or when the index has no canonical() (a hand-written fake). The inventory also refuses a variant that
 * leads into a skipped tree ('.GIT/config', 'NODE_MODULES/x').
 */
export async function canonicalTarget(ctx: RepoContext, target: string): Promise<string> {
  if (!ctx.index.canonical) return target;
  const variant = onDiskVariant(ctx.root, target);
  if (!variant) return target;
  const name = await ctx.index.canonical(variant.path).catch(() => undefined);
  return name === undefined || name === variant.path ? target : formatFileLoc({...variant.loc, path: name});
}

/** The ref with its path target under the name the inventory has for it (canonicalTarget); unchanged otherwise. */
export async function canonicalRef(ctx: RepoContext, ref: SourceRef): Promise<SourceRef> {
  if (!ref.target) return ref;
  const target = await canonicalTarget(ctx, ref.target);
  return target === ref.target ? ref : {...ref, target};
}

/** A source whose target is a path, made to read it under the inventory's name. Other sources are returned as they are. */
export function withCanonicalTarget(source: Source): Source {
  const kind = source.meta.target;
  if (kind !== 'path' && kind !== 'path|range') return source;
  return {meta: source.meta, run: async (ctx, ref, signal) => source.run(ctx, await canonicalRef(ctx, ref), signal)};
}
