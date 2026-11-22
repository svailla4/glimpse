// packages/catalog/src/calls.ts
// What the calls of a spec read, and why one gives no number (decision what-if-as-a2ui-calls). The server reads them to check a spec
// against its data and to say what a number set in the tab computed; the Slider view (lazy) reads them for the note
// under the field. Kept apart from calc.ts, which the tab loads eagerly: a module the eager script imports is
// bundled into it with everything the lazy views use from it (see links.ts).
import {applyCalc, CALC_NAMES, isCall} from './calc.ts';
import type {Bind, Call} from './props.ts';

/**
 * Why a call gives no number. 'not set' is a value not written yet, which the server reports as an unbound path;
 * 'relative' is a $path with no leading slash, which no unbound line names (review S6), so it is said as a call's.
 */
export type CalcReason = 'not set' | 'relative' | 'unknown' | 'not a number' | 'division by zero' | 'too large';
export type Explained = {value: unknown} | {problem: string; reason: CalcReason};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isBinding = (v: unknown): v is Bind => isRecord(v) && typeof v['@path'] === 'string';

/** A value for a message: JSON, at most 40 characters; numbers JSON cannot spell (NaN, Infinity) as JavaScript does. */
function shown(v: unknown): string {
  const text = typeof v === 'number' ? String(v) : (JSON.stringify(v) ?? String(v));
  return text.length > 40 ? text.slice(0, 39) + '…' : text;
}

/**
 * The value of a prop value that may be a call, or why it has none. `read` gives the data at an absolute path. A
 * binding reads its path; a call is computed from its arguments, and the first argument that has no number is named
 * (the innermost reason wins, so `mul(div($/a,$/b),4)` with b at 0 says division by zero). Anything else is itself.
 */
export function explainValue(node: unknown, read: (path: string) => unknown): Explained {
  if (isBinding(node)) {
    const path = node['@path'];
    if (!path.startsWith('/')) return {problem: `$${path} is relative; write an absolute $/path`, reason: 'relative'};
    return {value: read(path)};
  }
  if (!isCall(node)) return {value: node};
  const name = node['@call'];
  if (!(CALC_NAMES as readonly string[]).includes(name)) return {problem: `${name} is not a function (${CALC_NAMES.join(' ')})`, reason: 'unknown'};
  const args = isRecord(node.args) ? node.args : {};
  const values: unknown[] = [];
  const what: string[] = [];
  for (const key of ['a', 'b'] as const) {
    const arg = args[key];
    const got = explainValue(arg, read);
    const named = isBinding(arg) ? `${key} = $${arg['@path']}` : key;
    if ('problem' in got) return got.reason === 'relative' && isBinding(arg) ? {problem: `${name}: ${named} is relative; write an absolute $/path`, reason: 'relative'} : got;
    if (got.value === undefined) return {problem: `${name}: ${named} is not set`, reason: 'not set'};
    if (typeof got.value !== 'number' || !Number.isFinite(got.value)) return {problem: `${name}: ${named} is ${shown(got.value)}, not a number`, reason: 'not a number'};
    values.push(got.value);
    what.push(named);
  }
  if (name === 'div' && values[1] === 0) return {problem: `div: ${what[1]} is 0 (division by zero)`, reason: 'division by zero'};
  const value = applyCalc(name, values[0], values[1]);
  return value === undefined ? {problem: `${name}: the result is too large`, reason: 'too large'} : {value};
}

/**
 * The outermost calls in a component's props, with where each is: 'value', 'data/1/value'. A call inside another is
 * part of it, and a binding is never looked into. `id` and `component` are skipped.
 */
export function callsIn(props: Readonly<Record<string, unknown>>): Array<{at: string; call: Call}> {
  const found: Array<{at: string; call: Call}> = [];
  const walk = (v: unknown, at: string): void => {
    if (isCall(v)) found.push({at, call: v});
    else if (Array.isArray(v) || (isRecord(v) && !isBinding(v))) for (const [key, item] of Object.entries(v)) walk(item, `${at}/${key}`);
  };
  for (const [key, value] of Object.entries(props)) if (key !== 'id' && key !== 'component') walk(value, key);
  return found;
}

/** The absolute paths a call reads, through the calls nested in it. */
export function callReads(call: Call): Set<string> {
  const paths = new Set<string>();
  const walk = (v: unknown): void => {
    if (isBinding(v)) {
      if (v['@path'].startsWith('/')) paths.add(v['@path']);
    } else if (typeof v === 'object' && v !== null) for (const item of Object.values(v)) walk(item);
  };
  walk(call.args);
  return paths;
}

/** True when a write to `path` can change what the call reads: the same path, one inside it, or one around it. */
export function reads(call: Call, path: string): boolean {
  for (const read of callReads(call)) if (read === path || read.startsWith(path + '/') || path.startsWith(read + '/')) return true;
  return false;
}

/**
 * The number an input may set: a finite number, held to the limits that are finite numbers. undefined for anything
 * else (a string, NaN, Infinity), which is then not written.
 */
export function inputValue(v: unknown, limits: {min?: unknown; max?: unknown}): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  let value = v;
  if (typeof limits.min === 'number' && Number.isFinite(limits.min)) value = Math.max(value, limits.min);
  if (typeof limits.max === 'number' && Number.isFinite(limits.max)) value = Math.min(value, limits.max);
  return value;
}
