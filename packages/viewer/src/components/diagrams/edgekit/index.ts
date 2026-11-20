// edgekit: what the node-link diagrams share. Graph, Flowchart and ERDiagram draw on <Diagram>; SequenceDiagram
// and Layers use the text helpers only.
export {Diagram, matchesSelection} from './Diagram.tsx';
export type {DiagramEdge, DiagramGroup, DiagramNode, DiagramProps, NodeFlags} from './Diagram.tsx';
export * from './geometry.ts';
export {layoutDiagram, signatureOf} from './layout.ts';
export type {Laid, LayoutEdge, LayoutGroup, LayoutNode, LayoutSpec, Route} from './layout.ts';
export {POSITIONS_KEY, configurePositionStorage, positionsKey, readPositions, useNodePositions, writePositions} from './positions.ts';
export type {NodePositions, Positions} from './positions.ts';
export * from './text.ts';
export {SYNC_EDGE_LIMIT, SYNC_NODE_LIMIT, useLayout} from './useLayout.ts';
export type {LayoutState} from './useLayout.ts';
