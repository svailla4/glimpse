// Error vocabulary of the spec pipeline (design 6.6): one Problem per line the model reads, and the mapping from
// the Express compiler's messages to Glimpse codes. All contact with @a2ui/agent message texts is here; the patterns
// are pinned by test/spec/errors.test.ts, so an SDK upgrade that rewords a message fails there, not in production.
import {COMPONENT_BY_NAME, COMPONENTS, signatureOf} from '@glimpse/catalog';

export type ErrorCode =
  | 'E_SYNTAX' | 'E_UNKNOWN' | 'E_PROP' | 'E_ENUM' | 'E_REQUIRED' | 'E_TYPE' | 'E_REF' | 'E_PARENT'
  | 'E_SOURCE' | 'E_ARGS' | 'E_NOTATION' | 'E_PATH' | 'E_VIEW' | 'E_ID' | 'E_SPEC'
  // raised by a source at run time (contracts.ts, SourceError)
  | 'E_NO_GIT' | 'E_TARGET' | 'E_SHALLOW' | 'E_INTERNAL';

const SOURCE_CODES: ReadonlySet<string> = new Set(['E_NO_GIT', 'E_ARGS', 'E_TARGET', 'E_SHALLOW', 'E_INTERNAL', 'E_SOURCE']);
/** The code of a failed dataset as an ErrorCode; anything unexpected reads as E_INTERNAL. */
export const sourceCode = (code: string): ErrorCode => (SOURCE_CODES.has(code) ? (code as ErrorCode) : 'E_INTERNAL');

/** What a bounded auto-repair may try for a problem (spec/repair.ts). */
export type RepairHint =
  | {kind: 'component'; name: string}
  | {kind: 'prop'; component: string; name: string}
  | {kind: 'eof'};

export interface Problem {
  code: ErrorCode;
  message: string;
  /** Catalog component the problem is about; its signature is printed after the problem lines. */
  component?: string;
  repair?: RepairHint;
}

export const NOTHING_RENDERED = 'Nothing was rendered; the previous view is unchanged.';
const MAX_PROBLEM_LINES = 5;

/** A rejected call. `problems` is never empty. */
export class SpecError extends Error {
  problems: Problem[];
  constructor(problems: Problem[]) {
    super(problems.map(p => `${p.code} ${p.message}`).join('\n'));
    this.name = 'SpecError';
    this.problems = problems;
  }
}

export const problem = (code: ErrorCode, message: string, extra: Pick<Problem, 'component' | 'repair'> = {}): Problem => ({code, message, ...extra});

/** One line, no control characters, at most `max` characters. */
export function oneLine(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/**
 * At most five problem lines, the signature of the first offending component, then the fixed last line (null: none,
 * for tools that render nothing).
 */
export function formatProblems(problems: readonly Problem[], lastLine: string | null = NOTHING_RENDERED): string {
  const lines = problems.slice(0, MAX_PROBLEM_LINES).map(p => oneLine(`${p.code} ${p.message}`, 400));
  if (problems.length > MAX_PROBLEM_LINES) lines[MAX_PROBLEM_LINES - 1] += ` (+${problems.length - MAX_PROBLEM_LINES} more)`;
  const def = problems.map(p => (p.component ? COMPONENT_BY_NAME.get(p.component) : undefined)).find(d => d !== undefined);
  if (def) lines.push(`sig ${signatureOf(def)}`);
  if (lastLine !== null) lines.push(lastLine);
  return lines.join('\n');
}

// ---------------------------------------------------------------- nearest names
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** Case-insensitive distance; a candidate that merely extends or shortens the name by a prefix ranks close. */
function looseDistance(name: string, candidate: string): number {
  const a = name.toLowerCase();
  const b = candidate.toLowerCase();
  const d = editDistance(a, b);
  return a.length >= 3 && (b.startsWith(a) || a.startsWith(b)) ? Math.min(d, 2.5) : d;
}

/** The `n` candidates closest to `name`, best first (ties keep candidate order). */
export function nearest(name: string, candidates: Iterable<string>, n = 3): string[] {
  return [...candidates]
    .map((candidate, index) => ({candidate, index, d: looseDistance(name, candidate)}))
    .sort((x, y) => x.d - y.d || x.index - y.index)
    .slice(0, n)
    .map(x => x.candidate);
}

/**
 * The single candidate a typo most plausibly meant, or undefined: within edit distance 2 (1 for names of up to four
 * characters), closer than every other candidate.
 */
export function closeMatch(name: string, candidates: Iterable<string>): string | undefined {
  const limit = name.length <= 4 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = Infinity;
  let tie = false;
  for (const candidate of candidates) {
    const d = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) { best = candidate; bestDistance = d; tie = false; }
    else if (d === bestDistance) tie = true;
  }
  return best !== undefined && bestDistance <= limit && bestDistance < name.length && !tie ? best : undefined;
}

// ---------------------------------------------------------------- compiler messages -> problems
/** Props of a component in positional order, as the model may write them. */
function propsOf(component: string): string {
  const def = COMPONENT_BY_NAME.get(component);
  return def ? Object.keys(def.props).join(' ') : '';
}

/** The compiler's own sentence: its `detail` when it has one, else the message without the trailing "- Help: ..." text. */
export function compilerText(error: unknown): string {
  const e = error as {detail?: unknown; message?: unknown};
  const text = typeof e?.detail === 'string' ? e.detail : typeof e?.message === 'string' ? e.message : String(error);
  return text.replace(/\s+-\s+(?:Line \d+, Col \d+\s+-\s+)?Help:[\s\S]*$/, '').trim();
}

export interface ClassifyContext {
  surfaceId: string;
  /** True when the call patches a surface that already exists. */
  exists: boolean;
  /** Ids of the views that exist, for the "nothing to patch" message. */
  surfaces: readonly string[];
  /** Maps a 1-based line of the compiled text (header line removed) to the line the author wrote. */
  lineOf?: (line: number) => number;
}

/** Maps one thrown compiler error to a Problem. Unrecognised messages pass through as E_SPEC. */
export function classifyCompileError(error: unknown, ctx: ClassifyContext): Problem {
  const text = compilerText(error);

  const syntax = /Syntax error at line (\d+):(\d+):?\s*([\s\S]*?)(?:\s*\(line \d+\))?$/.exec(text);
  if (syntax) {
    const line = Math.max(1, Number(syntax[1]) - 1);
    const what = oneLine(syntax[3] || 'unexpected input', 160);
    return problem('E_SYNTAX', `line ${ctx.lineOf ? ctx.lineOf(line) : line} col ${syntax[2]}: ${what}`, /<EOF>/.test(what) ? {repair: {kind: 'eof'}} : {});
  }

  const unknown = /^(?:Function|Component) '([^']+)' is not defined in the catalog/.exec(text);
  if (unknown) {
    const name = unknown[1]!;
    return problem('E_UNKNOWN', `"${name}" is not a component. Nearest: ${nearest(name, COMPONENTS.map(c => c.name)).join(' ')}`, {repair: {kind: 'component', name}});
  }

  const badProp = /^Property '([^']+)' is not a valid property of component '([^']+)'/.exec(text);
  if (badProp) {
    const prop = badProp[1]!;
    const component = badProp[2]!;
    return problem('E_PROP', `${component}: unknown prop "${prop}". Props: ${propsOf(component)}`, {component, repair: {kind: 'prop', component, name: prop}});
  }

  const badEnum = /^Value '([\s\S]*)' is not a valid enum choice for property '([^']+)' of component '([^']+)'/.exec(text);
  if (badEnum) {
    const prop = badEnum[2]!;
    const component = badEnum[3]!;
    const values = (COMPONENT_BY_NAME.get(component)?.props as Record<string, {values?: readonly string[]}> | undefined)?.[prop]?.values;
    const allowed = values ? values.join(' ') : oneLine(text.replace(/^[\s\S]*Allowed values are:\s*/, '').replace(/[[\]',]/g, ' '));
    return problem('E_ENUM', `${component}.${prop}: "${oneLine(badEnum[1]!, 60)}" is not allowed. Use: ${allowed}`, {component});
  }

  const missing = /^Component '([^']+)' is missing required property '([^']+)'/.exec(text);
  if (missing) return problem('E_REQUIRED', `${missing[1]}: missing required prop "${missing[2]}".`, {component: missing[1]!});

  const invalid = /^Validation failed for component '([^']+)' \(([^)]*)\): ([\s\S]*)$/.exec(text);
  if (invalid) {
    const first = (invalid[3] ?? '').split(/;\s/)[0] ?? '';
    return problem('E_TYPE', `${invalid[1]}#${invalid[2]} ${oneLine(first, 200)}`, {component: invalid[1]!});
  }

  const code = (error as {code?: unknown; details?: Array<{code?: unknown}>})?.details?.[0]?.code ?? (error as {code?: unknown})?.code;
  if (code === 'UNALLOWED_PARENT' || code === 'UNALLOWED_CHILD') {
    const where = /^Component '([^']+)' \(([^)]+)\) cannot be placed under parent '([^']+)' \(([^)]+)\)\. Allowed parents: (.*?)\.?$/.exec(text);
    if (!where) return problem('E_PARENT', oneLine(text));
    const allowed = where[5]!.replace(/[[\]"]/g, '').replace(/,\s*/g, ' ');
    const hint = where[2] === 'Page' ? ' Page is the root: use it once, as root=Page(...).' : '';
    return problem('E_PARENT', `${where[2]} (${where[1]}) cannot sit inside ${where[4]} (${where[3]}). Allowed parents: ${allowed}.${hint}`, {component: where[2]!});
  }

  const dangling = /^Component '([^']+)' references non-existent component '([^']+)' in field '([^']+)'/.exec(text);
  if (dangling) {
    return problem('E_REF', `"${dangling[2]}" is used by ${dangling[1]} (${dangling[3]}) but never defined. Add ${dangling[2]}=Comp(...) or fix the name.`);
  }

  const orphan = /^Component '([^']+)' is not reachable from 'root'/.exec(text);
  if (orphan) return problem('E_REF', `"${orphan[1]}" is not reachable from root: resend its parent with the new child.`);

  if (/^Root target 'root' is not defined|^Surface not found for message|^Missing root component/.test(text)) {
    const others = ctx.surfaces.length > 0 ? ` Existing views: ${ctx.surfaces.join(' ')}.` : '';
    return problem('E_REF', ctx.exists
      ? 'the spec defines nothing to render. Use name=Comp(...), $/path=value or root=Page(...).'
      : `there is no view "${ctx.surfaceId}" to patch, and the spec defines no root. Start with root=Page(...) or pass the id of an existing view.${others}`);
  }

  const named = /component '([^']+)'|^([A-Z][A-Za-z]+) takes at most/.exec(text);
  const component = named?.[1] ?? named?.[2];
  return problem('E_SPEC', oneLine(text, 300), component && COMPONENT_BY_NAME.has(component) ? {component} : {});
}
