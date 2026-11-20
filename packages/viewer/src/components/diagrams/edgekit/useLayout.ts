// Runs the layout where it does not hold up the page: small diagrams are laid out during render (a few
// milliseconds), larger ones in a worker while the drafting frame is on screen, so a dense graph at the 150-node cap
// never blocks the main thread (design 5.6). Where there is no worker (tests, a browser that refuses one) a large
// layout runs after first paint instead. Results are remembered by signature, so remounting a diagram (a tab switch,
// a surface replaced with the same data) or resizing it back costs nothing.
import {useEffect, useMemo, useState} from 'react';
import {layoutDiagram, signatureOf, type Laid, type LayoutSpec} from './layout.ts';
import type {LayoutReply, LayoutRequest} from './layout.worker.ts';

/** Above this many nodes the layout runs off the main thread (design 5.6). */
export const SYNC_NODE_LIMIT = 80;
/** A small but dense graph costs as much as a large one. */
export const SYNC_EDGE_LIMIT = 200;
const CACHE_SIZE = 12;

type Result = {status: 'ready'; laid: Laid} | {status: 'error'; message: string};
export type LayoutState = Result | {status: 'pending'};

const cache = new Map<string, Result>();

function remember(signature: string, result: Result): Result {
  cache.set(signature, result);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return result;
}

function compute(spec: LayoutSpec, signature: string): Result {
  const hit = cache.get(signature);
  if (hit) {
    // Refresh its place: the map is the LRU order.
    cache.delete(signature);
    cache.set(signature, hit);
    return hit;
  }
  try {
    return remember(signature, {status: 'ready', laid: layoutDiagram(spec)});
  } catch (error) {
    return remember(signature, {status: 'error', message: error instanceof Error ? error.message : String(error)});
  }
}

// ---------------------------------------------------------------- the worker
/** The part of a Worker this module uses; tests hand in their own. */
export interface LayoutWorker {
  postMessage(request: LayoutRequest): void;
  onmessage: ((event: {data: LayoutReply}) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
type WorkerFactory = () => LayoutWorker;

const defaultFactory: WorkerFactory | undefined = typeof Worker === 'function'
  ? () => new Worker(new URL('./layout.worker.ts', import.meta.url), {type: 'module'}) as unknown as LayoutWorker
  : undefined;
let factory = defaultFactory;
let worker: LayoutWorker | undefined;
/** False once the worker failed to start or answer: layouts run after paint from then on. */
let workerUsable = true;
let nextId = 1;
const waiting = new Map<number, {signature: string; done: (result: Result) => void}>();

/** Replaces how the layout worker is made (null: no worker). For tests; also resets a worker that failed. */
export function configureLayoutWorker(next: WorkerFactory | null | undefined): void {
  factory = next === undefined ? defaultFactory : (next ?? undefined);
  worker = undefined;
  workerUsable = true;
  waiting.clear();
}

function failWorker(): void {
  workerUsable = false;
  worker = undefined;
  // What was asked of it is laid out here instead.
  const pending = [...waiting.values()];
  waiting.clear();
  for (const {done} of pending) done({status: 'error', message: 'worker failed'});
}

function getWorker(): LayoutWorker | undefined {
  if (!workerUsable || !factory) return undefined;
  if (worker) return worker;
  try {
    const made = factory();
    made.onmessage = event => {
      const reply = event.data;
      const entry = waiting.get(reply.id);
      if (!entry) return;
      waiting.delete(reply.id);
      entry.done(remember(entry.signature, 'laid' in reply ? {status: 'ready', laid: reply.laid} : {status: 'error', message: reply.error}));
    };
    made.onerror = () => failWorker();
    worker = made;
    return made;
  } catch {
    workerUsable = false;
    return undefined;
  }
}

/** Lays `spec` out in the worker; calls `done` with the result. Returns false when there is no worker to ask. */
function inWorker(spec: LayoutSpec, signature: string, done: (result: Result) => void): (() => void) | false {
  const target = getWorker();
  if (!target) return false;
  const id = nextId++;
  let live = true;
  waiting.set(id, {signature, done: result => { if (live) done(result); }});
  try {
    target.postMessage({id, spec});
  } catch {
    waiting.delete(id);
    failWorker();
    return false;
  }
  // A cancelled request still fills the cache when it comes back; only the answer is no longer wanted.
  return () => { live = false; };
}

/** Calls `task` once the browser had a chance to paint; returns a cancel function. */
function afterPaint(task: () => void): () => void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    task();
  };
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let frame: number | undefined;
  if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(() => timers.push(setTimeout(run, 0)));
  // A hidden tab gets no animation frames; do not wait for one forever.
  timers.push(setTimeout(run, 120));
  return () => {
    done = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    for (const timer of timers) clearTimeout(timer);
  };
}

/** The layout of `spec`; pending while a large one is computed, and while there is no spec yet (the stage is not measured). */
export function useLayout(spec: LayoutSpec | undefined): LayoutState {
  const signature = useMemo(() => (spec ? signatureOf(spec) : undefined), [spec]);
  const immediate = spec !== undefined && signature !== undefined
    && ((spec.nodes.length <= SYNC_NODE_LIMIT && spec.edges.length <= SYNC_EDGE_LIMIT) || cache.has(signature));
  // A new spec object with an old signature is a cache hit, so the result keeps its identity.
  const sync = useMemo(() => (immediate && spec && signature !== undefined ? compute(spec, signature) : undefined), [immediate, spec, signature]);
  const [deferred, setDeferred] = useState<{signature: string; result: Result}>();

  useEffect(() => {
    if (immediate || !spec || signature === undefined) return;
    const fallback = () => afterPaint(() => setDeferred({signature, result: compute(spec, signature)}));
    let cancel: () => void = () => {};
    const asked = inWorker(spec, signature, result => {
      // A worker that broke: lay the diagram out here after all.
      if (result.status === 'error' && !workerUsable) cancel = fallback();
      else setDeferred({signature, result});
    });
    cancel = asked === false ? fallback() : asked;
    return () => cancel();
  }, [immediate, spec, signature]);

  if (sync) return sync;
  return signature !== undefined && deferred?.signature === signature ? deferred.result : {status: 'pending'};
}
