// packages/viewer/src/components/diagrams/index.ts
// The `diagrams` chunk: component name -> view. edgekit/ holds what the node-link diagrams share.
import type {GlView} from '../../kit/index.ts';
import {ERDiagramView} from './ERDiagram.tsx';
import {FlowchartView} from './Flowchart.tsx';
import {GraphView} from './Graph.tsx';
import {LayersView} from './Layers.tsx';
import {SequenceDiagramView} from './SequenceDiagram.tsx';

export const views: Record<string, GlView<any>> = {
  Graph: GraphView,
  Flowchart: FlowchartView,
  SequenceDiagram: SequenceDiagramView,
  Layers: LayersView,
  ERDiagram: ERDiagramView,
};
