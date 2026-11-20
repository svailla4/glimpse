// packages/viewer/src/components/diagrams/index.ts
// The `diagrams` chunk: component name -> view. flowkit/ holds what the diagrams share: ELK in a worker and React Flow
// for Graph, Flowchart and ERDiagram (decision D19), the content-sized height (D20), text and path helpers.
import type {GlView} from '../../kit/index.ts';
import {ERDiagramView} from './ERDiagram.tsx';
import {FlowchartView} from './Flowchart.tsx';
import {prewarmElk} from './flowkit/index.ts';
import {GraphView} from './Graph.tsx';
import {LayersView} from './Layers.tsx';
import {SequenceDiagramView} from './SequenceDiagram.tsx';

// The layout worker's first answer costs about 80 ms (fetch, compile, start-up): start it as soon as the diagrams
// chunk loads, so the first diagram does not wait for it. Without a worker (tests) this does nothing.
prewarmElk();

export const views: Record<string, GlView<any>> = {
  Graph: GraphView,
  Flowchart: FlowchartView,
  SequenceDiagram: SequenceDiagramView,
  Layers: LayersView,
  ERDiagram: ERDiagramView,
};
