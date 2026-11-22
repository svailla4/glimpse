// The contract decisions of the third round, end to end against the bundled server: render reports are component
// state (reports-are-component-state), guessed field names never draw an empty plate (guessed-fields-repaired), layouts do what a model obviously means (layout-does-the-obvious)
// and every diagram opens readable (diagrams-open-readable). numbers-on-a-page-agree is in overview.spec.ts and the unit tests.
import type {Page} from '@playwright/test';
import {expectSettled, openViewer, type Glimpse} from './support/glimpse.ts';
import {EXTRA_REPO, ROOT} from './support/paths.ts';
import {expect, test} from './support/test.ts';

/** The lazy chunks are loaded once the tab is idle; a plate then draws, and reports, within the grace of a show. */
async function warm(page: Page, glimpse: Glimpse): Promise<void> {
  await glimpse.call('show', {id: 'probe', spec: "root=Page('Probe',[Text('ready')])"});
  await openViewer(page, glimpse);
  await expect(page.locator('[data-gl="Text"]')).toContainText('ready');
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').filter(entry => /\/assets\/(?:table|charts|diagrams|code)-[\w-]+\.js$/.test(entry.name)).length), {timeout: 5000}).toBe(4);
  await page.waitForTimeout(200);
}

const warnings = (lines: readonly string[]) => lines.filter(line => line.startsWith('warn ') || line.startsWith('viewer: '));

test.describe('reports-are-component-state: render reports are component state', () => {
  test('a truthful empty state and a view waiting for a selection add no warn line, then or later', async ({page, glimpse}) => {
    await warm(page, glimpse);
    // Nothing is staged in the fixture: the source says so, which is a true answer, not a problem. CodeView() waits
    // for the user to select a file.
    const shown = await glimpse.call('show', {id: 'probe', spec: "root=Page('Probe',[staged,code])\nstaged=DataTable('diff.files staged',title='Staged')\ncode=CodeView(title='Code')"});
    expect(shown.isError, shown.text).toBe(false);
    await expect(page.locator('.gl-cell[data-id="staged"] [data-gl-state="empty"]')).toBeVisible();
    await expect(page.locator('.gl-cell[data-id="code"] [data-gl-state="empty"]')).toContainText('no file selected');
    expect(warnings(shown.lines), shown.text).toEqual([]);
    await page.waitForTimeout(600);
    const later = await glimpse.call('events', {});
    expect(later.lines.filter(line => line.startsWith('viewer: error')), later.text).toEqual([]);
  });

  test('a fixed component loses its warn on the next show; a problem that survives a redefinition is told again', async ({page, glimpse}) => {
    await warm(page, glimpse);
    const rows = "$/rows=[{name:'a',n:1},{name:'b',n:2}]";
    const broken = await glimpse.call('show', {id: 'probe', spec: `root=Page('Probe',[t])\n${rows}\nt=DataTable($/rows,'name nope',title='Rows')`});
    expect(broken.isError, broken.text).toBe(false);
    const told = broken.lines.filter(line => /^warn DataTable#t: W_FIELD /.test(line));
    expect(told, broken.text).toHaveLength(1);
    expect(told[0]).toContain('nope');

    // the model fixes the component: the warn is gone
    const fixed = await glimpse.call('show', {id: 'probe', spec: "t=DataTable($/rows,'name n',title='Rows')"});
    expect(fixed.lines.filter(line => line.includes('DataTable#t')), fixed.text).toEqual([]);
    await expect(page.locator('.gl-cell[data-id="t"] [role="columnheader"]')).toHaveCount(2);

    // a redefinition that leaves it broken (a new title, the same unknown column) is a new report of the same state
    await glimpse.call('show', {id: 'probe', spec: "t=DataTable($/rows,'name nope',title='Rows')"});
    const again = await glimpse.call('show', {id: 'probe', spec: "t=DataTable($/rows,'name nope',title='Rows again')"});
    expect(again.lines.filter(line => /^warn DataTable#t: W_FIELD /.test(line)), again.text).toHaveLength(1);
    // told with the result, so never again as an event
    await page.waitForTimeout(600);
    expect((await glimpse.call('events', {})).lines.filter(line => line.includes('DataTable#t'))).toEqual([]);
  });
});

test.describe('guessed-fields-repaired: guessed field names', () => {
  test("ScatterPlot('git.hotspots', x='churn') draws, and the result says what was fixed", async ({page, glimpse}) => {
    const shown = await glimpse.call('show', {id: 'hot', spec: "root=Page('Hot',[s])\ns=ScatterPlot('git.hotspots',x='churn',title='Churn')"});
    expect(shown.isError, shown.text).toBe(false);
    expect(shown.lines, shown.text).toContain("fixed ScatterPlot.x 'churn' -> 'commits'");
    expect(warnings(shown.lines), shown.text).toEqual([]);
    await openViewer(page, glimpse);
    const state = await expectSettled(page);
    expect(state.empty, 'empty plates').toEqual([]);
    await expect(page.locator('.gl-cell[data-id="s"] svg circle').first()).toBeVisible();
  });
});

for (const [label, dir] of [['fixture', undefined], ['this repository', ROOT], ...(EXTRA_REPO ? [['GLIMPSE_E2E_REPO', EXTRA_REPO]] : [])] as Array<[string, string | undefined]>) test.describe(`numbers-on-a-page-agree: numbers on one page agree (${label})`, () => {
  test.use({projectDir: dir});

  test('the overview KPIs count what the plates beside them show', async ({page, glimpse}) => {
    const shown = await glimpse.call('show', {view: 'overview'});
    expect(shown.isError, shown.text).toBe(false);
    await openViewer(page, glimpse);
    await expectSettled(page);
    const tiles = await page.locator('.gl-cell[data-id="kpis"]').evaluate(cell => {
      const out: Record<string, string> = {};
      for (const tile of cell.querySelectorAll('[data-gl-stat], [data-label]')) {
        const label = tile.getAttribute('data-label') ?? tile.querySelector('[data-gl-stat-label]')?.textContent ?? '';
        const value = tile.querySelector('[data-gl-stat-value]')?.textContent ?? '';
        if (label) out[label.trim()] = value.trim();
      }
      return {out, text: cell.textContent ?? ''};
    });
    const kpi = (label: string) => Number((tiles.out[label] ?? '').replace(/[^\d]/g, ''));
    expect(Object.keys(tiles.out), tiles.text).toEqual(expect.arrayContaining(['Languages', 'Modules', 'File cycles']));
    // Modules: what the module graph beside it counts (its own nodes, or the 'of N' of a cut graph), packages apart
    const note = (await page.locator('.gl-cell[data-id="deps"] [data-gl-note]').textContent()) ?? '';
    const drawn = /^(?:([\d,]+) of )?([\d,]+) modules?\b/.exec(note);
    expect(drawn, note).not.toBeNull();
    expect(Number(drawn![2]!.replace(/,/g, '')), `Modules KPI against '${note}'`).toBe(kpi('Modules'));
    expect(note, 'the cycle marks say their level').toMatch(/modules? in cycles|^(?!.*in cycles)/);
    // Languages: the rows of the languages table but the catch-all, which is 'Unclassified', not 'Other'
    const langs = await page.locator('.gl-cell[data-id="langs"] [role="row"][data-index]').allTextContents();
    expect(langs.some(row => /^Other\b/.test(row)), JSON.stringify(langs)).toBe(false);
    expect(langs.filter(row => !row.startsWith('Unclassified')).length, JSON.stringify(langs)).toBe(kpi('Languages'));
    // File cycles: the rows of the file-level cycles table
    await page.locator('.gl-cell[data-id="side"] [role="tab"]', {hasText: 'File cycles'}).click();
    await expect(page.locator('.gl-cell[data-id="side"] [role="row"][data-index]')).toHaveCount(kpi('File cycles'));
  });
});

test.describe('layout-does-the-obvious: layout', () => {
  test.use({viewport: {width: 1440, height: 900}});

  test('a two-column Grid with span=6 children is side by side at 1440 px', async ({page, glimpse}) => {
    const spec = "root=Page('Grid',[g])\ng=Grid([a,b])\na=Text('left',title='Left',span=6)\nb=Text('right',title='Right',span=6)";
    const shown = await glimpse.call('show', {id: 'grid', spec});
    expect(shown.isError, shown.text).toBe(false);
    await openViewer(page, glimpse);
    await expectSettled(page);
    const a = (await page.locator('.gl-cell[data-id="a"]').boundingBox())!;
    const b = (await page.locator('.gl-cell[data-id="b"]').boundingBox())!;
    expect(Math.abs(a.y - b.y), 'same row').toBeLessThan(2);
    expect(b.x, 'b to the right of a').toBeGreaterThanOrEqual(a.x + a.width - 1);
    // each takes about half of the row
    expect(Math.abs(a.width - b.width)).toBeLessThan(4);
    expect(a.width).toBeGreaterThan(500);
  });
});

test.describe('diagrams-open-readable: diagrams open readable', () => {
  test.use({viewport: {width: 1440, height: 900}});

  test('Flowchart and ERDiagram draw their text at 10 px or more at the default view', async ({page, glimpse}) => {
    const schema = "$/s=[{name:'users',columns:[{name:'id',type:'uuid',pk:true},{name:'email',type:'text'},{name:'created_at',type:'timestamptz'}]},{name:'orders',columns:[{name:'id',type:'uuid',pk:true},{name:'user_id',type:'uuid',fk:'users.id'},{name:'total_cents',type:'int'},{name:'status',type:'text'}]},{name:'items',columns:[{name:'id',type:'uuid',pk:true},{name:'order_id',type:'uuid',fk:'orders.id'},{name:'sku',type:'text'},{name:'qty',type:'int'}]},{name:'payments',columns:[{name:'id',type:'uuid',pk:true},{name:'order_id',type:'uuid',fk:'orders.id'},{name:'amount_cents',type:'int'}]}]";
    const flow = "{nodes:{Req:'Request',Auth:{label:'Signed in?',shape:'diamond'},Login:'Login page',RL:{label:'Over limit?',shape:'diamond'},E:{label:'429',shape:'pill'},H:'Handler',DB:{label:'Postgres',shape:'store'},C:{label:'cache',shape:'circle'}},edges:[['Req','Auth'],['Auth','Login','no'],['Login','Auth'],['Auth','RL','yes'],['RL','E','yes'],['RL','H','no'],['H','DB'],{from:'H',to:'C',dashed:true},['H','H'],['DB','H','row']]}";
    const spec = `root=Page('Diagrams',[f,e])\n${schema}\nf=Flowchart(${flow},title='Flow',span=6)\ne=ERDiagram($/s,title='Schema',span=6)`;
    const shown = await glimpse.call('show', {id: 'diagrams', spec});
    expect(shown.isError, shown.text).toBe(false);
    await openViewer(page, glimpse);
    await expectSettled(page);
    for (const id of ['f', 'e']) {
      const plate = page.locator(`.gl-cell[data-id="${id}"]`);
      await expect(plate.locator('svg text').first()).toBeVisible();
      // The size a text is drawn at: its font size times the zoom of the drawing, as the screen shows it.
      const texts = await plate.locator('svg text').evaluateAll((nodes, frame) => {
        const stage = (frame as Element).getBoundingClientRect();
        return nodes.map(node => {
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          const ctm = (node as SVGTextElement).getScreenCTM();
          const size = parseFloat(style.fontSize) * (ctm ? Math.hypot(ctm.a, ctm.b) : 1);
          return {text: node.textContent ?? '', size, onStage: box.width > 0 && box.bottom > stage.top && box.top < stage.bottom && box.right > stage.left && box.left < stage.right && style.visibility !== 'hidden' && style.opacity !== '0'};
        }).filter(text => text.onStage && text.text.trim() !== '');
      }, await plate.elementHandle());
      expect(texts.length, `${id}: texts on screen`).toBeGreaterThan(5);
      const smallest = Math.min(...texts.map(text => text.size));
      console.log(`${id}: ${texts.length} texts on screen, smallest drawn at ${smallest.toFixed(1)} px`);
      expect(smallest, `${id}: smallest text on screen, in px`).toBeGreaterThanOrEqual(10);
    }
  });
});
