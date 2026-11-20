// packages/server/src/git/range.ts
// Change ranges: 'wt' (working tree against HEAD, the default), 'staged', 'A..B', 'A...B', or a bare ref R, which
// means R...HEAD. User text is validated against RANGE_PATTERN and then resolved to commit ids; only those ids are
// ever passed on to git, so nothing a model or a viewer writes can become a git option.
import {devNull} from 'node:os';
import {SourceError, type RepoContext} from '../contracts.ts';

export const RANGE_PATTERN = /^[\w./~^@{}-]+(\.\.\.?[\w./~^@{}-]+)?$/;

export interface ResolvedRange {
  kind: 'wt' | 'staged' | 'commits';
  /** Canonical text: 'wt', 'staged', 'main..feature', 'main...HEAD'. */
  label: string;
  /** Commit the diff starts from: HEAD for wt and staged, the first side or the merge base for commits. Undefined before the first commit. */
  base?: string;
  /** Commit the diff ends at (commits only). */
  head?: string;
  /** HEAD of the repository; undefined before the first commit. */
  repoHead?: string;
  /** Revision arguments for `git diff`. */
  diffArgs: string[];
  /** The commits the range adds, as arguments for `git log` / `git rev-list` (commits only). */
  logArgs?: string[];
}

export type ParsedRange = {kind: 'wt' | 'staged'} | {kind: 'commits'; left: string; right: string; dots: '..' | '...'; label: string};

const invalid = (text: string): SourceError =>
  new SourceError('E_TARGET', `invalid range "${text.slice(0, 60)}": use wt, staged, a ref such as main, or A..B`);

function checkRev(rev: string, text: string): string {
  if (rev === '' || rev.startsWith('-') || rev.startsWith('.') || rev.includes('..')) throw invalid(text);
  return rev;
}

/** Validates range text without touching the repository. Throws SourceError('E_TARGET') for anything else. */
export function parseRange(input: string | undefined): ParsedRange {
  const text = (input ?? '').trim();
  if (text === '' || text === 'wt') return {kind: 'wt'};
  if (text === 'staged') return {kind: 'staged'};
  if (text.startsWith('-') || !RANGE_PATTERN.test(text)) throw invalid(text);
  const at = text.indexOf('..');
  if (at < 0) return {kind: 'commits', left: checkRev(text, text), right: 'HEAD', dots: '...', label: `${text}...HEAD`};
  const dots = text.startsWith('...', at) ? '...' : '..';
  return {kind: 'commits', left: checkRev(text.slice(0, at), text), right: checkRev(text.slice(at + dots.length), text), dots, label: text};
}

const trimmed = (out: Buffer): string => out.toString('utf8').trim();

/** Full id of the commit a revision names, or undefined when it names none. */
export async function resolveCommit(ctx: RepoContext, rev: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const sha = trimmed(await ctx.runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], {signal}));
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

/** Parses, validates and resolves a range. Throws E_NO_GIT, E_TARGET or E_SHALLOW. */
export async function resolveRange(ctx: RepoContext, input: string | undefined, signal?: AbortSignal): Promise<ResolvedRange> {
  if (!ctx.git) throw new SourceError('E_NO_GIT', 'not a git repository');
  const parsed = parseRange(input);
  const repoHead = await resolveCommit(ctx, 'HEAD', signal);

  if (parsed.kind !== 'commits') {
    // Before the first commit there is no HEAD to compare with: everything is an addition to the empty tree.
    const against = repoHead ?? trimmed(await ctx.runGit(['hash-object', '-t', 'tree', devNull], {signal}));
    return {kind: parsed.kind, label: parsed.kind, base: repoHead, repoHead, diffArgs: parsed.kind === 'staged' ? ['--cached', against] : [against]};
  }

  const [left, right] = await Promise.all([resolveCommit(ctx, parsed.left, signal), resolveCommit(ctx, parsed.right, signal)]);
  if (!left) throw new SourceError('E_TARGET', `unknown revision "${parsed.left}"`);
  if (!right) throw new SourceError('E_TARGET', `unknown revision "${parsed.right}"`);
  let base = left;
  if (parsed.dots === '...') {
    try {
      base = trimmed(await ctx.runGit(['merge-base', left, right], {signal}));
    } catch {
      signal?.throwIfAborted();
      throw ctx.git.shallow
        ? new SourceError('E_SHALLOW', `shallow clone: the history does not reach the common ancestor of ${parsed.left} and ${parsed.right}`)
        : new SourceError('E_TARGET', `${parsed.left} and ${parsed.right} have no common ancestor`);
    }
  }
  return {kind: 'commits', label: parsed.label, base, head: right, repoHead, diffArgs: [base, right], logArgs: [`${left}..${right}`]};
}
