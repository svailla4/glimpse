// packages/viewer/src/components/layout/index.ts  (owned by WP4)
// Exports exactly `views`: component name -> view, one file per component next to this one.
// Components of this chunk (`chunk: 'layout'` in @glimpse/catalog):
//   Page, Plate, Section, Grid, Row, Column, Tabs, Split
// Page, Section, Grid and Row let people rearrange their cells (design 12.1.A, kit/arrange.tsx); Column, Tabs, Plate
// and Split do not, and say so by providing a null ArrangeContext to their children.
import type {GlView} from '../../kit/index.ts';
import {ColumnView} from './Column.tsx';
import {GridView} from './Grid.tsx';
import {PageView} from './Page.tsx';
import {PlateView} from './Plate.tsx';
import {RowView} from './Row.tsx';
import {SectionView} from './Section.tsx';
import {SplitView} from './Split.tsx';
import {TabsView} from './Tabs.tsx';

export const views: Record<string, GlView<any>> = {
  Page: PageView,
  Plate: PlateView,
  Section: SectionView,
  Grid: GridView,
  Row: RowView,
  Column: ColumnView,
  Tabs: TabsView,
  Split: SplitView,
};
