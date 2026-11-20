// packages/server/src/sources/all.ts  (WP0, final)
// The production registry: every runnable source, by name. The two chunks come from ./files/index.ts (files.*,
// repo.*, deps.*, code.*) and ./git/index.ts (git.*, diff.*); this file never changes when a source is added, only
// their `sources` arrays do.
// Importing this module loads all analyzer and git code. Only the composition root (src/main.ts) and the shared
// gate test (test/sources/all.test.ts) import it; other modules and tests take a SourceRegistry from ./registry.ts
// as a parameter.
import {sources as filesSources} from './files/index.ts';
import {sources as gitSources} from './git/index.ts';
import {createRegistry, type SourceRegistry} from './registry.ts';

export const REGISTRY: SourceRegistry = createRegistry([...filesSources, ...gitSources]);
