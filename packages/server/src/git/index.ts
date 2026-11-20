// packages/server/src/git/index.ts
// Git behind the server seams: repository facts, the diff service and the working-tree watcher.
// Everything here talks to git through the RunGit it is handed; nothing spawns a process itself.
import type {GitInfo, RunGit} from '../contracts.ts';

export {createDiffService} from './diff.ts';
export {createTreeWatcher} from './watcher.ts';

/**
 * Branch, HEAD and shape of the repository at `root`; null when `root` is not inside a git working tree (or git is
 * not installed). `head` is the commit id abbreviated to seven characters (more only if that is ambiguous), absent
 * before the first commit; `branch` is absent on a detached HEAD; `defaultBranch` is a ref that resolves here: the
 * remote's default branch, else main or master.
 */
export async function readGitInfo(_root: string, runGit: RunGit): Promise<GitInfo | null> {
  const line = async (args: string[]): Promise<string | undefined> => {
    try {
      return (await runGit(args)).toString('utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  };
  if ((await line(['rev-parse', '--is-inside-work-tree'])) !== 'true') return null;

  const exists = async (ref: string): Promise<boolean> => (await line(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== undefined;
  const [shallow, head, branch, remoteHead] = await Promise.all([
    line(['rev-parse', '--is-shallow-repository']),
    line(['rev-parse', '--verify', '--quiet', '--short=7', 'HEAD']),
    line(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    line(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
  ]);

  let defaultBranch: string | undefined;
  const candidates = [...(remoteHead ? [remoteHead.replace(/^origin\//, ''), remoteHead] : []), 'main', 'master'];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      defaultBranch = candidate;
      break;
    }
  }

  return {
    shallow: shallow === 'true',
    ...(head ? {head} : {}),
    ...(branch ? {branch} : {}),
    ...(defaultBranch ? {defaultBranch} : {}),
  };
}
