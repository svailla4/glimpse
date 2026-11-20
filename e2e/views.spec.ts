// Every preset view renders from the real analyzers without a redline, a console error or a CSP violation, and its
// tool result stays inside the 1,200-character budget: on the fixture repository, on this repository and on
// GLIMPSE_E2E_REPO when set.
import {expectSettled, expectSurface, openViewer, pageState, recordTiming} from './support/glimpse.ts';
import {EXTRA_REPO, ROOT} from './support/paths.ts';
import {expect, test} from './support/test.ts';

interface Target { label: string; dir: string | undefined; file: string; symbol: string; range: string }

const TARGETS: Target[] = [
  {label: 'fixture repository', dir: undefined, file: 'src/auth/service.ts', symbol: 'requireSession', range: 'main..feature'},
  {label: 'this repository', dir: ROOT, file: 'packages/catalog/src/views.ts', symbol: 'parseViewRef', range: 'HEAD~1..HEAD'},
  ...(EXTRA_REPO ? [{label: 'GLIMPSE_E2E_REPO', dir: EXTRA_REPO, file: 'README.md', symbol: 'main', range: 'HEAD~1..HEAD'}] : []),
];

for (const target of TARGETS) {
  test.describe(target.label, () => {
    test.use({projectDir: target.dir});

    test('every preset renders', async ({page, glimpse, watched, repoLabel}, testInfo) => {
      test.setTimeout(180_000);
      const views = ['overview', 'tree', 'deps', 'hotspots', 'history', `file ${target.file}`, `symbol ${target.symbol}`, 'stack', 'diff', `diff ${target.range}`, 'feature'];
      const first = await glimpse.call('show', {view: views[0]});
      expect(first.isError, first.text).toBe(false);
      await openViewer(page, glimpse);
      const report: string[] = [];
      for (const view of views) {
        const name = view.split(' ')[0]!;
        const result = await glimpse.call('show', {view});
        expect(result.isError, `${view}: ${result.text}`).toBe(false);
        expect(result.lines[0], view).toMatch(new RegExp(`^ok ${name} \\S+ tab=live \\d+ms$`));
        expect.soft(result.text.length, `${view}: preset result budget (design 10)\n${result.text}`).toBeLessThanOrEqual(1200);
        await expectSurface(page, name);
        await expect.poll(async () => (await pageState(page)).drafting, {timeout: 20_000, message: `${view}: drafting frames left`}).toBe(0);
        const state = await pageState(page);
        expect.soft(state.redlines, `${view}: redlines`).toEqual([]);
        expect(state.cells, `${view}: cells`).toBeGreaterThanOrEqual(3);
        report.push(`${view.padEnd(44)} ${String(result.ms).padStart(5)} ms  ${String(result.text.length).padStart(4)} chars  ${state.cells} cells  ${state.empty.length} empty${state.empty.length ? `: ${state.empty.join(' | ')}` : ''}`);
        recordTiming({test: testInfo.title, repo: repoLabel, metric: `time to result (show ${name === view ? view : `${name} <target>`}, tab live, index warm)`, ms: result.ms});
      }
      await testInfo.attach(`presets-${repoLabel}.txt`, {body: report.join('\n'), contentType: 'text/plain'});
      console.log(report.join('\n'));
      expect(watched.problems).toEqual([]);
      expect(await watched.csp()).toEqual([]);
      await expectSettled(page);
    });
  });
}

test('query returns rows as text without rendering', async ({glimpse}) => {
  const rows = await glimpse.call('query', {ref: 'git.hotspots top=3', fields: 'path commits'});
  expect(rows.isError, rows.text).toBe(false);
  expect(rows.lines[0]).toBe('path\tcommits');
  expect(rows.lines[1]).toBe('src/auth/service.ts\t4');
  expect(rows.lines.at(-1)).toMatch(/^total=\d+ returned=3$/);
  // nothing was rendered, so no host was started for it
  expect(rows.text).not.toContain('http://');
});

test('catalog answers the index, a component, a source and a preset', async ({glimpse}) => {
  const index = await glimpse.call('catalog', {});
  expect(index.isError).toBe(false);
  for (const word of ['overview', 'DataTable', 'git.hotspots']) expect(index.text).toContain(word);
  const detail = await glimpse.call('catalog', {names: ['DataTable', 'git.churn', 'view:diff', 'DataTabel']});
  expect(detail.isError).toBe(false);
  expect(detail.text).toContain('DataTable(data');
  expect(detail.text).toContain('git.churn');
  expect(detail.text).toContain("root=Page('Changes'");
});

// Decision D3 (was known defect E2E-04): a dataset ref with a bad target was reported to the agent, but a CodeView or
// DiffView with one answered a bare "ok" while the person saw "does not exist" or a redline. The server now checks
// literal files and revisions itself and says so in the result.
test('show tells the agent when a code or diff target does not exist', async ({glimpse}) => {
  const datasets = await glimpse.call('show', {id: 'typo', spec: "root=Page('Typos',[DataTable('git.churn nosuchdir top=5')])"});
  expect(datasets.text).toContain('warn git.churn nosuchdir top=5: E_TARGET');
  const code = await glimpse.call('show', {id: 'typo2', spec: "root=Page('Typos',[CodeView('src/does-not-exist.ts'),DiffView('nosuchbranch..HEAD')])"});
  expect(code.isError, code.text).toBe(false);
  expect(code.lines.filter(line => line.startsWith('warn ') && /does-not-exist\.ts/.test(line)), code.text).toHaveLength(1);
  expect(code.lines.filter(line => line.startsWith('warn ') && /nosuchbranch/.test(line)), code.text).toHaveLength(1);
});
