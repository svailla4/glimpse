// packages/server/src/code/outline.ts
// The outline of one file. Symbols are found once, by the repository index (the same scan that feeds code.symbols
// and the import graph), so an outline and a symbols dataset never disagree; this module looks the file up and
// returns clean, ordered rows.
import type {OutlineResult, SymbolRow} from '@glimpse/catalog';
import {canonicalPath, SourceError, type RepoContext} from '../contracts.ts';
import {repoPath} from './file.ts';

const KINDS: ReadonlySet<string> = new Set<SymbolRow['kind']>(['fn', 'class', 'method', 'type', 'iface', 'const', 'var', 'enum', 'mod', 'heading']);

function isSymbol(value: unknown): value is SymbolRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<SymbolRow>;
  return typeof row.name === 'string' && row.name !== '' && typeof row.kind === 'string' && KINDS.has(row.kind) && Number.isInteger(row.line) && row.line! > 0;
}

export async function outlineOf(ctx: RepoContext, path: string): Promise<OutlineResult> {
  const clean = repoPath(path);
  if (clean === null || clean === '') throw new SourceError('E_TARGET', 'outline needs the path of a file inside the repository');
  // 'readme.md' asks for README.md on a case-insensitive file system: the scan knows the file by its name on disk (V071)
  const [named, facts] = await Promise.all([canonicalPath(ctx.index, clean), ctx.index.facts()]);
  const symbols = (facts.get(named)?.symbols ?? [])
    .filter(isSymbol)
    .map(symbol => ({...symbol, depth: Number.isInteger(symbol.depth) && symbol.depth > 0 ? symbol.depth : 0, exported: symbol.exported === true}))
    .sort((a, b) => a.line - b.line);
  return {path: named, symbols};
}
