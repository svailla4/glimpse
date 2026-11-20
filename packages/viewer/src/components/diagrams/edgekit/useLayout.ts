// Runs the layout where it does not hold up paint: small diagrams are laid out during render (a few milliseconds),
// larger ones after the drafting frame is on screen. Results are remembered by signature, so remounting a diagram
// (a tab switch, a surface replaced with the same data) costs nothing.
import {useEffect, useMemo, useState} from 'react';
import {layoutDiagram, signatureOf, type Laid, type LayoutSpec} from './layout.ts';

/** Above this many nodes the layout runs after first paint (design 5.6). */
export const SYNC_NODE_LIMIT = 80;
/** A small but dense graph costs as much as a large one. */
export const SYNC_EDGE_LIMIT = 200;
const CACHE_SIZE = 12;

type Result = {status: 'ready'; laid: Laid} | {status: 'error'; message: string};
export type LayoutState = Result | {status: 'pending'};

const cache = new Map<string, Result>();

function compute(spec: LayoutSpec, signature: string): Result {
  const hit = cache.get(signature);
  if (hit) {
    // Refresh its place: the map is the LRU order.
    cache.delete(signature);
    cache.set(signature, hit);
    return hit;
  }
  let result: Result;
  try {
    result = {status: 'ready', laid: layoutDiagram(spec)};
  } catch (error) {
    result = {status: 'error', message: error instanceof Error ? error.message : String(error)};
  }
  cache.set(signature, result);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return result;
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

export function useLayout(spec: LayoutSpec): LayoutState {
  const signature = useMemo(() => signatureOf(spec), [spec]);
  const immediate = (spec.nodes.length <= SYNC_NODE_LIMIT && spec.edges.length <= SYNC_EDGE_LIMIT) || cache.has(signature);
  // A new spec object with an old signature is a cache hit, so the result keeps its identity.
  const sync = useMemo(() => (immediate ? compute(spec, signature) : undefined), [immediate, spec, signature]);
  const [deferred, setDeferred] = useState<{signature: string; result: Result}>();

  useEffect(() => {
    if (immediate) return;
    return afterPaint(() => setDeferred({signature, result: compute(spec, signature)}));
  }, [immediate, spec, signature]);

  if (sync) return sync;
  return deferred?.signature === signature ? deferred.result : {status: 'pending'};
}
