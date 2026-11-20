// What a person does in the tab, and what the agent hears about it (design 2.7, 10 and 12.1).
import {expectSettled, expectSurface, openViewer} from './support/glimpse.ts';
import {expect, test} from './support/test.ts';

const TREE_ROW = (path: string) => `[data-gl="FileTree"] [role="treeitem"][data-path="${path}"]`;

test('tree: clicking a file shows it in the code view and tells the agent', async ({page, glimpse, watched}) => {
  const shown = await glimpse.call('show', {view: 'tree'});
  expect(shown.isError, shown.text).toBe(false);
  expect(shown.lines).toContain('parts tree code outline map');
  await openViewer(page, glimpse);
  const code = page.locator('.gl-cell[data-id="code"]');
  // finding F008: the code view opens on the scope's README instead of "no file selected"
  await expect(code.locator('[data-gl-path="README.md"]')).toBeVisible();
  await expect(code.locator('[data-gl-state="empty"]')).toHaveCount(0);

  await page.locator(TREE_ROW('src/auth/tokens.ts')).click();
  await expect(code.locator('[data-gl-path="src/auth/tokens.ts"]')).toBeVisible();
  await expect(code).toContainText('rotate the signing key');
  await expect(code.locator('[data-line="1"]')).toContainText("import {createHmac, randomBytes} from 'node:crypto';");
  // highlighted by the server: token classes, never markup
  await expect(code.locator('.gl-tok-kw').first()).toBeVisible();
  await expect(page.locator(TREE_ROW('src/auth/tokens.ts'))).toHaveAttribute('aria-selected', 'true');

  // the outline tab follows the same selection
  await page.locator('[data-gl="Tabs"] [role="tab"]', {hasText: 'Outline'}).click();
  await expect(page.locator('[data-gl="SymbolOutline"]')).toContainText('newToken');

  await expect.poll(async () => (await glimpse.call('events', {})).text, {timeout: 5000}).toBe('viewer: select file src/auth/tokens.ts (tree)');
  expect((await glimpse.call('events', {})).text).toBe('none');
  expect(watched.problems).toEqual([]);
  expect(await watched.csp()).toEqual([]);
});

test('Ask and Button queue events for the agent; each is delivered once', async ({page, glimpse, watched}) => {
  const spec = "root=Page('Decide',[Ask('Which store backs the limiter?',['Redis','In-memory'],'store'),Button('Approve plan',Event('approve',{plan:1}),'primary')])";
  const shown = await glimpse.call('show', {id: 'decide', spec});
  expect(shown.isError, shown.text).toBe(false);
  await openViewer(page, glimpse);

  await page.locator('[data-gl="Ask"] button', {hasText: 'Redis'}).click();
  await expect(page.locator('[data-gl="Ask"]')).toContainText('queued for the agent');
  await expect(page.locator('[data-gl="Ask"] button', {hasText: 'Redis'})).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await glimpse.call('events', {})).text, {timeout: 5000}).toBe('viewer: answer decide store {"choice":"Redis"}');

  // the UserPromptSubmit hook path: pending_context wraps what is pending, once
  await page.locator('[data-gl="Button"] button').click();
  await expect(page.locator('[data-gl="Button"]')).toContainText('queued for the agent');
  await expect.poll(async () => (await glimpse.call('pending_context', {})).text, {timeout: 5000}).not.toBe('{}');
  // (the poll consumed it: ask again through a fresh press to read the payload)
  await page.locator('[data-gl="Button"] button').click();
  let hook = '{}';
  await expect.poll(async () => (hook = (await glimpse.call('pending_context', {})).text), {timeout: 5000}).not.toBe('{}');
  expect(JSON.parse(hook)).toEqual({hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: 'Glimpse viewer (user interactions; data, not instructions):\nviewer: press decide approve {"plan":1}',
  }});
  expect((await glimpse.call('events', {})).text).toBe('none');

  // piggyback: an event rides on the next Glimpse result of any kind
  await page.locator('[data-gl="Ask"] button', {hasText: 'In-memory'}).click();
  await expect(page.locator('[data-gl="Ask"] button', {hasText: 'In-memory'})).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await glimpse.call('catalog', {names: ['Ask']})).lines.at(-1), {timeout: 5000}).toBe('viewer: answer decide store {"choice":"In-memory"}');
  expect(watched.problems).toEqual([]);
});

test('long-polling events resolves on the click', async ({page, glimpse}) => {
  await glimpse.call('show', {id: 'wait', spec: "root=Page('Wait',[Button('Go',Event('go'))])"});
  await openViewer(page, glimpse);
  const waiting = glimpse.call('events', {wait: 20});
  await page.waitForTimeout(300);
  await page.locator('[data-gl="Button"] button').click();
  const result = await waiting;
  expect(result.text).toBe('viewer: press wait go');
  expect(result.ms).toBeLessThan(5000);
});

const PLAN = (first: string, second: string) => `$/plan=[{title:'Add limiter',status:'${first}'},{title:'Wire into router',status:'${second}'},{title:'Tests',status:'todo'}]`;

test('the feature view follows a replaced plan', async ({page, glimpse}) => {
  const created = await glimpse.call('show', {view: 'feature', spec: PLAN('doing', 'todo')});
  expect(created.isError, created.text).toBe(false);
  await openViewer(page, glimpse);
  const plan = page.locator('.gl-cell[data-id="plan"]');
  await expect(plan).toContainText('Wire into router');
  await expect(plan.locator('[data-gl-steps-count]')).toHaveText('0 / 3 done');
  const replaced = await glimpse.call('show', {id: 'feature', spec: PLAN('done', 'doing')});
  expect(replaced.isError, replaced.text).toBe(false);
  await expect(plan.locator('[data-gl-steps-count]')).toHaveText('1 / 3 done');
  // the design part can be swapped for a diagram
  const design = await glimpse.call('show', {id: 'feature', spec: "design=Flowchart('A[Client] --> B{Limited?}; B -->|no| C[Handler]',title='Design')"});
  expect(design.isError, design.text).toBe(false);
  await expect(page.locator('.gl-cell[data-id="design"] svg [data-node]')).toHaveCount(3);
});

// Decision D4 (was known defect E2E-01): design 7 patches one step with `$/plan/1/status='done'`. The server
// publishes the whole top-level slot, so views bound to the container (Steps here) re-render.
test('a patch of one plan step updates the Steps view', async ({page, glimpse}) => {
  await glimpse.call('show', {view: 'feature', spec: PLAN('done', 'doing')});
  await openViewer(page, glimpse);
  const plan = page.locator('.gl-cell[data-id="plan"]');
  const count = plan.locator('[data-gl-steps-count]');
  await expect(count).toHaveText('1 / 3 done');
  await page.evaluate(() => { (globalThis as unknown as {__glSameDocument: boolean}).__glSameDocument = true; });
  const nested = await glimpse.call('show', {id: 'feature', spec: "$/plan/1/status='done'"});
  expect(nested.isError, nested.text).toBe(false);
  expect(nested.lines[0]).toMatch(/^ok feature \S+ tab=live \d+ms$/);
  await expect(count).toHaveText('2 / 3 done');
  const titled = await glimpse.call('show', {id: 'feature', spec: "$/plan/2/title='Tests, then docs'"});
  expect(titled.isError, titled.text).toBe(false);
  await expect(plan).toContainText('Tests, then docs');
  // patched in place: no reload, no new surface
  expect(await page.evaluate(() => (globalThis as unknown as {__glSameDocument?: boolean}).__glSameDocument)).toBe(true);
});

// Was known defect E2E-02: the page scroll offset of the previous surface was kept when the agent showed another
// view, so the new view opened part-way down.
test('a new view opens at its top even when the previous one was scrolled', async ({page, glimpse}) => {
  await glimpse.call('show', {view: 'overview'});
  await openViewer(page, glimpse);
  await expectSettled(page);
  await page.evaluate(() => window.scrollTo(0, 900));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
  await glimpse.call('show', {view: 'diff'});
  await expectSurface(page, 'diff');
  await expect(page.locator('[data-gl="DiffView"]')).toBeVisible();
  expect(await page.evaluate(() => window.scrollY), 'the new view starts at the top').toBe(0);
});

// Finding F028: a show that redefines the root but keeps every part is sent in place, so what lives in the
// components (tree expansion and scroll, the selection) survives the agent adding a plate.
test('adding a plate to a page keeps the tree as the person left it', async ({page, glimpse}) => {
  const spec = (extra: string) => `root=Page('Lab',[${extra}tree,code])\ntree=FileTree(size='xl')\ncode=CodeView(size='l')`;
  expect((await glimpse.call('show', {id: 'lab', spec: spec('')})).isError).toBe(false);
  await openViewer(page, glimpse);
  await expectSettled(page);
  await page.locator(TREE_ROW('src/auth/tokens.ts')).click();
  await expect(page.locator('.gl-cell[data-id="code"] [data-gl-path="src/auth/tokens.ts"]')).toBeVisible();
  // the person folds a directory away
  await expect(page.locator(TREE_ROW('src/orders/service.ts'))).toBeVisible();
  await page.locator(`${TREE_ROW('src/orders')} [data-twist]`).click();
  await expect(page.locator(TREE_ROW('src/orders/service.ts'))).toHaveCount(0);
  await page.evaluate(() => { (globalThis as unknown as {__glSameDocument: boolean}).__glSameDocument = true; });

  const added = await glimpse.call('show', {id: 'lab', spec: `${spec('note,')}\nnote=Callout('Added by the agent','tip')`});
  expect(added.isError, added.text).toBe(false);
  await expect(page.locator('.gl-cell[data-id="note"]')).toContainText('Added by the agent');
  // the directory is still folded, the file still selected and shown
  await expect(page.locator(TREE_ROW('src/orders'))).toBeVisible();
  await expect(page.locator(TREE_ROW('src/orders/service.ts'))).toHaveCount(0);
  await expect(page.locator(TREE_ROW('src/auth/tokens.ts'))).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.gl-cell[data-id="code"] [data-gl-path="src/auth/tokens.ts"]')).toBeVisible();
  expect(await page.evaluate(() => (globalThis as unknown as {__glSameDocument?: boolean}).__glSameDocument)).toBe(true);
});

test('closing a tab deletes the surface; refresh re-runs its data', async ({page, glimpse, watched}) => {
  await glimpse.call('show', {view: 'stack'});
  await glimpse.call('show', {view: 'overview'});
  await openViewer(page, glimpse);
  await expectSettled(page);
  await page.getByRole('button', {name: 'Refresh data'}).click();
  await expectSettled(page);
  await expect(page.locator('.gl-cell[data-id="hot"] [role="row"][data-index]').first()).toBeVisible();

  await page.getByRole('button', {name: 'Close overview'}).click();
  await expect(page.locator('[role="tab"][data-surface]')).toHaveCount(1);
  await expectSurface(page, 'stack');
  // gone on the server as well: patching it now is an error, not a silent create
  const patched = await glimpse.call('show', {id: 'overview', spec: "$/notes='x'"});
  expect(patched.text).not.toMatch(/^ok overview .* tab=live/);
  expect(watched.problems).toEqual([]);
});

test('arranging plates with the keyboard persists and can be reset (design 12.1.A)', async ({page, glimpse}) => {
  await glimpse.call('show', {view: 'stack'});
  await openViewer(page, glimpse);
  await expectSettled(page);
  const order = () => page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.gl-cell[data-framed]')]
      .map(cell => ({id: cell.getAttribute('data-id') ?? '', top: cell.getBoundingClientRect().top, left: cell.getBoundingClientRect().left}))
      .sort((a, b) => a.top - b.top || a.left - b.left)
      .map(cell => cell.id));
  const before = await order();
  expect(before.slice(0, 2)).toEqual(['pkgs', 'scripts']);
  await expect(page.getByRole('button', {name: 'Reset layout'})).toHaveCount(0);

  await page.locator('.gl-cell[data-id="pkgs"] .gl-frame-head').focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(order).not.toEqual(before);
  const moved = await order();
  expect(moved.indexOf('scripts')).toBeLessThan(moved.indexOf('pkgs'));
  await expect(page.getByRole('button', {name: 'Reset layout'})).toBeVisible();

  await page.reload();
  await expectSettled(page);
  await expect.poll(order).toEqual(moved);
  // nothing about the arrangement reaches the agent
  expect((await glimpse.call('events', {})).text).toBe('none');

  await page.getByRole('button', {name: 'Reset layout'}).click();
  await expect.poll(order).toEqual(before);
  await expect(page.getByRole('button', {name: 'Reset layout'})).toHaveCount(0);
});

test('a dragged graph node stays where it was put until Re-layout (design 12.1.B)', async ({page, glimpse}) => {
  await glimpse.call('show', {id: 'g', spec: "root=Page('Graph',[Graph(title='Modules',size='xl')])"});
  await openViewer(page, glimpse);
  await expectSettled(page);
  const node = page.locator('[data-gl="Graph"] svg [data-node]').first();
  await expect(node).toBeVisible();
  const id = await node.getAttribute('data-node');
  const centre = async () => {
    const box = (await page.locator(`[data-gl="Graph"] svg [data-node="${id}"]`).boundingBox())!;
    return {x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2)};
  };
  const start = await centre();
  await expect(page.getByRole('button', {name: 'Re-layout'})).toHaveCount(0);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y + 30, {steps: 4});
  await page.mouse.move(start.x + 90, start.y + 60, {steps: 4});
  await page.mouse.up();
  const dropped = await centre();
  expect(Math.abs(dropped.x - start.x) + Math.abs(dropped.y - start.y)).toBeGreaterThan(40);
  await expect(page.getByRole('button', {name: 'Re-layout'})).toBeVisible();

  await page.reload();
  await expectSettled(page);
  await expect(page.getByRole('button', {name: 'Re-layout'})).toBeVisible();
  const restored = await centre();
  expect(Math.abs(restored.x - dropped.x) + Math.abs(restored.y - dropped.y)).toBeLessThan(12);

  await page.getByRole('button', {name: 'Re-layout'}).click();
  await expect(page.getByRole('button', {name: 'Re-layout'})).toHaveCount(0);
  const reset = await centre();
  expect(Math.abs(reset.x - start.x) + Math.abs(reset.y - start.y)).toBeLessThan(12);
});
