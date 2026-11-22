// packages/viewer/src/kit/surface.ts
// What a container may know about its children beyond their ids: which catalog component each one is, and whether
// it draws its own plate. Like hooks.ts this reads the surface model, so views never import @a2ui/*.
import {useA2uiSurface} from '@a2ui/react';
import {useCallback, useMemo, useSyncExternalStore} from 'react';

export interface ChildInfo {
  /** Catalog component name; '' while the component does not exist (a dangling reference). */
  type: string;
  /** Whether a `title` is set (literal or bound), so a plate-able leaf draws its own frame. */
  titled: boolean;
}

/** Type and title of the components `ids` name, in the same order. Follows updateComponents. */
export function useChildInfo(ids: readonly string[]): ChildInfo[] {
  const surface = useA2uiSurface();
  if (!surface) throw new Error('Glimpse views must render inside an A2uiSurface');
  // The contents of `ids` as one string, so a new array with the same ids does not resubscribe. The callback reads the
  // ids back out of it: a dependency it did not read would be dropped by the React Compiler (decision compiled-viewer).
  // Ids hold no line break (decision hyphenated-surface-ids).
  const key = ids.join('\n');
  const subscribe = useCallback(
    (notify: () => void) => {
      const components = surface.componentsModel;
      const wanted = new Set(key === '' ? [] : key.split('\n'));
      const own = new Map<string, {unsubscribe(): void}>();
      const watch = (id: string) => {
        own.get(id)?.unsubscribe();
        const model = components.get(id);
        if (model) own.set(id, model.onUpdated.subscribe(notify));
      };
      for (const id of wanted) watch(id);
      const created = components.onCreated.subscribe(model => {
        if (!wanted.has(model.id)) return;
        watch(model.id);
        notify();
      });
      const deleted = components.onDeleted.subscribe(id => { if (wanted.has(id)) notify(); });
      return () => {
        for (const subscription of own.values()) subscription.unsubscribe();
        created.unsubscribe();
        deleted.unsubscribe();
      };
    },
    [surface, key],
  );
  // A string snapshot is stable between renders; it is parsed back out below.
  const snapshot = useSyncExternalStore(subscribe, () =>
    JSON.stringify(ids.map(id => {
      const model = surface.componentsModel.get(id);
      const title: unknown = model?.properties.title;
      return [model?.type ?? '', title !== undefined && title !== null && title !== ''];
    })),
  );
  return useMemo(() => (JSON.parse(snapshot) as Array<[string, boolean]>).map(([type, titled]) => ({type, titled})), [snapshot]);
}
