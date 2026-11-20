// The cross-area decisions of the review round, end to end against the bundled server: a drill has a way back that
// survives a reload (D1), ids may carry hyphens (D2), what the tab drew reaches the agent (D3), a nested patch
// re-renders the views bound to its slot (D4, in interaction.spec.ts with the plan), and every call sees the working
// tree as it is, tab or no tab (D8). D7 is in overview.spec.ts and D10 in security.spec.ts.
import {appendFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {expectSettled, expectSurface, openViewer} from './support/glimpse.ts';
import {expect, FIXTURE, test} from './support/test.ts';

test('D1: a drill into a module has a way back, survives a reload, and a re-show starts whole again', async ({page, glimpse}) => {
  await glimpse.call('show', {view: 'deps'});
  await openViewer(page, glimpse);
  await expectSettled(page);
  const graph = page.locator('.gl-cell[data-id="graph"]');
  const module = graph.locator('svg [data-node="src/auth"]');
  await expect(module).toBeVisible();
  await expect(graph.locator('[data-gl-scope]')).toHaveCount(0);

  await module.dblclick();
  await expect(graph.locator('[data-gl-scope]')).toHaveAttribute('data-gl-scope', 'src/auth');
  await expectSettled(page);
  // the graph now draws the files of src/auth, and the module it came from is gone
  await expect(graph.locator('svg [data-node="src/auth/service.ts"]')).toBeVisible();
  await expect(graph.locator('svg [data-node="src/auth"]')).toHaveCount(0);

  await page.reload();
  await expectSurface(page, 'deps');
  await expect(graph.locator('[data-gl-scope]')).toHaveAttribute('data-gl-scope', 'src/auth');
  await expect(graph.locator('svg [data-node="src/auth/service.ts"]')).toBeVisible();

  await graph.locator('[data-gl-scope-reset]').click();
  await expect(graph.locator('[data-gl-scope]')).toHaveCount(0);
  await expect(graph.locator('svg [data-node="src/auth"]')).toBeVisible();

  // a show that replaces the surface clears its drills; a patch keeps them
  await graph.locator('svg [data-node="src/auth"]').dblclick();
  await expect(graph.locator('[data-gl-scope]')).toHaveAttribute('data-gl-scope', 'src/auth');
  expect((await glimpse.call('show', {id: 'deps', spec: "$/notes='kept'"})).isError).toBe(false);
  await expect(page.locator('.gl-cell[data-id="notes"]')).toContainText('kept');
  await expect(graph.locator('[data-gl-scope]')).toHaveAttribute('data-gl-scope', 'src/auth');
  expect((await glimpse.call('show', {view: 'deps'})).isError).toBe(false);
  await expect(graph.locator('[data-gl-scope]')).toHaveCount(0);
  await expect(graph.locator('svg [data-node="src/auth"]')).toBeVisible();
});

test('D2: a hyphenated id is a view of its own, end to end', async ({page, glimpse}) => {
  const shown = await glimpse.call('show', {id: 'auth-flow', spec: "root=Page('Auth flow',[Text($/msg)])\n$/msg='first'"});
  expect(shown.isError, shown.text).toBe(false);
  expect(shown.lines[0]).toMatch(/^ok auth-flow #\/auth-flow tab=none /);
  expect(shown.text).not.toContain('fixed ');
  await openViewer(page, glimpse);
  await expectSurface(page, 'auth-flow');
  await expect(page).toHaveURL(/#\/auth-flow$/);
  const patched = await glimpse.call('show', {id: 'auth-flow', spec: "$/msg='second'"});
  expect(patched.lines[0]).toMatch(/^ok auth-flow \S+ tab=live /);
  await expect(page.locator('[data-gl="Text"]')).toContainText('second');
  await page.reload();
  await expectSurface(page, 'auth-flow');
  await expect(page.locator('[data-gl="Text"]')).toContainText('second');
});

test('D3: what the tab drew instead of a component reaches the show result, and only once', async ({page, glimpse}) => {
  await glimpse.call('show', {id: 'probe', spec: "root=Page('Probe',[Text('ready')])"});
  await openViewer(page, glimpse);
  await expect(page.locator('[data-gl="Text"]')).toContainText('ready');
  // The tab loads the lazy chunks once it is idle (catalog.ts, warmChunks); a table then draws in the frame that
  // names it, well inside the grace a show gives the tab to report.
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').filter(entry => /\/assets\/(?:table|charts|diagrams|code)-[\w-]+\.js$/.test(entry.name)).length), {timeout: 5000}).toBe(4);
  await page.waitForTimeout(200);
  // An empty inline table: nothing the server can know is empty without drawing it.
  const shown = await glimpse.call('show', {id: 'probe', spec: "root=Page('Probe',[Text('ready'),rows])\nrows=DataTable($/rows,title='Rows')\n$/rows=[]"});
  expect(shown.isError, shown.text).toBe(false);
  expect(shown.lines[0]).toMatch(/^ok probe \S+ tab=live /);
  const reports = shown.lines.filter(line => /^warn DataTable#rows: W_EMPTY no items$/.test(line));
  expect(reports, shown.text).toHaveLength(1);
  // delivered with the result, so not again as an event
  await page.waitForTimeout(500);
  expect((await glimpse.call('events', {})).lines.filter(line => line.includes('DataTable#rows'))).toEqual([]);
  // filled, the plate is no longer reported
  const filled = await glimpse.call('show', {id: 'probe', spec: "$/rows=[{name:'a',n:1}]"});
  expect(filled.lines.filter(line => line.includes('DataTable#rows'))).toEqual([]);
  await expect(page.locator('.gl-cell[data-id="rows"] [role="row"][data-index]')).toHaveCount(1);
});

test('D8: a file edited while no tab is open is seen by the very next call', async ({glimpse, repoRoot}) => {
  const first = await glimpse.call('show', {view: 'stack'});
  expect(first.lines[1]).toMatch(/\| 36 files /);
  expect((await glimpse.call('query', {ref: 'code.todos', fields: 'text'})).text).not.toContain('glimpse-fresh-marker');

  // nobody is looking: no tab was ever opened, so no watcher is pushed anything
  await writeFile(join(repoRoot, 'src', 'fresh.ts'), '// TODO: glimpse-fresh-marker\nexport const fresh = 1;\n');
  await appendFile(join(repoRoot, FIXTURE.workingTree.modified[0]!), '\n// FIXME: glimpse-edit-marker\n');
  const todos = await glimpse.call('query', {ref: 'code.todos', fields: 'text'});
  expect(todos.text).toContain('glimpse-fresh-marker');
  expect(todos.text).toContain('glimpse-edit-marker');
  const again = await glimpse.call('show', {view: 'stack'});
  expect(again.lines[1], 'the repo line counts the new file').toMatch(/\| 37 files /);
  const changed = await glimpse.call('query', {ref: 'diff.files wt', fields: 'path'});
  expect(changed.lines).toContain('src/fresh.ts');
});
