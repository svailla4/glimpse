// packages/viewer/src/main.tsx - THROWAWAY by WP0. WP4 replaces this file with the real entry (shell, transports).
// It renders the gallery fixture through the real catalog so the build can be checked before any component exists:
// every component without a view shows the "not implemented" redline, and its children still render.
//
// Two things the real entry keeps:
// 1. './styles/tokens.css' is the FIRST import, before anything that can reach a component. It declares the layer
//    order (gl.tokens, gl.base, gl.kit, gl.components); CSS is emitted in import order, and a layer that is seen
//    first sorts first. The build repeats the declaration at the top of every CSS file (vite.config.ts), but the
//    dev server relies on this import order alone.
// 2. Fixture data is loaded with a dynamic import, so it stays out of the eager bundle (budget: 200 kB gzip).
import './styles/tokens.css';
import './styles/base.css';
import {A2uiSurface, type ReactCatalogComponent} from '@a2ui/react';
import {MessageProcessor} from '@a2ui/web_core/v1_0';
import type {A2uiMessage} from '@glimpse/catalog';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {createGlimpseCatalog} from './catalog.ts';
import {KitProvider, kitSlots} from './kit/index.ts';

async function main() {
  const [{createFixtureHost}, gallery] = await Promise.all([import('@glimpse/catalog/fixtures'), import('@glimpse/catalog/fixtures/gallery.wire.json')]);
  const processor = new MessageProcessor<ReactCatalogComponent>([createGlimpseCatalog(kitSlots)], undefined, {
    // The viewer is lenient (design 2.6); strictness lives in the server.
    validationConfig: {allowUnknownElements: false, allowDanglingReferences: true, allowOrphanComponents: true, allowMissingRoot: true},
  });
  const messages = structuredClone(gallery.default) as A2uiMessage[];
  for (const error of processor.processMessagesWithErrors(messages)) console.error('glimpse: invalid fixture message', error);

  const surface = processor.model.getSurface('gallery');
  const root = document.getElementById('root');
  if (!root || !surface) return;
  createRoot(root).render(
    <StrictMode>
      <KitProvider host={createFixtureHost()}>
        <div className="gl-page">
          <div className="gl-grid12">
            <A2uiSurface surface={surface} />
          </div>
        </div>
      </KitProvider>
    </StrictMode>,
  );
}

void main();
