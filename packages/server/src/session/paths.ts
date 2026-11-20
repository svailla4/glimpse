// The one place that decides whether a path from the viewer or the model stays inside the project root (design 2.8).
import {realpath} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';

const inside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
};

/** Realpath of the deepest existing ancestor of `target` (the path itself when it exists). */
async function existingRealpath(target: string): Promise<string | undefined> {
  for (let current = target; ; current = dirname(current)) {
    try {
      return await realpath(current);
    } catch {
      if (dirname(current) === current) return undefined;
    }
  }
}

/**
 * Absolute path of a repo-relative path, or undefined when it is absolute, malformed, or leaves the root, either
 * lexically (`../x`) or through a symlink. A path that does not exist is judged by its deepest existing directory,
 * so a symlinked directory cannot lead outside either. `root` must already be a realpath.
 */
export async function resolveInside(root: string, path: string): Promise<string | undefined> {
  if (typeof path !== 'string' || path === '' || path.includes('\u0000') || isAbsolute(path) || /^[A-Za-z]:/.test(path)) return undefined;
  const target = resolve(root, path);
  if (!inside(root, target) || inGitDir(root, target)) return undefined;
  const real = await existingRealpath(target);
  return real !== undefined && inside(root, real) && !inGitDir(root, real) ? target : undefined;
}

/** True for the repository's own `.git` (a directory, or the file a worktree has) and everything under it. */
function inGitDir(root: string, target: string): boolean {
  return relative(root, target).split(sep)[0]?.toLowerCase() === '.git';
}

/** A repo-relative path as the inventory writes it: forward slashes, no `./`, no `#L10` anchor. */
export function repoRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

/** A change range git accepts and that cannot be read as an option (design 2.8). */
export function isSafeRange(range: string): boolean {
  return range.length <= 200 && !range.startsWith('-') && /^[\w./~^@{}-]+(\.\.\.?[\w./~^@{}-]+)?$/.test(range);
}
