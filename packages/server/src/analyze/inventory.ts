// File inventory: which files exist (git, or a .gitignore-aware walk), and one lstat plus one read per file for line
// counts, the binary check and the facts scan. File system work is synchronous in short slices so the event loop of
// the server keeps turning while a large repository is read.
import {lstatSync, readdirSync, readFileSync, type Dirent, type Stats} from 'node:fs';
import ignore, {type Ignore} from 'ignore';
import type {FileEntry, RunGit} from '../contracts.ts';
import {scanFile, type ScannedFacts} from './facts.ts';
import {dirName, hasGeneratedHeader, isBinaryExt, isGeneratedPath, isTestPath, languageOf} from './languages.ts';

/** Files larger than this are listed but never read. */
export const MAX_READ_BYTES = 2 * 1024 * 1024;
/** Listing stops here; a repository this large is analysed in part and says so. */
const MAX_FILES = 200_000;
const SNIFF_BYTES = 8000;
/** Average line length above which a text file is taken for minified or machine-written. */
const MINIFIED_LINE = 1000;
const SLICE_MS = 12;
/**
 * Directories that never hold the project's own source: version-control data, installed dependencies, tool caches.
 * The walker does not enter them and untracked files beneath them are dropped; a tracked file is kept wherever it is.
 */
const ALWAYS_SKIPPED = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.gradle', '.dart_tool',
  'Pods', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '.terraform', 'DerivedData', '.idea',
]);
const underSkipped = (path: string) => path.split('/').slice(0, -1).some(segment => ALWAYS_SKIPPED.has(segment));

export interface Listing {
  files: Array<{path: string; tracked: boolean}>;
  source: 'git' | 'walk';
  warnings: string[];
}
export interface ScanRecord {
  entry: FileEntry;
  facts?: ScannedFacts;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}
export interface Scan {
  entries: FileEntry[];
  facts: Map<string, ScannedFacts>;
  warnings: string[];
  /** Files whose record was reused from the cache because size and times were unchanged. */
  reused: number;
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const byPath = (a: {path: string}, b: {path: string}) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function createSlicer(): () => Promise<void> | undefined {
  let since = performance.now();
  return () => {
    if (performance.now() - since < SLICE_MS) return undefined;
    return new Promise<void>(resolve => {
      setImmediate(() => {
        since = performance.now();
        resolve();
      });
    });
  };
}

/**
 * Walks `root` without git: nested .gitignore files are honoured through `ignore`, and version-control, dependency
 * and cache directories are always skipped. Symbolic links are never followed. Returns sorted repo-relative paths.
 */
export async function walkFiles(root: string, limit = MAX_FILES): Promise<{paths: string[]; warnings: string[]}> {
  const paths: string[] = [];
  const warnings: string[] = [];
  const pause = createSlicer();
  let unreadable = 0;
  let capped = false;
  const stack: Array<{dir: string; rules: Array<{base: string; matcher: Ignore}>}> = [{dir: '', rules: []}];
  while (stack.length > 0 && !capped) {
    const {dir, rules: inherited} = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir ? `${root}/${dir}` : root, {withFileTypes: true});
    } catch {
      unreadable++;
      continue;
    }
    let rules = inherited;
    if (entries.some(entry => entry.name === '.gitignore' && entry.isFile())) {
      try {
        rules = [...inherited, {base: dir, matcher: ignore().add(readFileSync(`${root}/${dir ? `${dir}/` : ''}.gitignore`, 'utf8'))}];
      } catch {
        // an unreadable .gitignore ignores nothing
      }
    }
    for (const entry of entries) {
      if (ALWAYS_SKIPPED.has(entry.name)) continue;
      const isDir = entry.isDirectory();
      if (!isDir && !entry.isFile()) continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      let ignored = false;
      for (const rule of rules) {
        const relative = rule.base ? path.slice(rule.base.length + 1) : path;
        try {
          const result = rule.matcher.test(isDir ? `${relative}/` : relative);
          if (result.ignored) ignored = true;
          else if (result.unignored) ignored = false;
        } catch {
          // a name the matcher rejects is not ignored
        }
      }
      if (ignored) continue;
      if (isDir) stack.push({dir: path, rules});
      else if (paths.push(path) >= limit) {
        capped = true;
        break;
      }
    }
    const wait = pause();
    if (wait) await wait;
  }
  if (capped) warnings.push(`file listing stopped at ${count(limit, 'file')}`);
  if (unreadable > 0) warnings.push(`${count(unreadable, 'directory', 'directories')} could not be read`);
  return {paths: paths.sort(), warnings};
}

/** Lists the files of the project: from git when `root` is inside a repository, otherwise by walking. */
export async function listFiles(root: string, runGit: RunGit, log: (message: string) => void): Promise<Listing> {
  let staged: Buffer;
  let others: Buffer;
  try {
    [staged, others] = await Promise.all([runGit(['ls-files', '-s', '-z']), runGit(['ls-files', '-o', '--exclude-standard', '-z'])]);
  } catch (error) {
    log(`glimpse: listing files without git (${error instanceof Error ? (error.message.split('\n')[0] ?? '').slice(0, 120) : 'git failed'})`);
    const walked = await walkFiles(root);
    return {files: walked.paths.map(path => ({path, tracked: false})), source: 'walk', warnings: walked.warnings};
  }
  const seen = new Set<string>();
  const files: Listing['files'] = [];
  for (const record of staged.toString('utf8').split('\0')) {
    const tab = record.indexOf('\t');
    // Mode 160000 is a submodule: a commit pointer, not a file.
    if (tab === -1 || record.startsWith('160000 ')) continue;
    const path = record.slice(tab + 1);
    if (seen.has(path)) continue;
    seen.add(path);
    files.push({path, tracked: true});
  }
  for (const path of others.toString('utf8').split('\0')) {
    // Untracked dependency trees and caches are noise even when nothing ignores them.
    if (!path || seen.has(path) || underSkipped(path)) continue;
    seen.add(path);
    files.push({path, tracked: false});
  }
  files.sort(byPath);
  const warnings: string[] = [];
  if (files.length > MAX_FILES) {
    warnings.push(`file listing stopped at ${count(MAX_FILES, 'file')} of ${files.length.toLocaleString('en-US')}`);
    files.length = MAX_FILES;
  }
  return {files, source: 'git', warnings};
}

function countLines(buffer: Buffer): {loc: number; sloc: number} {
  const n = buffer.length;
  let loc = 0;
  let sloc = 0;
  let at = 0;
  while (at < n) {
    let end = buffer.indexOf(10, at);
    if (end === -1) end = n;
    loc++;
    let j = at;
    while (j < end) {
      const c = buffer[j]!;
      if (c !== 32 && c !== 9 && c !== 13) break;
      j++;
    }
    if (j < end) sloc++;
    at = end + 1;
  }
  return {loc, sloc};
}

type ReadOutcome = 'ok' | 'gone' | 'unreadable' | 'oversized';

function readRecord(root: string, path: string, tracked: boolean, cache: Map<string, ScanRecord>): {record?: ScanRecord; outcome: ReadOutcome; reused?: boolean} {
  const absolute = `${root}/${path}`;
  let stats: Stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    return {outcome: 'gone'};
  }
  // Symbolic links, sockets and the like are not files of the project; a link could point outside the root.
  if (!stats.isFile()) return {outcome: 'gone'};
  const cached = cache.get(path);
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs && cached.entry.tracked === tracked) {
    return {record: cached, outcome: 'ok', reused: true};
  }
  const language = languageOf(path);
  const entry: FileEntry = {
    path, ...(language ? {lang: language.name} : {}), loc: 0, sloc: 0, bytes: stats.size,
    binary: isBinaryExt(path), tracked, isTest: isTestPath(path), generated: isGeneratedPath(path),
  };
  const record: ScanRecord = {entry, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs};
  if (entry.binary || stats.size === 0) return {record, outcome: 'ok'};
  if (stats.size > MAX_READ_BYTES) return {record, outcome: 'oversized'};
  let buffer: Buffer;
  try {
    buffer = readFileSync(absolute);
  } catch {
    return {record, outcome: 'unreadable'};
  }
  if (buffer.subarray(0, SNIFF_BYTES).indexOf(0) !== -1) {
    entry.binary = true;
    return {record, outcome: 'ok'};
  }
  const lines = countLines(buffer);
  entry.loc = lines.loc;
  entry.sloc = lines.sloc;
  if (buffer.length / lines.loc > MINIFIED_LINE) entry.generated = true;
  if (!entry.generated && language && (language.kind === 'code' || language.comments)) {
    const text = buffer.toString('utf8');
    if (hasGeneratedHeader(text.slice(0, 400))) entry.generated = true;
    else record.facts = scanFile(text, language);
  }
  return {record, outcome: 'ok'};
}

/**
 * Reads every listed file once. `cache` survives between scans: a file whose size and times are unchanged is not
 * read again, which makes a rescan after an edit cost one lstat per file.
 */
export async function scanFiles(root: string, listing: Listing, cache: Map<string, ScanRecord>): Promise<Scan> {
  const pause = createSlicer();
  const entries: FileEntry[] = [];
  const facts = new Map<string, ScannedFacts>();
  const live = new Set<string>();
  let unreadable = 0;
  let oversized = 0;
  let reused = 0;
  // A listed path may sit beneath a directory that has since become a symbolic link (git lists from its index):
  // every directory on the way is checked once, so nothing is read through a link out of the root.
  const realDirs = new Map<string, boolean>([['', true]]);
  const isRealDir = (dir: string): boolean => {
    let real = realDirs.get(dir);
    if (real === undefined) {
      try {
        real = isRealDir(dirName(dir)) && lstatSync(`${root}/${dir}`).isDirectory();
      } catch {
        real = false;
      }
      realDirs.set(dir, real);
    }
    return real;
  };
  for (const file of listing.files) {
    if (!isRealDir(dirName(file.path))) continue;
    const {record, outcome, reused: hit} = readRecord(root, file.path, file.tracked, cache);
    if (record) {
      cache.set(file.path, record);
      live.add(file.path);
      entries.push(record.entry);
      if (record.facts) facts.set(file.path, record.facts);
      if (hit) reused++;
    }
    if (outcome === 'unreadable') unreadable++;
    else if (outcome === 'oversized') oversized++;
    const wait = pause();
    if (wait) await wait;
  }
  for (const path of cache.keys()) if (!live.has(path)) cache.delete(path);
  const warnings = [...listing.warnings];
  if (unreadable > 0) warnings.push(`${count(unreadable, 'file')} could not be read`);
  if (oversized > 0) warnings.push(`${count(oversized, 'file')} over 2 MB counted by size only`);
  return {entries, facts, warnings, reused};
}
