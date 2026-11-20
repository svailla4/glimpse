// packages/server/src/git/watcher.ts
// Live working tree by polling: no file-system watchers, no dependencies. Each poll takes a fingerprint of
// everything a view could show differently (HEAD, the index, every modified and every untracked file) and
// reports a change when it differs from the last one.
import {lstat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import type {RepoContext, TreeWatcher} from '../contracts.ts';

export interface WatcherOptions {
  /** Shortest pause between polls. Default 2,000 ms. */
  minIntervalMs?: number;
  /** The pause is at least this many times the duration of the last poll, so a slow repository is polled less. Default 10. */
  backoffFactor?: number;
}

const STAT_PARALLEL = 64;

async function stamp(root: string, path: string): Promise<string> {
  try {
    const info = await lstat(join(root, path));
    return `${path}:${info.mtimeMs}:${info.size}`;
  } catch {
    return `${path}:gone`;
  }
}

/** Fingerprint of the working tree. Two equal fingerprints mean nothing a view reads has changed. */
export async function fingerprint(ctx: RepoContext, signal?: AbortSignal): Promise<string> {
  const lines = (out: Buffer): string[] => out.toString('utf8').split('\0').filter(Boolean);
  const quiet = (args: string[]): Promise<Buffer> => ctx.runGit(args, {signal}).catch(() => Buffer.alloc(0));
  const [head, indexPath, modified, untracked] = await Promise.all([
    // commit id and branch name: switching between two branches at the same commit is a change too
    quiet(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']),
    quiet(['rev-parse', '--git-path', 'index']),
    ctx.runGit(['diff-files', '--name-only', '--relative', '-z'], {signal}),
    ctx.runGit(['ls-files', '-o', '--exclude-standard', '-z'], {signal}),
  ]);
  const index = indexPath.toString('utf8').trim();
  const parts = [head.toString('utf8').trim().replace(/\s+/g, ' '), index ? await stamp('', resolve(ctx.root, index)) : ''];
  const paths = [...new Set([...lines(modified), ...lines(untracked)])].sort();
  for (let i = 0; i < paths.length; i += STAT_PARALLEL) {
    parts.push(...(await Promise.all(paths.slice(i, i + STAT_PARALLEL).map(path => stamp(ctx.root, path)))));
  }
  return parts.join('\n');
}

export function createTreeWatcher(ctx: RepoContext, options: WatcherOptions = {}): TreeWatcher {
  const minInterval = Math.max(10, options.minIntervalMs ?? 2_000);
  const backoff = Math.max(1, options.backoffFactor ?? 10);
  let run: {abort: AbortController; timer?: NodeJS.Timeout} | undefined;

  const stop = () => {
    if (!run) return;
    clearTimeout(run.timer);
    run.abort.abort();
    run = undefined;
  };

  return {
    start(onChange) {
      stop();
      if (!ctx.git) return;
      const mine: NonNullable<typeof run> = {abort: new AbortController()};
      run = mine;
      let last: string | undefined;
      let failed = false;

      const poll = async () => {
        const started = performance.now();
        let changed = false;
        try {
          const now = await fingerprint(ctx, mine.abort.signal);
          if (run !== mine) return;
          changed = last !== undefined && now !== last;
          last = now;
          failed = false;
        } catch (error) {
          if (run !== mine) return;
          if (!failed) ctx.log(`glimpse: watching the working tree failed: ${error instanceof Error ? error.message : String(error)}`);
          failed = true;
        }
        const elapsed = performance.now() - started;
        if (changed) {
          try {
            onChange();
          } catch (error) {
            ctx.log(`glimpse: the working-tree change handler failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (run !== mine) return;
        const pause = Math.max(minInterval, backoff * elapsed);
        mine.timer = setTimeout(() => void poll(), pause);
        mine.timer.unref();
      };
      void poll();
    },
    stop,
  };
}
