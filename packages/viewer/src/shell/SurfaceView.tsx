// packages/viewer/src/shell/SurfaceView.tsx
// Mounts one surface. A surface whose root is a Page brings its own page container; any other root is put on the
// same 12-column grid without a masthead (design 5.2). A failure outside every component's own boundary shows one
// redline instead of an empty tab, and is reported to the host.
import {A2uiSurface} from '@a2ui/react';
import {Component, useCallback, useSyncExternalStore, type JSX, type ReactNode} from 'react';
import {Redline} from '../kit/index.ts';
import type {Surface} from './session.ts';

const ROOT = 'root';

/** Catalog name of the root component; undefined until the surface has one. */
function useRootType(surface: Surface): string | undefined {
  const subscribe = useCallback(
    (notify: () => void) => {
      const components = surface.componentsModel;
      const created = components.onCreated.subscribe(model => { if (model.id === ROOT) notify(); });
      const deleted = components.onDeleted.subscribe(id => { if (id === ROOT) notify(); });
      return () => {
        created.unsubscribe();
        deleted.unsubscribe();
      };
    },
    [surface],
  );
  return useSyncExternalStore(subscribe, () => surface.componentsModel.get(ROOT)?.type);
}

class SurfaceBoundary extends Component<{surfaceId: string; onError(message: string): void; children: ReactNode}, {error?: Error}> {
  state: {error?: Error} = {};
  static getDerivedStateFromError(error: Error) { return {error}; }
  componentDidCatch(error: Error) { this.props.onError(error.message); }
  render() {
    const {error} = this.state;
    if (!error) return this.props.children;
    return (
      <div className="gl-page">
        <Redline code="E_RENDER" id={`Surface#${this.props.surfaceId}`} message={error.message} />
      </div>
    );
  }
}

export function SurfaceView(p: {surface: Surface; onError(message: string): void}): JSX.Element {
  const rootType = useRootType(p.surface);
  const tree = <A2uiSurface surface={p.surface} />;
  return (
    <SurfaceBoundary surfaceId={p.surface.id} onError={p.onError}>
      {rootType === 'Page' ? tree : (
        <div className="gl-page" data-bare="">
          <div className="gl-grid12">{tree}</div>
        </div>
      )}
    </SurfaceBoundary>
  );
}
