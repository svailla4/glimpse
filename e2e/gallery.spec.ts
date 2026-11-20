// show{view:"gallery"}: all 44 components render, in both themes and at two widths; one screenshot per section is
// stored under <artifacts>/gallery/<theme>-<width>/ (and attached to the report). There is no pixel gate yet: the
// design adds a visual diff once the look is approved.
import {mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expectSettled, openViewer, pageState} from './support/glimpse.ts';
import {GALLERY_SHOTS, ROOT} from './support/paths.ts';
import {expect, test} from './support/test.ts';

const catalog = JSON.parse(readFileSync(join(ROOT, 'packages', 'catalog', 'generated', 'catalog.json'), 'utf8')) as {components: Record<string, unknown>};
const COMPONENTS = Object.keys(catalog.components);
const SECTIONS = ['layout', 'content', 'data', 'charts', 'diagrams', 'code', 'input'];

test('the catalog has 44 components', () => {
  expect(COMPONENTS).toHaveLength(44);
});

test('gallery: every component renders; a screenshot per section, theme and width', async ({page, glimpse, watched}, testInfo) => {
  test.setTimeout(180_000);
  const shown = await glimpse.call('show', {view: 'gallery'});
  expect(shown.isError, shown.text).toBe(false);
  expect(shown.lines[0]).toMatch(/^ok gallery /);
  expect(shown.lines).toContain(`parts ${SECTIONS.join(' ')} | slots $/g`);
  expect(shown.text.length).toBeLessThanOrEqual(1200);

  await page.emulateMedia({colorScheme: 'light', reducedMotion: 'reduce'});
  await openViewer(page, glimpse);
  const state = await expectSettled(page);
  expect(state.redlines.filter(text => /not implemented/i.test(text))).toEqual([]);

  // Tabs mounts one panel at a time: open each tab of the layout section so every component gets its turn.
  const kinds = new Set<string>();
  const collect = async () => {
    for (const kind of await page.evaluate(() => [...document.querySelectorAll('[data-gl]')].map(element => element.getAttribute('data-gl') ?? ''))) kinds.add(kind);
  };
  await collect();
  const tabs = page.locator('[data-gl="Tabs"] [role="tab"]');
  for (let i = (await tabs.count()) - 1; i >= 0; i--) {
    await tabs.nth(i).click();
    await collect();
  }
  expect(COMPONENTS.filter(name => !kinds.has(name)), 'components missing from the gallery').toEqual([]);
  expect((await pageState(page)).redlines).toEqual([]);

  const backgrounds: Record<string, string> = {};
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1320, 720]) {
      await page.emulateMedia({colorScheme: theme, reducedMotion: 'reduce'});
      await page.setViewportSize({width, height: 900});
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await expectSettled(page);
      // nothing may make the page itself scroll sideways
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect.soft(overflow, `horizontal page overflow at ${width}px (${theme})`).toBeLessThanOrEqual(0);
      // A viewport as tall as the page, so the sticky top bar is not stitched into the middle of a tall section.
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({width, height: Math.min(height, 16_000)});
      await page.waitForTimeout(400);
      backgrounds[theme] = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const dir = join(GALLERY_SHOTS, `${theme}-${width}`);
      mkdirSync(dir, {recursive: true});
      for (const [index, id] of SECTIONS.entries()) {
        const section = page.locator(`.gl-cell[data-gl="Section"][data-id="${id}"]`);
        await section.scrollIntoViewIfNeeded();
        const path = join(dir, `${index + 1}-${id}.png`);
        await section.screenshot({path, animations: 'disabled'});
        await testInfo.attach(`gallery-${theme}-${width}-${id}`, {path, contentType: 'image/png'});
      }
      await page.screenshot({path: join(dir, '0-page.png'), fullPage: true, animations: 'disabled'});
      expect((await pageState(page)).redlines, `${theme} ${width}`).toEqual([]);
    }
  }
  expect(backgrounds.light).not.toBe(backgrounds.dark);

  // the gallery's buttons are live
  await page.setViewportSize({width: 1320, height: 900});
  await page.locator('[data-gl="Button"] button', {hasText: 'Queue an event'}).click();
  // (decision D3: a render report, `viewer: error ...`, may ride along with the press, so the line is looked for)
  await expect.poll(async () => (await glimpse.call('events', {})).lines, {timeout: 5000}).toContain('viewer: press gallery demo_pressed {"from":"gallery"}');
  expect(watched.problems).toEqual([]);
  expect(await watched.csp()).toEqual([]);
});

test('the theme and density toggles work from the keyboard and persist', async ({page, glimpse}) => {
  await glimpse.call('show', {view: 'gallery'});
  await page.emulateMedia({colorScheme: 'light'});
  await openViewer(page, glimpse);
  const look = () => page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    density: document.documentElement.getAttribute('data-density'),
    background: getComputedStyle(document.body).backgroundColor,
  }));
  const before = await look();
  expect(before.theme).toBe('auto');
  await page.keyboard.press('t');
  await expect.poll(async () => (await look()).theme).toBe('dark');
  expect((await look()).background).not.toBe(before.background);
  await page.keyboard.press('d');
  await expect.poll(async () => (await look()).density).toBe('comfortable');
  await page.reload();
  await expect(page.locator('[data-gl="Page"]').first()).toBeVisible();
  expect(await look()).toMatchObject({theme: 'dark', density: 'comfortable'});
});

// Finding F092 (was known defect E2E-03): the gallery's SymbolOutline read README.md, which had no symbols, so that
// plate was always empty. The server now gives the Code section a source file of the repository with an outline
// (the result's first line names it), and nothing in the showcase is an empty plate or a redline. The fixture's
// working tree is dirty, so even the live DiffView has something to show.
test('the gallery has no redline and no empty plate, and its Code section reads a real file', async ({page, glimpse, watched}) => {
  const shown = await glimpse.call('show', {view: 'gallery'});
  expect(shown.isError, shown.text).toBe(false);
  expect(shown.lines[0]).toMatch(/^ok gallery /);
  await openViewer(page, glimpse);
  const state = await expectSettled(page);
  expect(state.empty, 'empty plates').toEqual([]);
  expect(state.redlines).toEqual([]);
  // a source file of the fixture, not the README
  const shownFile = await page.locator('[data-gl="CodeView"] [data-gl-path]').first().getAttribute('data-gl-path');
  expect(shownFile).toMatch(/\.(?:ts|py|go)$/);
  // the tab told the server what it drew: nothing reached the agent as a render problem
  await page.waitForTimeout(500);
  const events = await glimpse.call('events', {});
  expect(events.lines.filter(line => line.startsWith('viewer: error')), events.text).toEqual([]);
  expect(watched.problems).toEqual([]);
});
