// packages/viewer/src/kit/subscribe.ts
// One component of the surface model as an external store, for useSyncExternalStore. The model is mutable and keeps
// its identity when a component is updated, so a value read from it during render is cached by the React Compiler
// and never read again (decision compiled-viewer): read it in a snapshot instead. Not exported from kit/index.ts.
import type {SurfaceModel} from '@a2ui/web_core/v1_0';

type Components = SurfaceModel<never>['componentsModel'];

/**
 * Calls `notify` when the component `componentId` is updated, created (it may not exist yet, or be deleted and
 * created again under the same id) or deleted. Returns the unsubscribe function.
 */
export function subscribeComponent(components: Components, componentId: string, notify: () => void): () => void {
  let own = components.get(componentId)?.onUpdated.subscribe(notify);
  const created = components.onCreated.subscribe(model => {
    if (model.id !== componentId) return;
    own?.unsubscribe();
    own = model.onUpdated.subscribe(notify);
    notify();
  });
  const deleted = components.onDeleted.subscribe(id => { if (id === componentId) notify(); });
  return () => {
    own?.unsubscribe();
    created.unsubscribe();
    deleted.unsubscribe();
  };
}
