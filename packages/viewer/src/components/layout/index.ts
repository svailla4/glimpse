// packages/viewer/src/components/layout/index.ts  (stub by WP0; owned by WP4)
// Exports exactly `views`: component name -> view, one file per component next to this one, for example
//   import {DataTableView} from './DataTable.tsx';
//   export const views: Record<string, GlView<any>> = {DataTable: DataTableView};
// Components of this chunk (`chunk: 'layout'` in @glimpse/catalog):
//   Page, Plate, Section, Grid, Row, Column, Tabs, Split
// A name missing here renders the "not implemented" redline (E_NOT_IMPLEMENTED) instead of the component.
// Rules for views are in the header of ../../kit/implement.tsx. Three concern this file: add a view here only
// after its file exists (a broken import here breaks every component of this chunk); reuse a view of another chunk
// only through borrowView(() => import('../<chunk>/index.ts'), name, Fallback), never by importing its file; and
// every Name.module.css wraps its content in `@layer gl.components { ... }` (the build fails otherwise).
// Containers that let people rearrange their cells (Page, Section, Grid, Row; design 12.1.A) get the child component
// ids from useChildIds(id) and the surface id from useSurfaceId(): the tokens in props.children are not ids.
import type {GlView} from '../../kit/index.ts';

export const views: Record<string, GlView<any>> = {};
