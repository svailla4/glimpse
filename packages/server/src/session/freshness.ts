// A look at HEAD and the working tree that needs no tab and no watcher (decision fresh-tree-every-call). The session asks the injected
// TreeWatcher first (`check()`); this is what it falls back to when the watcher has no such call, so tool results can
// never be stale for want of one. Everything goes through the RunGit the session owns; without git the directory is
// walked. A stamp is a digest: two equal stamps mean nothing a source reads has changed.
import {createHash} from 'node:crypto';
import {lstat, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {RunGit} from '../contracts.ts';

const STAT_PARALLEL = 64;
/** Changed or untracked paths whose size and time are part of the stamp; beyond that the list itself has to do. */
const MAX_STAMPED = 4000;
/** Entries a walk of a directory without git looks at. */
const MAX_WALKED = 20_000;
const SKIPPED_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', '.hg', '.svn', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__']);

async function stamp(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return 'gone';
  }
}

async function stampAll(root: string, paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < paths.length; i += STAT_PARALLEL) {
    out.push(...(await Promise.all(paths.slice(i, i + STAT_PARALLEL).map(async path => `${path}:${await stamp(join(root, path))}`))));
  }
  return out;
}

/** HEAD, the branch, and every staged, modified or untracked path under the root with its size and time. */
async function gitStamp(root: string, runGit: RunGit, signal?: AbortSignal): Promise<string[]> {
  const [head, status] = await Promise.all([
    runGit(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], signal ? {signal} : undefined).then(out => out.toString('utf8').trim().replace(/\s+/g, ' '), () => 'unborn'),
    runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], signal ? {signal} : undefined),
  ]);
  const entries = status.toString('utf8').split('\0').filter(Boolean);
  // `XY path`; the second half of a rename entry is the bare old path.
  const paths = [...new Set(entries.map(entry => (/^[ MADRCUT?!]{2} /.test(entry) ? entry.slice(3) : entry)))].sort();
  return [head, ...entries, ...(await stampAll(root, paths.slice(0, MAX_STAMPED)))];
}

/** Without git: names, sizes and times of the files under the root, dependency and build directories aside. */
async function walkStamp(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  while (queue.length > 0 && out.length < MAX_WALKED) {
    const dir = queue.shift()!;
    const entries = await readdir(join(root, dir), {withFileTypes: true}).catch(() => []);
    const files: string[] = [];
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!SKIPPED_DIRS.has(entry.name)) queue.push(path); }
      else files.push(path);
    }
    out.push(...(await stampAll(root, files.slice(0, MAX_WALKED - out.length))));
  }
  return out;
}

/** The current stamp of the tree at `root`. Rejects only when git itself fails on a repository. */
export async function treeStamp(root: string, runGit: RunGit, isGit: boolean, signal?: AbortSignal): Promise<string> {
  const parts = isGit ? await gitStamp(root, runGit, signal) : await walkStamp(root);
  // Whether the root holds a .git at all: `git init` in a plain directory is a change neither list above shows.
  parts.push(`dotgit:${(await stamp(join(root, '.git'))) !== 'gone'}`);
  const hash = createHash('sha1');
  for (const part of parts) hash.update(part).update('\0');
  return `${isGit ? 'git' : 'fs'}:${hash.digest('hex')}`;
}
