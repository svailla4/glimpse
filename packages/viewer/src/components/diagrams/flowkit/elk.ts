// The page side of the ELK layout (decision D19): one shared module worker, one promise per request.
//   const {laid, ms} = await layoutElk(graph);   // graph: ELK JSON (elkjs/lib/elk-api.js types); laid: the same tree
//                                                // with x/y/width/height, edge sections and label positions filled in
//   prewarmElk();                                // start the worker early (its first answer costs ~80 ms: fetch,
//                                                // compile 1.47 MB, GWT start-up); call when the diagrams chunk loads
//   configureElkWorker(factory | null)           // tests: an in-process ELK, or no worker at all
// There is no main-thread fallback on purpose: ELK would put 449 kB gzip into the lazy diagrams chunk. Without a
// worker (jsdom, a browser that refuses one) layoutElk rejects, and the view shows its error state.
import type {ElkNode} from 'elkjs/lib/elk-api.js';
import type {ElkReply, ElkRequest} from './elk.protocol.ts';

export type {ElkReply, ElkRequest} from './elk.protocol.ts';

/** The part of a Worker this module uses; tests hand in their own. */
export interface ElkWorker {
  postMessage(request: ElkRequest): void;
  onmessage: ((event: {data: ElkReply}) => void) | null;
  onerror: ((event: unknown) => void) | null;
  terminate?(): void;
}
export type ElkWorkerFactory = () => ElkWorker;

export interface ElkLaid {
  /** The graph as ELK returned it. */
  laid: ElkNode;
  /** Time ELK took inside the worker. */
  ms: number;
}

// The pattern Vite recognises: the worker is bundled as its own entry and emitted as assets/elk.worker-<hash>.js,
// loaded from the same origin (a blob: or data: worker would be blocked by script-src 'self').
const browserFactory: ElkWorkerFactory | undefined =
  typeof Worker === 'function'
    ? () => new Worker(new URL('./elk.worker.ts', import.meta.url), {type: 'module', name: 'elk-layout'}) as unknown as ElkWorker
    : undefined;

let factory = browserFactory;
let worker: ElkWorker | undefined;
let nextId = 1;
const waiting = new Map<number, {resolve: (laid: ElkLaid) => void; reject: (error: Error) => void}>();

/** Replaces how the worker is made: undefined restores the browser's, null means none. Ends the current worker. */
export function configureElkWorker(next: ElkWorkerFactory | null | undefined): void {
  drop(new Error('the layout worker was replaced'));
  factory = next === undefined ? browserFactory : (next ?? undefined);
}

/** Ends the worker and fails what it still owes. The next request starts a new one. */
function drop(error: Error): void {
  const ended = worker;
  worker = undefined;
  ended?.terminate?.();
  const owed = [...waiting.values()];
  waiting.clear();
  for (const {reject} of owed) reject(error);
}

function getWorker(): ElkWorker {
  if (worker) return worker;
  if (!factory) throw new Error('no layout worker in this environment');
  const made = factory();
  made.onmessage = event => {
    const reply = event.data;
    const entry = waiting.get(reply.id);
    if (!entry) return;
    waiting.delete(reply.id);
    if (reply.ok) entry.resolve({laid: reply.laid, ms: reply.ms});
    else entry.reject(new Error(reply.error));
  };
  // A worker that fails to load or dies fails what it owes; it is not reused, but the next request tries a new one
  // (a later diagram can still draw after a passing failure).
  made.onerror = event => {
    if (worker !== made) return;
    const message = event && typeof event === 'object' && typeof (event as {message?: unknown}).message === 'string' ? (event as {message: string}).message : '';
    drop(new Error(`the layout worker failed${message ? `: ${message}` : ' to load'}`));
  };
  worker = made;
  return made;
}

/** Starts the worker now, so the first diagram does not wait for it. False when there is no worker to start. */
export function prewarmElk(): boolean {
  try {
    getWorker();
    return true;
  } catch {
    return false;
  }
}

/** Lays `graph` out in the worker. Rejects when there is no worker, it fails, or ELK refuses the graph. */
export function layoutElk(graph: ElkNode): Promise<ElkLaid> {
  return new Promise((resolve, reject) => {
    let target: ElkWorker;
    try {
      target = getWorker();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const id = nextId++;
    waiting.set(id, {resolve, reject});
    try {
      target.postMessage({id, graph});
    } catch (error) {
      // A graph that cannot be cloned (a function, a DOM node in it) fails alone; the worker is fine.
      waiting.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
