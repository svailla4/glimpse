// Conformance of the catalog and of everything Glimpse writes, against the published runtime (@a2ui/web_core,
// @a2ui/agent) and the vendored v1.0 spec schemas. C1-C3 follow section 9 (WP0 acceptance) of the design.
import {Catalog, MessageProcessor, STRICT_VALIDATION} from '@a2ui/web_core/v1_0';
import {describe, expect, it} from 'vitest';
import {CATALOG_ID, COMPONENTS, createApiCatalog, type A2uiMessage} from '../src/index.ts';
import {buildCatalogJson} from '../testing/artifacts.ts';
import {buildPatch, buildSurface, compileExpress, strictErrors} from '../testing/index.ts';
import {catalogDefinitionValidator, corpus, messageValidator, readJson} from './support.ts';

const catalogJson = readJson('../generated/catalog.json') as Record<string, any>;
const entries = corpus();
const validateMessage = messageValidator(catalogJson);

const jsonCatalog = Catalog.fromJson(catalogJson as never);
const strictErrorsFromJson = (messages: readonly A2uiMessage[]) =>
  new MessageProcessor([jsonCatalog as never], undefined, {validationConfig: STRICT_VALIDATION}).processMessagesWithErrors(structuredClone(messages) as never);

describe('C1: generated/catalog.json is a valid v1.0 catalog document', () => {
  it('passes catalog_definition.json', () => {
    const validate = catalogDefinitionValidator();
    expect(validate(catalogJson), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
  });

  it('is what the zod catalog generates today', () => {
    expect(catalogJson).toEqual(JSON.parse(JSON.stringify(buildCatalogJson())));
  });

  it('declares every component with a description, the four functions and the permanent id', () => {
    expect(catalogJson.catalogId).toBe(CATALOG_ID);
    expect(catalogJson.$id).toBe(CATALOG_ID);
    expect(catalogJson.protocolVersion).toBe('1.0');
    expect(Object.keys(catalogJson.components)).toEqual(COMPONENTS.map(c => c.name));
    for (const def of COMPONENTS) {
      const entry = catalogJson.components[def.name];
      expect(entry.description).toBe(def.doc);
      expect(entry.properties.component).toEqual({const: def.name});
      expect('unevaluatedProperties' in entry, `${def.name}: unevaluatedProperties removed`).toBe(false);
    }
    // decision what-if-as-a2ui-calls: add|sub|mul|div(a, b), strict here (a literal argument must be a number)
    expect(Object.keys(catalogJson.functions)).toEqual(['add', 'sub', 'mul', 'div']);
    expect(catalogJson.$defs.anyFunction.oneOf.map((f: {$ref: string}) => f.$ref)).toEqual(['add', 'sub', 'mul', 'div'].map(name => `#/functions/${name}`));
    for (const name of ['add', 'sub', 'mul', 'div']) expect(catalogJson.functions[name].properties.args.required, name).toEqual(['a', 'b']);
    expect(catalogJson.$defs.anyComponent.oneOf).toHaveLength(COMPONENTS.length);
    expect(catalogJson.components.Page.allowedParents).toEqual(['Surface']);
  });
});

describe('C2: every spec Glimpse writes compiles to valid v1.0 messages', () => {
  it('covers the 16 preset variants, the 44 examples, the gallery and the 6 recipes', () => {
    expect(entries).toHaveLength(16 + 44 + 1 + 6);
  });

  it.each(entries.map(e => [e.label, e] as const))('%s passes STRICT_VALIDATION and agent_to_renderer.json', (_label, entry) => {
    expect(strictErrors(entry.messages)).toEqual([]);
    for (const message of entry.messages) {
      expect(message.version).toBe('1.0');
      expect(validateMessage(message), JSON.stringify(validateMessage.errors?.slice(0, 3))).toBe(true);
    }
  });

  it('the gallery uses every component type and 70 components', () => {
    const gallery = entries.find(e => e.label === 'gallery')!.messages[0]!;
    if (!('createSurface' in gallery)) throw new Error('gallery is not a createSurface');
    expect(gallery.createSurface.components).toHaveLength(70);
    expect(new Set(gallery.createSurface.components.map(c => c.component))).toEqual(new Set(COMPONENTS.map(c => c.name)));
  });
});

describe('C3: the same corpus through Catalog.fromJson(catalog.json)', () => {
  it('loads every component from the JSON document', () => {
    expect(jsonCatalog.components.size).toBe(COMPONENTS.length);
  });

  it.each(entries.map(e => [e.label, e] as const))('%s is strictly valid for the JSON catalog', (_label, entry) => {
    expect(strictErrorsFromJson(entry.messages)).toEqual([]);
  });
});

describe('patch flows', () => {
  const base = buildSurface('feature', `$/plan=[]\n$/notes=''\nroot=Page('Feature',[plan,design,notes])\nplan=Steps($/plan,title='Plan')\ndesign=Text('none yet')\nnotes=Text($/notes)`);
  const kinds = (messages: A2uiMessage[]) => messages.map(m => Object.keys(m).find(k => k !== 'version'));

  it('a data assignment compiles to one updateDataModel', () => {
    const patch = buildPatch('feature', base, `$/plan=[{title:'Add limiter',status:'doing'},{title:'Tests'}]`);
    expect(kinds(patch)).toEqual(['updateDataModel']);
    expect(patch[0]).toMatchObject({updateDataModel: {surfaceId: 'feature', path: '/plan', value: [{title: 'Add limiter', status: 'doing'}, {title: 'Tests'}]}});
    expect(strictErrors([...base, ...patch])).toEqual([]);
  });

  it('a named part compiles to one updateComponents with only that component', () => {
    const patch = buildPatch('feature', base, `design=Flowchart('Req --> RL{Over limit?}; RL -->|no| H[Handler]',title='Design')`);
    expect(kinds(patch)).toEqual(['updateComponents']);
    const update = patch[0]!;
    if (!('updateComponents' in update)) throw new Error('expected updateComponents');
    expect(update.updateComponents.components.map(c => c.id)).toEqual(['design']);
    expect(strictErrors([...base, ...patch])).toEqual([]);
    for (const message of patch) expect(validateMessage(message)).toBe(true);
  });

  it('nested path assignments compile to one updateDataModel each', () => {
    const withPlan = [...base, ...buildPatch('feature', base, `$/plan=[{title:'A',status:'doing'},{title:'B'}]`)];
    const patch = buildPatch('feature', withPlan, `$/plan/0/status='done';$/plan/1/status='doing'`);
    expect(patch.map(m => ('updateDataModel' in m ? m.updateDataModel.path : undefined))).toEqual(['/plan/0/status', '/plan/1/status']);
  });

  it('a patch that introduces a source ref binds it and adds its pending envelope', () => {
    const patch = buildPatch('feature', base, `notes=DataTable('git.churn top=5',title='Churn')`);
    expect(kinds(patch)).toEqual(['updateComponents', 'updateDataModel']);
    expect(strictErrors([...base, ...patch])).toEqual([]);
  });

  it('a patch cannot be compiled without the surface it patches', () => {
    expect(() => compileExpress('nowhere', `$/x=1`, [])).toThrow();
  });
});

describe('negative corpus: invalid messages are rejected', () => {
  const base = buildSurface('s', `root=Page('T',[a,b])\na=Text('x')\nb=DataTable('git.churn',title='C')`);
  const mutate = (change: (surface: Extract<A2uiMessage, {createSurface: unknown}>['createSurface'], message: Record<string, unknown>) => void) => {
    const messages = structuredClone(base);
    const first = messages[0]!;
    if (!('createSurface' in first)) throw new Error('expected createSurface');
    change(first.createSurface, first as unknown as Record<string, unknown>);
    return messages;
  };
  const codes = (errors: unknown[]) => errors.map(e => (e as {error: {code: string}}).error.code);

  it('the unmodified surface is valid everywhere', () => {
    expect(strictErrors(base)).toEqual([]);
    expect(strictErrorsFromJson(base)).toEqual([]);
    expect(base.every(m => validateMessage(m))).toBe(true);
  });

  it('unknown prop', () => {
    const bad = mutate(s => { s.components[1]!.bogus = 1; });
    expect(codes(strictErrors(bad))).toEqual(['VALIDATION_FAILED']);
    expect(codes(strictErrorsFromJson(bad))).toEqual(['VALIDATION_FAILED']);
    expect(validateMessage(bad[0])).toBe(false);
  });

  it('bad enum value', () => {
    const bad = mutate(s => { s.components[0]!.width = 'huge'; });
    expect(codes(strictErrors(bad))).toEqual(['VALIDATION_FAILED']);
    expect(codes(strictErrorsFromJson(bad))).toEqual(['VALIDATION_FAILED']);
    expect(validateMessage(bad[0])).toBe(false);
  });

  it('hyphenated component id', () => {
    const bad = mutate(s => { s.components[1]!.id = 'my-part'; (s.components[0]!.children as string[])[0] = 'my-part'; });
    expect(codes(strictErrors(bad))).toEqual(['VALIDATION_FAILED']);
    expect(codes(strictErrorsFromJson(bad))).toEqual(['VALIDATION_FAILED']);
    // and Express cannot even name it
    expect(() => compileExpress('s', `root=Page('T',[my-part])\nmy-part=Text('x')`)).toThrow(/Syntax error/);
  });

  it('version "v1.0"', () => {
    const bad = mutate((_s, message) => { message.version = 'v1.0'; });
    expect(codes(strictErrors(bad))).toEqual(['VALIDATION_FAILED']);
    expect(validateMessage(bad[0])).toBe(false);
  });

  it('dangling child', () => {
    const bad = mutate(s => { (s.components[0]!.children as string[]).push('missing'); });
    expect(codes(strictErrors(bad))).toEqual(['INTEGRITY_ERROR']);
    expect(codes(strictErrorsFromJson(bad))).toEqual(['INTEGRITY_ERROR']);
    expect(() => compileExpress('s', `root=Page('T',[missing])`)).toThrow();
  });

  it('nested Page', () => {
    const bad = mutate(s => { s.components[1] = {id: 'a', component: 'Page', title: 'inner', children: []}; });
    expect(codes(strictErrors(bad))).toEqual(['UNALLOWED_PARENT']);
    expect(codes(strictErrorsFromJson(bad))).toEqual(['UNALLOWED_PARENT']);
    expect(() => compileExpress('s', `root=Page('T',[Page('inner',[])])`)).toThrow(/cannot be placed under parent/);
  });

  it.each([
    ['unknown component', `root=Page('x',[DataTabel('git.churn')])`, /DataTabel/],
    ['unknown prop', `root=Page('x',[DataTable('git.churn',colums='path')])`, /colums/],
    ['bad enum', `root=Page('x',[Callout('x','danger')])`, /danger/],
    ['missing required prop', `root=Page('x',[Flowchart()])`, /data/],
    ['syntax error', `root=Page('x',[Text('x')]`, /Syntax error/],
    ['span out of range', `root=Page('x',[Text('a',span=13)])`, /span/],
  ])('the compiler rejects %s', (_label, spec, message) => {
    expect(() => compileExpress('bad', spec)).toThrow(message);
  });
});

describe('upgrade guard: @a2ui 0.15 mixin keys', () => {
  // Glimpse never emits a mixin key (design decision 1), but the lint rules and the viewer rely on how 0.15.0
  // treats them. 0.16 renames them to @accessibility / @metadata / @catalogId / @checks.
  const UPGRADE_NOTES =
    'The installed @a2ui runtime no longer treats mixin keys like 0.15.0. Before upgrading: re-read the 0.16 changelog; ' +
    're-run the catalog lint with the @-prefixed names reserved; re-vendor packages/catalog/spec/v1_0; check kit/implement.tsx ' +
    '(props.context is deprecated in 0.16) and the catalog.json fix-ups in testing/artifacts.ts (unevaluatedProperties).';
  const withKey = (key: string) => {
    const messages = buildSurface('s', `root=Page('T',[a])\na=Text('x')`);
    const first = messages[0]!;
    if ('createSurface' in first) first.createSurface.components[1]![key] = {label: 'x'};
    return messages;
  };

  it('accepts bare `accessibility` on a strict component', () => {
    expect(strictErrors(withKey('accessibility')), UPGRADE_NOTES).toEqual([]);
  });

  it('rejects `@accessibility`', () => {
    expect(strictErrors(withKey('@accessibility')), UPGRADE_NOTES).toHaveLength(1);
  });

  it('toJson() still emits unevaluatedProperties: false, which the generator strips', () => {
    const raw = createApiCatalog().toJson() as {components: Record<string, Record<string, unknown>>};
    expect(raw.components.Text?.unevaluatedProperties, UPGRADE_NOTES).toBe(false);
  });
});
