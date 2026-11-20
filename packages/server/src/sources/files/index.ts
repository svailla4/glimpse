// The files.*, repo.*, deps.* and code.* sources (15), each carrying its SourceMeta from @glimpse/catalog.
// Argument rules (packages/catalog/src/sources.ts): every rows source honours top=N, a source judges its own target
// and argument values (SourceError E_TARGET / E_ARGS) and ignores argument names it does not know.
import type {Source} from '../../contracts.ts';
import {codeSources} from './code.ts';
import {depsSources} from './deps.ts';
import {filesSources} from './files.ts';
import {repoSources} from './repo.ts';
import type {SourceOptions} from './shared.ts';

/** Builds the sources; tests pass a fixed clock so ages and the 30-day window do not drift. */
export function createFilesSources(options: Partial<SourceOptions> = {}): Source[] {
  const resolved: SourceOptions = {now: options.now ?? Date.now};
  return [...filesSources(resolved), ...repoSources(resolved), ...depsSources(), ...codeSources()];
}

export const sources: Source[] = createFilesSources();
