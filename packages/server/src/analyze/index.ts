// packages/server/src/analyze/index.ts  (stub by WP0; owned by WP2)
// WP2 replaces this file. Frozen signature:
//   createRepoIndex(root: string, runGit: RunGit, log: (message: string) => void): RepoIndex
// The stub builds an index whose queries reject with SourceError('E_INTERNAL', 'not implemented'), so creating the
// index (which the server does while warming up) is safe and only the sources that need it fail.
import {SourceError, type RepoIndex, type RunGit} from '../contracts.ts';

const notImplemented = (what: string) => Promise.reject(new SourceError('E_INTERNAL', `not implemented: ${what}`));

export function createRepoIndex(_root: string, _runGit: RunGit, _log: (message: string) => void): RepoIndex {
  return {
    files: () => notImplemented('RepoIndex.files'),
    facts: () => notImplemented('RepoIndex.facts'),
    edges: () => notImplemented('RepoIndex.edges'),
    moduleOf: () => notImplemented('RepoIndex.moduleOf'),
    invalidate: () => {},
  };
}
