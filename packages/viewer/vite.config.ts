// packages/viewer/vite.config.ts  (WP0, frozen)
//   npm run dev   -w @glimpse/viewer    dev server on 127.0.0.1:5173
//   npm run build -w @glimpse/viewer    static app in packages/viewer/dist (index.html + hashed files under assets/)
// The server serves that directory under a strict Content-Security-Policy (script-src 'self'; style-src 'self'):
// nothing here may emit an inline <script> or <style>.
//
// Cascade layers (design 8.4). The order gl.tokens < gl.base < gl.kit < gl.components must hold in every CSS file
// the build emits, whatever order modules are imported in and whichever lazy chunk loads first. glimpseLayers():
// - puts the layer-order statement at the top of every emitted CSS file (the minifier drops the one in tokens.css
//   when it looks redundant, and a layer that is merely seen first would otherwise sort first);
// - fails the build when a CSS Module under src/ declares no gl.* layer: component modules wrap their content in
//   `@layer gl.components { ... }`, kit modules in `@layer gl.kit { ... }`.
// The dev server does not run the first step: there the order comes from src/main.tsx importing styles/tokens.css
// before anything else.
import react from '@vitejs/plugin-react';
import {defineConfig, type Plugin} from 'vite';

const LAYER_ORDER = '@layer gl.tokens,gl.base,gl.kit,gl.components;';

function glimpseLayers(): Plugin {
  return {
    name: 'glimpse:layers',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0] ?? id;
      if (!file.endsWith('.module.css') || file.includes('/node_modules/') || !file.includes('/src/')) return null;
      const css = code.replace(/\/\*[\s\S]*?\*\//g, '');
      if (!/@layer\s+gl\.(?:kit|components)\b/.test(css)) {
        this.error(`${file}: a CSS Module must put its rules in a layer. Wrap the whole file in "@layer gl.components { ... }" (kit modules: "@layer gl.kit { ... }").`);
      }
      return null;
    },
    generateBundle(_options, bundle) {
      for (const asset of Object.values(bundle)) {
        if (asset.type !== 'asset' || !asset.fileName.endsWith('.css')) continue;
        const css = typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source);
        // A leading @charset must stay first; nothing else may precede the layer order.
        const charset = /^@charset\s+"[^"]*";/.exec(css)?.[0] ?? '';
        asset.source = charset + LAYER_ORDER + css.slice(charset.length);
      }
    },
  };
}

export default defineConfig({
  plugins: [glimpseLayers(), react()],
  resolve: {
    // @a2ui/web_core keeps module-level state (signals, registries): exactly one copy may be bundled.
    dedupe: ['@a2ui/web_core', 'react', 'react-dom', 'zod'],
  },
  server: {host: '127.0.0.1', port: 5173},
  preview: {host: '127.0.0.1', port: 4173},
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Evergreen browsers only: tokens.css relies on light-dark() and @layer, which must reach the browser untouched.
    target: ['chrome125', 'edge125', 'firefox128', 'safari17.5'],
    cssTarget: ['chrome125', 'edge125', 'firefox128', 'safari17.5'],
    // The module-preload polyfill is only needed by browsers older than the targets above.
    modulePreload: {polyfill: false},
    // Fonts and other files stay as files; a data: URI font would need a wider font-src in the CSP.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 700,
  },
});
