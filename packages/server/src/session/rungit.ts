// The production RunGit (the seam is described in contracts.ts): git as an argument vector, never through a shell,
// with nothing inherited on stdio (stdout is the JSON-RPC channel), a 64 MB output cap, and every child tracked so
// shutdown can kill what is still running.
import {spawn, type ChildProcess} from 'node:child_process';
import type {RunGit} from '../contracts.ts';

export const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;

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

export function createRunGit(root: string, env: NodeJS.ProcessEnv = process.env): GitRunner {
  const running = new Map<ChildProcess, (error: Error) => void>();
  let closed = false;
  // No prompts, stable messages, and no opportunistic index refresh: `git status` must not touch .git/index, or the
  // tree watcher would see a change every time the server looks.
  const childEnv = {...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C'};

  const runGit: RunGit = (args, opts) =>
    new Promise<Buffer>((resolve, reject) => {
      const what = `git ${args[0] ?? ''}`.trim();
      if (closed) return reject(new Error(`${what} failed: the session has ended`));
      if (opts?.signal?.aborted) return reject(new Error(`${what} aborted`));
      const limit = opts?.maxBuffer ?? GIT_MAX_BUFFER;
      const child = spawn('git', ['-c', 'core.quotepath=off', ...args], {
        cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
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

  return {
    runGit,
    killAll() {
      closed = true;
      for (const stop of [...running.values()]) stop(new Error('git failed: the session has ended'));
    },
  };
}
