// The one place that decides whether a path from the viewer or the model stays inside the project root (design 2.8),
// and where the programs Glimpse starts (git, an editor) may come from.
import {accessSync, constants, realpathSync, statSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {delimiter, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';

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

/**
 * Finding V019: the PATH entries a program may be looked up in. Only absolute directories that are not inside the
 * project: a relative entry (`.`, `node_modules/.bin`) resolves against whatever directory a child runs in, which is
 * the project for git, and a directory of the project is the repository's to fill. `root` must be a realpath.
 */
export function trustedPath(env: NodeJS.ProcessEnv, root: string): string[] {
  const out: string[] = [];
  for (const dir of (Object.hasOwn(env, 'PATH') ? env.PATH ?? '' : '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    if (!inside(root, real) && !inside(root, dir) && !out.includes(dir)) out.push(dir);
  }
  return out;
}

/** The absolute path of an executable named `name` in a trusted PATH directory (trustedPath), or undefined. */
export function findProgram(name: string, env: NodeJS.ProcessEnv, root: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (name === '' || name.includes('/') || name.includes('\\')) return undefined;
  const extensions = platform === 'win32' ? (Object.hasOwn(env, 'PATHEXT') ? env.PATHEXT ?? '' : '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of trustedPath(env, root)) {
    for (const extension of extensions) {
      const candidate = join(dir, name + extension);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/** A change range git accepts and that cannot be read as an option (design 2.8). */
export function isSafeRange(range: string): boolean {
  return range.length <= 200 && !range.startsWith('-') && /^[\w./~^@{}-]+(\.\.\.?[\w./~^@{}-]+)?$/.test(range);
}
