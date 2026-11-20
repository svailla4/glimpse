// packages/server/src/code/file.ts
// Reading files of the project safely, and serving them as highlighted line windows.
// Every read goes through locate(): the real path of the file must stay inside the real path of the root.
import {lstat, readFile, realpath, stat} from 'node:fs/promises';
import {relative, resolve, sep} from 'node:path';
import {parseFileLoc, type FileQuery, type FileSlice, type TokenLine} from '@glimpse/catalog';
import type {GrammarState} from 'shiki/core';
import type {RepoContext} from '../contracts.ts';
import {plainLines, prepareLang, splitLines, tokenizeLines} from './highlight.ts';
import {langOfPath, PLAIN_LANG} from './langs.ts';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** A NUL byte this early marks a file as binary. */
const BINARY_SNIFF_BYTES = 8_000;
const DEFAULT_WINDOW = 400;
const MAX_WINDOW = 2_000;
/** Longer lines are cut for display; no viewer needs a megabyte on one line. */
export const MAX_LINE_CHARS = 10_000;
const CACHE_FILES = 50;
const CACHE_BYTES = 24 * 1024 * 1024;

/**
 * Normalises a repo-relative path written by a model or a viewer: forward slashes, no leading './', no trailing
 * '/', a '#L10-20' suffix removed. Returns '' for the root itself and null for anything that is not a path inside
 * the repository (absolute, or climbing out with '..').
 */
export function repoPath(text: string | undefined): string | null {
  const raw = parseFileLoc(text ?? '').path;
  if (raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) return null;
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.join('/');
}

export type Located = {ok: true; abs: string; rel: string} | {ok: false; reason: 'missing' | 'outside-root'};

/**
 * Resolves `path` (relative to the root, or absolute) to a real file-system path inside `root`, which must itself
 * be a real path. Symbolic links are followed first, so a link that points outside the root is refused.
 */
export async function locate(root: string, path: string): Promise<Located> {
  if (path === '' || path.includes('\0')) return {ok: false, reason: 'missing'};
  const lexical = resolve(root, path);
  const inside = (candidate: string) => candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
  if (!inside(lexical)) return {ok: false, reason: 'outside-root'};
  let abs: string;
  try {
    abs = await realpath(lexical);
  } catch {
    return {ok: false, reason: 'missing'};
  }
  if (!inside(abs)) return {ok: false, reason: 'outside-root'};
  return {ok: true, abs, rel: relative(root, lexical).split(sep).join('/')};
}

export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export type TextFile =
  | {ok: true; text: string; size: number; mtimeMs: number}
  | {ok: false; reason: 'binary' | 'too-large' | 'missing'; size: number};

/** Reads a located file as UTF-8 text, refusing directories, files over 2 MB and binary content. */
export async function readTextFile(abs: string): Promise<TextFile> {
  try {
    const info = await stat(abs);
    if (!info.isFile()) return {ok: false, reason: 'missing', size: 0};
    if (info.size > MAX_FILE_BYTES) return {ok: false, reason: 'too-large', size: info.size};
    const bytes = await readFile(abs);
    if (bytes.length > MAX_FILE_BYTES) return {ok: false, reason: 'too-large', size: bytes.length};
    if (isBinary(bytes)) return {ok: false, reason: 'binary', size: bytes.length};
    const text = bytes.toString('utf8');
    return {ok: true, text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, size: bytes.length, mtimeMs: info.mtimeMs};
  } catch {
    return {ok: false, reason: 'missing', size: 0};
  }
}

/** Size of a regular file (not a link, not a directory) at a path already known to be inside the root; undefined otherwise. */
export async function regularFileSize(abs: string): Promise<number | undefined> {
  try {
    const info = await lstat(abs);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

export function clipLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} … (+${line.length - MAX_LINE_CHARS} characters)` : line;
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  grammar: string | undefined;
  lines: string[];
  /** Tokens of the first `tokens.length` lines; the rest is tokenised when a window reaches it. */
  tokens: TokenLine[];
  state?: GrammarState;
  /** Serialises tokenising, so two windows of one file never run the grammar from the same state twice. */
  queue: Promise<void>;
}

const wholeNumber = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined;

/** The `file` method of the code service. Tokens are cached per path, mtime and size. */
export function createFileReader(ctx: RepoContext, root: Promise<string>): (q: FileQuery) => Promise<FileSlice> {
  const cache = new Map<string, CachedFile>();
  let cachedBytes = 0;

  const remember = (abs: string, entry: CachedFile) => {
    const previous = cache.get(abs);
    if (previous) cachedBytes -= previous.size;
    cache.delete(abs);
    cache.set(abs, entry);
    cachedBytes += entry.size;
    for (const [key, old] of cache) {
      if (cache.size <= CACHE_FILES && cachedBytes <= CACHE_BYTES) break;
      if (key === abs) continue;
      cache.delete(key);
      cachedBytes -= old.size;
    }
  };

  const tokensThrough = (entry: CachedFile, end: number): Promise<void> => {
    const grammar = entry.grammar;
    if (!grammar) return Promise.resolve();
    const run = entry.queue.then(async () => {
      if (entry.tokens.length >= end) return;
      const more = await tokenizeLines(entry.lines.slice(entry.tokens.length, end), grammar, entry.state);
      entry.tokens.push(...more.lines);
      entry.state = more.state;
    });
    entry.queue = run.catch(() => {});
    return run;
  };

  return async q => {
    const requested = typeof q.path === 'string' ? q.path : '';
    const lang = langOfPath(parseFileLoc(requested).path)?.id ?? PLAIN_LANG;
    const rev = ctx.rev();
    const skipped = (path: string, reason: NonNullable<FileSlice['skipped']>, size = 0): FileSlice =>
      ({path, lang, total: 0, start: 0, end: 0, lines: [], size, skipped: reason, rev});

    const where = await locate(await root, requested);
    if (!where.ok) return skipped(requested, where.reason);

    let entry = cache.get(where.abs);
    const info = await stat(where.abs).catch(() => null);
    if (!info || !info.isFile()) return skipped(where.rel, 'missing');
    if (!entry || entry.mtimeMs !== info.mtimeMs || entry.size !== info.size) {
      const file = await readTextFile(where.abs);
      if (!file.ok) return skipped(where.rel, file.reason, file.size);
      const grammar = await prepareLang(langOfPath(where.rel)?.id, ctx.log);
      entry = {mtimeMs: file.mtimeMs, size: file.size, grammar, lines: splitLines(file.text).map(clipLine), tokens: [], queue: Promise.resolve()};
    }
    remember(where.abs, entry);

    const total = entry.lines.length;
    const start = Math.min(total, Math.max(1, wholeNumber(q.start) ?? 1));
    const end = Math.min(total, start + MAX_WINDOW - 1, Math.max(start, wholeNumber(q.end) ?? start + DEFAULT_WINDOW - 1));
    await tokensThrough(entry, end);
    const lines = entry.grammar ? entry.tokens.slice(Math.max(0, start - 1), end) : plainLines(entry.lines.slice(Math.max(0, start - 1), end));
    return {path: where.rel, lang: entry.grammar ?? PLAIN_LANG, total, start, end, lines, size: entry.size, rev};
  };
}
