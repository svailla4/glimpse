// Bounded auto-repair (design 2.2 step 3): a misspelt component or prop within edit distance 2 is renamed and an
// unexpected end of input closes the open brackets. Everything else stays an error. A repair edits the normalized
// Express text and is reported to the model as `fixed A -> B`, so it learns the right spelling.
import {COMPONENT_BY_NAME, COMPONENTS} from '@glimpse/catalog';
import {closeMatch, type RepairHint} from './errors.ts';

export interface Repair {
  text: string;
  /** The text after `fixed `, e.g. `DataTabel -> DataTable`. */
  note: string;
}

interface Token { kind: 'ident' | 'punct'; text: string; start: number }
interface Lexed { tokens: Token[]; /** The text ends inside a line comment, so appended text must start on a new line. */ endsInComment: boolean }

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

/** Identifiers and punctuation of normalized Express; strings and comments are skipped, never edited. */
function lex(src: string): Lexed {
  const tokens: Token[] = [];
  let endsInComment = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"') {
      const triple = src.startsWith('"""', i);
      const close = triple ? '"""' : '"';
      let j = i + close.length;
      while (j < src.length && !src.startsWith(close, j)) j += src[j] === '\\' ? 2 : 1;
      i = Math.min(src.length, j + close.length);
      endsInComment = false;
    } else if (c === '#' || (c === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') i++;
      endsInComment = true;
    } else if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < src.length && IDENT_PART.test(src[j]!)) j++;
      // r"..." is a raw string, not the identifier r.
      if (j === i + 1 && c === 'r' && src[j] === '"') { i = j; continue; }
      tokens.push({kind: 'ident', text: src.slice(i, j), start: i});
      endsInComment = false;
      i = j;
    } else {
      if (!/\s/.test(c)) {
        tokens.push({kind: 'punct', text: c, start: i});
        endsInComment = false;
      }
      i++;
    }
  }
  return {tokens, endsInComment};
}

const CLOSER: Record<string, string> = {'(': ')', '[': ']', '{': '}'};

function replaceAt(src: string, starts: number[], from: string, to: string): string {
  let out = src;
  for (const start of [...starts].sort((a, b) => b - a)) out = out.slice(0, start) + to + out.slice(start + from.length);
  return out;
}

function renameComponent(src: string, name: string): Repair | undefined {
  if (COMPONENT_BY_NAME.has(name)) return undefined;
  const target = closeMatch(name, COMPONENTS.map(c => c.name));
  if (!target) return undefined;
  const {tokens} = lex(src);
  const starts = tokens.filter((t, i) => t.kind === 'ident' && t.text === name && tokens[i + 1]?.text === '(').map(t => t.start);
  return starts.length > 0 ? {text: replaceAt(src, starts, name, target), note: `${name} -> ${target}`} : undefined;
}

/** Renames `name=` only as a keyword argument written directly inside a call of `component`. */
function renameProp(src: string, component: string, name: string): Repair | undefined {
  const def = COMPONENT_BY_NAME.get(component);
  if (!def || name in def.props) return undefined;
  const target = closeMatch(name, Object.keys(def.props));
  if (!target) return undefined;
  const {tokens} = lex(src);
  const stack: Array<string | undefined> = [];
  const starts: number[] = [];
  tokens.forEach((token, i) => {
    if (token.kind === 'punct' && token.text in CLOSER) {
      const prev = tokens[i - 1];
      stack.push(token.text === '(' && prev?.kind === 'ident' ? prev.text : undefined);
    } else if (token.kind === 'punct' && (token.text === ')' || token.text === ']' || token.text === '}')) {
      stack.pop();
    } else if (token.kind === 'ident' && token.text === name && stack.at(-1) === component && tokens[i + 1]?.text === '=' && tokens[i + 2]?.text !== '=') {
      starts.push(token.start);
    }
  });
  return starts.length > 0 ? {text: replaceAt(src, starts, name, target), note: `${name} -> ${target}`} : undefined;
}

function closeBrackets(src: string): Repair | undefined {
  const {tokens, endsInComment} = lex(src);
  const stack: string[] = [];
  for (const token of tokens) {
    if (token.kind !== 'punct') continue;
    if (token.text in CLOSER) stack.push(CLOSER[token.text]!);
    else if (token.text === ')' || token.text === ']' || token.text === '}') {
      if (stack.pop() !== token.text) return undefined; // mismatched, not merely unfinished
    }
  }
  if (stack.length === 0) return undefined;
  const closers = stack.reverse().join('');
  return {text: src.replace(/\s+$/, '') + (endsInComment ? '\n' : '') + closers, note: `end of input -> ${closers}`};
}

/** The repaired text for a problem, or undefined when the problem is not one Glimpse repairs. */
export function repair(text: string, hint: RepairHint): Repair | undefined {
  if (hint.kind === 'component') return renameComponent(text, hint.name);
  if (hint.kind === 'prop') return renameProp(text, hint.component, hint.name);
  return closeBrackets(text);
}
