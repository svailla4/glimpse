// packages/server/src/git/watcher.ts
// Live working tree by polling: no file-system watchers, no dependencies. Each look takes a fingerprint of
// everything a view could show differently (HEAD, the index, every modified and every untracked file; without git,
// every file the inventory would list) and reports a change when it differs from the last one.
//
// The watcher keeps the last fingerprint for as long as it lives, not for as long as it polls. Its first one is
// taken when it is created, so a change made before anybody started it, or between a stop() and the next start(),
// is reported by the first look afterwards. check() is that same look on demand, for callers that must not serve
// stale data and cannot wait for a poll (every tool call; no tab needs to be connected).
import {createHash} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {walkFiles} from '../analyze/inventory.ts';
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

async function stamps(root: string, paths: readonly string[], signal: AbortSignal | undefined): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < paths.length; i += STAT_PARALLEL) {
    signal?.throwIfAborted();
    out.push(...(await Promise.all(paths.slice(i, i + STAT_PARALLEL).map(path => stamp(root, path)))));
  }
  return out;
}

/** Without git: every file a walk lists, with its size and time, as one digest (the list can be long). */
async function walkFingerprint(ctx: RepoContext, signal?: AbortSignal): Promise<string> {
  const {paths} = await walkFiles(ctx.root);
  signal?.throwIfAborted();
  const hash = createHash('sha1');
  for (const line of await stamps(ctx.root, paths, signal)) hash.update(line).update('\n');
  return `walk ${paths.length} ${hash.digest('hex')}`;
}

/** Fingerprint of the working tree. Two equal fingerprints mean nothing a view reads has changed. */
export async function fingerprint(ctx: RepoContext, signal?: AbortSignal): Promise<string> {
  if (!ctx.git) return walkFingerprint(ctx, signal);
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
  parts.push(...(await stamps(ctx.root, paths, signal)));
  return parts.join('\n');
}

export function createTreeWatcher(ctx: RepoContext, options: WatcherOptions = {}): TreeWatcher {
  const minInterval = Math.max(10, options.minIntervalMs ?? 2_000);
  const backoff = Math.max(1, options.backoffFactor ?? 10);
  let run: {abort: AbortController; timer?: NodeJS.Timeout} | undefined;
  /** The state every later look is compared with. It outlives stop(). */
  let last: string | undefined;
  /**
   * A change that was seen but not yet told to anybody: a look can finish after its poll was stopped, and the change
   * it found must still reach whoever looks next.
   */
  let unreported = false;
  /** Looks run one after another, so each compares with the fingerprint of the one before it. */
  let queue: Promise<unknown> = Promise.resolve();

  const look = (signal?: AbortSignal): Promise<void> => {
    const mine = queue.then(async () => {
      const now = await fingerprint(ctx, signal);
      if (last !== undefined && now !== last) unreported = true;
      last = now;
    });
    queue = mine.catch(() => {});
    return mine;
  };
  const take = (): boolean => {
    const was = unreported;
    unreported = false;
    return was;
  };
  // The reference: whatever the session computes from here on is at least as new as this.
  void look().catch(() => {});

  const stop = () => {
    if (!run) return;
    clearTimeout(run.timer);
    run.abort.abort();
    run = undefined;
  };

  return {
    start(onChange) {
      stop();
      const mine: NonNullable<typeof run> = {abort: new AbortController()};
      run = mine;
      let failed = false;

      const poll = async () => {
        const started = performance.now();
        let changed = false;
        try {
          await look(mine.abort.signal);
          if (run !== mine) return;
          changed = take();
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
    check: () => look().then(take, () => false),
  };
}
