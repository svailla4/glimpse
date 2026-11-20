// Bounded auto-repair (design 2.2 step 3): what the author plainly meant is accepted and reported, never silently.
// A misspelt component or prop within edit distance 2 is renamed; an enum value that is a synonym or a near miss of
// an allowed one is replaced (Callout kind 'warning' -> warn); a number where the prop takes a string is quoted
// (Grid cols=4); an unexpected end of input closes the open brackets. Everything else stays an error. A repair
// edits the normalized Express text and is reported to the model as `fixed A -> B`, so it learns the right spelling.
import {COMPONENT_BY_NAME, COMPONENTS, enumValue, type Prop} from '@glimpse/catalog';
import {closeMatch, type RepairHint} from './errors.ts';
import {stringValue, tokenize, type SpecToken} from './guard.ts';

export interface Repair {
  text: string;
  /** The text after `fixed `, e.g. `DataTabel -> DataTable`. */
  note: string;
}

const CLOSER: Record<string, string> = {'(': ')', '[': ']', '{': '}'};
const isOpen = (token: SpecToken) => token.kind === 'punct' && token.text in CLOSER;
const isClose = (token: SpecToken) => token.kind === 'punct' && (token.text === ')' || token.text === ']' || token.text === '}');

function replaceAt(src: string, edits: Array<{start: number; end: number; text: string}>): string {
  let out = src;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

function renameComponent(src: string, name: string): Repair | undefined {
  if (COMPONENT_BY_NAME.has(name)) return undefined;
  const target = closeMatch(name, COMPONENTS.map(c => c.name));
  if (!target) return undefined;
  const {tokens} = tokenize(src);
  const edits = tokens.filter((t, i) => t.kind === 'ident' && t.text === name && tokens[i + 1]?.text === '(').map(t => ({start: t.start, end: t.end, text: target}));
  return edits.length > 0 ? {text: replaceAt(src, edits), note: `${name} -> ${target}`} : undefined;
}

/** One argument written directly inside a call: `value` is its first token. */
interface Argument { callee: string; index: number; keyword: string | undefined; value: SpecToken; keywordToken: SpecToken | undefined }

/** Every argument of every call in the text, positional index and keyword included. Nested brackets are skipped over. */
function callArguments(tokens: SpecToken[]): Argument[] {
  const out: Argument[] = [];
  interface Frame { callee: string | undefined; index: number; keyword: SpecToken | undefined; fresh: boolean }
  const stack: Frame[] = [];
  tokens.forEach((token, i) => {
    const top = stack.at(-1);
    if (top?.callee !== undefined && top.fresh && !isClose(token)) {
      // `name = value` (but not `==`) is a keyword argument; anything else is the positional value itself.
      if (token.kind === 'ident' && tokens[i + 1]?.text === '=' && tokens[i + 2]?.text !== '=') { top.keyword = token; return; }
      if (token.text === '=' && top.keyword && tokens[i - 1] === top.keyword) return;
      out.push({callee: top.callee, index: top.index, keyword: top.keyword?.text, value: token, keywordToken: top.keyword});
      top.fresh = false;
    }
    if (isOpen(token)) {
      const prev = tokens[i - 1];
      stack.push({callee: token.text === '(' && prev?.kind === 'ident' ? prev.text : undefined, index: 0, keyword: undefined, fresh: true});
    } else if (isClose(token)) {
      stack.pop();
    } else if (token.text === ',' && top) {
      top.index++;
      top.keyword = undefined;
      top.fresh = true;
    }
  });
  return out;
}

/** The arguments that set `prop` of `component`: by keyword, or by position in signature order. */
function argumentsOf(src: string, component: string, prop: string): Argument[] {
  const def = COMPONENT_BY_NAME.get(component);
  if (!def) return [];
  const position = Object.keys(def.props).indexOf(prop);
  return callArguments(tokenize(src).tokens).filter(arg => arg.callee === component && (arg.keyword === prop || (arg.keyword === undefined && arg.index === position)));
}

/** Renames `name=` only as a keyword argument written directly inside a call of `component`. */
function renameProp(src: string, component: string, name: string): Repair | undefined {
  const def = COMPONENT_BY_NAME.get(component);
  if (!def || name in def.props) return undefined;
  const target = closeMatch(name, Object.keys(def.props));
  if (!target) return undefined;
  const edits = callArguments(tokenize(src).tokens)
    .filter(arg => arg.callee === component && arg.keyword === name && arg.keywordToken)
    .map(arg => ({start: arg.keywordToken!.start, end: arg.keywordToken!.end, text: target}));
  return edits.length > 0 ? {text: replaceAt(src, edits), note: `${name} -> ${target}`} : undefined;
}

/**
 * What people write for an enum value, and the catalog words it may stand for (the first one the prop allows wins).
 * Keys are lower case.
 */
const SYNONYMS: Record<string, readonly string[]> = {
  warning: ['warn'], caution: ['warn'], alert: ['warn', 'risk'],
  danger: ['risk', 'bad'], error: ['risk', 'bad'], critical: ['risk', 'bad'], failure: ['risk', 'bad'],
  info: ['note', 'info'], information: ['note', 'info'], hint: ['tip'],
  success: ['tip', 'good'], ok: ['good', 'tip'], positive: ['good'], negative: ['bad'],
  small: ['s'], sm: ['s'], medium: ['m'], md: ['m'], large: ['l'], lg: ['l'], xlarge: ['xl'], full: ['fill'], auto: ['fill'],
  horizontal: ['row', 'h', 'LR'], vertical: ['col', 'v', 'TB'], column: ['col', 'v'], rows: ['row'], columns: ['col'],
  lr: ['LR'], tb: ['TB'], 'left-right': ['LR'], 'top-bottom': ['TB'], 'top-down': ['TB'],
  stack: ['stacked'], percent: ['pct'], percentage: ['pct'], '%': ['pct'], group: ['grouped'],
  centre: ['center'], middle: ['center'], left: ['start'], right: ['end'], top: ['start'], bottom: ['end'],
  side: ['split'], 'side-by-side': ['split'], inline: ['unified'],
  secondary: ['quiet'], ghost: ['quiet'], subtle: ['quiet', 'dim'], muted: ['dim'], code: ['mono'], monospace: ['mono'],
  number: ['num'], size: ['bytes', 'loc'], lines: ['loc'], language: ['lang'], log10: ['log'],
};

/** The allowed value a rejected one most plausibly meant: same word in another case, a synonym, or a near miss. */
export function enumMeant(value: string, allowed: readonly string[]): string | undefined {
  const wanted = value.trim().toLowerCase();
  if (!wanted) return undefined;
  return allowed.find(option => option.toLowerCase() === wanted)
    ?? (Object.hasOwn(SYNONYMS, wanted) ? SYNONYMS[wanted]!.find(option => allowed.includes(option)) : undefined)
    ?? closeMatch(value, allowed);
}

function replaceEnum(src: string, component: string, prop: string, value: string): Repair | undefined {
  const def = (COMPONENT_BY_NAME.get(component)?.props as Record<string, Prop> | undefined)?.[prop];
  // The catalog's own aliases for this prop come first; the general table and near misses cover the rest.
  const target = def?.values ? enumValue(def, value) ?? enumMeant(value, def.values) : undefined;
  if (!target) return undefined;
  const edits = argumentsOf(src, component, prop)
    .filter(arg => arg.value.kind === 'string' && stringValue(arg.value) === value)
    .map(arg => ({start: arg.value.start, end: arg.value.end, text: JSON.stringify(target)}));
  return edits.length > 0 ? {text: replaceAt(src, edits), note: `${component}.${prop} ${value} -> ${target}`} : undefined;
}

function quoteNumber(src: string, component: string, prop: string): Repair | undefined {
  const args = argumentsOf(src, component, prop).filter(arg => arg.value.kind === 'number');
  if (args.length === 0) return undefined;
  const edits = args.map(arg => ({start: arg.value.start, end: arg.value.end, text: JSON.stringify(arg.value.text)}));
  return {text: replaceAt(src, edits), note: `${component}.${prop} ${args[0]!.value.text} -> '${args[0]!.value.text}'`};
}

function closeBrackets(src: string): Repair | undefined {
  const {tokens, endsInComment} = tokenize(src);
  const stack: string[] = [];
  for (const token of tokens) {
    if (isOpen(token)) stack.push(CLOSER[token.text]!);
    else if (isClose(token) && stack.pop() !== token.text) return undefined; // mismatched, not merely unfinished
  }
  if (stack.length === 0) return undefined;
  const closers = stack.reverse().join('');
  return {text: src.replace(/\s+$/, '') + (endsInComment ? '\n' : '') + closers, note: `end of input -> ${closers}`};
}

/** The repaired text for a problem, or undefined when the problem is not one Glimpse repairs here. */
export function repair(text: string, hint: RepairHint): Repair | undefined {
  if (hint.kind === 'component') return renameComponent(text, hint.name);
  if (hint.kind === 'prop') return renameProp(text, hint.component, hint.name);
  if (hint.kind === 'enum') return replaceEnum(text, hint.component, hint.prop, hint.value);
  if (hint.kind === 'quote') return quoteNumber(text, hint.component, hint.prop);
  if (hint.kind === 'eof') return closeBrackets(text);
  return undefined;
}
