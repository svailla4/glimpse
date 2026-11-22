// Lays a diagram out in the ELK worker (decision diagram-engine-in-worker) and keeps the results: one or more specs in (two when the
// diagram lets the direction be chosen), their layouts out, or pending while the worker works, or the error. Nothing
// is laid out on the main thread. Results are remembered by signature, so remounting a diagram (a tab switch, a
// surface replaced with the same data) shows it at once. The reveal is a transition: React may yield while it builds
// the canvases of a page of diagrams that arrive together.
import {startTransition, useEffect, useMemo, useRef, useState} from 'react';
import {layoutElk} from './elk.ts';
import {fromElk, signatureOf, toElk, type Laid, type LayoutSpec} from './graph.ts';

export type LayoutState =
  | {status: 'pending'}
  | {status: 'ready'; laid: readonly Laid[]; ms: number}
  | {status: 'error'; message: string};

const CACHE_SIZE = 16;
const cache = new Map<string, {laid: readonly Laid[]; ms: number}>();

function remember(key: string, value: {laid: readonly Laid[]; ms: number}): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}

/** Forgets every remembered layout (tests). */
export function clearLayoutCache(): void {
  cache.clear();
}

/** Lays every spec out in the worker; in the order given. */
export async function layoutAll(specs: readonly LayoutSpec[]): Promise<{laid: Laid[]; ms: number}> {
  const results = await Promise.all(specs.map(spec => layoutElk(toElk(spec))));
  return {laid: results.map((result, i) => fromElk(result.laid, specs[i]!)), ms: Math.max(0, ...results.map(result => result.ms))};
}

/** The layouts of `specs`, pending until the worker answers. Undefined specs: pending. */
export function useLayouts(specs: readonly LayoutSpec[] | undefined): LayoutState {
  const key = useMemo(() => (specs ? specs.map(signatureOf).join('\u0003') : undefined), [specs]);
  const hit = key !== undefined ? cache.get(key) : undefined;
  const [done, setDone] = useState<{key: string; state: LayoutState}>();
  // The specs of the current key: a new array with the same signature (a resize, a re-render) asks for nothing new.
  const latest = useRef(specs);
  latest.current = specs;

  useEffect(() => {
    const asked = latest.current;
    if (key === undefined || !asked || cache.has(key)) return;
    let live = true;
    layoutAll(asked).then(
      result => {
        remember(key, result);
        if (live) startTransition(() => setDone({key, state: {status: 'ready', ...result}}));
      },
      (error: unknown) => {
        if (live) setDone({key, state: {status: 'error', message: error instanceof Error ? error.message : String(error)}});
      },
    );
    return () => {
      live = false;
    };
  }, [key]);

  if (hit) return {status: 'ready', ...hit};
  return key !== undefined && done?.key === key ? done.state : {status: 'pending'};
}
