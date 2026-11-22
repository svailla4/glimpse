// One vitest run for the whole repo, split into three projects.
//   npm test                                     everything
//   npm test -w @glimpse/viewer                  one project (same as: npx vitest run --project viewer)
//   npx vitest run packages/viewer/test/table    one directory or file (path filters are substring matches)
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vitest/config';
import {reactCompiler} from './packages/viewer/vite.config.ts';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'catalog',
          root: 'packages/catalog',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'server',
          root: 'packages/server',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
      {
        plugins: [react(), reactCompiler()],
        resolve: {dedupe: ['@a2ui/web_core', 'react', 'react-dom', 'zod']},
        test: {
          name: 'viewer',
          root: 'packages/viewer',
          include: ['test/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          // RTL cleanup after each test and React's act() environment flag (vitest globals are off).
          setupFiles: ['test/setup.ts'],
          // Longer than the 10 s one waitFor may take (test/setup.ts), so a wait that fails reports its assertion
          // ("expected X, received Y") instead of the test timing out mid-wait with no detail.
          testTimeout: 20_000,
        },
      },
    ],
  },
});
