// packages/server/src/code/index.ts
// The code service behind /api/file, /api/highlight and /api/outline.
import {realpath} from 'node:fs/promises';
import type {HighlightResult} from '@glimpse/catalog';
import type {CodeService, RepoContext} from '../contracts.ts';
import {createFileReader} from './file.ts';
import {plainLines, prepareLang, splitLines, tokenizeLines} from './highlight.ts';
import {PLAIN_LANG} from './langs.ts';
import {outlineOf} from './outline.ts';

/** Snippets above this size are returned as plain text. */
const MAX_HIGHLIGHT_CHARS = 500_000;

export function createCodeService(ctx: RepoContext): CodeService {
  // ctx.root is documented as a real path; resolving it again costs one call and keeps containment honest if it is not.
  const root = realpath(ctx.root).catch(() => ctx.root);

  return {
    file: createFileReader(ctx, root),

    async highlight(code, lang): Promise<HighlightResult> {
      const lines = splitLines(typeof code === 'string' ? code : '');
      const grammar = typeof code === 'string' && code.length <= MAX_HIGHLIGHT_CHARS ? await prepareLang(lang, ctx.log) : undefined;
      if (!grammar) return {lang: PLAIN_LANG, lines: plainLines(lines)};
      return {lang: grammar, lines: (await tokenizeLines(lines, grammar)).lines};
    },

    outline: path => outlineOf(ctx, path),
  };
}
