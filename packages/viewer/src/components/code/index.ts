// packages/viewer/src/components/code/index.ts
// The `code` chunk: component name -> view. A name missing here renders the E_NOT_IMPLEMENTED redline.
import type {GlView} from '../../kit/index.ts';
import {CodeBlockView} from './CodeBlock.tsx';
import {CodeTourView} from './CodeTour.tsx';
import {CodeViewView} from './CodeView.tsx';
import {DiffViewView} from './DiffView.tsx';
import {SymbolOutlineView} from './SymbolOutline.tsx';

export const views: Record<string, GlView<any>> = {
  CodeBlock: CodeBlockView,
  CodeView: CodeViewView,
  DiffView: DiffViewView,
  CodeTour: CodeTourView,
  SymbolOutline: SymbolOutlineView,
};
