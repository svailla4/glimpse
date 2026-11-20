// scripts/server-bundle.ts - the esbuild options of the server bundle (plugin/dist/server.mjs), shared by
// scripts/build.mjs, which writes the bundle, and by the notices test, which bundles in memory to learn what ships.
import {dirname, join} from 'node:path';
import type {BuildOptions, Plugin} from 'esbuild';

/**
 * Leaves the GLSL grammar out of the bundle. Shiki's C++ grammar imports it for GLSL embedded in C++ source, and no
 * licence could be found for it (its upstream, polym0rph/GLSL.tmbundle, has none; tm-grammars lists none), so it
 * cannot be redistributed with a notice. In its place the C grammar it extends is imported, which C++ already loads:
 * C++ still highlights fully, except for GLSL inside it. Glimpse never maps a file to GLSL (src/code/langs.ts).
 */
export const omitUnlicensedGrammars: Plugin = {
  name: 'glimpse:omit-unlicensed-grammars',
  setup(build) {
    build.onResolve({filter: /^\.\/glsl\.mjs$/}, args => {
      if (!/[\\/]@shikijs[\\/]langs[\\/]dist[\\/]/.test(args.importer)) return undefined;
      return {path: 'glsl.mjs', namespace: 'glimpse-omitted', pluginData: {dir: dirname(args.importer)}};
    });
    build.onLoad({filter: /.*/, namespace: 'glimpse-omitted'}, args => ({
      contents: "import c from './c.mjs';\nexport default [...c];\n",
      resolveDir: (args.pluginData as {dir: string}).dir,
      loader: 'js',
    }));
  },
};

/** The options scripts/build.mjs bundles packages/server/src/main.ts with. `root` is the repository root. */
export function serverBuildOptions(root: string, outfile: string): BuildOptions & {metafile: true} {
  return {
    absWorkingDir: root,
    entryPoints: [join(root, 'packages', 'server', 'src', 'main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // Some dependencies still call require() for Node built-ins; an ESM bundle has to provide it.
    banner: {js: "import {createRequire as __cr} from 'node:module'; const require = __cr(import.meta.url);"},
    // Comments esbuild treats as legal (/*!, //!, @license, @preserve) go to server.mjs.LEGAL.txt. The complete
    // third-party notices are THIRD_PARTY_NOTICES.md, written by scripts/notices.ts from the metafile.
    legalComments: 'external',
    logLevel: 'warning',
    metafile: true,
    plugins: [omitUnlicensedGrammars],
  };
}
