// packages/catalog/src/calc.ts
// Computed values (decision D25): the four A2UI functions add|sub|mul|div(a, b), written `div($/w/seats,60)` in any
// component argument and compiled by Express to {"@call": "div", "args": {a, b}}. A2UI resolves them in the tab and
// recomputes them when a $/path they read changes (a Slider writes one).
//
// Two schemas for the same four functions: strict ones for catalog.json and the server's compiler (a literal argument
// must be a number, so `div('ten',2)` is refused before anything is drawn), permissive ones for the tab (a value the
// tab holds can be anything, and a strict schema there raises an EXPRESSION_ERROR that only reaches the log; an
// operand that is not a number gives an empty value instead, and the server says why).
//
// The tab's catalog imports this module eagerly, so it holds only what that catalog needs and a few constants; what
// the server and the lazy Slider read about calls is in calls.ts (as links.ts is kept apart from diagrams.ts).
// Everything here but constants is a function, so the tab bundles calcFunctions and applyCalc and nothing else.
import {createFunctionImplementation, type FunctionApi, type FunctionImplementation} from '@a2ui/web_core/v1_0';
import {z} from 'zod';
import {p, type Call} from './props.ts';

const OPS = {
  add: (a: number, b: number) => a + b,
  sub: (a: number, b: number) => a - b,
  mul: (a: number, b: number) => a * b,
  div: (a: number, b: number) => a / b,
} as const;

export const CALC_NAMES = ['add', 'sub', 'mul', 'div'] as const;
export type CalcName = (typeof CALC_NAMES)[number];

/**
 * Other names authors write for the four functions (lower case). The spec pipeline rewrites them and says so
 * (`fixed multiply -> mul`); no other spelling is read.
 */
export const CALC_ALIASES: Readonly<Record<string, CalcName>> = {
  plus: 'add', sum: 'add', minus: 'sub', subtract: 'sub', times: 'mul', multiply: 'mul', product: 'mul', divide: 'div', quotient: 'div',
};

const CALC_DOC: Readonly<Record<CalcName, string>> = {
  add: 'a + b.', sub: 'a - b.', mul: 'a * b.', div: 'a / b; no value when b is 0.',
};

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The function an author meant: a CALC_NAME, the same word in another case ('Div'), or an alias ('multiply'). */
export function calcName(written: unknown): CalcName | undefined {
  if (typeof written !== 'string') return undefined;
  const key = written.trim().toLowerCase();
  if ((CALC_NAMES as readonly string[]).includes(key)) return key as CalcName;
  return Object.hasOwn(CALC_ALIASES, key) ? CALC_ALIASES[key] : undefined;
}

/** A call node as Express compiles it: {"@call": "div", "args": {...}}. */
export const isCall = (v: unknown): v is Call =>
  typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)['@call'] === 'string';

/**
 * The value of `name(a, b)`: undefined unless name is one of the four, a and b are finite numbers, b is not 0 for
 * div and the result is finite. The tab and the server both compute with it, so they agree on every value.
 */
export function applyCalc(name: string, a: unknown, b: unknown): number | undefined {
  if (!Object.hasOwn(OPS, name) || !isNumber(a) || !isNumber(b) || (name === 'div' && b === 0)) return undefined;
  const value = OPS[name as CalcName](a, b);
  return Number.isFinite(value) ? value : undefined;
}

/** Strict: catalog.json and the server's compiler. An argument is a number, a binding or another call. */
export function calcApis(): FunctionApi[] {
  return CALC_NAMES.map(name => ({
    name,
    returnType: 'number',
    description: CALC_DOC[name],
    schema: z.object({a: p.number('First operand.').schema, b: p.number('Second operand.').schema}).strict(),
  }));
}

/** Permissive: the tab. Any resolved value is accepted; one that is not a number gives no value, never an error. */
export function calcFunctions(): FunctionImplementation[] {
  return CALC_NAMES.map(name =>
    createFunctionImplementation(
      {name, returnType: 'number', schema: z.object({a: z.unknown(), b: z.unknown()}).strict()},
      // undefined is an empty value in the tab (Stat draws a dash), not an error
      args => applyCalc(name, args.a, args.b) as number,
    ),
  );
}
