import {describe, expect, it} from 'vitest';
import {COMPONENT_BY_NAME, COMPONENTS, SOURCE_BY_NAME, parseRef, type Prop} from '../src/index.ts';
import {buildSurface, strictErrors} from '../testing/index.ts';
import {exampleSpec} from './support.ts';

const RESERVED = ['id', 'component', 'metadata', 'catalogId', 'accessibility', 'checks'];
const FAMILIES = ['layout', 'content', 'data', 'chart', 'diagram', 'code', 'input'];
const CHUNKS = ['layout', 'content', 'table', 'charts', 'diagrams', 'code'];
const propsOf = (def: (typeof COMPONENTS)[number]) => Object.entries(def.props) as Array<[string, Prop]>;

describe('catalog lint', () => {
  it('has 44 uniquely named components and none is called Surface', () => {
    expect(COMPONENTS).toHaveLength(44);
    expect(COMPONENT_BY_NAME.size).toBe(44);
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

  it.each(COMPONENTS.map(def => [def.name, def.example] as const))('the %s example compiles and is strictly valid', (name, example) => {
    const messages = buildSurface('example', exampleSpec(example));
    const first = messages[0]!;
    expect('createSurface' in first).toBe(true);
    const used = 'createSurface' in first ? first.createSurface.components.map(c => c.component) : [];
    expect(used, 'the example uses its own component').toContain(name);
    expect(strictErrors(messages)).toEqual([]);
  });
});
