// Shared by the catalog tests: the spec corpus and the JSON Schema validators built from the vendored v1.0 schemas.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {COMPONENT_EXAMPLES, COMPONENTS, EXAMPLES, GALLERY_SPEC, VIEW_BY_NAME, parseViewRef, type A2uiMessage} from '../src/index.ts';
import {buildPatch, buildSurface} from '../testing/index.ts';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export const readJson = (path: string) => JSON.parse(readFileSync(here(path), 'utf8'));
export const readText = (path: string) => readFileSync(here(path), 'utf8');

const spec = (name: string) => readJson(`../spec/v1_0/${name}`);

function ajv() {
  const instance = new Ajv2020({strict: false, allErrors: true, discriminator: false});
  instance.addSchema(spec('common_types.json'));
  return instance;
}

/** Validator for a catalog document (spec: catalog_definition.json). */
export function catalogDefinitionValidator() {
  return ajv().compile(spec('catalog_definition.json'));
}

/** Validator for one agent-to-renderer message against the spec envelope plus the given catalog document. */
export function messageValidator(catalogDoc: Record<string, unknown>) {
  const instance = ajv();
  const envelope = spec('agent_to_renderer.json');
  instance.addSchema({...catalogDoc, $id: new URL('catalog.json', envelope.$id).href});
  return instance.compile(envelope);
}

/** Every preset with every argument shape the design lists (16 variants). */
export const PRESET_CALLS = [
  'overview', 'tree', 'tree src/auth', 'deps', 'deps packages/server', 'hotspots', 'hotspots src since=90d', 'history',
  "history it's/odd path", 'file src/core/index.ts', 'symbol MessageProcessor', 'stack', 'diff', 'diff staged', 'diff main..HEAD', 'feature',
] as const;

export function presetSource(call: string): {view: string; source: string} {
  const {view, target, args} = parseViewRef(call);
  const meta = VIEW_BY_NAME.get(view);
  if (!meta) throw new Error(`unknown preset ${view}`);
  return {view, source: meta.build(target, args)};
}

/** A component `example` is one expression unless it already assigns root. */
export const exampleSpec = (example: string) => (/^root\s*=/.test(example) ? example : `root=Page('Example',[${example}])`);

export interface CorpusEntry { label: string; messages: A2uiMessage[] }

/**
 * Everything Glimpse itself writes in Express, compiled and expanded the way the server publishes it:
 * the 16 preset variants, the 44 component examples, the gallery, and the seven recipes (new views and patches).
 */
export function corpus(): CorpusEntry[] {
  const entries: CorpusEntry[] = [];
  for (const call of PRESET_CALLS) {
    const {view, source} = presetSource(call);
    entries.push({label: `view ${call}`, messages: buildSurface(view, source)});
  }
  for (const def of COMPONENTS) entries.push({label: `example ${def.name}`, messages: buildSurface('example', exampleSpec(COMPONENT_EXAMPLES[def.name]))});
  entries.push({label: 'gallery', messages: buildSurface('gallery', GALLERY_SPEC, {datasets: 'ready'})});
  for (const example of EXAMPLES) {
    if (!example.view) {
      entries.push({label: `recipe ${example.title}`, messages: buildSurface(example.id ?? 'main', example.spec ?? '')});
      continue;
    }
    const {view, source} = presetSource(example.view);
    const base = buildSurface(view, source);
    entries.push({label: `recipe ${example.title}`, messages: [...base, ...buildPatch(view, base, example.spec ?? '')]});
  }
  return entries;
}
