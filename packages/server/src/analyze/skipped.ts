// Directories that never hold the project's own source: version-control data, installed dependencies, tool caches.
// One list, no imports: the inventory applies it when it lists files, and the diff applies it to untracked files, so
// "a file of the project" means the same thing in both.
export const ALWAYS_SKIPPED: ReadonlySet<string> = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.gradle', '.dart_tool',
  'Pods', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '.terraform', 'DerivedData', '.idea',
]);

/** True for a path that lies inside one of those directories. */
export const underSkipped = (path: string): boolean => path.split('/').slice(0, -1).some(segment => ALWAYS_SKIPPED.has(segment));
