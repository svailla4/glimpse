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
 * Refuses reserved names in the two places a spec can address data: `$/a/b` paths and the keys of object literals.
 * Strings that are values are never looked at, so prose may mention __proto__ freely.
 */
export function scanSpec(text: string): Problem | undefined {
  const {tokens} = tokenize(text);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === 'path') {
      const found = pathProblem(token.text);
      if (found) return found;
    } else if ((token.kind === 'ident' || token.kind === 'string') && tokens[i + 1]?.text === ':') {
      const key = token.kind === 'string' ? stringValue(token) : token.text;
      if (UNSAFE_KEYS.has(key)) return refusal(key, 'data key');
    }
  }
  return undefined;
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
