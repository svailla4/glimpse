// packages/viewer/src/components/content/index.ts  (stub by WP0; owned by WP4)
// Exports exactly `views`: component name -> view, one file per component next to this one, for example
//   import {DataTableView} from './DataTable.tsx';
//   export const views: Record<string, GlView<any>> = {DataTable: DataTableView};
// Components of this chunk (`chunk: 'content'` in @glimpse/catalog):
//   Text, Markdown, Callout, KeyValue, Chips, FileRef, Steps, Stat, Stats, List, Sparkline, SegmentedBar, Button, Ask
// A name missing here renders the "not implemented" redline (E_NOT_IMPLEMENTED) instead of the component.
// Rules for views are in the header of ../../kit/implement.tsx. Three concern this file: add a view here only
// after its file exists (a broken import here breaks every component of this chunk); reuse a view of another chunk
// only through borrowView(() => import('../<chunk>/index.ts'), name, Fallback), never by importing its file; and
// every Name.module.css wraps its content in `@layer gl.components { ... }` (the build fails otherwise).
// List accepts ListItem[] or any rows dataset; the mapping for rows is written above `List` in
// packages/catalog/src/components.ts (roles.label / roles.value first, then the first text and numeric fields).
import type {GlView} from '../../kit/index.ts';

export const views: Record<string, GlView<any>> = {};
