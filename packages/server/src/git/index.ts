// packages/server/src/git/index.ts  (stub by WP0; owned by WP3)
// WP3 replaces this file. Frozen signatures:
//   readGitInfo(root: string, runGit: RunGit): Promise<GitInfo | null>      null outside a git repository
//   createDiffService(ctx: RepoContext, code: CodeService): DiffService
//   createTreeWatcher(ctx: RepoContext): TreeWatcher
// The stubs are inert rather than throwing, so the server core runs before WP3 lands: no git information (git.* and
// diff.* answer E_NO_GIT), a diff service that rejects, and a watcher that never fires.
import {SourceError, type CodeService, type DiffService, type GitInfo, type RepoContext, type RunGit, type TreeWatcher} from '../contracts.ts';

export function readGitInfo(_root: string, _runGit: RunGit): Promise<GitInfo | null> {
  return Promise.resolve(null);
}

export function createDiffService(_ctx: RepoContext, _code: CodeService): DiffService {
  return {
    diff: () => Promise.reject(new SourceError('E_INTERNAL', 'not implemented: DiffService.diff')),
  };
}

export function createTreeWatcher(_ctx: RepoContext): TreeWatcher {
  return {
    start: () => {},
    stop: () => {},
  };
}
