// packages/server/src/code/highlight.ts
// Tokenising with Shiki on the JavaScript regex engine. One highlighter per process, created on first use; grammars
// load on demand. Output is TokenLine[]: [text, class] pairs with adjacent tokens of one class merged.
import type {TokenLine} from '@glimpse/catalog';
import type {GrammarState, HighlighterCore, ThemedToken} from 'shiki/core';
import {GRAMMARS, grammarOfName} from './langs.ts';
import {classOfColor, glimpseTheme, THEME_NAME} from './theme.ts';

/** Lines tokenised per turn of the event loop. */
const CHUNK_LINES = 400;
/** Longer lines are returned as plain text: minified code is not worth the regex time. */
const MAX_TOKENIZED_LINE = 2_000;
const LINE_TIME_LIMIT_MS = 200;

export interface TokenRun {
  lines: TokenLine[];
  /** Grammar state after the last line: pass it back to continue with the lines that follow. */
  state?: GrammarState;
}

let core: Promise<HighlighterCore> | undefined;
const loaded = new Map<string, Promise<boolean>>();

// Shiki is imported on first use: a session that never shows code never loads it.
function highlighter(): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{createHighlighterCore}, {createJavaScriptRegexEngine}] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript')]);
    // forgiving: a pattern the JavaScript engine cannot express is skipped instead of failing the whole grammar
    return createHighlighterCore({themes: [glimpseTheme], langs: [], engine: createJavaScriptRegexEngine({forgiving: true})});
  })();
  return core;
}

/**
 * Resolves a language name or alias to a grammar id and makes sure the grammar is loaded.
 * Answers undefined for an unknown language, or one whose grammar fails to load: the caller shows plain text.
 */
export async function prepareLang(name: string | undefined, log: (message: string) => void = () => {}): Promise<string | undefined> {
  const id = grammarOfName(name);
  if (!id) return undefined;
  let ready = loaded.get(id);
  if (!ready) {
    ready = (async () => {
      try {
        const [shiki, grammar] = await Promise.all([highlighter(), GRAMMARS[id]!()]);
        await shiki.loadLanguage(grammar.default);
        return true;
      } catch (error) {
        log(`glimpse: grammar ${id} failed to load: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    })();
    loaded.set(id, ready);
  }
  return (await ready) ? id : undefined;
}

/** Splits text into lines the way the tokenizer does; a trailing newline does not start another line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function plainLines(lines: readonly string[]): TokenLine[] {
  return lines.map(line => (line === '' ? [] : [[line, 0]]));
}

function toTokenLine(tokens: readonly ThemedToken[]): TokenLine {
  const line: TokenLine = [];
  for (const token of tokens) {
    if (token.content === '') continue;
    const cls = classOfColor(token.color);
    const last = line.at(-1);
    if (last && last[1] === cls) last[0] += token.content;
    else line.push([token.content, cls]);
  }
  return line;
}

const nextTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/**
 * Tokenises `lines` with a grammar prepared by prepareLang(), continuing from `state` when given.
 * Long inputs are processed in chunks with a pause between them so the server stays responsive.
 * A grammar that throws degrades to plain text for the lines it could not handle.
 */
export async function tokenizeLines(lines: readonly string[], grammar: string, state?: GrammarState): Promise<TokenRun> {
  const shiki = await highlighter();
  const out: TokenLine[] = [];
  let current = state;
  for (let from = 0; from < lines.length; from += CHUNK_LINES) {
    if (from > 0) await nextTurn();
    const chunk = lines.slice(from, from + CHUNK_LINES);
    try {
      const tokens = shiki.codeToTokensBase(chunk.join('\n'), {
        lang: grammar,
        theme: THEME_NAME,
        grammarState: current,
        tokenizeMaxLineLength: MAX_TOKENIZED_LINE,
        tokenizeTimeLimit: LINE_TIME_LIMIT_MS,
      });
      current = shiki.getLastGrammarState(tokens) ?? current;
      // The tokenizer splits on the same line breaks, so the counts agree; the fallback keeps the result aligned if not.
      for (let i = 0; i < chunk.length; i++) out.push(tokens[i] ? toTokenLine(tokens[i]!) : plainLines([chunk[i]!])[0]!);
    } catch {
      out.push(...plainLines(chunk));
      current = undefined;
    }
  }
  return {lines: out, state: current};
}
