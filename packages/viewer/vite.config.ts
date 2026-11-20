// packages/viewer/vite.config.ts  (first version by WP0; owned by the viewer kit)
//   npm run dev   -w @glimpse/viewer    dev server on 127.0.0.1:5173
//   npm run build -w @glimpse/viewer    static app in packages/viewer/dist (index.html + hashed files under assets/)
// The server serves that directory under a strict Content-Security-Policy (script-src 'self'; style-src 'self'):
// nothing here may emit an inline <script> or <style>.
//
// Cascade layers (design 8.4). The order xyflow < gl.tokens < gl.base < gl.kit < gl.components must hold in every CSS
// file the build emits, whatever order modules are imported in and whichever lazy chunk loads first. `xyflow` is the
// layer React Flow's own stylesheet (@xyflow/react/dist/base.css, imported by the lazy diagrams chunk only) puts all
// its rules in: ordered first, the library's defaults lose to every Linework rule without !important, and they cannot
// touch the --gl-* tokens (base.css sets only --xy-* properties, on .react-flow). glimpseLayers():
// - puts the layer-order statement at the top of every emitted CSS file (the minifier drops the one in tokens.css
//   when it looks redundant, and a layer that is merely seen first would otherwise sort first);
// - fails the build when a CSS Module under src/ declares no gl.* layer: component modules wrap their content in
//   `@layer gl.components { ... }`, kit modules in `@layer gl.kit { ... }`.
// The dev server does not run the first step: there the order comes from src/main.tsx importing styles/tokens.css
// before anything else.
//
// The eager script (budget: 200 kB gzip, design section 10). Two modules the A2UI packages import but this viewer
// has no use for are aliased to small shims in src/kit/shims/ (each file says why it is safe):
// - `zod-to-json-schema`: @a2ui/web_core needs it only to write a catalog out as JSON Schema;
// - `@a2ui/web_core/v0_9/basic_catalog`: @a2ui/react takes the markdown-renderer registry from it, which drags in lit.
// test/build.test.ts checks that both stay out and that the eager script keeps headroom under the budget.
import {fileURLToPath} from 'node:url';
import react from '@vitejs/plugin-react';
import {defineConfig, type Plugin} from 'vite';

const shim = (name: string) => fileURLToPath(new URL(`./src/kit/shims/${name}.ts`, import.meta.url));
/** Exported for test/build.test.ts. */
export const SHIMS = [
  {find: /^zod-to-json-schema$/, replacement: shim('zod-to-json-schema')},
  {find: /^@a2ui\/web_core\/v0_9\/basic_catalog$/, replacement: shim('a2ui-basic-catalog')},
];

/** Exported for test/build.test.ts. styles/tokens.css declares the same order for the dev server. */
export const LAYER_ORDER = '@layer xyflow,gl.tokens,gl.base,gl.kit,gl.components;';

/**
 * React Flow (D19) and the runtime it brings, in a lazy chunk of its own (assets/xyflow-<hash>.js and .css): measured
 * on its own line in scripts/budgets.mjs, and cached across releases that change only diagram code. Only the d3
 * modules React Flow alone uses are captured: d3-interpolate and d3-color are shared with the charts' d3-scale and
 * stay where rolldown puts them, so loading a chart never loads React Flow. `includeDependenciesRecursively: false`
 * is required: otherwise the group also swallows what its modules import (react, react-dom) and becomes eager.
 * Exported for test/build.test.ts.
 */
export const XYFLOW_CHUNK = /node_modules[\\/](?:@xyflow[\\/]|d3-(?:zoom|drag|selection|transition|dispatch|ease|timer)[\\/]|zustand[\\/]|classcat[\\/]|react-compiler-runtime[\\/])/;

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
    alias: SHIMS,
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
    rolldownOptions: {
      // react-compiler-runtime (a React Flow 13 dependency) opens with "use no memo", a hint for the React Compiler,
      // which this build does not run; bundling drops it harmlessly. Every other log goes through.
      onLog(level, log, handler) {
        if (log.code === 'MODULE_LEVEL_DIRECTIVE' && /[\\/]react-compiler-runtime[\\/]/.test(log.id ?? log.message)) return;
        handler(level, log);
      },
      output: {
        codeSplitting: {includeDependenciesRecursively: false, groups: [{name: 'xyflow', test: XYFLOW_CHUNK}]},
      },
    },
  },
});
