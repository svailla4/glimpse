// End-to-end suite (design 10): Playwright Chromium against the real bundled MCP server, driven over stdio.
//   npm run e2e                          everything
//   npm run e2e -- overview              one spec file (substring match)
//   GLIMPSE_DIST=<dir> npm run e2e       test another build (see support/paths.ts for every variable)
// One worker: each test owns a server process and the timings are recorded, so the tests do not compete for the CPU.
import {join} from 'node:path';
import {defineConfig} from '@playwright/test';
import {ARTIFACTS} from './support/paths.ts';

const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: join(ARTIFACTS, 'playwright'),
  globalSetup: './support/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  timeout: 90_000,
  expect: {timeout: 10_000},
  reporter: ci ? [['list'], ['html', {outputFolder: join(ARTIFACTS, 'report'), open: 'never'}]] : [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: {width: 1320, height: 900},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
