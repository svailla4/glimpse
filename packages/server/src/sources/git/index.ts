// packages/server/src/sources/git/index.ts  (stub by WP0; owned by WP3)
// WP3 replaces this file. It must keep exporting `sources`: one Source per git.* and diff.* entry of SOURCES in
// @glimpse/catalog (11 in all), each with `meta` taken from SOURCE_BY_NAME so names never drift.
// Until then the registry answers those names with E_INTERNAL "not implemented" (see ../registry.ts).
// Argument rules are at the top of packages/catalog/src/sources.ts: every rows source honours `top=N`, a source
// judges its own target and argument values (SourceError E_TARGET / E_ARGS) and ignores argument names it does not know.
// git.log takes a path or a change range as its target. diff.files rows carry add, del and delta: {add, del} (DiffFileRow).
import type {Source} from '../../contracts.ts';

export const sources: Source[] = [];
