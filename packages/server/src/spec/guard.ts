// Keeps anything a spec says away from the JavaScript object model. A data path or an object key named `__proto__`,
// `constructor` or `prototype` is refused before the text reaches the Express compiler (whose path setter walks
// `current[segment]` and would write into Object.prototype), again on the compiled messages, and a snapshot of the
// built-in prototypes is restored after every compile as the last line of defence.
import {problem, type Problem} from './errors.ts';

/** Names that reach a prototype or a constructor through a plain property access. */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const refusal = (name: string, what: string): Problem =>
  problem('E_PATH', `"${name}" cannot be used as a ${what}: __proto__, constructor and prototype are reserved. Rename it.`);

/** The first reserved segment of a JSON-pointer or `$/a/b` path, if any. */
export function unsafeSegment(path: string): string | undefined {
  return path.replace(/^\$/, '').split('/').map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~')).find(segment => UNSAFE_KEYS.has(segment));
}

/** The problem with a data path, or undefined when every segment is an ordinary name. */
export function pathProblem(path: string): Problem | undefined {
  const bad = unsafeSegment(path);
  return bad === undefined ? undefined : refusal(bad, 'data path segment');
}

/** The first reserved own key anywhere inside a JSON-like value (bounded: specs are capped at 200,000 characters). */
export function unsafeKey(value: unknown): string | undefined {
  const stack: unknown[] = [value];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== 'object' || node === null || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) { for (const item of node) stack.push(item); continue; }
    for (const key of Object.getOwnPropertyNames(node)) {
      if (UNSAFE_KEYS.has(key)) return key;
      stack.push((node as Record<string, unknown>)[key]);
    }
  }
  return undefined;
}

/** The problem with a compiled value (component props, data), or undefined. */
export function valueProblem(value: unknown): Problem | undefined {
  const bad = unsafeKey(value);
  return bad === undefined ? undefined : refusal(bad, 'data key');
}

// ---------------------------------------------------------------- tokens of normalized Express
export interface SpecToken {
  kind: 'ident' | 'string' | 'number' | 'path' | 'punct';
  text: string;
  start: number;
  end: number;
  /** 1-based line of the first character. */
  line: number;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const PATH_PART = /[A-Za-z0-9_/]/;

/**
 * Tokens of normalized Express (double-quoted strings only). Comments are dropped; strings are one token each, so
 * nothing inside a string is ever mistaken for syntax. `endsInComment`: appended text must start on a new line.
 */
export function tokenize(src: string): {tokens: SpecToken[]; endsInComment: boolean} {
  const tokens: SpecToken[] = [];
  let endsInComment = false;
  let line = 1;
  let i = 0;
  const push = (kind: SpecToken['kind'], end: number) => {
    const text = src.slice(i, end);
    tokens.push({kind, text, start: i, end, line});
    for (const c of text) if (c === '\n') line++;
    endsInComment = false;
    i = end;
  };
  while (i < src.length) {
    const c = src[i]!;
    const raw = c === 'r' && src[i + 1] === '"';
    if (c === '"' || raw) {
      const open = raw ? i + 1 : i;
      const close = src.startsWith('"""', open) ? '"""' : '"';
      let j = open + close.length;
      while (j < src.length && !src.startsWith(close, j)) j += src[j] === '\\' && !raw ? 2 : 1;
      push('string', Math.min(src.length, j + close.length));
    } else if (c === '#' || (c === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') i++;
      endsInComment = true;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (const d of src.slice(i, stop)) if (d === '\n') line++;
      i = stop;
    } else if (c === '$') {
      let j = i + 1;
      while (j < src.length && PATH_PART.test(src[j]!)) j++;
      push('path', j);
    } else if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < src.length && IDENT_PART.test(src[j]!)) j++;
      push('ident', j);
    } else if (/[0-9]/.test(c) || ((c === '-' || c === '+' || c === '.') && /[0-9.]/.test(src[i + 1] ?? '') && /[0-9]/.test(src.slice(i + 1, i + 3)))) {
      let j = i + 1;
      while (j < src.length && /[0-9A-Za-z_.%]/.test(src[j]!)) j++;
      push('number', j);
    } else if (/\s/.test(c)) {
      if (c === '\n') line++;
      i++;
    } else {
      push('punct', i + 1);
    }
  }
  return {tokens, endsInComment};
}

/** The text inside a string token, with the simple escapes resolved. */
export function stringValue(token: SpecToken): string {
  const text = token.text.replace(/^r/, '');
  const quote = text.startsWith('"""') ? 3 : 1;
  const body = text.slice(quote, text.endsWith('"'.repeat(quote)) && text.length >= quote * 2 ? -quote : undefined);
  return token.text.startsWith('r') ? body : body.replace(/\\(["\\'])/g, '$1');
}

/**
 * Strings and comments exactly as the Express compiler's preprocessor finds them before its lexer runs
 * (normalizeExpressSource in @a2ui/agent, which is not exported): raw strings in either case, triple and standard
 * strings, `#`, `//`, `/* *\/` and `--` comments. Whatever lies between two matches is code. Finding V020: a scan
 * that read strings differently could be shown a line the compiler treats as code.
 */
const COMPILER_STRINGS_AND_COMMENTS = /([rR]"""[\s\S]*?"""|[rR]"[^\r\n"]*"|"""(?:\\[\s\S]|[^\\])*?"""|"(?:\\[\s\S]|[^\\])*?"|(?:#|\/\/)[^\r\n]*|\/\*[\s\S]*?\*\/)|--[^\r\n]*/g;

/** The value of a string the preprocessor found: raw strings as written, the others with their escapes resolved. */
function compilerString(text: string): string | undefined {
  if (/^[rR]"""/.test(text)) return text.slice(4, -3);
  if (/^[rR]"/.test(text)) return text.slice(2, -1);
  const body = text.startsWith('"""') ? text.slice(3, -3) : text.startsWith('"') ? text.slice(1, -1) : undefined;
  if (body === undefined) return undefined;
  return body.replace(/\\(u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, escaped: string) => {
    if (escaped.startsWith('u{')) return String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(escaped.slice(2, -1), 16)));
    if (escaped.length > 1 && (escaped[0] === 'u' || escaped[0] === 'x')) return String.fromCharCode(Number.parseInt(escaped.slice(1), 16));
    return escaped;
  });
}

/**
 * Refuses reserved names wherever a spec can name data: in the code (a `$/a/b` path, a path split over two lines that
 * the compiler joins, an object key, a part name), and in a string used as an object key. The text is cut into code,
 * strings and comments the way the compiler cuts it, and every word of the code is looked at. Strings that are values
 * are never looked at, so prose may mention __proto__ freely.
 */
export function scanSpec(text: string): Problem | undefined {
  let at = 0;
  const code = (segment: string): Problem | undefined => {
    for (const match of segment.matchAll(/[A-Za-z0-9_]+/g)) {
      if (!UNSAFE_KEYS.has(match[0])) continue;
      const before = segment.slice(0, match.index).replace(/\s+$/, '');
      return refusal(match[0], before.endsWith('/') || before.endsWith('$') ? 'data path segment' : /^\s*:/.test(segment.slice(match.index + match[0].length)) ? 'data key' : 'name');
    }
    return undefined;
  };
  for (const match of text.matchAll(COMPILER_STRINGS_AND_COMMENTS)) {
    const found = code(text.slice(at, match.index));
    if (found) return found;
    at = match.index + match[0].length;
    if (match[1] === undefined || match[1].startsWith('#') || match[1].startsWith('/')) continue;
    // A string followed by a colon is an object key.
    if (/^\s*:/.test(text.slice(at)) && UNSAFE_KEYS.has(compilerString(match[1]) ?? '')) return refusal(compilerString(match[1])!, 'data key');
  }
  return code(text.slice(at));
}

// ---------------------------------------------------------------- the built-in prototypes
type Snapshot = Array<{target: object; name: string; entries: Map<string | symbol, PropertyDescriptor>}>;

const snapshot = (): Snapshot =>
  ([['Object.prototype', Object.prototype], ['Array.prototype', Array.prototype], ['Function.prototype', Function.prototype], ['Object', Object]] as const)
    .map(([name, target]) => ({target, name, entries: new Map(Reflect.ownKeys(target).map(key => [key, Reflect.getOwnPropertyDescriptor(target, key)!]))}));

/** Taken when this module loads: before any spec has been seen. */
const BUILTINS = snapshot();

const same = (a: PropertyDescriptor | undefined, b: PropertyDescriptor): boolean =>
  a !== undefined && a.value === b.value && a.get === b.get && a.set === b.set;

/**
 * Puts every built-in prototype back the way it was when the server started and returns what had been changed
 * (e.g. `Object.prototype.polluted`). An empty list means nothing was touched, which is the only expected answer.
 */
export function restoreBuiltins(): string[] {
  const changed: string[] = [];
  for (const {target, name, entries} of BUILTINS) {
    const now = Reflect.ownKeys(target);
    if (now.length === entries.size && now.every(key => entries.has(key) && same(Reflect.getOwnPropertyDescriptor(target, key), entries.get(key)!))) continue;
    for (const key of now) {
      if (entries.has(key)) continue;
      changed.push(`${name}.${String(key)}`);
      Reflect.deleteProperty(target, key);
    }
    for (const [key, descriptor] of entries) {
      if (same(Reflect.getOwnPropertyDescriptor(target, key), descriptor)) continue;
      changed.push(`${name}.${String(key)}`);
      try {
        Object.defineProperty(target, key, descriptor);
      } catch {
        // a non-configurable property cannot have been changed in the first place
      }
    }
  }
  return changed;
}
