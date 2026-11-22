// flowkit: the engine Graph, Flowchart and ERDiagram draw with (decisions diagram-engine-in-worker, content-sized-plates): ELK lays out in a worker
// (elk.ts), React Flow 13 draws (Diagram.tsx), and the height and opening view follow the content (sizing.ts).
// SequenceDiagram and Layers draw themselves and use the text and path helpers only. Views import from here, never
// elk.worker.ts or elkjs itself.
// React Flow's stylesheet is imported here, once, and only here: base.css (structure only; the Linework look is
// ours) puts every rule in `@layer xyflow`, which the layer order sorts below all gl.* layers (vite.config.ts,
// styles/tokens.css), and the build emits it as assets/xyflow-<hash>.css, fetched with the lazy React Flow chunk.
import '@xyflow/react/dist/base.css';

export {Diagram, labelPlate, seen} from './Diagram.tsx';
export type {DiagramProps} from './Diagram.tsx';
export {configureElkWorker, layoutElk, prewarmElk} from './elk.ts';
export type {ElkLaid, ElkReply, ElkRequest, ElkWorker, ElkWorkerFactory} from './elk.ts';
export * from './geometry.ts';
export {GROUP_PAD, fromElk, hasCycle, partCount, signatureOf, toElk} from './graph.ts';
export type {Laid, LayoutEdge, LayoutGroup, LayoutNode, LayoutSpec, Route} from './graph.ts';
export {FULL_ZOOM, LOD_ZOOM, detailAt, legsOf, zoomStep} from './parts.tsx';
export type {Detail, DiagramEdge, DiagramGroup, DiagramNode, NodeFlags} from './parts.tsx';
export {POSITIONS_KEY, configurePositionStorage, positionsKey, readPositions, useNodePositions, writePositions} from './positions.ts';
export type {NodePositions, Positions} from './positions.ts';
export {CONTROLS, MIN_HEIGHT, PAD, READABLE_ZOOM, centred, cutAt, fitZoom, readableZoom, scoreLayout, sizeDiagram} from './sizing.ts';
export type {SizeInput, Sizing, Viewport} from './sizing.ts';
export * from './text.ts';
export {clearLayoutCache, layoutAll, useLayouts} from './useLayout.ts';
export type {LayoutState} from './useLayout.ts';
