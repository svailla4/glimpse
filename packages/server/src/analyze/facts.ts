// One pass per file: imports, symbol outline, TODO tags and indentation complexity, from regular expressions only.
// The numbers are heuristics by design (no parser); they are exact enough to rank and to draw, and every pattern is
// bounded so that hostile or minified input cannot make a scan run away.
import type {SymbolRow} from '@glimpse/catalog';
import type {FileFacts} from '../contracts.ts';
import type {CommentStyle, Language, ScanLang} from './languages.ts';

export interface ScannedImport {
  spec: string;
  kind: string;
  line: number;
  /** Python `from x import a, b`: the imported names, which may themselves be modules. */
  names?: string[];
}
export interface ScannedFacts extends FileFacts {
  imports: ScannedImport[];
  /** Package or namespace declared by the file (JVM, C#, PHP, Go). */
  pkg?: string;
  scan?: ScanLang;
}

type Kind = SymbolRow['kind'];
/** `impl` is a Rust container that makes its functions methods; it is never emitted. */
type RawKind = Kind | 'impl';

const TAB_WIDTH = 4;
/** Lines longer than this are cut before the patterns run: no declaration worth listing is that long. */
const LONG_LINE = 1000;
const MAX_SYMBOLS = 2000;
const MAX_TODOS = 50;
const MAX_IMPORTS = 2000;
const MAX_DEPTH = 3;

// ---------------------------------------------------------------- imports
interface ImportRule {
  re: RegExp;
  spec: number;
  kind: (m: RegExpExecArray) => string;
  names?: number;
  /** `import a, b.c as d`: several specifiers in one match. */
  multi?: boolean;
  /** Go import blocks: `block` finds the block, `re` the entries inside it. */
  block?: RegExp;
  /** Rust `use a::{b, c}`: the group holding the brace list. */
  braces?: number;
  /** A second pattern over ground another rule covers: skipped where that rule already matched. */
  fallback?: boolean;
}

const IMPORTS: Record<ScanLang, ImportRule[]> = {
  ts: [
    {re: /(?:^|[;\n}])[ \t]*(import|export)\s{1,20}(type\s{1,20})?(?:[\w*${}\s,]{0,2000}?from\s{0,20})?(['"])([^'"\n]{1,300})\3/g, spec: 4,
      kind: m => (m[2] ? 'type' : m[1] === 'export' ? 'reexport' : 'static')},
    {re: /\b(require|import)\s{0,20}\(\s{0,20}(['"`])([^'"`\n$]{1,300})\2\s{0,20}[,)]/g, spec: 3, kind: m => (m[1] === 'import' ? 'dynamic' : 'require')},
    // Specifier lists longer than the first pattern allows, or with comments inside.
    {re: /\}\s{0,20}from\s{0,20}(['"])([^'"\n]{1,300})\1/g, spec: 2, kind: () => 'static', fallback: true},
  ],
  py: [
    {re: /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]{0,2000}\)|[^\n#]+)/gm, spec: 1, names: 2, kind: () => 'static'},
    {re: /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm, spec: 1, multi: true, kind: () => 'static'},
  ],
  go: [
    {re: /^import[ \t]+(?:[\w.]+[ \t]+)?"([^"\n]+)"/gm, spec: 1, kind: () => 'package'},
    {block: /^import[ \t]*\(([^)]*)\)/gm, re: /"([^"\n]+)"/g, spec: 1, kind: () => 'package'},
  ],
  rs: [
    {re: /^[ \t]*(?:pub(?:\([\w: ]+\))?[ \t]+)?use[ \t]+((?:crate|super|self|::)?[\w:]*)(?:\{([^;]{0,1500})\})?/gm, spec: 1, braces: 2, kind: () => 'static'},
    {re: /^[ \t]*(?:pub(?:\([\w: ]+\))?[ \t]+)?mod[ \t]+(\w+)[ \t]*;/gm, spec: 1, kind: () => 'mod'},
    {re: /^[ \t]*extern[ \t]+crate[ \t]+(\w+)/gm, spec: 1, kind: () => 'static'},
  ],
  java: [{re: /^[ \t]*import[ \t]+(static[ \t]+)?([\w.]+)(\.\*)?[ \t]*;/gm, spec: 2, kind: m => (m[1] ? 'member' : m[3] ? 'wildcard' : 'static')}],
  kt: [{re: /^[ \t]*import[ \t]+([\w.`]+?)(\.\*)?(?:[ \t]+as[ \t]+\w+)?[ \t]*;?[ \t]*$/gm, spec: 1, kind: m => (m[2] ? 'wildcard' : 'static')}],
  rb: [{re: /^[ \t]*(require_relative|require|load)[ \t(]*(['"])([^'"\n]+)\2/gm, spec: 3, kind: m => (m[1] === 'require_relative' ? 'relative' : 'static')}],
  cs: [{re: /^[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+)?(?:\w+[ \t]*=[ \t]*)?([\w.]+)[ \t]*;/gm, spec: 1, kind: () => 'package'}],
  php: [
    {re: /^[ \t]*use[ \t]+(?:function[ \t]+|const[ \t]+)?\\?([\w\\]+)(?:[ \t]+as[ \t]+\w+)?[ \t]*;/gm, spec: 1, kind: () => 'static'},
    {re: /\b(?:require|include)(?:_once)?[ \t(]*(?:__DIR__[ \t]*\.[ \t]*)?(['"])([^'"\n]+)\1/g, spec: 2, kind: () => 'relative'},
  ],
  swift: [{re: /^[ \t]*(?:@\w+[ \t]+)*import[ \t]+(?:(?:struct|class|enum|protocol|func|var|let|typealias)[ \t]+)?([\w.]+)/gm, spec: 1, kind: () => 'package'}],
  dart: [{re: /^[ \t]*(import|export|part)[ \t]+(['"])([^'"\n]+)\2/gm, spec: 3, kind: m => (m[1] === 'export' ? 'reexport' : m[1] === 'part' ? 'part' : 'static')}],
  c: [{re: /^[ \t]*#[ \t]*(?:include|import)[ \t]*(["<])([^">\n]+)[">]/gm, spec: 2, kind: m => (m[1] === '<' ? 'system' : 'relative')}],
};

const PACKAGE_DECL: Partial<Record<ScanLang, RegExp>> = {
  java: /^[ \t]*package[ \t]+([\w.]+)/m,
  kt: /^[ \t]*package[ \t]+([\w.`]+)/m,
  cs: /^[ \t]*namespace[ \t]+([\w.]+)/m,
  php: /^[ \t]*namespace[ \t]+([\w\\]+)/m,
  go: /^package[ \t]+(\w+)/m,
};

// ---------------------------------------------------------------- symbols
interface SymbolRule {
  /** Group 1 is always the indentation. */
  re: RegExp;
  name: number;
  /** A group holding the keyword, a fixed kind, or a function of the match. */
  kind: number | RawKind | ((m: RegExpExecArray) => RawKind);
  mods?: number;
  /** Only valid directly inside a class body (methods and fields that have no keyword of their own). */
  member?: boolean;
  /** No keyword announces the name, so a statement keyword in its place means the line is not a declaration. */
  guard?: boolean;
}

const KEYWORD_KIND: Readonly<Record<string, RawKind>> = {
  function: 'fn', 'function*': 'fn', fn: 'fn', func: 'fn', fun: 'fn', def: 'fn', 'macro_rules!': 'fn',
  class: 'class', struct: 'class', record: 'class', object: 'class', actor: 'class', extension: 'class', union: 'class', mixin: 'class',
  interface: 'iface', protocol: 'iface', trait: 'iface', '@interface': 'iface',
  enum: 'enum',
  namespace: 'mod', module: 'mod', mod: 'mod',
  type: 'type', typealias: 'type', typedef: 'type',
  const: 'const', val: 'const', static: 'const',
  let: 'var', var: 'var',
};

const TS_MODS = '(?:public|private|protected|static|async|override|abstract|readonly|declare|accessor|get|set)';
const SYMBOLS: Record<ScanLang, SymbolRule[]> = {
  ts: [
    {re: /^([ \t]*)(export[ \t]+)?(?:default[ \t]+)?(?:declare[ \t]+)?(?:abstract[ \t]+)?(?:async[ \t]+)?(?:const[ \t]+)?(function\*?|class|interface|enum|namespace|module)[ \t]+([A-Za-z_$][\w$]*)/gm, kind: 3, name: 4, mods: 2},
    {re: /^([ \t]*)(export[ \t]+)?(?:declare[ \t]+)?(type)[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?:<[^=\n]*>)?[ \t]*=/gm, kind: 3, name: 4, mods: 2},
    {re: /^([ \t]*)(export[ \t]+)?(?:declare[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?::[^=\n]+)?=[ \t]*(?:async[ \t]*)?(?:\([^()\n]*\)[ \t]*(?::[^=\n]*)?=>|\([ \t]*$|function\b|<[\w ,]+>[ \t]*\(|[A-Za-z_$][\w$]*[ \t]*=>|(?:React\.)?(?:memo|forwardRef)\()/gm, kind: 'fn', name: 3, mods: 2},
    {re: /^()(export[ \t]+)?(?:declare[ \t]+)?(const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gm, kind: 3, name: 4, mods: 2, guard: true},
    {re: new RegExp(`^([ \\t]+)((?:${TS_MODS}[ \\t]+)*)(\\*?[A-Za-z_$#][\\w$]*)[ \\t]*(?:<[^>\\n]*>)?\\((?:[^\\n]*\\{|[^\\n)]*)[ \\t]*$`, 'gm'), kind: 'method', name: 3, mods: 2, member: true, guard: true},
    {re: new RegExp(`^([ \\t]+)((?:${TS_MODS}[ \\t]+)*)([A-Za-z_$#][\\w$]*)[ \\t]*(?::[^=\\n]+)?=[ \\t]*(?:async[ \\t]*)?\\([^()\\n]*\\)[ \\t]*(?::[^=\\n]*)?=>`, 'gm'), kind: 'method', name: 3, mods: 2, member: true, guard: true},
    {re: new RegExp(`^([ \\t]+)((?:${TS_MODS}[ \\t]+)*)([A-Za-z_$#][\\w$]*)[?!]?[ \\t]*(?::[^=;\\n]+)?(?:=[^=>\\n][^\\n]*)?;[ \\t]*$`, 'gm'), kind: 'var', name: 3, mods: 2, member: true, guard: true},
  ],
  py: [
    {re: /^([ \t]*)(?:async[ \t]+)?(def|class)[ \t]+(\w+)/gm, kind: 2, name: 3},
    // Module constants, private ones included: `_DEFAULT_VERSION: Final[str] = "0.9"`.
    {re: /^()(_{0,2}[A-Z][A-Z0-9_]+)[ \t]*(?::[^=\n]+)?=(?!=)/gm, kind: 'const', name: 2},
  ],
  go: [
    {re: /^()func[ \t]+(\([^)\n]*\)[ \t]*)?([A-Za-z_]\w*)/gm, kind: m => (m[2] ? 'method' : 'fn'), name: 3},
    {re: /^()type[ \t]+([A-Za-z_]\w*)[ \t]+(struct\b|interface\b)?/gm, kind: m => (m[3] === 'struct' ? 'class' : m[3] === 'interface' ? 'iface' : 'type'), name: 2},
    {re: /^()(const|var)[ \t]+([A-Za-z_]\w*)/gm, kind: 2, name: 3},
  ],
  rs: [
    {re: /^([ \t]*)(pub(?:\([\w: ]+\))?[ \t]+)?(?:default[ \t]+)?(?:const[ \t]+)?(?:async[ \t]+)?(?:unsafe[ \t]+)?(?:extern[ \t]+"[^"\n]*"[ \t]+)?(fn|struct|enum|trait|mod|type|union|macro_rules!)[ \t]+(\w+)/gm, kind: 3, name: 4, mods: 2},
    {re: /^([ \t]*)(pub(?:\([\w: ]+\))?[ \t]+)?(?:const|static)[ \t]+(?:mut[ \t]+)?([A-Z_][A-Z0-9_]*)[ \t]*:/gm, kind: 'const', name: 3, mods: 2},
    {re: /^([ \t]*)(?:unsafe[ \t]+)?(impl)\b/gm, kind: 'impl', name: 2},
  ],
  java: [
    {re: /^([ \t]*)((?:(?:public|protected|private|static|final|abstract|sealed|non-sealed|strictfp)[ \t]+)*)(class|interface|enum|record|@interface)[ \t]+(\w+)/gm, kind: 3, name: 4, mods: 2},
    {re: /^([ \t]+)((?:(?:public|protected|private|static|final|abstract|synchronized|native|default)[ \t]+)+)(?:<[^>\n]+>[ \t]+)?[\w.<>[\], ?]+[ \t]+(\w+)[ \t]*\([^;{=\n]*\)?[ \t]*(?:throws[ \t]+[\w., ]+)?[ \t]*\{?[ \t]*$/gm, kind: 'method', name: 3, mods: 2, guard: true},
  ],
  kt: [
    {re: /^([ \t]*)((?:(?:public|private|internal|protected|open|abstract|sealed|data|inline|suspend|override|operator|infix|tailrec|external|actual|expect|enum|annotation|value|companion|const|lateinit)[ \t]+)*)(fun|class|interface|object|typealias)[ \t]+(?:<[^>\n]+>[ \t]+)?(?:[\w.<>?, ]+\.)?(\w+)/gm,
      kind: m => (/\benum\b/.test(m[2] ?? '') ? 'enum' : (KEYWORD_KIND[m[3] ?? ''] ?? 'fn')), name: 4, mods: 2},
    {re: /^()((?:(?:public|private|internal|const|lateinit|override)[ \t]+)*)(val|var)[ \t]+(\w+)/gm, kind: 3, name: 4, mods: 2},
  ],
  rb: [
    {re: /^([ \t]*)(def|class|module)[ \t]+((?:self\.)?[\w:]+[?!=]?)/gm, kind: 2, name: 3},
    {re: /^([ \t]*)([A-Z][A-Z0-9_]+)[ \t]*=(?![=~])/gm, kind: 'const', name: 2},
  ],
  cs: [
    {re: /^([ \t]*)((?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|unsafe|file)[ \t]+)*)(class|interface|struct|enum|record)[ \t]+(?:(?:class|struct)[ \t]+)?(\w+)/gm, kind: 3, name: 4, mods: 2},
    {re: /^([ \t]+)((?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|new|partial)[ \t]+)+)[\w.<>[\], ?]+[ \t]+(\w+)[ \t]*(?:<[^>\n]+>)?[ \t]*\([^;{=\n]*\)?[ \t]*(?:where[^\n{]+)?\{?[ \t]*$/gm, kind: 'method', name: 3, mods: 2, guard: true},
  ],
  php: [
    {re: /^([ \t]*)((?:(?:public|private|protected|static|abstract|final|readonly)[ \t]+)*)(function|class|interface|trait|enum)[ \t]+&?(\w+)/gm,
      kind: m => (m[3] === 'trait' ? 'class' : (KEYWORD_KIND[m[3] ?? ''] ?? 'fn')), name: 4, mods: 2},
    {re: /^([ \t]*)((?:(?:public|private|protected|final)[ \t]+)*)const[ \t]+(\w+)/gm, kind: 'const', name: 3, mods: 2},
  ],
  swift: [
    {re: /^([ \t]*)((?:(?:public|private|fileprivate|internal|open|static|final|override|mutating|nonisolated|indirect|convenience|required|@\w+(?:\([^)\n]*\))?)[ \t]+)*)(func|class|struct|enum|protocol|extension|actor|typealias)[ \t]+([\w.]+)/gm, kind: 3, name: 4, mods: 2},
  ],
  dart: [
    {re: /^([ \t]*)((?:(?:abstract|final|sealed|base|interface|mixin)[ \t]+)*)(class|mixin|enum|extension|typedef)[ \t]+(?:type[ \t]+)?(\w+)/gm, kind: 3, name: 4},
    // `Type name(...) {` or `=>`; the type may be generic with spaces (`Map<String, Object?>`), and a signature may
    // break after its opening parenthesis (named parameters in braces follow on the next lines).
    {re: /^([ \t]*)((?:(?:static|external|override|@override)[ \t]+)*)(?!(?:return|await|throw|new|else|case|final|const|var|yield|if|for|while|switch|assert|in|is|as)\b)[A-Za-z_][\w.]*(?:<[^\n;(){}=]{0,200}>)?\??(?:\[\])?[ \t]+(?:get[ \t]+)?(\w+)[ \t]*(?:<[^>\n]+>)?\((?:[^;{}]{0,400}?\)[ \t]*(?:async\*?[ \t]*)?(?:\{|=>)|[ \t]*$)/gm, kind: 'fn', name: 3, guard: true},
  ],
  c: [
    {re: /^([ \t]*)(?:typedef[ \t]+)?(struct|class|enum|union|namespace)[ \t]+(?:class[ \t]+)?(\w+)[ \t]*(?:final[ \t]*)?(?::[^\n{;]*)?\{/gm, kind: 2, name: 3},
  ],
};

const NOT_A_NAME = new Set([
  'if', 'for', 'while', 'switch', 'return', 'catch', 'else', 'new', 'throw', 'function', 'await', 'typeof', 'case', 'do', 'try', 'using', 'lock',
  'foreach', 'when', 'extends', 'implements', 'break', 'continue', 'yield', 'delete', 'void', 'super', 'this', 'in', 'of', 'on', 'with', 'sizeof',
  'enum', 'class', 'interface', 'namespace', 'import', 'export', 'const', 'let', 'var', 'static', 'public', 'private', 'protected', 'async', 'def',
]);
const CLASS_LIKE = new Set<RawKind>(['class', 'iface', 'enum', 'impl']);

// ---------------------------------------------------------------- comments
/** Characters that open a string in each scanned language (for telling a real comment opener from one inside a string). */
const QUOTES: Record<ScanLang, string> = {
  ts: '\'"`', py: '\'"', rb: '\'"', php: '\'"', dart: '\'"', go: '"`', rs: '"', java: '"', kt: '"', cs: '"', swift: '"', c: '"',
};

/** How far back on its line a position is examined: enough for real code, and a bound on hostile lines. */
const LOOK_BEHIND = 400;

/** Start of the line holding `pos`, or `pos - window` when the line begins further back. */
function nearLineStart(text: string, pos: number, window = LOOK_BEHIND): number {
  const from = Math.max(0, pos - window);
  const newline = text.slice(from, pos).lastIndexOf('\n');
  return newline === -1 ? from : from + newline + 1;
}

/**
 * Tells, for positions asked in increasing order, whether a position sits inside a string or after a line comment on
 * its own line: a comment opener found there is text. State is carried from one question to the next, so the cost is
 * linear in the text however many openers a line holds. Strings that span lines are not tracked.
 */
function inertTracker(text: string, quotes: string, lineComment: string): {inert(pos: number): boolean; skipTo(pos: number): void} {
  let at = 0;
  let quote = '';
  let commented = false;
  return {
    inert(pos) {
      // Far from the last question: restart at the line start instead of walking the gap. The restart reads at
      // most ten times what it skipped, so the whole stays linear.
      if (pos < at || pos - at > LOOK_BEHIND) {
        at = nearLineStart(text, pos, 10 * LOOK_BEHIND);
        quote = '';
        commented = false;
      }
      for (; at < pos; at++) {
        const ch = text[at]!;
        if (ch === '\n') {
          quote = '';
          commented = false;
        } else if (commented) continue;
        else if (quote) {
          if (ch === '\\') at++;
          else if (ch === quote) quote = '';
        } else if (quotes.includes(ch)) quote = ch;
        else if (text.startsWith(lineComment, at)) commented = true;
      }
      return commented || quote !== '';
    },
    /** A comment was taken from the last position asked to `pos`: what it holds is not code. */
    skipTo(pos) {
      at = pos;
      quote = '';
      commented = false;
    },
  };
}

function blankRanges(text: string, ranges: number[]): string {
  if (ranges.length === 0) return text;
  const parts: string[] = [];
  let at = 0;
  for (let i = 0; i < ranges.length; i += 2) {
    const from = ranges[i]!;
    const to = ranges[i + 1]!;
    parts.push(text.slice(at, from), text.slice(from, to).replace(/[^\n]/g, ' '));
    at = to;
  }
  parts.push(text.slice(at));
  return parts.join('');
}

/**
 * Replaces block comments (and Python docstrings, Ruby =begin blocks) with spaces, keeping every newline, so the
 * patterns below never match commented-out code and comment bodies do not count as indentation.
 */
export function blankBlockComments(text: string, language: Language): string {
  const ranges: number[] = [];
  if (language.scan === 'py') {
    const tracker = inertTracker(text, '\'"', '#');
    let double = text.indexOf('"""');
    let single = text.indexOf("'''");
    for (;;) {
      const pos = double === -1 ? single : single === -1 ? double : Math.min(double, single);
      if (pos === -1) break;
      const delimiter = pos === double ? '"""' : "'''";
      let next = pos + 3;
      if (!tracker.inert(pos)) {
        const close = text.indexOf(delimiter, pos + 3);
        next = close === -1 ? text.length : close + 3;
        ranges.push(pos, next);
        tracker.skipTo(next);
      }
      if (double !== -1 && double < next) double = text.indexOf('"""', next);
      if (single !== -1 && single < next) single = text.indexOf("'''", next);
    }
  } else if (language.comments === 'c') {
    const tracker = inertTracker(text, language.scan ? QUOTES[language.scan] : '"', '//');
    let pos = text.indexOf('/*');
    while (pos !== -1) {
      if (tracker.inert(pos)) {
        pos = text.indexOf('/*', pos + 2);
        continue;
      }
      const close = text.indexOf('*/', pos + 2);
      const end = close === -1 ? text.length : close + 2;
      ranges.push(pos, end);
      tracker.skipTo(end);
      pos = text.indexOf('/*', end);
    }
  } else if (language.scan === 'rb') {
    let pos = text.startsWith('=begin') ? 0 : text.indexOf('\n=begin');
    while (pos !== -1) {
      const close = text.indexOf('\n=end', pos + 1);
      const end = close === -1 ? text.length : close + 5;
      ranges.push(pos, end);
      pos = text.indexOf('\n=begin', end);
    }
  }
  return blankRanges(text, ranges);
}

const LINE_COMMENT: Record<CommentStyle, string> = {c: '//', hash: '#', dash: '--', semi: ';', pct: '%', html: '<!--'};

// ---------------------------------------------------------------- lines
interface Lines {
  /** Offset of each line start. */
  starts: number[];
  /** Indentation width in columns (a tab is four), or -1 for blank and comment-only lines. */
  indent: number[];
  longest: number;
}

function measureLines(code: string, style: CommentStyle | undefined): Lines {
  const starts = [0];
  const indent: number[] = [];
  const comment = style ? LINE_COMMENT[style] : '';
  const n = code.length;
  let longest = 0;
  let i = 0;
  for (;;) {
    let width = 0;
    let j = i;
    for (; j < n; j++) {
      const c = code.charCodeAt(j);
      if (c === 32) width++;
      else if (c === 9) width += TAB_WIDTH;
      else break;
    }
    const c = j < n ? code.charCodeAt(j) : 10;
    const blank = c === 10 || c === 13 || (comment !== '' && code.startsWith(comment, j));
    indent.push(blank ? -1 : width);
    const newline = code.indexOf('\n', j);
    const end = newline === -1 ? n : newline;
    if (end - i > longest) longest = end - i;
    if (newline === -1) break;
    i = newline + 1;
    starts.push(i);
  }
  return {starts, indent, longest};
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * The indent unit is the most frequent positive step between consecutive code lines (2 to 8 columns), not the
 * smallest indent seen: alignment and comment continuation lines would otherwise read as one-column indentation.
 */
function indentUnit(indent: number[]): number {
  const steps = new Array<number>(9).fill(0);
  let previous = 0;
  for (const width of indent) {
    if (width < 0) continue;
    const step = width - previous;
    if (step >= 2 && step <= 8) steps[step]!++;
    previous = width;
  }
  let unit = TAB_WIDTH;
  let best = 0;
  for (let step = 2; step <= 8; step++) {
    if (steps[step]! > best) {
      best = steps[step]!;
      unit = step;
    }
  }
  return unit;
}

// ---------------------------------------------------------------- todos
const TODO_TAG = /\b(TODO|FIXME|HACK|XXX)\b/g;

function hasCommentLeader(prefix: string, style: CommentStyle): boolean {
  if (style === 'c') return prefix.includes('//') || prefix.includes('/*') || prefix.includes('<!--') || /^\s*\*/.test(prefix);
  return prefix.includes(LINE_COMMENT[style]);
}

function scanTodos(text: string, style: CommentStyle): FileFacts['todos'] {
  const todos: FileFacts['todos'] = [];
  let line = 1;
  let counted = 0;
  let lastLine = 0;
  TODO_TAG.lastIndex = 0;
  for (let m = TODO_TAG.exec(text); m && todos.length < MAX_TODOS; m = TODO_TAG.exec(text)) {
    if (!hasCommentLeader(text.slice(nearLineStart(text, m.index), m.index), style)) continue;
    for (let k = text.indexOf('\n', counted); k !== -1 && k < m.index; k = text.indexOf('\n', k + 1)) {
      line++;
      counted = k + 1;
    }
    if (line === lastLine) continue;
    lastLine = line;
    const rest = text.slice(m.index + m[0].length, m.index + 400).split('\n', 1)[0]!;
    // Finding V039: 'TODO(owner):' and 'TODO(https://…/issues/12):' name who or what tracks it, not the message.
    const owner = /^\(([^()\s][^()]{0,199})\)/.exec(rest)?.[1]?.trim();
    const body = rest.slice(owner === undefined ? 0 : rest.indexOf(')') + 1).replace(/^[\s:.-]*/, '').replace(/\s*(?:\*\/|-->)\s*$/, '').trim();
    todos.push({tag: m[1]!, line, text: body.slice(0, 160), ...(owner ? {owner: owner.slice(0, 120)} : {})});
  }
  return todos;
}

// ---------------------------------------------------------------- imports
function rustBraceItems(prefix: string, list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let item = '';
  for (const ch of `${list},`) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      const path = /^\s*([\w:]+)/.exec(item)?.[1];
      if (path) out.push(path === 'self' ? prefix.replace(/::$/, '') : prefix + path);
      item = '';
    } else item += ch;
  }
  return out;
}

function scanImports(code: string, scan: ScanLang, starts: number[]): ScannedImport[] {
  const imports: ScannedImport[] = [];
  const seen = new Set<number>();
  const add = (spec: string | undefined, kind: string, offset: number, names?: string[]) => {
    if (!spec || imports.length >= MAX_IMPORTS) return;
    imports.push({spec, kind, line: lineOf(starts, offset), ...(names && names.length > 0 ? {names} : {})});
  };
  for (const rule of IMPORTS[scan]) {
    if (rule.block) {
      rule.block.lastIndex = 0;
      for (let block = rule.block.exec(code); block; block = rule.block.exec(code)) {
        const bodyAt = block.index + block[0].indexOf('(') + 1;
        rule.re.lastIndex = 0;
        for (let m = rule.re.exec(block[1] ?? ''); m; m = rule.re.exec(block[1] ?? '')) add(m[rule.spec], rule.kind(m), bodyAt + m.index);
      }
      continue;
    }
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(code); m; m = rule.re.exec(code)) {
      if (m[0] === '') {
        rule.re.lastIndex++;
        continue;
      }
      // Skip the separator the pattern may have consumed, so the line is the statement's own.
      const offset = m.index + (/^[;\n}]/.test(m[0]) && scan === 'ts' && !rule.fallback ? 1 : 0);
      const spec = m[rule.spec];
      if (scan === 'ts' && spec) {
        const specAt = m.index + m[0].lastIndexOf(spec);
        if (seen.has(specAt)) continue;
        seen.add(specAt);
      }
      if (rule.multi) {
        for (const part of (spec ?? '').split(',')) add(part.trim().split(/\s+/)[0], rule.kind(m), offset);
      } else if (rule.braces && m[rule.braces]) {
        for (const item of rustBraceItems(spec ?? '', m[rule.braces]!)) add(item, rule.kind(m), offset);
      } else if (rule.names) {
        const names = (m[rule.names] ?? '').replace(/[()\\]/g, ' ').split(',').map(part => part.trim().split(/\s+/)[0] ?? '').filter(name => /^[\w*]+$/.test(name)).slice(0, 40);
        add(spec, rule.kind(m), offset, names);
      } else add(spec, rule.kind(m), offset);
    }
  }
  return imports.sort((a, b) => a.line - b.line);
}

/**
 * Python imports that do not run when the module loads: one inside a function body runs when the function is called
 * (kind 'dynamic', as a lazy import() is in TypeScript), one under `if TYPE_CHECKING:` never runs (kind 'type').
 * Imports in a class body, a `try:` or another `if` at module level do run at load time and keep their kind. The
 * enclosing blocks come from indentation alone: a line belongs to every `def` or `if TYPE_CHECKING:` above it that is
 * less indented, up to the next line at that block's own indentation or less.
 */
function markPythonLoadTime(code: string, lines: Lines, imports: ScannedImport[]): void {
  const indented = imports.filter(imp => (lines.indent[imp.line - 1] ?? 0) > 0);
  if (indented.length === 0) return;
  const context = new Array<'dynamic' | 'type' | undefined>(lines.starts.length);
  const open: Array<{indent: number; kind: 'dynamic' | 'type'}> = [];
  for (let i = 0; i < lines.starts.length; i++) {
    const width = lines.indent[i]!;
    if (width < 0) continue;
    const start = lines.starts[i]!;
    const end = i + 1 < lines.starts.length ? lines.starts[i + 1]! - 1 : code.length;
    const text = code.slice(start, Math.min(end, start + 400)).trimStart();
    // The closing line of a signature that broke over lines (`) -> None:`) is still the def's own header.
    if (/^[)\]}]/.test(text)) continue;
    while (open.length > 0 && open.at(-1)!.indent >= width) open.pop();
    context[i] = open.some(block => block.kind === 'dynamic') ? 'dynamic' : open.length > 0 ? 'type' : undefined;
    if (/^(?:async[ \t]+)?def[ \t]/.test(text)) open.push({indent: width, kind: 'dynamic'});
    else if (/^if[ \t]+(?:typing\.)?TYPE_CHECKING[ \t]*:/.test(text)) open.push({indent: width, kind: 'type'});
  }
  for (const imp of indented) {
    const kind = context[imp.line - 1];
    if (kind) imp.kind = kind;
  }
}

// ---------------------------------------------------------------- symbols
interface RawSymbol {
  name: string;
  kind: RawKind;
  line: number;
  indent: number;
  mods: string;
  member: boolean;
  endLine: number;
}

/** Visible outside its file (or its class, for members). Anything nested in a function is local. */
function isExported(scan: ScanLang, symbol: RawSymbol, parent: RawSymbol | undefined): boolean {
  const {name, mods} = symbol;
  const inClass = parent !== undefined && CLASS_LIKE.has(parent.kind);
  if (parent !== undefined && !inClass && parent.kind !== 'mod') return false;
  switch (scan) {
    case 'ts': return inClass ? !/\bprivate\b/.test(mods) && !name.startsWith('#') : /\bexport\b/.test(mods);
    case 'go': return /^[A-Z]/.test(name);
    case 'py': case 'rb': case 'dart': return !name.startsWith('_');
    case 'rs': return /\bpub\b/.test(mods);
    case 'kt': case 'swift': return !/\b(private|fileprivate|internal)\b/.test(mods);
    case 'php': return !/\b(private|protected)\b/.test(mods);
    case 'c': return !/\bstatic\b/.test(mods);
    default: return /\bpublic\b/.test(mods);
  }
}

const C_NOT_A_FUNCTION = /^(?:if|for|while|switch|return|else|do|typedef|struct|class|enum|union|namespace|using|template|extern|case|default|public|private|protected)\b/;

/** C-family function definitions: a line at column 0 with a parameter list that opens a body on it or on the next line. */
function scanCFunctions(code: string, lines: Lines, out: RawSymbol[]): void {
  const {starts, indent} = lines;
  for (let i = 0; i < starts.length; i++) {
    if (indent[i] !== 0) continue;
    const end = i + 1 < starts.length ? starts[i + 1]! - 1 : code.length;
    const text = code.slice(starts[i]!, end).trimEnd();
    const first = text.charCodeAt(0);
    if (first === 35 || first === 125 || first === 123 || first === 47 || text.endsWith(';') || C_NOT_A_FUNCTION.test(text)) continue;
    const paren = text.indexOf('(');
    if (paren <= 0 || text.includes('=')) continue;
    const name = /([A-Za-z_~][\w:~]*)[ \t]*$/.exec(text.slice(0, paren))?.[1];
    if (!name || NOT_A_NAME.has(name)) continue;
    let opens = text.endsWith('{');
    if (!opens && text.endsWith(')')) {
      let next = i + 1;
      while (next < starts.length && indent[next] === -1) next++;
      opens = next < starts.length && code.charCodeAt(starts[next]!) === 123;
    }
    if (!opens) continue;
    out.push({name, kind: name.includes('::') ? 'method' : 'fn', line: i + 1, indent: 0, mods: /^static\b/.test(text) ? 'static' : '', member: false, endLine: i + 1});
  }
}

const CLOSERS = new Set([125, 41, 93]); // } ) ]

/**
 * Last line of a declaration, from indentation: everything indented deeper belongs to it, and so does a closing
 * bracket at its own indent (which may reopen, as in `) {` or `} else {`).
 */
function endLineOf(code: string, lines: Lines, line: number, scan: ScanLang): number {
  const {starts, indent} = lines;
  const own = indent[line - 1] ?? 0;
  let end = line;
  for (let k = line; k < starts.length; k++) {
    const width = indent[k]!;
    if (width < 0) continue;
    if (width > own) {
      end = k + 1;
      continue;
    }
    if (width < own) break;
    let at = starts[k]!;
    while (code.charCodeAt(at) === 32 || code.charCodeAt(at) === 9) at++;
    // A brace on its own line under the declaration opens its body.
    if (code.charCodeAt(at) === 123) {
      end = k + 1;
      continue;
    }
    const closes = CLOSERS.has(code.charCodeAt(at)) || (scan === 'rb' && code.startsWith('end', at));
    if (!closes) break;
    end = k + 1;
    const lineEnd = k + 1 < starts.length ? starts[k + 1]! - 1 : code.length;
    const last = code.slice(at, lineEnd).trimEnd().slice(-1);
    if (!(last === '{' || last === '(' || last === '[' || last === '>' || (scan === 'py' && last === ':'))) break;
  }
  return end;
}

function scanSymbols(code: string, scan: ScanLang, lines: Lines, unit: number): {symbols: SymbolRow[]; found: number} {
  const raw: RawSymbol[] = [];
  const seen = new Set<string>();
  // Declarations past the caps are counted, not kept: the outline says how much it left out.
  let uncounted = 0;
  for (const rule of SYMBOLS[scan]) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(code); m; m = rule.re.exec(code)) {
      const name = m[rule.name];
      if (!name || (rule.guard && NOT_A_NAME.has(name))) continue;
      const line = lineOf(lines.starts, m.index);
      const key = `${line}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (raw.length >= MAX_SYMBOLS * 2) {
        uncounted++;
        continue;
      }
      const keyword = typeof rule.kind === 'number' ? (m[rule.kind] ?? '').trim() : '';
      const kind = typeof rule.kind === 'function' ? rule.kind(m) : typeof rule.kind === 'number' ? (KEYWORD_KIND[keyword] ?? 'fn') : rule.kind;
      const indent = (m[1] ?? '').replace(/\t/g, ' '.repeat(TAB_WIDTH)).length;
      const mods = rule.mods ? (m[rule.mods] ?? '') : '';
      raw.push({name, kind, line, indent, mods, member: rule.member === true, endLine: line});
    }
  }
  if (scan === 'c') scanCFunctions(code, lines, raw);
  raw.sort((a, b) => a.line - b.line);

  const out: SymbolRow[] = [];
  const stack: RawSymbol[] = [];
  for (const symbol of raw) {
    while (stack.length > 0 && (stack.at(-1)!.endLine < symbol.line || stack.at(-1)!.indent >= symbol.indent)) stack.pop();
    const parent = stack.at(-1);
    const inClass = parent !== undefined && CLASS_LIKE.has(parent.kind);
    // Members without a keyword are only trusted as direct children of a class body.
    if (symbol.member && !(parent?.kind === 'class' && symbol.indent - parent.indent <= unit)) continue;
    symbol.endLine = endLineOf(code, lines, symbol.line, scan);
    const depth = stack.filter(entry => entry.kind !== 'impl').length;
    if (symbol.endLine > symbol.line) stack.push(symbol);
    if (symbol.kind === 'impl' || depth > MAX_DEPTH) continue;
    if (out.length >= MAX_SYMBOLS) {
      uncounted++;
      continue;
    }
    const kind: Kind = symbol.kind === 'fn' && inClass ? 'method' : symbol.kind;
    out.push({
      name: symbol.name, kind, line: symbol.line, ...(symbol.endLine > symbol.line ? {endLine: symbol.endLine} : {}), depth,
      exported: isExported(scan, symbol, parent),
    });
  }
  return {symbols: out, found: out.length + uncounted};
}

// ---------------------------------------------------------------- Markdown outline
/** An ATX heading: up to three spaces, 1-6 `#`, a space, the text, an optional closing run of `#`. */
const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MAX_HEADING = 120;

/** Heading text as a reader sees it: code spans and link targets dropped, emphasis marks kept out. */
function headingText(raw: string): string {
  const text = raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_HEADING ? `${text.slice(0, MAX_HEADING - 1)}…` : text;
}

/**
 * The outline of a Markdown file: its ATX headings ('# Title', '## Usage'), nested by level, each running to the line
 * before the next heading of the same or a higher level. Headings in fenced code blocks and in a leading YAML front
 * matter (where '# ' starts a comment) are not headings. So a README has an outline like any source file.
 */
function scanHeadings(text: string): {symbols: SymbolRow[]; found: number} {
  const lines = text.split('\n');
  let last = lines.length;
  while (last > 0 && lines[last - 1]!.trim() === '') last--;
  const raw: Array<{name: string; level: number; line: number}> = [];
  let found = 0;
  let fence: {char: string; length: number} | undefined;
  let start = 0;
  // A leading '---' block is front matter only when it holds YAML keys; otherwise the line is a thematic break and
  // the title after it is a heading (V073).
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (end > 0 && lines.slice(1, end).some(line => /^[\w"'-][^:\n]{0,80}:(\s|$)/.test(line))) start = end + 1;
  }
  const add = (text: string, level: number, line: number) => {
    // '### ###' is an empty heading: its text is only the closing run.
    const name = /^#+$/.test(text.trim()) ? '' : headingText(text);
    if (name === '') return;
    found++;
    if (raw.length < MAX_SYMBOLS) raw.push({name, level, line});
  };
  let comment = false;
  /** First line of the paragraph being read, for a setext underline ('Title' then '=====') that ends it. */
  let paragraph: number | undefined;
  for (let i = start; i < last; i++) {
    const line = lines[i]!.replace(/\r$/, '');
    // Inside an HTML comment nothing is a heading, and the comment ends no section (V073).
    if (comment) {
      if (line.includes('-->')) comment = false;
      continue;
    }
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence.char && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      continue;
    }
    if (marker) {
      fence = {char: marker[0]!, length: marker.length};
      paragraph = undefined;
      continue;
    }
    const opens = line.lastIndexOf('<!--');
    if (opens !== -1 && line.indexOf('-->', opens + 4) === -1) {
      comment = true;
      paragraph = undefined;
      continue;
    }
    const m = ATX.exec(line);
    if (m) {
      add(m[2] ?? '', m[1]!.length, i + 1);
      paragraph = undefined;
      continue;
    }
    const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(line)?.[1];
    if (underline && paragraph !== undefined) {
      add(lines.slice(paragraph, i).map(text => text.replace(/\r$/, '').trim()).join(' '), underline[0] === '=' ? 1 : 2, paragraph + 1);
      paragraph = undefined;
      continue;
    }
    // Paragraph text: not blank, not indented code, not a list item, a quote, a table row or raw HTML.
    const text = line.trim() !== '' && !/^( {4}|\t)/.test(line) && !/^ {0,3}([-*+]|\d{1,9}[.)])([ \t]|$)|^ {0,3}[>|<]/.test(line);
    if (!text) paragraph = undefined;
    else paragraph ??= i;
  }
  const symbols: SymbolRow[] = [];
  const open: Array<{level: number}> = [];
  raw.forEach((heading, index) => {
    while (open.length > 0 && open.at(-1)!.level >= heading.level) open.pop();
    const depth = Math.min(open.length, MAX_DEPTH);
    open.push(heading);
    const next = raw.slice(index + 1).find(other => other.level <= heading.level);
    const endLine = next ? next.line - 1 : last;
    symbols.push({name: heading.name, kind: 'heading', line: heading.line, ...(endLine > heading.line ? {endLine} : {}), depth, exported: true});
  });
  return {symbols, found};
}

// ---------------------------------------------------------------- entry point
function cutLongLines(code: string): string {
  return code.split('\n').map(line => (line.length > LONG_LINE ? line.slice(0, 200) : line)).join('\n');
}

/**
 * Facts of one file. `text` is the decoded content; `language` decides what is looked for: TODO tags wherever the
 * language has comments, complexity for code, imports and symbols where there are patterns for the language.
 */
export function scanFile(text: string, language: Language): ScannedFacts {
  const facts: ScannedFacts = {imports: [], symbols: [], complexity: 0, maxIndent: 0, todos: []};
  if (language.comments) facts.todos = scanTodos(text, language.comments);
  if (language.outline === 'headings') {
    const outline = scanHeadings(text);
    facts.symbols = outline.symbols;
    if (outline.found > outline.symbols.length) facts.symbolsFound = outline.found;
  }
  if (language.kind !== 'code') return facts;

  let code = blankBlockComments(text, language);
  let lines = measureLines(code, language.comments);
  if (lines.longest > LONG_LINE) {
    code = cutLongLines(code);
    lines = measureLines(code, language.comments);
  }
  const unit = indentUnit(lines.indent);
  for (const width of lines.indent) {
    if (width <= 0) continue;
    const level = Math.min(20, Math.round(width / unit));
    facts.complexity += level;
    if (level > facts.maxIndent) facts.maxIndent = level;
  }
  const scan = language.scan;
  if (!scan) return facts;
  facts.scan = scan;
  facts.imports = scanImports(code, scan, lines.starts);
  if (scan === 'py') markPythonLoadTime(code, lines, facts.imports);
  const outline = scanSymbols(code, scan, lines, unit);
  facts.symbols = outline.symbols;
  if (outline.found > outline.symbols.length) facts.symbolsFound = outline.found;
  const pkg = PACKAGE_DECL[scan]?.exec(code)?.[1];
  if (pkg) facts.pkg = pkg.replace(/`/g, '');
  return facts;
}
