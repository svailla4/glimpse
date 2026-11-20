// packages/server/src/git/diff.ts
// What a change range touches (listChanges, shared by the diff.* sources) and the DiffService behind /api/diff:
// hunks with line numbers, syntax tokens from the code service and word-level marks.
// Every path in an answer comes from git's own change list (tracked files, and untracked files that are not ignored
// and not inside a dependency directory): a ?path= only selects from that list, so the diff can never be used to
// read .git, an ignored file or anything else outside the inventory.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {DiffFile, DiffHunk, DiffLine, DiffPayload, TokenLine} from '@glimpse/catalog';
import {diffWordsWithSpace, parsePatch} from 'diff';
import {underSkipped} from '../analyze/skipped.ts';
import {clipLine, isBinary, MAX_FILE_BYTES, readTextFile, regularFileSize, repoPath} from '../code/file.ts';
import {splitLines} from '../code/highlight.ts';
import {langOfPath} from '../code/langs.ts';
import {SourceError, type CodeService, type DiffService, type RepoContext} from '../contracts.ts';
import {resolveRange, type ResolvedRange} from './range.ts';

export type ChangeStatus = 'A' | 'M' | 'D' | 'R';

export interface Change {
  path: string;
  /** Previous path of a renamed file. */
  from?: string;
  status: ChangeStatus;
  add: number;
  del: number;
  binary: boolean;
  /** A new file git does not track yet (working tree only): its content is read from disk, not from a patch. */
  untracked: boolean;
}

export interface ChangeSet {
  range: ResolvedRange;
  /** Sorted by path. */
  files: Change[];
  totals: {files: number; add: number; del: number};
  warnings: string[];
}

/** Untracked files whose lines are counted; a working tree with more is almost always missing an ignore rule. */
const MAX_UNTRACKED = 2_000;
const READ_PARALLEL = 16;
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '-M', '--relative'];

// Payload budget of one /api/diff answer; files beyond it carry no hunks and are fetched one by one with ?path=.
const MAX_FILES_WITH_HUNKS = 30;
const MAX_CHANGED_LINES = 3_000;
/**
 * Diff lines of one file in an answer to an explicit ?path= request, which the budget above does not limit. A longer
 * diff ends with a hunk that only says how much was left out; the file itself can be read through /api/file.
 */
export const MAX_FILE_DIFF_LINES = 5_000;
/** Above this many diff lines in one answer the rest is sent without syntax tokens or word marks. */
const MAX_TOKENIZED_LINES = 6_000;
/** Word marks are skipped for longer lines and for pairs that have little in common. */
const MAX_MARKED_LINE = 500;
const MIN_COMMON_RATIO = 0.35;

const fields = (out: Buffer): string[] => out.toString('utf8').split('\0');
const byPath = (a: {path: string}, b: {path: string}): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function statusOf(code: string): ChangeStatus {
  if (code.startsWith('R')) return 'R';
  if (code.startsWith('A') || code.startsWith('C')) return 'A';
  return code.startsWith('D') ? 'D' : 'M';
}

function countLines(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const byte of bytes) if (byte === 10) lines++;
  return bytes[bytes.length - 1] === 10 ? lines : lines + 1;
}

async function inBatches<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(work));
}

/** Files a range changes, with line counts. For the working tree, untracked files count as additions. */
export async function listChanges(ctx: RepoContext, rangeText: string | undefined, signal?: AbortSignal): Promise<ChangeSet> {
  const range = await resolveRange(ctx, rangeText, signal);
  const [status, numstat, others] = await Promise.all([
    ctx.runGit(['diff', ...DIFF_FLAGS, '--name-status', '-z', ...range.diffArgs], {signal}),
    ctx.runGit(['diff', ...DIFF_FLAGS, '--numstat', '-z', ...range.diffArgs], {signal}),
    range.kind === 'wt' ? ctx.runGit(['ls-files', '-o', '--exclude-standard', '-z'], {signal}) : Promise.resolve(Buffer.alloc(0)),
  ]);

  const changes = new Map<string, Change>();
  const names = fields(status);
  for (let i = 0; i + 1 < names.length; i++) {
    const code = names[i]!;
    if (code === '') continue;
    const first = names[++i]!;
    const renamed = code.startsWith('R') || code.startsWith('C');
    const path = renamed ? names[++i] : first;
    if (!path) continue;
    changes.set(path, {path, status: statusOf(code), add: 0, del: 0, binary: false, untracked: false, ...(code.startsWith('R') ? {from: first} : {})});
  }
  const counts = fields(numstat);
  for (let i = 0; i < counts.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(counts[i]!);
    if (!match) continue;
    // A rename or copy is written as "add<TAB>del<TAB>" followed by the old and the new path as two more fields.
    let path = match[3];
    if (path === '') {
      i += 2;
      path = counts[i];
    }
    const change = path ? changes.get(path) : undefined;
    if (!change) continue;
    change.binary = match[1] === '-';
    change.add = Number(match[1]) || 0;
    change.del = Number(match[2]) || 0;
  }

  const warnings: string[] = [];
  const untracked = fields(others).filter(path => path !== '' && !path.endsWith('/') && !changes.has(path) && !underSkipped(path));
  if (untracked.length > MAX_UNTRACKED) warnings.push(`${untracked.length - MAX_UNTRACKED} untracked files are not shown`);
  await inBatches(untracked.slice(0, MAX_UNTRACKED), READ_PARALLEL, async path => {
    const abs = join(ctx.root, path);
    const size = await regularFileSize(abs);
    if (size === undefined) return;
    const change: Change = {path, status: 'A', add: 0, del: 0, binary: size > MAX_FILE_BYTES, untracked: true};
    if (!change.binary) {
      try {
        const bytes = await readFile(abs, {signal});
        if (isBinary(bytes)) change.binary = true;
        else change.add = countLines(bytes);
      } catch {
        signal?.throwIfAborted();
        return; // deleted between the listing and the read
      }
    }
    changes.set(path, change);
  });

  const files = [...changes.values()].sort(byPath);
  const totals = {files: files.length, add: 0, del: 0};
  for (const file of files) {
    totals.add += file.add;
    totals.del += file.del;
  }
  return {range, files, totals, warnings};
}

// ---------------------------------------------------------------- hunks

export interface RawHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; header: string; lines: Array<{t: DiffLine['t']; text: string; o?: number; n?: number}> }

/** Splits `git diff` output into one text per file. Hunk lines never start at column 0 with "diff --git". */
function splitSections(patch: string): string[] {
  const starts: number[] = patch.startsWith('diff --git ') ? [0] : [];
  for (let at = patch.indexOf('\ndiff --git '); at >= 0; at = patch.indexOf('\ndiff --git ', at + 1)) starts.push(at + 1);
  return starts.map((start, index) => patch.slice(start, starts[index + 1] ?? patch.length));
}

function hunksOf(section: string): RawHunk[] {
  const [parsed] = parsePatch(section);
  // parsePatch drops the text after the second "@@"; the raw header lines are taken from the section in order.
  const headers = section.split('\n').filter(line => line.startsWith('@@ '));
  return (parsed?.hunks ?? []).map((hunk, index) => {
    let o = hunk.oldStart;
    let n = hunk.newStart;
    const lines: RawHunk['lines'] = [];
    for (const line of hunk.lines) {
      const text = clipLine(line.slice(1).replace(/\r$/, ''));
      if (line.startsWith('+')) lines.push({t: '+', text, n: n++});
      else if (line.startsWith('-')) lines.push({t: '-', text, o: o++});
      else if (line.startsWith(' ')) lines.push({t: ' ', text, o: o++, n: n++});
      // "\ No newline at end of file" describes the line before it and is not a line of either side.
    }
    return {
      oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines,
      header: headers[index] ?? `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      lines,
    };
  });
}

/** Cuts the hunks of one file to `max` diff lines; what was left out is said by a last hunk without lines. */
export function capHunks(raw: RawHunk[], max: number): RawHunk[] {
  const total = raw.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  if (total <= max) return raw;
  const kept: RawHunk[] = [];
  let left = max;
  for (const hunk of raw) {
    if (left <= 0) break;
    if (hunk.lines.length <= left) {
      kept.push(hunk);
      left -= hunk.lines.length;
      continue;
    }
    const lines = hunk.lines.slice(0, left);
    left = 0;
    const oldLines = lines.filter(line => line.t !== '+').length;
    const newLines = lines.filter(line => line.t !== '-').length;
    kept.push({...hunk, oldLines, newLines, header: `@@ -${hunk.oldStart},${oldLines} +${hunk.newStart},${newLines} @@`, lines});
  }
  const last = kept.at(-1);
  const oldStart = last ? last.oldStart + last.oldLines : 0;
  const newStart = last ? last.newStart + last.newLines : 0;
  kept.push({oldStart, oldLines: 0, newStart, newLines: 0, header: `@@ ${(total - max).toLocaleString('en-US')} more diff lines not shown: the change is too large for one view @@`, lines: []});
  return kept;
}

type Marks = Array<[from: number, to: number]>;

/** Character ranges that differ between a removed line and the added line that replaces it; null when they share too little. */
export function wordMarks(before: string, after: string): {removed: Marks; added: Marks} | null {
  if (before === after || before.length > MAX_MARKED_LINE || after.length > MAX_MARKED_LINE) return null;
  const removed: Marks = [];
  const added: Marks = [];
  let o = 0;
  let n = 0;
  let common = 0;
  const push = (marks: Marks, from: number, to: number) => {
    const last = marks.at(-1);
    if (last && last[1] === from) last[1] = to;
    else marks.push([from, to]);
  };
  for (const part of diffWordsWithSpace(before, after)) {
    const length = part.value.length;
    if (part.added) {
      push(added, n, n + length);
      n += length;
    } else if (part.removed) {
      push(removed, o, o + length);
      o += length;
    } else {
      if (part.value.trim() !== '') common += length;
      o += length;
      n += length;
    }
  }
  const longest = Math.max(before.trim().length, after.trim().length);
  if (longest === 0 || common / longest < MIN_COMMON_RATIO) return null;
  return {removed, added};
}

function markHunk(lines: DiffLine[], texts: readonly string[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.t !== '-') { i++; continue; }
    const firstRemoved = i;
    while (i < lines.length && lines[i]!.t === '-') i++;
    const firstAdded = i;
    while (i < lines.length && lines[i]!.t === '+') i++;
    const pairs = Math.min(firstAdded - firstRemoved, i - firstAdded);
    for (let k = 0; k < pairs; k++) {
      const marks = wordMarks(texts[firstRemoved + k]!, texts[firstAdded + k]!);
      if (!marks) continue;
      if (marks.removed.length > 0) lines[firstRemoved + k]!.marks = marks.removed;
      if (marks.added.length > 0) lines[firstAdded + k]!.marks = marks.added;
    }
  }
}

const plain = (text: string): TokenLine => (text === '' ? [] : [[text, 0]]);

/**
 * Turns parsed hunks into the payload shape. Each side of a hunk (context + removed, context + added) is highlighted
 * as one block, so strings and comments that span lines inside the hunk keep their class.
 */
async function buildHunks(raw: RawHunk[], lang: string | undefined, code: CodeService, budget: {lines: number}): Promise<DiffHunk[]> {
  const hunks: DiffHunk[] = [];
  for (const hunk of raw) {
    const rich = budget.lines >= hunk.lines.length;
    budget.lines -= hunk.lines.length;
    const texts = hunk.lines.map(line => line.text);
    const side = async (keep: DiffLine['t']): Promise<Map<number, TokenLine>> => {
      const picked = hunk.lines.flatMap((line, index) => (line.t === ' ' || line.t === keep ? [index] : []));
      const tokens = new Map<number, TokenLine>();
      if (!rich || !lang || !hunk.lines.some(line => line.t === keep)) return tokens;
      const result = await code.highlight(picked.map(index => texts[index]!).join('\n'), lang);
      picked.forEach((index, at) => {
        tokens.set(index, result.lines[at] ?? plain(texts[index]!));
      });
      return tokens;
    };
    const [added, removed] = await Promise.all([side('+'), side('-')]);
    const lines: DiffLine[] = hunk.lines.map((line, index) => ({
      t: line.t,
      ...(line.o === undefined ? {} : {o: line.o}),
      ...(line.n === undefined ? {} : {n: line.n}),
      tokens: (line.t === '-' ? removed.get(index) : (added.get(index) ?? removed.get(index))) ?? plain(line.text),
    }));
    if (rich) markHunk(lines, texts);
    hunks.push({oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, header: hunk.header, lines});
  }
  return hunks;
}

const shortSha = (sha: string | undefined): string | undefined => sha?.slice(0, 7);

export function createDiffService(ctx: RepoContext, code: CodeService): DiffService {
  return {
    async diff(q): Promise<DiffPayload> {
      const changes = await listChanges(ctx, q?.range);
      const {range} = changes;
      let files = changes.files;
      let totals = changes.totals;
      const only = q?.path === undefined || q.path === '' ? undefined : repoPath(q.path);
      if (only === null) throw new SourceError('E_TARGET', 'the path of a diff must be inside the repository');
      if (only !== undefined) {
        files = files.filter(file => file.path === only);
        totals = {files: files.length, add: files.reduce((sum, f) => sum + f.add, 0), del: files.reduce((sum, f) => sum + f.del, 0)};
      }

      // Which files get hunks: all of an explicit ?path= request, otherwise as many as the payload budget holds.
      const chosen = new Set<Change>();
      let changedLines = 0;
      for (const file of files) {
        if (file.binary) continue;
        const size = file.add + file.del;
        if (only === undefined && (chosen.size >= MAX_FILES_WITH_HUNKS || changedLines + size > MAX_CHANGED_LINES)) continue;
        chosen.add(file);
        changedLines += size;
      }

      const raw = new Map<Change, RawHunk[]>();
      const tracked = [...chosen].filter(file => !file.untracked);
      if (tracked.length > 0) {
        const paths = tracked.flatMap(file => (file.from ? [file.from, file.path] : [file.path]));
        const patch = (await ctx.runGit(
          ['--literal-pathspecs', 'diff', ...DIFF_FLAGS, '--src-prefix=a/', '--dst-prefix=b/', '-U3', ...range.diffArgs, '--', ...paths],
        )).toString('utf8');
        splitSections(patch).forEach((section, index) => {
          const header = section.slice(0, section.indexOf('\n'));
          const fits = (file: Change) => header.endsWith(` b/${file.path}`);
          // Sections come in the order of the file list; the name check guards that assumption for unquoted paths.
          const inOrder = tracked[index];
          const file = inOrder && (header.includes('"') || fits(inOrder)) ? inOrder : tracked.find(fits);
          if (!file) return;
          try {
            raw.set(file, hunksOf(section));
          } catch (error) {
            ctx.log(`glimpse: could not parse the diff of ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      }
      for (const file of chosen) {
        if (!file.untracked) continue;
        const abs = join(ctx.root, file.path);
        const read = (await regularFileSize(abs)) === undefined ? undefined : await readTextFile(abs);
        if (!read?.ok) continue;
        const lines = splitLines(read.text).map(clipLine);
        raw.set(file, lines.length === 0 ? [] : [{
          oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, header: `@@ -0,0 +1,${lines.length} @@`,
          lines: lines.map((text, index) => ({t: '+' as const, text, n: index + 1})),
        }]);
      }

      // A chosen file git or the disk had nothing for (a mode change, a file that vanished) is complete with no hunks:
      // leaving them undefined would tell the viewer to fetch it again.
      for (const file of chosen) if (!raw.has(file)) raw.set(file, []);
      // An explicit ?path= bypasses the payload budget, so one enormous file is cut here instead.
      for (const [file, hunks] of raw) raw.set(file, capHunks(hunks, MAX_FILE_DIFF_LINES));

      const budget = {lines: MAX_TOKENIZED_LINES};
      const out: DiffFile[] = [];
      for (const file of files) {
        const lang = langOfPath(file.path)?.id;
        const hunks = raw.get(file);
        out.push({
          path: file.path,
          ...(file.from ? {from: file.from} : {}),
          status: file.status,
          add: file.add,
          del: file.del,
          ...(lang ? {lang} : {}),
          ...(file.binary ? {binary: true, hunks: []} : {}),
          ...(hunks ? {hunks: await buildHunks(hunks, lang, code, budget)} : {}),
        });
      }

      const base = range.kind === 'commits' ? shortSha(range.base) : undefined;
      const head = shortSha(range.kind === 'commits' ? range.head : range.repoHead);
      return {range: range.label, ...(base ? {base} : {}), ...(head ? {head} : {}), files: out, totals, rev: ctx.rev()};
    },
  };
}
