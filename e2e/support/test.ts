// The suite's `test`: Playwright's, plus a repository, a bundled server started for it and a watched page.
//
//   test.use({projectDir: ROOT})    run against a real directory instead of a fresh fixture repository
import {test as base, type PlaywrightTestArgs, type PlaywrightTestOptions, type PlaywrightWorkerArgs, type PlaywrightWorkerOptions, type TestInfo} from '@playwright/test';
import {makeFixtureRepo} from '../../packages/server/test/fixtures/repo.ts';
import {startGlimpse, watch, type Glimpse, type Watch} from './glimpse.ts';

export {FIXTURE} from '../../packages/server/test/fixtures/repo.ts';
export {expect} from '@playwright/test';

interface Fixtures {
  /** A directory to analyse; undefined (the default) builds the deterministic fixture repository. */
  projectDir: string | undefined;
  /** Root of the repository under test. */
  repoRoot: string;
  /** Short name for reports: 'fixture' or the directory's base name. */
  repoLabel: string;
  glimpse: Glimpse;
  watched: Watch;
}

export const test = base.extend<Fixtures>({
  projectDir: [undefined, {option: true}],
  repoRoot: async ({projectDir}, use) => {
    if (projectDir !== undefined) {
      await use(projectDir);
      return;
    }
    const repo = await makeFixtureRepo();
    try {
      await use(repo.root);
    } finally {
      await repo.cleanup();
    }
  },
  repoLabel: async ({projectDir}, use) => {
    await use(projectDir === undefined ? 'fixture' : projectDir.split(/[\\/]/).filter(Boolean).at(-1) ?? 'repo');
  },
  glimpse: async ({repoRoot}, use, testInfo) => {
    const glimpse = await startGlimpse(repoRoot);
    try {
      await use(glimpse);
    } finally {
      await glimpse.close();
      if (!(await glimpse.exited()) && glimpse.pid !== null) process.kill(glimpse.pid, 'SIGKILL');
      if (testInfo.status !== testInfo.expectedStatus) await testInfo.attach('server-stderr', {body: glimpse.stderr(), contentType: 'text/plain'});
    }
  },
  watched: async ({page}, use) => {
    await use(await watch(page));
  },
});

type Body = (args: Fixtures & PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions, testInfo: TestInfo) => Promise<void> | void;

/**
 * A test that fails because of a product defect this suite found. It is declared with test.fixme, so the suite stays
 * green and the report lists it as a known gap; `ref` is the id used in e2e/README.md. Run these as ordinary tests with
 * GLIMPSE_E2E_KNOWN=1 (they are expected to fail until the defect is fixed, then the wrapper should be removed).
 */
export function knownDefect(ref: string, title: string, body: Body): void {
  if (process.env.GLIMPSE_E2E_KNOWN === '1') test(`${title} [${ref}]`, body);
  else test.fixme(`${title} [${ref}]`, body);
}
