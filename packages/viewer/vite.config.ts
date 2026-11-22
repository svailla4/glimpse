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
//
// Third-party notices (scripts/notices.ts). Two more plugins:
// - glimpseModuleRecord() records, for the main build and the ELK worker's own build, which modules went into each
//   script and which source file each asset (the fonts) was copied from, in .vite/glimpse-modules.json in the output
//   directory. scripts/build.mjs reads it to write the notices and does not copy it into plugin/.
// - elkNotices() puts elkjs's copyright notices back at the top of the ELK worker: the minifier drops them, and the
//   Eclipse Public License 2.0 (s. 3.3) does not allow them to be removed.
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import react from '@vitejs/plugin-react';
import {defineConfig, type Plugin} from 'vite';
import {ELK_LICENSE_FILE, MODULE_RECORD, type OutputRecord} from '../../scripts/notices.ts';

const shim = (name: string) => fileURLToPath(new URL(`./src/kit/shims/${name}.ts`, import.meta.url));
/** Exported for test/build.test.ts. */
export const SHIMS = [
  {find: /^zod-to-json-schema$/, replacement: shim('zod-to-json-schema')},
  {find: /^@a2ui\/web_core\/v0_9\/basic_catalog$/, replacement: shim('a2ui-basic-catalog')},
];

/** Exported for test/build.test.ts. styles/tokens.css declares the same order for the dev server. */
export const LAYER_ORDER = '@layer xyflow,gl.tokens,gl.base,gl.kit,gl.components;';

/**
 * React Flow (diagram-engine-in-worker) and the runtime it brings, in a lazy chunk of its own (assets/xyflow-<hash>.js and .css): measured
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

const viewerRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(viewerRoot, '..', '..');
/** A module id or a source file as a repository-relative path; bundler-internal ids (`\0...`) stay as they are. */
const repoPath = (id: string, base = viewerRoot) => {
  if (id.startsWith('\0')) return id;
  const file = id.split('?')[0] ?? id;
  return relative(repoRoot, isAbsolute(file) ? file : resolve(base, file)).split(sep).join('/');
};
/** What the worker build recorded; the main build writes it out with its own, after the worker has been bundled. */
const workerOutputs = new Map<string, OutputRecord>();

function glimpseModuleRecord(build: 'main' | 'worker'): Plugin {
  return {
    name: `glimpse:module-record-${build}`,
    generateBundle(_options, bundle) {
      const outputs = Object.values(bundle)
        .filter(file => file.fileName !== MODULE_RECORD)
        .map((file): OutputRecord => (file.type === 'chunk' ? {file: file.fileName, modules: Object.keys(file.modules).map(id => repoPath(id))} : {file: file.fileName, originalFileNames: (file.originalFileNames ?? []).map(name => repoPath(name))}));
      if (build === 'worker') {
        for (const output of outputs) workerOutputs.set(output.file, output);
        return;
      }
      const record = {main: outputs, worker: [...workerOutputs.values()]};
      this.emitFile({type: 'asset', fileName: MODULE_RECORD, source: `${JSON.stringify(record, null, 1)}\n`});
    },
  };
}

function elkNotices(): Plugin {
  const require = createRequire(import.meta.url);
  const source = readFileSync(require.resolve('elkjs/lib/elk.bundled.js'), 'utf8');
  const {version} = JSON.parse(readFileSync(require.resolve('elkjs/package.json'), 'utf8')) as {version: string};
  const headers = [...new Set(source.match(/\/\*{20,}\n[\s\S]*?\*{20,}\//g)?.filter(block => /Copyright[^\n]*Kiel University/.test(block)) ?? [])];
  return {
    name: 'glimpse:elk-notices',
    generateBundle(_options, bundle) {
      if (headers.length === 0) this.error('elkjs/lib/elk.bundled.js has no Kiel University copyright header any more: check its notices and update elkNotices() in vite.config.ts');
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !Object.keys(chunk.modules).some(id => /[\\/]node_modules[\\/]elkjs[\\/]/.test(id))) continue;
        const intro = `/*! elkjs ${version} (https://github.com/kieler/elkjs), distributed by Glimpse under the Eclipse Public License 2.0. The licence, the notices and where to get the Source Code: ${ELK_LICENSE_FILE} next to this file. The notices of elkjs's lib/elk.bundled.js follow, unchanged. */`;
        chunk.code = `${intro}\n${headers.join('\n')}\n${chunk.code}`;
      }
    },
  };
}

export default defineConfig({
  plugins: [glimpseLayers(), react(), glimpseModuleRecord('main')],
  worker: {plugins: () => [glimpseModuleRecord('worker'), elkNotices()]},
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
