// packages/viewer/src/main.tsx - the viewer's entry.
//
// Two rules for this file:
// 1. './styles/tokens.css' is the FIRST import, before anything that can reach a component. It declares the layer
//    order (xyflow, gl.tokens, gl.base, gl.kit, gl.components); CSS is emitted in import order, and a layer that is seen
//    first sorts first. The build repeats the declaration at the top of every CSS file (vite.config.ts), but the
//    dev server relies on this import order alone.
// 2. Fixture data is loaded with a dynamic import, and only in dev builds, so it stays out of the eager bundle
//    (budget: 215 kB gzip) and out of the bundle the host serves.
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/base.css';
import './styles/kit.css';
import './styles/syntax.css';
import type {Transport} from '@glimpse/catalog';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App.tsx';
import {warmChunks} from './catalog.ts';
import {Notice} from './shell/Notice.tsx';
import {applyPrefs, loadPrefs} from './shell/prefs.ts';
import {createViewerSession} from './shell/session.ts';
import {createHubTransport} from './transport/hub.ts';
import {launchFromLocation} from './transport/launch.ts';

/** `?fixture=gallery` in a dev build: canned surfaces, no host. */
async function fixtureTransport(): Promise<Transport | undefined> {
  if (!import.meta.env.DEV) return undefined;
  const name = new URLSearchParams(window.location.search).get('fixture');
  if (name === null) return undefined;
  const {createFixtureTransport, isFixtureName} = await import('./transport/fixture.ts');
  return createFixtureTransport(isFixtureName(name) ? name : 'gallery');
}

async function main() {
  // Before the first render, so a remembered theme is on screen from the first frame React paints.
  applyPrefs(loadPrefs());
  const root = document.getElementById('root');
  if (!root) return;
  const launch = launchFromLocation();
  const transport = (await fixtureTransport()) ?? (launch.token === null ? undefined : createHubTransport({token: launch.token}));
  createRoot(root).render(
    <StrictMode>
      {transport ? (
        <App session={createViewerSession(transport, {route: launch.route})} />
      ) : (
        <Notice title="No session">
          This tab was opened without a session token. Ask your agent to show a view, then open the link it prints (it ends in <code>#t=…</code>).
          {import.meta.env.DEV ? <> In a dev build, <a href="?fixture=gallery">open the gallery fixture</a>.</> : null}
        </Notice>
      )}
    </StrictMode>,
  );
  // The lazy chunks, once the first view is up and the tab has a quiet moment (catalog.ts, warmChunks).
  if (transport) {
    const idle = (globalThis as {requestIdleCallback?: (run: () => void, options: {timeout: number}) => number}).requestIdleCallback;
    setTimeout(() => (idle ? idle(warmChunks, {timeout: 2000}) : warmChunks()), 1000);
  }
}

void main();
