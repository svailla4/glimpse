// code.symbols, code.refs, code.todos: what is inside the files.
import {readFileSync} from 'node:fs';
import type {Rows} from '@glimpse/catalog';
import {repoModel, type RepoModel} from '../../analyze/index.ts';
import {MAX_READ_BYTES} from '../../analyze/inventory.ts';
import {languageOf} from '../../analyze/languages.ts';
import {SourceError, type RepoContext, type Source} from '../../contracts.ts';
import {filesIn} from './files.ts';
import {byText, define, plural, rowsResult, scopeOf} from './shared.ts';

interface Match {
  path: string;
  line: number;
  text: string;
}

const MAX_MATCHES = 20_000;
const MAX_TEXT = 240;
const GREP_BUFFER = 16 * 1024 * 1024;
const SLICE_MS = 12;

const isWordChar = (code: number) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;

/** Lines of `text` holding `word` between word boundaries: the rule `git grep -w -F` applies. */
export function wordMatches(text: string, word: string): Array<{line: number; text: string}> {
  const out: Array<{line: number; text: string}> = [];
  let line = 1;
  let counted = 0;
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    const end = at + word.length;
    if ((at > 0 && isWordChar(text.charCodeAt(at - 1))) || (end < text.length && isWordChar(text.charCodeAt(end)))) continue;
    for (let newline = text.indexOf('\n', counted); newline !== -1 && newline < at; newline = text.indexOf('\n', newline + 1)) {
      line++;
      counted = newline + 1;
    }
    const lineEnd = text.indexOf('\n', at);
    out.push({line, text: text.slice(counted, lineEnd === -1 ? text.length : lineEnd).replace(/\r$/, '')});
    if (lineEnd === -1) break;
    // One row per line: continue after it.
    at = lineEnd;
  }
  return out;
}

async function grepWithGit(ctx: RepoContext, word: string, signal: AbortSignal): Promise<Match[] | undefined> {
  if (!ctx.git) return undefined;
  let out: Buffer;
  try {
    out = await ctx.runGit(['grep', '-n', '-w', '-F', '-I', '-z', '--untracked', '--no-color', '-e', word, '--', '.'], {signal, maxBuffer: GREP_BUFFER});
  } catch {
    // git grep exits 1 when nothing matches, and RunGit cannot tell that from a failure: the scan below decides.
    signal.throwIfAborted();
    return undefined;
  }
  const matches: Match[] = [];
  for (const record of out.toString('utf8').split('\n')) {
    const first = record.indexOf('\0');
    const second = record.indexOf('\0', first + 1);
    if (first <= 0 || second === -1) continue;
    const line = Number(record.slice(first + 1, second));
    if (Number.isInteger(line)) matches.push({path: record.slice(0, first), line, text: record.slice(second + 1).replace(/\r$/, '')});
  }
  return matches;
}

/** The same search without git: every readable text file of the inventory, in short slices. */
async function grepInProcess(ctx: RepoContext, model: RepoModel, word: string, signal: AbortSignal): Promise<Match[]> {
  const matches: Match[] = [];
  let since = performance.now();
  for (const file of model.files) {
    if (file.binary || file.generated || file.bytes > MAX_READ_BYTES || file.bytes < word.length) continue;
    let text: string;
    try {
      text = readFileSync(`${ctx.root}/${file.path}`, 'utf8');
    } catch {
      continue;
    }
    for (const match of wordMatches(text, word)) matches.push({path: file.path, ...match});
    if (matches.length >= MAX_MATCHES) break;
    if (performance.now() - since > SLICE_MS) {
      await new Promise<void>(resolve => setImmediate(resolve));
      signal.throwIfAborted();
      since = performance.now();
    }
  }
  return matches;
}

export function codeSources(): Source[] {
  const symbols = define('code.symbols', async (ctx, ref, _signal, meta) => {
    const target = scopeOf(ref);
    if (target === '') throw new SourceError('E_TARGET', `${meta.name} needs a file path, e.g. ${meta.name} src/index.ts`);
    const model = await repoModel(ctx);
    const file = model.byPath.get(target);
    if (!file) throw new SourceError('E_TARGET', `${meta.name}: no such file "${target}"`);
    const rows = (model.facts.get(target)?.symbols ?? []) as unknown as Rows;
    const warnings: string[] = [];
    if (file.binary) warnings.push('binary file: no outline');
    else if (file.generated) warnings.push('generated file: not scanned');
    else if (!languageOf(target)?.scan && !languageOf(target)?.outline) warnings.push(`no symbol patterns for ${file.lang ?? 'this file type'}: the outline is empty`);
    const lead = rows.filter(row => row.depth === 0).slice(0, 6).map(row => String(row.name)).join(' ');
    const result = rowsResult(meta, ref, rows, {by: 'line', lead, warnings});
    // The scanner keeps the first 2,000 declarations of a file; a longer outline says so instead of looking complete.
    const found = model.facts.get(target)?.symbolsFound;
    if (found !== undefined && found > rows.length) {
      result.truncated = {total: found, returned: result.data.length, strategy: 'topN', by: 'line'};
      result.warnings = [...(result.warnings ?? []), `outline shows the first ${rows.length.toLocaleString('en-US')} of about ${found.toLocaleString('en-US')} declarations`];
    }
    return result;
  });

  const refs = define('code.refs', async (ctx, ref, signal, meta) => {
    const word = (ref.target ?? '').trim();
    if (word === '') throw new SourceError('E_TARGET', `${meta.name} needs an identifier, e.g. ${meta.name} createServer`);
    if (word.length > 200 || /[\0\r\n]/.test(word)) throw new SourceError('E_TARGET', `${meta.name}: "${word.slice(0, 40)}" is not an identifier`);
    const model = await repoModel(ctx);
    const found = (await grepWithGit(ctx, word, signal)) ?? (await grepInProcess(ctx, model, word, signal));
    // Only files of the inventory count, so both searches agree and nothing generated floods the list.
    const matches = found.filter(match => {
      const file = model.byPath.get(match.path);
      return file !== undefined && !file.generated && !file.binary;
    });
    if (matches.length === 0) throw new SourceError('E_TARGET', `${meta.name}: no matches for "${word}"`);
    const defines = (path: string) => model.facts.get(path)?.symbols.some(symbol => symbol.name === word) === true;
    const definedIn = [...new Set(matches.map(match => match.path))].filter(defines);
    const rank = new Set(definedIn);
    matches.sort((a, b) => Number(rank.has(b.path)) - Number(rank.has(a.path)) || byText(a.path, b.path) || a.line - b.line);
    const rows: Rows = matches.map(match => ({file: `${match.path}#L${match.line}`, text: match.text.trimEnd().slice(0, MAX_TEXT)}));
    const fileCount = new Set(matches.map(match => match.path)).size;
    const lead = `${plural(matches.length, 'match', 'matches')} in ${plural(fileCount, 'file')}${definedIn[0] ? `; defined in ${definedIn[0]}` : ''}`;
    return rowsResult(meta, ref, rows, {by: 'file', lead, warnings: matches.length >= MAX_MATCHES ? [`stopped at ${MAX_MATCHES} matches`] : []});
  });

  const todos = define('code.todos', async (ctx, ref, _signal, meta) => {
    const scope = scopeOf(ref);
    const model = await repoModel(ctx);
    const rows: Rows = [];
    const tags = new Map<string, number>();
    for (const file of filesIn(model, scope, meta.name)) {
      for (const todo of model.facts.get(file.path)?.todos ?? []) {
        rows.push({tag: todo.tag, file: `${file.path}#L${todo.line}`, text: todo.text});
        tags.set(todo.tag, (tags.get(todo.tag) ?? 0) + 1);
      }
    }
    const lead = [...tags].sort((a, b) => b[1] - a[1] || byText(a[0], b[0])).map(([tag, n]) => `${n} ${tag}`).join(', ');
    return rowsResult(meta, ref, rows, {by: 'file', lead});
  });

  return [symbols, refs, todos];
}
