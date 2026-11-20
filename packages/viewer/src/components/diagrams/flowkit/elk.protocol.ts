// The one request and the one reply between the page (elk.ts) and the ELK layout worker (elk.worker.ts), and what
// the worker does with a request. Kept apart from the worker module so tests run the very same answer() with an
// in-process ELK (jsdom has no Worker), and so nothing on the page side imports ELK itself: the engine is 449 kB
// gzip and lives only in the worker file (decision D19).
import type {ELK, ElkNode} from 'elkjs/lib/elk-api.js';

/** An ELK JSON graph to lay out; every option travels in its `layoutOptions` (and those of its elements). */
export type ElkRequest = {id: number; graph: ElkNode};
export type ElkReply =
  | {id: number; ok: true; laid: ElkNode; ms: number}
  | {id: number; ok: false; error: string};

/** Lays one request out with `elk`; never throws (a failure is a reply). */
export async function answer(elk: Pick<ELK, 'layout'>, request: ElkRequest): Promise<ElkReply> {
  const started = performance.now();
  try {
    const laid = await elk.layout(request.graph);
    return {id: request.id, ok: true, laid, ms: performance.now() - started};
  } catch (error) {
    return {id: request.id, ok: false, error: describe(error)};
  }
}

/** ELK's GWT errors are objects with a `message` (or a `g` holding one), not always Error instances. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (error && typeof error === 'object') {
    const message = (error as {message?: unknown}).message ?? (error as {g?: unknown}).g;
    if (typeof message === 'string' && message !== '') return message;
  }
  return String(error);
}
