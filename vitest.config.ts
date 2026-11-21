// One vitest run for the whole repo, split into three projects.
//   npm test                                     everything
//   npm test -w @glimpse/viewer                  one project (same as: npx vitest run --project viewer)
//   npx vitest run packages/viewer/test/table    one directory or file (path filters are substring matches)
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vitest/config';

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
        plugins: [react()],
        resolve: {dedupe: ['@a2ui/web_core', 'react', 'react-dom', 'zod']},
        test: {
          name: 'viewer',
          root: 'packages/viewer',
          include: ['test/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          // RTL cleanup after each test and React's act() environment flag (vitest globals are off).
          setupFiles: ['test/setup.ts'],
          // At least the 10 s a waitFor may take (test/setup.ts): a test of several waits that takes 400 ms here took
          // over 5 s on a macOS CI runner and timed out at the default, mid-wait.
          testTimeout: 20_000,
        },
      },
    ],
  },
});
