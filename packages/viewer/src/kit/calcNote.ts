// packages/viewer/src/kit/calcNote.ts
// Why the values computed from a Slider's number have none at the number it holds now (decision what-if-as-a2ui-calls). Like hooks.ts
// this reads the surface model, so views never import @a2ui/*. It is not exported from kit/index.ts: only the Slider
// imports it, so it and the call walkers of the catalog's calls.ts stay in the lazy `charts` chunk, out of the
// eager script.
import {useA2uiSurface, useSignalValue} from '@a2ui/react';
import {computed, getValue} from '@a2ui/web_core/v1_0';
import {callsIn, explainValue, reads, type CalcReason} from '@glimpse/catalog';
import {useMemo} from 'react';

/** The absolute $/path a component's `value` binds as the spec wrote it, or undefined. */
function boundPath(raw: unknown): string | undefined {
  const path = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['@path'] : undefined;
  return typeof path === 'string' && path.startsWith('/') ? path : undefined;
}

/**
 * The first reason, in component order, that a call reading the path `componentId`'s `value` binds gives no number:
 * 'division by zero', 'not a number', 'too large', 'unknown'. undefined when every such call computes, or when the
 * component binds no absolute path. 'not set' and 'relative' are never the answer: a value nobody wrote yet and a
 * relative $path are the server's report (an unbound path, a calc line), not something the user caused. It is worked out again whenever a path one of those calls reads
 * changes; a component the spec redefines is read again at the next data change.
 */
export function useCalcNote(componentId: string): Exclude<CalcReason, 'not set' | 'relative'> | undefined {
  const surface = useA2uiSurface();
  if (!surface) throw new Error('Glimpse views must render inside an A2uiSurface');
  // Read on each render of the caller, so a Slider bound to another path is followed.
  const path = boundPath(surface.componentsModel.get(componentId)?.properties.value);
  const note = useMemo(
    () =>
      computed(() => {
        if (path === undefined) return undefined;
        // getValue inside computed() subscribes to every path a call reads, and only to those.
        const read = (at: string) => getValue(surface.dataModel.getSignal(at));
        for (const [, model] of surface.componentsModel.entries) {
          for (const {call} of callsIn(model.properties)) {
            if (!reads(call, path)) continue;
            const got = explainValue(call, read);
            if ('problem' in got && got.reason !== 'not set' && got.reason !== 'relative') return got.reason;
          }
        }
        return undefined;
      }),
    [surface, path],
  );
  return useSignalValue(note) as Exclude<CalcReason, 'not set' | 'relative'> | undefined;
}
