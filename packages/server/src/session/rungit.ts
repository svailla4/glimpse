// The production RunGit (the seam is described in contracts.ts): git as an argument vector, never through a shell,
// with nothing inherited on stdio (stdout is the JSON-RPC channel), a 64 MB output cap, and every child tracked so
// shutdown can kill what is still running.
import {spawn, type ChildProcess} from 'node:child_process';
import {delimiter} from 'node:path';
import type {RunGit} from '../contracts.ts';
import {findProgram, trustedPath} from './paths.ts';

export const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;

/**
 * Configuration forced on every git call. The repository's own .git/config is untrusted input: `core.fsmonitor` names
 * a program git would run for a plain `git status`, and a hooks path could do the same for other commands. Glimpse
 * only reads, so both are switched off; paths are printed unquoted.
 */
export const SAFE_CONFIG: readonly string[] = [
  '-c', 'core.quotepath=off',
  '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
];

export interface GitRunner {
  runGit: RunGit;
  /** Kills every git process still running and fails new calls. */
  killAll(): void;
}

/**
 * Kills git and whatever it started (an external diff driver, a credential helper). On POSIX the child leads its own
 * process group, so the whole group goes; elsewhere only git itself can be signalled.
 */
function killTree(child: ChildProcess): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** How long the list of the repository's own filter drivers is trusted before it is read again. */
const FILTERS_TTL_MS = 2000;

/**
 * Finding V017: a filter driver (`filter.<name>.clean`, `.smudge`, `.process`) is a program git runs on file content
 * for a plain `git status` or `git diff`. One defined by the repository's own configuration (.git/config, a worktree
 * config, a file they include) is untrusted input and is switched off: its commands are emptied, which git treats as
 * no filter, and it is no longer required. Drivers of the user's own (global, system) configuration, such as Git LFS,
 * are the user's and stay. Reading configuration runs nothing.
 */
export function filterOverrides(listing: string, scoped: boolean): string[] {
  const names = new Set<string>();
  // `git config --null [--show-scope] --get-regexp`: [scope NUL] key LF value NUL, entry after entry.
  const parts = listing.split('\0');
  for (let i = 0; i < parts.length;) {
    const scope = scoped ? parts[i++] : 'local';
    const entry = parts[i++];
    if (!entry || scope === 'global' || scope === 'system') continue;
    const key = entry.split('\n')[0] ?? '';
    const match = /^filter\.([\s\S]+)\.(?:clean|smudge|process|required)$/i.exec(key);
    if (match) names.add(match[1]!);
  }
  return [...names].flatMap(name => [`filter.${name}.clean=`, `filter.${name}.smudge=`, `filter.${name}.process=`, `filter.${name}.required=false`]);
}

/** The commands that look at the working tree of each submodule unless told not to. */
const SUBMODULE_COMMANDS: ReadonlySet<string> = new Set(['status', 'diff', 'diff-files', 'diff-index']);

/**
 * Finding V017, the submodule re-attack: `git status` and the diff commands run `git status` inside every submodule,
 * which reads that submodule's own configuration (.git/modules/<name>/config, part of the same untrusted .git
 * directory) and runs its filter drivers, fsmonitor and the rest; none of it is the superproject's to switch off.
 * `--ignore-submodules=dirty` keeps git out of the submodules' working trees: a submodule still shows as changed when
 * its checked-out commit moved, only uncommitted changes inside it go unseen. Given right after the subcommand, unless
 * the call says otherwise itself.
 */
export function withoutSubmoduleTrees(args: readonly string[]): string[] {
  let at = 0;
  while (at < args.length && args[at]!.startsWith('-')) at += args[at] === '-c' || args[at] === '-C' ? 2 : 1;
  const command = args[at];
  if (command === undefined || !SUBMODULE_COMMANDS.has(command) || args.some(arg => arg.startsWith('--ignore-submodules'))) return [...args];
  return [...args.slice(0, at + 1), '--ignore-submodules=dirty', ...args.slice(at + 1)];
}

export function createRunGit(root: string, env: NodeJS.ProcessEnv = process.env): GitRunner {
  const running = new Map<ChildProcess, (error: Error) => void>();
  let closed = false;
  // Finding V019: git is run by its absolute path, found in a PATH directory that is absolute and outside the
  // project, and its children (a helper git starts) see only those directories. Looked up once, on first use.
  let program: string | null | undefined;
  const trusted = trustedPath(env, root).join(delimiter);
  // No prompts, stable messages, and no opportunistic index refresh: `git status` must not touch .git/index, or the
  // tree watcher would see a change every time the server looks.
  const childEnv: NodeJS.ProcessEnv = {...env, PATH: trusted, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C'};
  let filters: {at: number; overrides: Promise<string[]>} | undefined;

  /** One git child; `extra` is configuration given before SAFE_CONFIG's own. */
  const spawnGit = (args: readonly string[], overrides: readonly string[], opts: Parameters<RunGit>[1]) =>
    new Promise<Buffer>((resolve, reject) => {
      const what = `git ${args[0] ?? ''}`.trim();
      if (closed) return reject(new Error(`${what} failed: the session has ended`));
      if (opts?.signal?.aborted) return reject(new Error(`${what} aborted`));
      program ??= findProgram('git', env, root) ?? null;
      if (program === null) return reject(new Error(`${what} failed: git was not found on PATH (only absolute directories outside the project are searched)`));
      const limit = opts?.maxBuffer ?? GIT_MAX_BUFFER;
      // -c for git of any age; GIT_CONFIG_* as well, for a driver name -c cannot spell (one with an `=`).
      const dashC = overrides.filter(item => item.indexOf('=') === item.lastIndexOf('=')).flatMap(item => ['-c', item]);
      // After any GIT_CONFIG_* pairs of the user's own environment, which stay as they are.
      const base = Number.parseInt(childEnv.GIT_CONFIG_COUNT ?? '', 10) || 0;
      const configEnv = overrides.length === 0 ? {} : Object.fromEntries([
        ['GIT_CONFIG_COUNT', String(base + overrides.length)],
        ...overrides.flatMap((item, i) => {
          const at = item.lastIndexOf('=');
          return [[`GIT_CONFIG_KEY_${base + i}`, item.slice(0, at)], [`GIT_CONFIG_VALUE_${base + i}`, item.slice(at + 1)]];
        }),
      ]);
      const child = spawn(program, [...SAFE_CONFIG, ...dashC, ...args], {
        cwd: root, env: {...childEnv, ...configEnv}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
      });
      const out: Buffer[] = [];
      let size = 0;
      let stderr = '';
      let settled = false;
      const settle = (error: Error | undefined) => {
        if (settled) return;
        settled = true;
        running.delete(child);
        opts?.signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(Buffer.concat(out));
      };
      // Rejects at once: a grandchild may keep the pipes open long after git itself is gone.
      const stop = (error: Error) => {
        if (settled) return;
        killTree(child);
        child.stdout!.destroy();
        child.stderr!.destroy();
        settle(error);
      };
      const onAbort = () => stop(new Error(`${what} aborted`));
      running.set(child, stop);
      opts?.signal?.addEventListener('abort', onAbort, {once: true});
      child.stdout!.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) stop(new Error(`${what} failed: output exceeds ${limit >= 1024 * 1024 ? `${Math.round(limit / (1024 * 1024))} MB` : `${limit} bytes`}`));
        else out.push(chunk);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8');
      });
      // A spawn failure (git is not installed) may never be followed by 'close'.
      child.on('error', error => settle(new Error(`${what} failed: ${error.message}`)));
      child.on('close', code => settle(code === 0 ? undefined : new Error(`git ${args.join(' ')} failed: ${stderr.trim() || `exit code ${code}`}`)));
    });

  /** The overrides for the repository's own filter drivers, read at most every FILTERS_TTL_MS. Never rejects. */
  const filterConfig = (): Promise<string[]> => {
    const now = Date.now();
    if (filters && now - filters.at < FILTERS_TTL_MS) return filters.overrides;
    const list = (scoped: boolean) => spawnGit(['config', '--null', ...(scoped ? ['--show-scope'] : []), '--get-regexp', '^filter\\.'], [], undefined)
      .then(out => filterOverrides(out.toString('utf8'), scoped));
    // Exit status 1 is "no such key"; an older git without --show-scope fails otherwise and is asked without it.
    const overrides = list(true).catch((error: Error) => (/exit code 1$/.test(error.message) ? [] : list(false).catch(() => [])));
    filters = {at: now, overrides};
    return overrides;
  };

  const runGit: RunGit = async (args, opts) => spawnGit(withoutSubmoduleTrees(args), await filterConfig(), opts);

  return {
    runGit,
    killAll() {
      closed = true;
      for (const stop of [...running.values()]) stop(new Error('git failed: the session has ended'));
    },
  };
}
