// Entry point of the Glimpse MCP server and its only composition root: the one module that names the real
// analyzers, git and code services and the production source registry. Everything else receives them as parameters.
//
// stdout is the JSON-RPC channel. Console output is sent to stderr before any other module is evaluated, which is
// why the rest of the program is loaded with import() below instead of static imports.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const {serve} = await import('./mcp/server.ts');

serve({
  env: process.env,
  argv: process.argv.slice(2),
  // Loaded by the first tool call: a process that is only probed, or a session that never uses Glimpse, pays nothing.
  loadDeps: async () => {
    const [{REGISTRY}, {checkRegistry}, analyze, git, code] = await Promise.all([
      import('./sources/all.ts'), import('./sources/registry.ts'), import('./analyze/index.ts'), import('./git/index.ts'), import('./code/index.ts'),
    ]);
    checkRegistry(message => void process.stderr.write(`${message}\n`), REGISTRY);
    return {
      registry: REGISTRY,
      createRepoIndex: analyze.createRepoIndex,
      createCodeService: code.createCodeService,
      createDiffService: git.createDiffService,
      createTreeWatcher: git.createTreeWatcher,
      readGitInfo: git.readGitInfo,
    };
  },
  // Bundled (plugin/dist/server.mjs): the viewer sits next to the bundle. From source: the viewer package's build.
  viewerDirs: [
    ...(process.env.GLIMPSE_VIEWER_DIR ? [process.env.GLIMPSE_VIEWER_DIR] : []),
    new URL('./viewer/', import.meta.url),
    new URL('../../viewer/dist/', import.meta.url),
  ],
});
