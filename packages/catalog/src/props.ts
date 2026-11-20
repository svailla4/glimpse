// packages/catalog/src/props.ts
// Prop helpers: ONE descriptor per prop gives the zod schema (A2UI v1.0 CommonSchemas),
// the wire type, the resolved (viewer) type, and the doc/metadata used for docs and expansion.
import {z} from 'zod';
import {CommonSchemas} from '@a2ui/web_core/v1_0';
import type {Dataset} from './datasets.ts';

export type Bind = {'@path': string};
export type Call = {'@call': string; args?: Record<string, unknown>};
/** Wire form of a bindable value. */
export type Dyn<T> = T | Bind | Call;

/** Opaque child token the viewer hands back to buildChild(). */
export type ChildToken = string | {id: string; basePath: string};
export type ChildListWire = string[] | {componentId: string; path: string};
export type ActionWire =
  | {event: {name: string; context?: Record<string, unknown>; userMessage?: Dyn<string>}}
  | {functionCall: Call};

/** What a data prop resolves to in the viewer: a server Dataset envelope, a bare value, or nothing yet. */
export type DataInput<T> = Dataset<T> | T | undefined;

export type PropKind =
  | 'text' | 'number' | 'data'            // bindable (DynamicString / DynamicNumber / DynamicValue)
  | 'child' | 'children' | 'action'       // structural
  | 'enum' | 'str' | 'int' | 'num' | 'flag' | 'strings'; // static

export interface Prop<W = unknown, V = unknown, Req extends boolean = boolean> {
  readonly kind: PropKind;
  readonly doc: string;
  readonly required: Req;
  readonly bindable: boolean;
  readonly values?: readonly string[];   // enum values
  /**
   * enum props: other words an author may write for a value ({warning: 'warn'}). Keys are lower case. The schema
   * accepts canonical values only; the spec pipeline rewrites an alias before validation and reports
   * `fixed warning -> warn` (see enumValue()).
   */
  readonly aliases?: Readonly<Record<string, string>>;
  readonly shape?: string;               // data props: name of the expected shape in datasets.ts (docs/tests)
  readonly source?: string;              // data props: default source ref used when the prop is omitted
  /**
   * A tuning knob: left out of the one-line index in the server instructions (componentIndex) to keep that text
   * short. It is a normal prop everywhere else (schema, catalog{names}, error signatures). Only trailing optional
   * props may be minor, so the positions of the listed ones do not change.
   */
  readonly minor?: boolean;
  readonly schema: z.ZodTypeAny;
  /** phantom types, never set at runtime */
  readonly _wire?: W;
  readonly _view?: V;
}

const ref = <S extends z.ZodTypeAny>(s: S, def: string, doc: string): S =>
  s.describe(`REF:#/$defs/${def}|${doc}`) as S;

function mk<W, V>(kind: PropKind, schema: z.ZodTypeAny, doc: string, extra: Partial<Prop> = {}): Prop<W, V, true> {
  return {kind, doc, required: true, bindable: false, schema, ...extra} as Prop<W, V, true>;
}

/** Marks a prop optional. Always call as opt(p.xxx(...)). */
export function opt<W, V>(prop: Prop<W, V, true>): Prop<W, V, false> {
  return {...prop, required: false, schema: prop.schema.optional()} as Prop<W, V, false>;
}

/** Marks an optional prop as a tuning knob (see Prop.minor). Always call as minor(opt(p.xxx(...))). */
export function minor<W, V>(prop: Prop<W, V, false>): Prop<W, V, false> {
  return {...prop, minor: true};
}

export const p = {
  /** Bindable string (DynamicString). */
  text: (doc: string) =>
    mk<Dyn<string>, string>('text', ref(CommonSchemas.DynamicString, 'DynamicString', doc), doc, {bindable: true}),
  /** Bindable number (DynamicNumber). */
  number: (doc: string) =>
    mk<Dyn<number>, number>('number', ref(CommonSchemas.DynamicNumber, 'DynamicNumber', doc), doc, {bindable: true}),
  /**
   * Bindable data (DynamicValue). On the wire: {"@path": "/ds/<key>"} (server dataset), {"@path": "/x"} (agent data)
   * or an inline value. In a tool call the agent may also write a SOURCE REF string ('git.churn src top=20');
   * the server replaces it with a /ds binding before anything reaches the viewer.
   */
  data: <T>(shape: string, doc: string, source?: string) =>
    mk<Dyn<T | Dataset<T> | string>, DataInput<T>>('data', ref(CommonSchemas.DynamicValue, 'DynamicValue', doc), doc, {
      bindable: true, shape, source,
    }),
  /** Single child component id. */
  child: (doc: string) => mk<string, string>('child', ref(CommonSchemas.ComponentId, 'ComponentId', doc), doc),
  /** Child list (ids or a {componentId, path} template). */
  children: (doc: string) =>
    mk<ChildListWire, ChildToken[]>('children', ref(CommonSchemas.ChildList, 'ChildList', doc), doc),
  /** A2UI Action ({event: {name, context}}). */
  action: (doc: string) => mk<ActionWire, () => Promise<void>>('action', ref(CommonSchemas.Action, 'Action', doc), doc),
  /**
   * Static enum. Values are appended to the description so they show up in every generated prompt.
   * `aliases` maps other words to one of the values (lower-case keys).
   */
  enum: <const T extends readonly [string, ...string[]]>(values: T, doc: string, aliases?: Readonly<Record<string, T[number]>>) =>
    mk<T[number], T[number]>('enum', z.enum(values).describe(`${doc} One of: ${values.join('|')}.`), doc, {values, ...(aliases ? {aliases} : {})}),
  /** Static string. */
  str: (doc: string) => mk<string, string>('str', z.string().describe(doc), doc),
  /** Static integer. */
  int: (doc: string, min = 0, max = 1_000_000) =>
    mk<number, number>('int', z.number().int().min(min).max(max).describe(doc), doc),
  /** Static boolean. */
  flag: (doc: string) => mk<boolean, boolean>('flag', z.boolean().describe(doc), doc),
  /** Static string list. */
  strings: (doc: string) => mk<string[], string[]>('strings', z.array(z.string()).describe(doc), doc),
};

/**
 * The canonical value of an enum prop for what the author wrote: the value itself, the same word in another case
 * ('Warn', 'lr'), or the target of an alias ('warning' -> 'warn'). undefined when it is none of those, or when the
 * prop is not an enum.
 */
export function enumValue(prop: Prop, written: unknown): string | undefined {
  if (prop.kind !== 'enum' || !prop.values || typeof written !== 'string') return undefined;
  if (prop.values.includes(written)) return written;
  const key = written.trim().toLowerCase();
  const alias = prop.aliases && Object.hasOwn(prop.aliases, key) ? prop.aliases[key] : undefined;
  return alias ?? prop.values.find(value => value.toLowerCase() === key);
}

export type Family = 'layout' | 'content' | 'data' | 'chart' | 'diagram' | 'code' | 'input';
/**
 * Directory that holds the React implementation: packages/viewer/src/components/<chunk>/index.ts.
 * 'layout' and 'content' are bundled eagerly; the other four are lazy chunks.
 */
export type Chunk = 'layout' | 'content' | 'table' | 'charts' | 'diagrams' | 'code';
export type Tier = 'A' | 'B' | 'C';

export interface ComponentMeta {
  family: Family;
  chunk: Chunk;
  tier: Tier;
  /** One line, <= 80 chars: used in catalog.json, docs and the instructions index. */
  doc: string;
  /** One Express example line (compiled in CI). */
  example: string;
  allowedParents?: string[];
  allowedChildren?: string[];
}

export type PropMap = Record<string, Prop<any, any, boolean>>;

export interface ComponentDef<N extends string = string, P extends PropMap = PropMap> extends ComponentMeta {
  name: N;
  /** Key order is the Express positional order. */
  props: P;
  /** z.object(shape).strict(), WITHOUT id/component (A2UI ComponentApi.schema). */
  schema: z.ZodObject<Record<string, z.ZodTypeAny>, 'strict'>;
}

export function component<const N extends string, P extends PropMap>(name: N, meta: ComponentMeta, props: P): ComponentDef<N, P> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(props)) shape[key] = prop.schema;
  return {name, ...meta, props, schema: z.object(shape).strict()};
}

type ReqKeys<P extends PropMap> = {[K in keyof P]: P[K] extends Prop<any, any, true> ? K : never}[keyof P];
type OptKeys<P extends PropMap> = Exclude<keyof P, ReqKeys<P>>;
type WireOf<X> = X extends Prop<infer W, any, boolean> ? W : never;
type ViewOf<X> = X extends Prop<any, infer V, boolean> ? V : never;
type Simplify<T> = {[K in keyof T]: T[K]} & {};

/** Component object on the wire, minus id/component. */
export type WireProps<D> = D extends ComponentDef<string, infer P>
  ? Simplify<{[K in ReqKeys<P>]: WireOf<P[K]>} & {[K in OptKeys<P>]?: WireOf<P[K]>}>
  : never;

/** Resolved props a viewer implementation receives (bindings unwrapped, children as tokens, actions as functions). */
export type ViewProps<D> = D extends ComponentDef<string, infer P>
  ? Simplify<{[K in ReqKeys<P>]: ViewOf<P[K]>} & {[K in OptKeys<P>]?: ViewOf<P[K]>}>
  : never;
