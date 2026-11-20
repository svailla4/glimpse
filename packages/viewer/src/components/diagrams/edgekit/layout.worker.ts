// The layout of a large diagram, off the main thread (useLayout.ts): one message in, one message out.
import {layoutDiagram, type Laid, type LayoutSpec} from './layout.ts';

export type LayoutRequest = {id: number; spec: LayoutSpec};
export type LayoutReply = {id: number; laid: Laid} | {id: number; error: string};

/** What the worker does with one request; exported for the tests, which have no workers. */
export function answer(request: LayoutRequest): LayoutReply {
  try {
    return {id: request.id, laid: layoutDiagram(request.spec)};
  } catch (error) {
    return {id: request.id, error: error instanceof Error ? error.message : String(error)};
  }
}

const scope = globalThis as unknown as {onmessage: ((event: {data: LayoutRequest}) => void) | null; postMessage(reply: LayoutReply): void; document?: unknown};
// Only inside a worker: imported by a test, this module must not take over the page's message handler.
if (scope.document === undefined) scope.onmessage = event => scope.postMessage(answer(event.data));
