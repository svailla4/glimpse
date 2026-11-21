// Data as text, end to end against the bundled server: a data argument written in a notation models already write (a
// Mermaid graph or erDiagram, a Markdown table, a task list, `Key: value` lines, `Tier: a, b — note` lines) is parsed
// by the server into the shapes the viewer draws; the tab never receives the text. A notation error renders nothing
// and says where; a small slip is repaired and said; a file a node names is checked like any other (D3).
import type {Page} from '@playwright/test';
import {expectSettled, openViewer, type Called, type Glimpse} from './support/glimpse.ts';
import {expect, test} from './support/test.ts';

test.use({viewport: {width: 1440, height: 900}});

const told = (shown: Called) => shown.lines.filter(line => /^(E_|warn |fixed |viewer: )/.test(line));

// Real newlines inside single quotes, as a model writes them; the compiler reads them as \n.
const ARCH = `graph LR
subgraph api[API layer]
routes[routes<br>request handlers]:::changed
limiter[limiter<br>sliding window]:::new
end
subgraph data[Storage]
db[(Postgres)]
cache((cache)):::gone
end
routes -->|take| limiter
routes -.->|reads| db
limiter -.-> cache
click limiter "src/api/middleware.ts#L1-10"
click routes "src/api/routes.ts"`;

const SCHEMA = `erDiagram
users {
uuid id PK
text email
}
orders {
uuid id PK
uuid user_id FK
int total_cents
}
users ||--o{ orders : places`;

const FILES = `| path | loc | owner |
|---|---|---|
| src/api/routes.ts | 12 | api |
| src/api/limiter.ts | 48 | api |
| src/orders/pricing.ts | 1,866 | orders |`;

const QUEUES = `| title | value |
|---|---|
| redis | 14 |
| postgres | 3 |`;

const PLAN = `- [x] Add the limiter [[src/api/middleware.ts]]
- [~] Wire it into the router — behind a flag
- [ ] Tests`;

const FACTS = `Language: TypeScript
Entry: src/index.ts
Strict: true`;

const KPIS = `Files: 412
Coverage: 87% (+2)`;

const TIERS = `Edge: routes, middleware — HTTP only
Domain: orders, pricing [[src/orders/pricing.ts]]
Storage: db, cache`;

const EVERY = [
  "root=Page('Notations',[arch,schema,files,queues,plan,facts,kpis,tiers])",
  `arch=Graph('${ARCH}',title='Request path',span=12)`,
  `$/schema='${SCHEMA}'`,
  "schema=ERDiagram($/schema,title='Schema',span=6)",
  `files=DataTable('${FILES}',title='Files',span=6)`,
  `queues=List('${QUEUES}',title='Queues',span=4)`,
  `$/plan='${PLAN}'`,
  "plan=Steps($/plan,title='Plan',span=4)",
  `facts=KeyValue('${FACTS}',title='Facts',span=4)`,
  `kpis=Stats('${KPIS}',title='KPIs',span=6)`,
  `tiers=Layers('${TIERS}',title='Tiers',span=6)`,
].join('\n');

async function showAndOpen(page: Page, glimpse: Glimpse, id: string, spec: string): Promise<Called> {
  const shown = await glimpse.call('show', {id, spec});
  expect(shown.isError, shown.text).toBe(false);
  await openViewer(page, glimpse);
  return shown;
}

test('every notation draws: the result is clean and each plate shows what the text says', async ({page, glimpse, watched}) => {
  const shown = await showAndOpen(page, glimpse, 'notations', EVERY);
  expect(shown.lines[0]).toMatch(/^ok notations /);
  expect(told(shown), shown.text).toEqual([]);
  const state = await expectSettled(page);
  expect(state.empty, 'empty plates').toEqual([]);

  // Graph: four nodes in two groups, each status mark on its node, the sub-line, the click link to a real file
  const arch = page.locator('.gl-cell[data-id="arch"]');
  await expect(arch.locator('[data-node]').first()).toBeVisible();
  await expect(arch.locator('[data-node]')).toHaveCount(4);
  await expect(arch.locator('[data-group]')).toHaveCount(2);
  await expect(arch.locator('[data-group="api"]')).toContainText('API layer');
  await expect(arch.locator('[data-group="data"]')).toContainText('Storage');
  const mark = (node: string) => arch.locator(`[data-node="${node}"] text`).filter({hasText: /^[+~−›]$/});
  await expect(mark('limiter')).toHaveText('+');
  await expect(mark('routes')).toHaveText('~');
  await expect(mark('cache')).toHaveText('−');
  await expect(mark('db')).toHaveCount(0);
  await expect(arch.locator('[data-node="limiter"]')).toContainText('sliding window');
  // the click link is the node's file: selecting the node marks the step that links the same file
  await arch.locator('[data-node="limiter"]').click();
  await expect(page.locator('.gl-cell[data-id="plan"] li[data-selected]')).toHaveCount(1);
  await expect(page.locator('.gl-cell[data-id="plan"] li[data-selected]')).toContainText('Add the limiter');
  expect((await glimpse.call('events', {wait: 5})).text).toContain('viewer: select node limiter');

  // ERDiagram, bound through the data model
  const schema = page.locator('.gl-cell[data-id="schema"]');
  await expect(schema).toContainText('users');
  await expect(schema).toContainText('total_cents');

  // DataTable: one row per table row, the numeric column read as numbers (1,866 sorts as a number)
  const files = page.locator('.gl-cell[data-id="files"]');
  await expect(files.locator('[role="row"][data-index]')).toHaveCount(3);
  await expect(files.locator('[role="columnheader"]')).toHaveCount(3);
  await expect(files).toContainText('12');
  await expect(files).toContainText('src/orders/pricing.ts');

  // List from a title/value table
  const queues = page.locator('.gl-cell[data-id="queues"]');
  await expect(queues).toContainText('redis');
  await expect(queues).toContainText('14');

  // Steps from a bound task list: done, doing, todo, and the file of the first step
  const plan = page.locator('.gl-cell[data-id="plan"]');
  await expect(plan.locator('li[data-status]')).toHaveCount(3);
  expect(await plan.locator('li[data-status]').evaluateAll(items => items.map(item => item.getAttribute('data-status')))).toEqual(['done', 'doing', 'todo']);
  await expect(plan.locator('[data-gl-steps-count]')).toHaveText('1 / 3 done');
  await expect(plan).toContainText('behind a flag');

  await expect(page.locator('.gl-cell[data-id="facts"]')).toContainText('TypeScript');
  await expect(page.locator('.gl-cell[data-id="kpis"]')).toContainText('87');
  const tiers = page.locator('.gl-cell[data-id="tiers"]');
  await expect(tiers).toContainText('Domain');
  await expect(tiers).toContainText('HTTP only');

  expect(watched.problems).toEqual([]);
});

test('a stored view takes its data as text, then a patch of one field', async ({page, glimpse}) => {
  await showAndOpen(page, glimpse, 'plan', "root=Page('Plan',[plan])\n$/plan=[]\nplan=Steps($/plan,title='Plan')");
  const plan = page.locator('.gl-cell[data-id="plan"]');
  const statuses = () => plan.locator('li[data-status]').evaluateAll(items => items.map(item => `${item.textContent?.trim().replace(/^\d+/, '').slice(0, 1)}:${item.getAttribute('data-status')}`));
  const text = await glimpse.call('show', {id: 'plan', spec: "$/plan='- [x] A\\n- [~] B'"});
  expect(text.isError, text.text).toBe(false);
  expect(told(text), text.text).toEqual([]);
  await expect.poll(statuses).toEqual(['A:done', 'B:doing']);
  const nested = await glimpse.call('show', {id: 'plan', spec: "$/plan/1/status='done'"});
  expect(nested.isError, nested.text).toBe(false);
  await expect.poll(statuses).toEqual(['A:done', 'B:done']);
  await expect(plan.locator('[data-gl-steps-count]')).toHaveText('2 / 2 done');
});

test('a notation error renders nothing, says where, and leaves the view as it was', async ({page, glimpse}) => {
  await showAndOpen(page, glimpse, 'bad', "root=Page('Bad',[g])\ng=Graph('graph LR\\na[API] --> b[DB]',title='Before')");
  const plate = page.locator('.gl-cell[data-id="g"]');
  await expect(plate.locator('[data-node]')).toHaveCount(2);
  const refused = await glimpse.call('show', {id: 'bad', spec: "g=Graph('graph LR\\na[API] --> b[DB]\\nb => c[Cache]',title='After')"});
  expect(refused.isError).toBe(true);
  expect(refused.lines[0], refused.text).toMatch(/^E_NOTATION Graph#g\.data line 3 col 3: expected an arrow \(-->, -->\|label\|, -- label -->, -\.->\), found "=> c\[Cache\]"\. Example: b --> c\[Cache\]$/);
  expect(refused.lines.slice(-3), refused.text).toEqual([
    expect.stringMatching(/^sig Graph\(/),
    expect.stringMatching(/^notation Mermaid graph: /),
    'Nothing was rendered; the previous view is unchanged.',
  ]);
  await page.waitForTimeout(500);
  await expect(plate.locator('[data-node]')).toHaveCount(2);
  await expect(plate).toContainText('Before');
  await expect(plate).not.toContainText('Cache');
  // a bad table bound through the data model is refused the same way
  const table = await glimpse.call('show', {id: 'bad', spec: "$/t='| a | b |\\n|---|---|\\n| 1 | 2 | 3 |'\nt=DataTable($/t)"});
  expect(table.isError).toBe(true);
  expect(table.lines[0], table.text).toMatch(/^E_NOTATION \$\/t \(DataTable#t\.data\) line 3 col \d+: /);
});

test("a slip is repaired and said: ':::hot' is dropped and the node drawn without a status", async ({page, glimpse}) => {
  const shown = await showAndOpen(page, glimpse, 'slip', "root=Page('Slip',[g])\ng=Graph('graph LR\\na[API] --> b[DB]\\nb:::hot',title='Slip')");
  expect(shown.lines.filter(line => line.startsWith('fixed ')), shown.text).toEqual(["fixed Graph#g.data line 3: ':::hot' dropped (status: new changed gone affected)"]);
  await expectSettled(page);
  const plate = page.locator('.gl-cell[data-id="g"]');
  await expect(plate.locator('[data-node]')).toHaveCount(2);
  await expect(plate.locator('[data-node="b"] text').filter({hasText: /^[+~−›]$/})).toHaveCount(0);
});

test('a node file that does not exist is reported (D3)', async ({page, glimpse}) => {
  const shown = await showAndOpen(page, glimpse, 'missing', "root=Page('Missing',[g])\ng=Graph('graph LR\\nx[Missing] --> y[There]\\nclick x \"src/missing.ts\"\\nclick y \"src/api/routes.ts\"',title='Files')");
  expect(shown.lines.filter(line => line.startsWith('warn ')), shown.text).toEqual([expect.stringMatching(/^warn Graph#g\.data node x: file "src\/missing\.ts" does not exist\./)]);
  await expect(page.locator('.gl-cell[data-id="g"] [data-node]')).toHaveCount(2);
});
