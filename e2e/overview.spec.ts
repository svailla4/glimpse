// The end-to-end test of design section 10: the nine steps on the fixture repository, then the first four on real
// repositories (this one, and GLIMPSE_E2E_REPO when set).
import {appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {expectSettled, expectSurface, openViewer, recordTiming, TOKEN} from './support/glimpse.ts';
import {EXTRA_REPO, ROOT} from './support/paths.ts';
import {expect, FIXTURE, knownDefect, test} from './support/test.ts';

const HOT_ROWS = '.gl-cell[data-id="hot"] [role="row"][data-index]';
const GRAPH_NODES = '.gl-cell[data-id="deps"] svg [data-node]';

test.describe('fixture repository', () => {
  test('overview: result, first plate, patch, select, live diff, bad spec, shutdown', async ({page, glimpse, watched, repoRoot}, testInfo) => {
    // Steps 1 and 2 are the fixtures: makeFixtureRepo(), the built bundle, the server spawned over stdio.
    const shown = await test.step('3. show{view:"overview"} answers with the documented lines', async () => {
      const result = await glimpse.call('show', {view: 'overview'});
      expect(result.isError, result.text).toBe(false);
      expect(result.lines[0]).toMatch(new RegExp(`^ok overview http://127\\.0\\.0\\.1:\\d+/#/overview tab=none \\d+ms open http://127\\.0\\.0\\.1:\\d+/#t=${TOKEN}$`));
      expect(result.lines[1]).toMatch(/^repo \S+ main@[0-9a-f]{7} dirty \| 36 files \d+ loc \| TypeScript \d+%/);
      // one `ds` line per dataset the preset binds, none of them a failure
      const datasets = result.lines.filter(line => line.startsWith('ds ')).map(line => line.slice(3).split(' | ')[0]);
      expect(datasets.sort()).toEqual([
        'deps.cycles', 'deps.external top=12', 'deps.modules', 'files.langs', 'files.tree', 'git.hotspots top=15', 'git.timeline', 'repo.kpis', 'repo.packages', 'repo.stack',
      ]);
      expect(result.lines.filter(line => line.startsWith('warn '))).toEqual([]);
      expect(result.lines).toContain('parts kpis stack notes map langs deps side activity hot pkgs | slots $/notes');
      expect(result.text.length, 'preset result budget (design 10)').toBeLessThanOrEqual(1200);
      recordTiming({test: testInfo.title, repo: 'fixture', metric: 'time to result (show overview, cold)', ms: result.ms});
      return result;
    });

    await test.step('4. the viewer renders the overview', async () => {
      const firstPlate = await openViewer(page, glimpse);
      recordTiming({test: testInfo.title, repo: 'fixture', metric: 'time to first plate', ms: firstPlate});
      expect(firstPlate, 'time from navigation to the first [data-gl="Page"]').toBeLessThanOrEqual(2000);
      await expect.poll(() => page.locator('.gl-cell').count()).toBeGreaterThanOrEqual(10);
      const started = performance.now();
      await expectSettled(page);
      recordTiming({test: testInfo.title, repo: 'fixture', metric: 'navigation to settled (no drafting frames)', ms: firstPlate + Math.round(performance.now() - started)});
      await expect(page.locator(HOT_ROWS).first()).toBeVisible();
      expect(await page.locator(HOT_ROWS).count()).toBe(15);
      expect(await page.locator(GRAPH_NODES).count()).toBeGreaterThan(3);
      // the fixture's one import cycle is on the page
      await expect(page.locator('.gl-cell[data-id="side"]')).toContainText('src/auth/service.ts');
      // the token left the address bar and lives in sessionStorage only
      expect(new URL(page.url()).hash).toBe('#/overview');
      expect(await page.evaluate(() => sessionStorage.getItem('glimpse.token'))).toBe(TOKEN);
      expect(watched.problems).toEqual([]);
      expect(await watched.csp()).toEqual([]);
    });

    await test.step('5. a data patch shows up without a reload', async () => {
      await page.evaluate(() => { (globalThis as unknown as {__glSameDocument: boolean}).__glSameDocument = true; });
      const patched = await glimpse.call('show', {id: 'overview', spec: "$/notes='hello **world**'"});
      expect(patched.isError, patched.text).toBe(false);
      expect(patched.lines[0]).toMatch(/^ok overview \S+ tab=live \d+ms$/);
      recordTiming({test: testInfo.title, repo: 'fixture', metric: 'time to result (patch, tab live)', ms: patched.ms});
      const notes = page.locator('.gl-cell[data-id="notes"]');
      await expect(notes).toContainText('hello world');
      await expect(notes.locator('strong')).toHaveText('world');
      expect(await page.evaluate(() => (globalThis as unknown as {__glSameDocument?: boolean}).__glSameDocument)).toBe(true);
    });

    await test.step('6. a click reaches the agent once', async () => {
      await page.locator(HOT_ROWS).first().click();
      await expect.poll(async () => (await glimpse.call('events', {})).text, {timeout: 5000}).toMatch(/^viewer: select file src\/auth\/service\.ts \(overview\)$/);
      expect((await glimpse.call('pending_context', {})).text).toBe('{}');
      expect((await glimpse.call('events', {})).text).toBe('none');
    });

    await test.step('7. the diff view lists the edited files and follows the working tree', async () => {
      const diff = await glimpse.call('show', {view: 'diff'});
      expect(diff.isError, diff.text).toBe(false);
      expect(diff.lines[0]).toMatch(/^ok diff \S+ tab=live \d+ms$/);
      recordTiming({test: testInfo.title, repo: 'fixture', metric: 'time to result (show diff, tab live)', ms: diff.ms});
      await expectSurface(page, 'diff');
      const files = page.locator('[data-gl="DiffView"] [role="option"]');
      for (const path of FIXTURE.workingTree.modified) await expect(files.filter({hasText: path.split('/').at(-1)})).toHaveCount(1);
      expect(await files.evaluateAll(options => options.map(option => option.getAttribute('data-path')))).toEqual(
        [...FIXTURE.workingTree.modified, ...FIXTURE.workingTree.untracked].sort(),
      );
      await expectSettled(page);
      const edited = FIXTURE.workingTree.modified[0];
      const started = performance.now();
      await appendFile(join(repoRoot, edited), '\n// glimpse-e2e-marker\n');
      await expect(page.locator('[data-gl="DiffView"]')).toContainText('glimpse-e2e-marker', {timeout: 5000});
      recordTiming({test: testInfo.title, repo: 'fixture', metric: 'file edit to diff on screen', ms: Math.round(performance.now() - started)});
    });

    await test.step('8. a bad spec is an error that names the valid kinds and changes nothing', async () => {
      const before = {cells: await page.locator('.gl-cell').count(), title: await page.locator('[data-gl="Page"] h1').first().textContent()};
      const bad = await glimpse.call('show', {spec: "root=Page('x',[Callout('y','danger')])"});
      expect(bad.isError).toBe(true);
      expect(bad.lines[0]).toBe('E_ENUM Callout.kind: "danger" is not allowed. Use: note tip warn risk decision question');
      expect(bad.lines.at(-1)).toBe('Nothing was rendered; the previous view is unchanged.');
      await page.waitForTimeout(300);
      await expectSurface(page, 'diff');
      expect(await page.locator('[role="tab"][data-surface]').count()).toBe(2);
      expect({cells: await page.locator('.gl-cell').count(), title: await page.locator('[data-gl="Page"] h1').first().textContent()}).toEqual(before);
      expect(before.title).toBe('Changes');
    });

    await test.step('9. closing the client ends the process and the page says so', async () => {
      await glimpse.close();
      expect(await glimpse.exited(3000), 'the server process is gone').toBe(true);
      await expect(page.locator('[data-gl-banner="ended"]')).toHaveText('Session ended. This is a snapshot.');
      // the last pixels stay
      expect(await page.locator('.gl-cell').count()).toBeGreaterThan(5);
    });

    expect(shown.isError).toBe(false);
    // The lost connection after shutdown is the only request allowed to fail.
    expect(watched.problems.filter(problem => !/ERR_CONNECTION_REFUSED|ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_EMPTY_RESPONSE|Failed to load resource/.test(problem))).toEqual([]);
    expect(await watched.csp()).toEqual([]);
  });

  test('a second tab gets the same snapshot, and a reload keeps the route', async ({page, glimpse, watched, context}) => {
    await glimpse.call('show', {view: 'overview'});
    await glimpse.call('show', {view: 'stack'});
    await openViewer(page, glimpse);
    await expectSurface(page, 'stack');
    await expectSettled(page);
    await page.locator('[role="tab"][data-surface="overview"]').click();
    await expect(page).toHaveURL(/#\/overview$/);
    await page.reload();
    await expectSurface(page, 'overview');
    await expect(page.locator(HOT_ROWS).first()).toBeVisible();

    const second = await context.newPage();
    await second.goto(glimpse.url());
    await expect(second.locator('[role="tab"][data-surface]')).toHaveCount(2);
    await expect(second.locator('[data-gl="Page"]').first()).toBeVisible();
    await second.close();
    expect(watched.problems).toEqual([]);
  });
});

for (const [label, dir] of [['this repository', ROOT], ...(EXTRA_REPO ? [['GLIMPSE_E2E_REPO', EXTRA_REPO]] : [])] as Array<[string, string]>) {
  test.describe(label, () => {
    test.use({projectDir: dir});

    test('overview renders from real analyzers', async ({page, glimpse, watched, repoLabel}, testInfo) => {
      const result = await glimpse.call('show', {view: 'overview'});
      expect(result.isError, result.text).toBe(false);
      expect(result.lines[0]).toMatch(/^ok overview http:\/\/127\.0\.0\.1:\d+\/#\/overview tab=none \d+ms open /);
      expect(result.lines[1]).toMatch(/^repo \S+ /);
      expect(result.lines.filter(line => line.startsWith('ds ')).length).toBeGreaterThanOrEqual(10);
      expect(result.text.length, 'preset result budget (design 10)').toBeLessThanOrEqual(1200);
      recordTiming({test: testInfo.title, repo: repoLabel, metric: 'time to result (show overview, cold)', ms: result.ms});

      const firstPlate = await openViewer(page, glimpse);
      recordTiming({test: testInfo.title, repo: repoLabel, metric: 'time to first plate', ms: firstPlate});
      expect(firstPlate).toBeLessThanOrEqual(2000);
      await expect.poll(() => page.locator('.gl-cell').count()).toBeGreaterThanOrEqual(10);
      const started = performance.now();
      await expectSettled(page);
      recordTiming({test: testInfo.title, repo: repoLabel, metric: 'navigation to settled (no drafting frames)', ms: firstPlate + Math.round(performance.now() - started)});
      await expect(page.locator(HOT_ROWS).first()).toBeVisible();
      expect(await page.locator(GRAPH_NODES).count()).toBeGreaterThan(1);

      const again = await glimpse.call('show', {view: 'overview'});
      expect(again.isError, again.text).toBe(false);
      expect(again.text.length, 'preset result budget, every dataset settled').toBeLessThanOrEqual(1200);
      recordTiming({test: testInfo.title, repo: repoLabel, metric: 'time to result (show overview, warm)', ms: again.ms});
      expect(watched.problems).toEqual([]);
      expect(await watched.csp()).toEqual([]);
    });
  });
}

test.describe('legibility on this repository', () => {
  test.use({projectDir: ROOT});

  // The path column cuts a long path at its end, so on a repository with deep directories every hotspot row reads
  // "packages/viewer/src/compon" and the file name, the only part that tells the rows apart, is not on screen.
  knownDefect('E2E-05', 'the hotspots table shows the file name of every row', async ({page, glimpse}) => {
    await glimpse.call('show', {view: 'overview'});
    await openViewer(page, glimpse);
    await expectSettled(page);
    await expect(page.locator(HOT_ROWS).first()).toBeVisible();
    const hidden = await page.locator(`${HOT_ROWS} [data-kind="path"]`).evaluateAll(cells => cells.flatMap(cell => {
      const base = cell.querySelector('.gl-path-base');
      if (!base) return [];
      const box = cell.getBoundingClientRect();
      const name = base.getBoundingClientRect();
      return name.width > 0 && name.right <= box.right + 1 && name.left >= box.left - 1 ? [] : [base.textContent ?? ''];
    }));
    expect(hidden, 'file names that are clipped away').toEqual([]);
  });

  // The module graph is fitted into its 420 px plate whatever its size: with 48 modules it is drawn at about 20%, and
  // the node labels are two or three pixels tall.
  knownDefect('E2E-06', 'the module graph opens with readable node labels', async ({page, glimpse}) => {
    await glimpse.call('show', {view: 'overview'});
    await openViewer(page, glimpse);
    await expectSettled(page);
    const heights = await page.locator(`${GRAPH_NODES} text`).evaluateAll(labels => labels.map(label => label.getBoundingClientRect().height).filter(height => height > 0));
    expect(heights.length).toBeGreaterThan(0);
    expect(Math.min(...heights), 'smallest node label on screen, in px').toBeGreaterThanOrEqual(8);
  });
});
