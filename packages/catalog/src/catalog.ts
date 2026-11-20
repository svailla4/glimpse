// packages/catalog/src/catalog.ts
import {Catalog} from '@a2ui/web_core/v1_0';
import {COMPONENTS} from './components.ts';

/** Permanent. A breaking catalog change mints urn:glimpse:catalog:v2 and the viewer registers both. */
export const CATALOG_ID = 'urn:glimpse:catalog:v1';
export const PROTOCOL_VERSION = '1.0' as const;

export const CATALOG_INSTRUCTIONS = [
  'Root is Page(title, children). Children flow on a 12-column grid; every component takes span=1..12.',
  'Data props take a /ds binding (server dataset), any other binding, or an inline value. Datasets are self-describing: tables and charts need no column or axis props.',
  'Data, chart, diagram and code components draw their own plate frame when given title=.',
  'Code and diffs are read from disk by the renderer host: CodeView(file) and DiffView(range) carry no file contents.',
  'The current selection is at /ui/sel ({type,id,path?,line?}); the selected file is at /ui/file ("path#L10-20").',
].join('\n');

/** Schema-only catalog: validation, Express compilation and toJson() in Node. Never imports @a2ui/react. */
export function createApiCatalog() {
  return new Catalog(
    CATALOG_ID,
    PROTOCOL_VERSION,
    COMPONENTS.map(c => ({
      name: c.name,
      schema: c.schema,
      ...(c.allowedParents ? {allowedParents: c.allowedParents} : {}),
      ...(c.allowedChildren ? {allowedChildren: c.allowedChildren} : {}),
    })),
    [],
    {instructions: CATALOG_INSTRUCTIONS, title: 'Glimpse', description: 'Generative UI for codebases.'},
  );
}
