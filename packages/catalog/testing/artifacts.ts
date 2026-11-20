// packages/catalog/testing/artifacts.ts
// Every generated file of packages/catalog, as {path relative to packages/catalog: content}. scripts/generate.ts
// writes them; test/docs.test.ts fails when the files on disk are stale. Pure and deterministic.
import {DATASET_FIXTURES, HOST_FIXTURES} from '../fixtures/index.ts';
import {CATALOG_ID, createApiCatalog} from '../src/catalog.ts';
import {COMPONENTS} from '../src/components.ts';
import {serverInstructions, typedSignatureList} from '../src/docs.ts';
import {GALLERY_SPEC} from '../src/gallery.ts';
import {SOURCES} from '../src/sources.ts';
import {buildSurface} from './index.ts';

/**
 * generated/catalog.json: createApiCatalog().toJson() with two fixes per component (design 4.1): drop
 * `unevaluatedProperties` (0.15.0 emits it and it makes valid messages fail the spec schema) and add
 * `description` (which toJson() cannot emit).
 */
export function buildCatalogJson(): Record<string, unknown> {
  const doc = createApiCatalog().toJson() as Record<string, any>;
  for (const def of COMPONENTS) {
    const {unevaluatedProperties: _dropped, type, ...rest} = doc.components[def.name];
    doc.components[def.name] = {type, description: def.doc, ...rest};
  }
  return {$schema: 'https://json-schema.org/draft/2020-12/schema', $id: CATALOG_ID, ...doc};
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

export function buildArtifacts(): Record<string, string> {
  const files: Record<string, string> = {
    'generated/catalog.json': json(buildCatalogJson()),
    'generated/instructions.txt': serverInstructions() + '\n',
    'generated/signatures.txt': typedSignatureList() + '\n',
    'fixtures/gallery.wire.json': json(buildSurface('gallery', GALLERY_SPEC)),
    'fixtures/host/file.json': json(HOST_FIXTURES.file),
    'fixtures/host/diff.json': json(HOST_FIXTURES.diff),
    'fixtures/host/outline.json': json(HOST_FIXTURES.outline),
    'fixtures/host/rows.json': json(HOST_FIXTURES.rows),
  };
  for (const source of SOURCES) {
    const dataset = DATASET_FIXTURES[source.name];
    if (!dataset) throw new Error(`no dataset fixture for source ${source.name}`);
    files[`fixtures/datasets/${source.name}.json`] = json(dataset);
  }
  return files;
}
