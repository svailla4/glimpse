// The diagram engine and plate sizing of decisions diagram-engine-in-worker and content-sized-plates, end to end against the bundled server: a small
// diagram opens fitted and centred with every node on the stage, a Flowchart flows the way dir= says
// (dir= still wins), and plates in one row keep the height of what they show instead of growing to the tallest.
import type {Locator, Page} from '@playwright/test';
import {expectSettled, openViewer, type Glimpse} from './support/glimpse.ts';
import {expect, test} from './support/test.ts';

interface Rect { x: number; y: number; w: number; h: number }

/** Shows `spec` as surface `id` at 1440 px and waits until nothing drafts and no plate is a redline. */
async function showSettled(page: Page, glimpse: Glimpse, id: string, spec: string): Promise<void> {
  const shown = await glimpse.call('show', {id, spec});
  expect(shown.isError, shown.text).toBe(false);
  expect(shown.lines.filter(line => line.startsWith('warn ')), shown.text).toEqual([]);
  await openViewer(page, glimpse);
  await expectSettled(page);
}

/** The stage of the diagram in plate `id` (the element the drawing is clipped to), once its nodes are drawn. */
async function stageOf(page: Page, id: string): Promise<Locator> {
  const stage = page.locator(`.gl-cell[data-id="${id}"] [role="img"]:has([data-node])`).first();
  await expect(stage.locator('[data-node]').first()).toBeVisible();
  // the opening view is set on the first frame after layout; give the fonts and React Flow one more frame
  await page.evaluate(() => document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))));
  return stage;
}

/** Screen rectangles of the stage and of every node (by id) and group frame drawn on it. */
function geometry(stage: Locator): Promise<{stage: Rect; nodes: Record<string, Rect>; frames: Rect[]; minimap: number; zoom: string}> {
  return stage.evaluate(element => {
    const rect = (el: Element) => {
      const box = el.getBoundingClientRect();
      return {x: box.x, y: box.y, w: box.width, h: box.height};
    };
    const nodes: Record<string, Rect> = {};
    for (const node of element.querySelectorAll('[data-node]')) nodes[node.getAttribute('data-node') ?? ''] = rect(node);
    const plate = element.closest('.gl-cell') ?? element;
    return {
      stage: rect(element),
      nodes,
      frames: [...element.querySelectorAll('[data-group]')].map(rect),
      minimap: plate.querySelectorAll('.react-flow__minimap').length,
      zoom: plate.querySelector('[data-zoom]')?.textContent ?? '',
    };
  });
}

const centre = (r: Rect) => ({x: r.x + r.w / 2, y: r.y + r.h / 2});
const union = (rects: readonly Rect[]): Rect => {
  const x = Math.min(...rects.map(r => r.x));
  const y = Math.min(...rects.map(r => r.y));
  return {x, y, w: Math.max(...rects.map(r => r.x + r.w)) - x, h: Math.max(...rects.map(r => r.y + r.h)) - y};
};

test.describe('diagram-engine-in-worker/content-sized-plates: diagrams open whole when they can, the way they are written', () => {
  test.use({viewport: {width: 1440, height: 900}});

  // Five nodes with a group, and eight with sub-lines, statuses and edge labels in a wide, short plate: both fit at a
  // zoom where every text is 10 px or more on screen, so both must open whole (an earlier engine opened the second at
  // 84 % with its first nodes cut off). The same eight top to bottom in a short half-width plate do not fit at that
  // zoom, so they open readable with pan and a minimap instead (the last test).
  const SMALL = "{nodes:[{id:'api',label:'api',group:'svc'},{id:'auth',label:'auth',group:'svc'},{id:'db',label:'db',sub:'postgres'},{id:'cache',label:'cache'},{id:'queue',label:'queue'}],edges:[{from:'api',to:'auth'},{from:'api',to:'db'},{from:'auth',to:'db',label:'reads'},{from:'api',to:'cache',kind:'dashed'},{from:'auth',to:'queue'}],groups:[{id:'svc',label:'services'}]}";
  const EIGHT = "{nodes:[{id:'lint',label:'lint config',sub:'runs before builds',status:'added'},{id:'opts',label:'options',sub:'paths and defaults',status:'modified'},{id:'builder',label:'Builder',sub:'build loop'},{id:'pages',label:'page_writer',sub:'page_writer.ts',status:'added'},{id:'schema',label:'Page schema',sub:'fields, sizes, rules',status:'added'},{id:'cache',label:'build cache',sub:'hashes and outputs'},{id:'index',label:'site_index',sub:'+ of_section',status:'modified'},{id:'feed',label:'change feed',sub:'rebuild notices',status:'modified'}],edges:[{from:'opts',to:'builder',label:'reads paths'},{from:'lint',to:'builder',label:'lints',kind:'dashed'},{from:'builder',to:'pages',label:'renders'},{from:'pages',to:'schema',label:'checks'},{from:'pages',to:'cache',label:'loads'},{from:'pages',to:'index',label:'entries'},{from:'index',to:'feed',label:'updates'}]}";
  const CASES: Array<{id: string; call: string; nodes: number; maxHeight: number}> = [
    {id: 'five', call: `Graph(${SMALL},title='Five nodes',span=6)`, nodes: 5, maxHeight: 420},
    {id: 'wide', call: `Graph(${EIGHT},'LR',title='Eight, left to right',span=12,size='m')`, nodes: 8, maxHeight: 280},
  ];

  test('a small inline Graph opens fitted and centred, every node inside the stage, the plate as tall as the drawing', async ({page, glimpse, watched}) => {
    await showSettled(page, glimpse, 'small', [`root=Page('Small',[${CASES.map(c => c.id).join(',')}])`, ...CASES.map(c => `${c.id}=${c.call}`)].join('\n'));
    for (const {id, nodes, maxHeight} of CASES) {
      const stage = await stageOf(page, id);
      const shape = await geometry(stage);
      expect(Object.keys(shape.nodes), id).toHaveLength(nodes);
      // every node is inside the stage, whole
      for (const [node, box] of Object.entries(shape.nodes)) {
        expect.soft(box.x, `${id}: ${node} left`).toBeGreaterThanOrEqual(shape.stage.x - 1);
        expect.soft(box.y, `${id}: ${node} top`).toBeGreaterThanOrEqual(shape.stage.y - 1);
        expect.soft(box.x + box.w, `${id}: ${node} right`).toBeLessThanOrEqual(shape.stage.x + shape.stage.w + 1);
        expect.soft(box.y + box.h, `${id}: ${node} bottom`).toBeLessThanOrEqual(shape.stage.y + shape.stage.h + 1);
      }
      // centred: the drawing (its nodes and group frames) sits in the middle of the stage, both ways
      const drawing = centre(union([...Object.values(shape.nodes), ...shape.frames]));
      const middle = centre(shape.stage);
      console.log(`${id}: stage ${Math.round(shape.stage.w)}x${Math.round(shape.stage.h)}, drawing centre off by ${(drawing.x - middle.x).toFixed(1)}, ${(drawing.y - middle.y).toFixed(1)} px at ${shape.zoom}`);
      expect(Math.abs(drawing.x - middle.x), `${id}: horizontal centring, px`).toBeLessThanOrEqual(Math.max(12, shape.stage.w * 0.03));
      expect(Math.abs(drawing.y - middle.y), `${id}: vertical centring, px`).toBeLessThanOrEqual(Math.max(12, shape.stage.h * 0.03));
      // whole, so no minimap and no "n of m in view"; never blown up past 100 %
      expect(shape.minimap, `${id}: minimap on a diagram that fits`).toBe(0);
      await expect(page.locator(`.gl-cell[data-id="${id}"] [data-in-view]`)).toHaveCount(0);
      expect(Number(shape.zoom.replace('%', '')), `${id}: opening zoom`).toBeLessThanOrEqual(100);
      // content-sized (content-sized-plates): a small drawing does not take all the height its plate may grow to
      expect(shape.stage.h, `${id}: stage height, px`).toBeLessThanOrEqual(maxHeight);
    }
    expect(watched.problems).toEqual([]);
  });

  test('a Flowchart flows the way dir= says; without it, the way it reads larger in its plate', async ({page, glimpse}) => {
    const chain = "{nodes:{A:'Start',B:'Check the input',C:'Write the row',D:{label:'Done',shape:'pill'}},edges:[['A','B'],['B','C'],['C','D']]}";
    // Twelve steps and no dir= in a full-width plate: drawn top to bottom it would be squeezed to the plate's height
    // cap, so it is drawn left to right (the old default, top to bottom, opened it at a fraction of its size).
    const steps = ['Open the file', 'Read the header', 'Check the version', 'Parse the rows', 'Drop empty rows', 'Merge duplicates', 'Sort by key', 'Split in pages', 'Write the pages', 'Build the index', 'Write the index', 'Close the file'];
    const long = `{nodes:{${steps.map((label, i) => `S${i}:'${label}'`).join(',')}},edges:[${steps.slice(1).map((_, i) => `['S${i}','S${i + 1}']`).join(',')}]}`;
    const spec = [
      "root=Page('Flow',[Grid([lr,plain,forced]),long])",
      `lr=Flowchart(${chain},dir='LR',title='dir LR')`,
      `plain=Flowchart(${chain},title='No dir')`,
      `forced=Flowchart(${chain},dir='TB',title='dir TB')`,
      `long=Flowchart(${long},title='Long, no dir')`,
    ].join('\n');
    await showSettled(page, glimpse, 'flow', spec);
    // the long chain: left to right, its first steps side by side, the drawing wider than tall
    const longStage = await stageOf(page, 'long');
    await expect(longStage, 'long').toHaveAttribute('data-dir', 'LR');
    const longShape = await geometry(longStage);
    expect(Object.keys(longShape.nodes), 'long: nodes drawn').toHaveLength(steps.length);
    const first = centre(longShape.nodes.S0!);
    const second = centre(longShape.nodes.S1!);
    expect(second.x - first.x, 'long: step 1 runs right').toBeGreaterThan(20);
    expect(Math.abs(second.y - first.y), 'long: step 1 level').toBeLessThan(4);
    const drawing = union(Object.values(longShape.nodes));
    expect(drawing.w, 'long: the drawing is wider than tall').toBeGreaterThan(drawing.h);
    // a plain four-step chain in a third of the width still reads larger top to bottom
    const expected: Record<string, 'LR' | 'TB'> = {lr: 'LR', plain: 'TB', forced: 'TB'};
    for (const [id, dir] of Object.entries(expected)) {
      const stage = await stageOf(page, id);
      const {nodes} = await geometry(stage);
      const at = ['A', 'B', 'C', 'D'].map(node => centre(nodes[node]!));
      // the chain runs along the flow: each step further right (LR) or further down (TB), and level across it; a flow
      // left to right too long for its plate wraps into rows, so a step there may instead start the next row down
      for (let i = 1; i < at.length; i++) {
        const along = dir === 'LR' ? at[i]!.x - at[i - 1]!.x : at[i]!.y - at[i - 1]!.y;
        const across = dir === 'LR' ? at[i]!.y - at[i - 1]!.y : at[i]!.x - at[i - 1]!.x;
        if (dir === 'LR' && i > 1 && across > 20) continue;
        expect(along, `${id}: step ${i} along ${dir}`).toBeGreaterThan(20);
        expect(Math.abs(across), `${id}: step ${i} across ${dir}`).toBeLessThan(4);
      }
      await expect(stage, id).toHaveAttribute('data-dir', dir);
    }
  });

  test('plates in one row keep the height of what they show; a short one is not stretched to its tall neighbour', async ({page, glimpse}) => {
    const rows = Array.from({length: 24}, (_, i) => `{name:'row ${i + 1}',n:${i + 1}}`).join(',');
    const spec = [
      "root=Page('Row',[short,tall,small])",
      "short=Text('Two lines of prose.\\n\\nNothing more.',title='Short',span=4)",
      `tall=DataTable([${rows}],title='Tall',span=4)`,
      "small=Graph({nodes:[{id:'a',label:'a'},{id:'b',label:'b'}],edges:[{from:'a',to:'b'}]},title='Two nodes',span=4)",
    ].join('\n');
    await showSettled(page, glimpse, 'row', spec);
    await stageOf(page, 'small');
    const plates = await page.evaluate(() => Object.fromEntries(['short', 'tall', 'small'].map(id => {
      const cell = document.querySelector(`.gl-cell[data-id="${id}"]`)!;
      const frame = cell.querySelector(':scope > .gl-frame')!.getBoundingClientRect();
      const body = cell.querySelector(':scope > .gl-frame > .gl-frame-body')!;
      // what the view inside the body draws: the bottom of its text, or of the diagram's stage and its zoom controls
      const drawn = id === 'small' ? [body.querySelector('[role="img"]')!, body.querySelector('[data-zoom]') ?? body.querySelector('[role="img"]')!] : [...body.querySelectorAll('p, li, [role="row"]')];
      const content = Math.max(...drawn.map(el => el.getBoundingClientRect().bottom));
      return [id, {top: frame.top, height: frame.height, blank: body.getBoundingClientRect().bottom - content}];
    })));
    console.log(`row: ${JSON.stringify(plates)}`);
    // one row
    expect(Math.abs(plates.short!.top - plates.tall!.top)).toBeLessThan(2);
    expect(Math.abs(plates.small!.top - plates.tall!.top)).toBeLessThan(2);
    // the table is tall; the prose and the two-node graph end well above it, with no blank paper under their content
    expect(plates.tall!.height).toBeGreaterThan(400);
    expect(plates.short!.height, 'short plate height').toBeLessThan(plates.tall!.height / 2);
    expect(plates.small!.height, 'two-node graph plate height').toBeLessThan(plates.tall!.height * 0.75);
    for (const id of ['short', 'small']) {
      expect(plates[id]!.blank, `${id}: blank paper under the content, px`).toBeLessThan(24);
      expect(plates[id]!.blank, `${id}: content cut off at the bottom, px`).toBeGreaterThanOrEqual(-1);
    }
  });

  test('a diagram that opens in part says how much is in view and has a minimap of the whole; Fit to view hides both', async ({page, glimpse}) => {
    // The eight nodes top to bottom in a short half-width plate: they do not fit at a readable zoom.
    await showSettled(page, glimpse, 'part', `root=Page('Part',[part])\npart=Graph(${EIGHT},'TB',title='Eight, top to bottom',span=6,size='s')`);
    const stage = await stageOf(page, 'part');
    const plate = page.locator('.gl-cell[data-id="part"]');
    await expect(plate.locator('[data-in-view]')).toHaveCount(1);
    await expect(plate.locator('.react-flow__minimap')).toHaveCount(1);
    const {nodes, zoom} = await geometry(stage);
    expect(Object.keys(nodes)).toHaveLength(8);
    console.log(`part: ${await plate.locator('[data-in-view]').textContent()} at ${zoom}`);
    await plate.getByRole('button', {name: 'Fit to view'}).click();
    await expect(plate.locator('[data-in-view]')).toHaveCount(0);
    await expect(plate.locator('.react-flow__minimap')).toHaveCount(0);
  });
});
