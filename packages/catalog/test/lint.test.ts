import {describe, expect, it} from 'vitest';
import {COMPONENT_BY_NAME, COMPONENT_EXAMPLES, COMPONENTS, SHARED_PROPS, SOURCE_BY_NAME, enumValue, hasFrame, parseRef, type Prop} from '../src/index.ts';
import {buildSurface, strictErrors} from '../testing/index.ts';
import {exampleSpec} from './support.ts';

const RESERVED = ['id', 'component', 'metadata', 'catalogId', 'accessibility', 'checks'];
const FAMILIES = ['layout', 'content', 'data', 'chart', 'diagram', 'code', 'input'];
const CHUNKS = ['layout', 'content', 'table', 'charts', 'diagrams', 'code'];
const propsOf = (def: (typeof COMPONENTS)[number]) => Object.entries(def.props) as Array<[string, Prop]>;
const propOf = (component: string, key: string): Prop => (COMPONENT_BY_NAME.get(component)!.props as Record<string, Prop>)[key]!;

describe('catalog lint', () => {
  it('has 45 uniquely named components and none is called Surface', () => {
    expect(COMPONENTS).toHaveLength(45);
    expect(COMPONENT_BY_NAME.size).toBe(45);
    expect(COMPONENT_BY_NAME.has('Surface')).toBe(false);
    for (const def of COMPONENTS) expect(def.name, def.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  it.each(COMPONENTS.map(def => [def.name, def] as const))('%s follows the catalog rules', (_name, def) => {
    expect(FAMILIES).toContain(def.family);
    expect(CHUNKS).toContain(def.chunk);
    expect(['A', 'B', 'C']).toContain(def.tier);
    expect(def.doc.length, 'doc is at most 100 characters').toBeLessThanOrEqual(100);
    expect(def.doc.length).toBeGreaterThan(0);
    // z.object(shape).strict(): unknown props are rejected, not stripped
    expect(def.schema._def.unknownKeys).toBe('strict');
    expect(Object.keys(def.schema.shape)).toEqual(Object.keys(def.props));

    let seenOptional = false;
    for (const [key, prop] of propsOf(def)) {
      expect(RESERVED, `prop ${key}`).not.toContain(key);
      expect(key, 'prop names are identifiers').toMatch(/^[a-z][A-Za-z0-9]*$/);
      expect(prop.doc.length, `prop ${key} has a doc`).toBeGreaterThan(0);
      if (prop.required) expect(seenOptional, `required prop ${key} comes before optional ones`).toBe(false);
      else seenOptional = true;
      expect(prop.schema.isOptional(), `prop ${key} schema optionality`).toBe(!prop.required);
      if (prop.kind === 'enum') expect(prop.values?.length).toBeGreaterThan(0);
      // static props are plain JSON: no unions, so one Express literal has one meaning
      if (!prop.bindable && !['child', 'children', 'action'].includes(prop.kind)) {
        const inner = prop.required ? prop.schema : prop.schema._def.innerType;
        expect(inner._def.typeName, `static prop ${key}`).not.toBe('ZodUnion');
      }
      if (prop.source) {
        expect(prop.kind).toBe('data');
        expect(prop.required, `prop ${key} with a default source is optional`).toBe(false);
        expect(SOURCE_BY_NAME.has(parseRef(prop.source).source), `default source ${prop.source}`).toBe(true);
      }
    }
    expect('span' in def.props || def.name === 'Page', 'every component but Page takes span').toBe(true);
  });

  it.each(COMPONENTS.map(def => [def.name, def] as const))('%s: enum aliases are lower-case words that map to a value, and minor props trail', (_name, def) => {
    for (const [key, prop] of propsOf(def)) {
      for (const [alias, target] of Object.entries(prop.aliases ?? {})) {
        expect(prop.kind, `${key}: only enums have aliases`).toBe('enum');
        expect(alias, `${key} alias`).toBe(alias.toLowerCase());
        expect(prop.values, `${key}: ${alias} -> ${target}`).toContain(target);
        // an alias never shadows a value, in any case: enumValue would not reach it
        expect(prop.values!.map(value => value.toLowerCase()), `${key}: alias ${alias} is already a value`).not.toContain(alias);
        expect(enumValue(prop, alias)).toBe(target);
        expect(enumValue(prop, ` ${alias.toUpperCase()} `)).toBe(target);
      }
      if (prop.minor) expect(prop.required, `minor prop ${key} is optional`).toBe(false);
    }
    // minor props are the last ones of the signature, so hiding them never shifts a positional argument
    const own = propsOf(def).filter(([key]) => key !== 'span' && !(hasFrame(def) && (SHARED_PROPS as readonly string[]).includes(key)));
    const firstMinor = own.findIndex(([, prop]) => prop.minor);
    if (firstMinor >= 0) expect(own.slice(firstMinor).every(([, prop]) => prop.minor), 'minor props are trailing').toBe(true);
  });

  // F035: 3 of 4 first Callout attempts wrote kind='warning' (the tag even reads WARNING on screen).
  it('enumValue accepts the value, another case of it, or an alias; nothing else', () => {
    const kind = propOf('Callout', 'kind');
    expect(enumValue(kind, 'warn')).toBe('warn');
    expect(enumValue(kind, 'Warn')).toBe('warn');
    expect(Object.fromEntries(['warning', 'caution', 'danger', 'error', 'critical', 'info', 'success', 'hint'].map(word => [word, enumValue(kind, word)]))).toEqual({
      warning: 'warn', caution: 'warn', danger: 'risk', error: 'risk', critical: 'risk', info: 'note', success: 'tip', hint: 'tip',
    });
    expect(enumValue(kind, 'purple')).toBeUndefined();
    expect(enumValue(kind, 'toString')).toBeUndefined();
    expect(enumValue(kind, 3)).toBeUndefined();
    const dir = propOf('Graph', 'dir');
    expect(enumValue(dir, 'lr')).toBe('LR');
    expect(enumValue(dir, 'TD')).toBe('TB');
    expect(enumValue(propOf('DataTable', 'size'), 'large')).toBe('l');
    // not an enum
    expect(enumValue(propOf('Grid', 'cols'), '3')).toBeUndefined();
  });

  // F034: both cold writers highlighted the wrong step; the doc said only "Index of the active step".
  it('Steps.current is documented as counting from 1, and every Steps the catalog writes uses it that way', () => {
    expect((propOf('Steps', 'current')).doc).toMatch(/counting from 1/);
  });

  it.each(COMPONENTS.map(def => [def.name, COMPONENT_EXAMPLES[def.name]] as const))('the %s example compiles and is strictly valid', (name, example) => {
    const messages = buildSurface('example', exampleSpec(example));
    const first = messages[0]!;
    expect('createSurface' in first).toBe(true);
    const used = 'createSurface' in first ? first.createSurface.components.map(c => c.component) : [];
    expect(used, 'the example uses its own component').toContain(name);
    expect(strictErrors(messages)).toEqual([]);
  });
});
