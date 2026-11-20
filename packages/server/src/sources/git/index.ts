// packages/server/src/sources/git/index.ts
// The git.* and diff.* sources, in catalog order. Each takes its `meta` from SOURCE_BY_NAME, so names never drift.
import type {Source} from '../../contracts.ts';
import {createDiffSources} from './diff.ts';
import {createGitSources} from './git.ts';

export const sources: Source[] = [...createGitSources(), ...createDiffSources()];
