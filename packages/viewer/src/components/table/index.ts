// packages/viewer/src/components/table/index.ts  (WP5)
// The `table` chunk: component name -> view. A name missing here renders the "not implemented" redline.
import type {GlView} from '../../kit/index.ts';
import {CommitListView} from './CommitList.tsx';
import {DataTableView} from './DataTable.tsx';
import {FileTreeView} from './FileTree.tsx';
import {JsonViewView} from './JsonView.tsx';

export const views: Record<string, GlView<any>> = {
  DataTable: DataTableView,
  FileTree: FileTreeView,
  CommitList: CommitListView,
  JsonView: JsonViewView,
};
