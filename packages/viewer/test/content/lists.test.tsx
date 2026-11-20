// Steps and List: status marks and progress, row mapping, selection and keyboard.
import {fireEvent, waitFor, within} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {datasetFixture, errorDataset, renderExpress} from '../harness.tsx';

const state = (cell: HTMLElement) => cell.querySelector('[data-gl-state]')?.getAttribute('data-gl-state');
const code = (cell: HTMLElement) => cell.querySelector('[data-gl-state="redline"]')?.getAttribute('data-code');
const PLAN = `[{title:'Add limiter middleware',note:'Sliding window per IP, see \`take()\`.',status:'done',file:'src/api/limiter.go#L1-40'},{title:'Wire into router',status:'doing',file:'src/api/routes.ts#L12'},{title:'Tests',status:'todo'},{title:'Dashboards',status:'blocked',note:'Needs metrics endpoint.'},{title:'Docs',status:'skipped'}]`;

describe('Steps', () => {
  it('draws numbered steps with status marks, a count and a segmented progress rule', async () => {
    const view = renderExpress(`$/plan=${PLAN}\nroot=Page('T',[plan])\nplan=Steps($/plan,1,title='Plan')`);
    const cell = view.cell('plan');
    const steps = [...cell.querySelectorAll('ol > li')] as HTMLElement[];
    expect(steps).toHaveLength(5);
    expect(steps.map(step => step.getAttribute('data-status'))).toEqual(['done', 'doing', 'todo', 'blocked', 'skipped']);
    // every status is a glyph plus a word
    expect(steps.map(step => step.querySelector('svg')?.getAttribute('data-status'))).toEqual(['done', 'doing', 'todo', 'blocked', 'skipped']);
    for (const [i, word] of ['Done', 'Doing', 'To do', 'Blocked', 'Skipped'].entries()) expect(steps[i]!.textContent).toContain(word);
    expect(steps[0]!.textContent).toContain('1Add limiter middleware');
    expect(steps[0]!.querySelector('code')?.textContent).toBe('take()');
    expect(steps[0]!.querySelector('.gl-path-base')?.textContent).toBe('limiter.go');
    // `current` marks the active step
    expect(steps.map(step => step.getAttribute('aria-current'))).toEqual([null, 'step', null, null, null]);
    // the plate header carries the count; the body starts with one segment per step
    const frame = cell.querySelector('.gl-frame')!;
    expect(frame.querySelector('.gl-frame-head [data-gl-steps-count]')?.textContent).toBe('1 / 5 done');
    const progress = within(cell).getByRole('img', {name: 'Progress: 1 done, 1 doing, 1 blocked, 1 skipped, 1 to do'});
    expect([...progress.children].map(segment => segment.getAttribute('data-status'))).toEqual(['done', 'doing', 'todo', 'blocked', 'skipped']);
    expect(view.errors).toEqual([]);
  });

  it('selecting a step selects its file; arrows, Home and End rove; o opens, c copies, Escape clears', async () => {
    const view = renderExpress(`$/plan=${PLAN}\nroot=Page('T',[plan])\nplan=Steps($/plan)`);
    const steps = [...view.cell('plan').querySelectorAll('ol > li')] as HTMLElement[];
    // one tab stop
    expect(steps.map(step => step.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    fireEvent.click(steps[1]!);
    expect(view.getData('/ui/sel')).toEqual({type: 'file', id: 'src/api/routes.ts', path: 'src/api/routes.ts', line: 12});
    expect(view.getData('/ui/file')).toBe('src/api/routes.ts#L12');
    await waitFor(() => expect(view.actions.at(-1)).toMatchObject({name: 'gl_select', sourceComponentId: 'plan'}));
    expect(steps.map(step => step.hasAttribute('data-selected'))).toEqual([false, true, false, false, false]);

    steps[0]!.focus();
    fireEvent.keyDown(steps[0]!, {key: 'ArrowDown'});
    expect(document.activeElement).toBe(steps[1]);
    expect(steps.map(step => step.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    fireEvent.keyDown(steps[1]!, {key: 'End'});
    expect(document.activeElement).toBe(steps[4]);
    fireEvent.keyDown(steps[4]!, {key: 'ArrowDown'});
    expect(document.activeElement).toBe(steps[4]);
    fireEvent.keyDown(steps[4]!, {key: 'Home'});
    expect(document.activeElement).toBe(steps[0]);

    fireEvent.keyDown(steps[0]!, {key: 'Enter'});
    expect(view.getData('/ui/file')).toBe('src/api/limiter.go#L1-40');
    fireEvent.keyDown(steps[0]!, {key: 'o'});
    await waitFor(() => expect(view.actions.at(-1)).toMatchObject({name: 'gl_open', context: {file: 'src/api/limiter.go#L1-40'}}));
    fireEvent.click(steps[0]!, {ctrlKey: true});
    await waitFor(() => expect(view.actions.filter(action => action.name === 'gl_open')).toHaveLength(2));
    fireEvent.keyDown(steps[0]!, {key: 'c'});
    expect(view.clipboard).toEqual(['src/api/limiter.go:1']);
    // a step without a file selects nothing
    const selections = view.actions.filter(action => action.name === 'gl_select').length;
    fireEvent.click(steps[2]!);
    fireEvent.keyDown(steps[2]!, {key: 'Enter'});
    expect(view.actions.filter(action => action.name === 'gl_select')).toHaveLength(selections);
    fireEvent.keyDown(steps[2]!, {key: 'Escape'});
    expect(view.getData('/ui/sel') ?? null).toBeNull();
    expect(view.cell('plan').querySelector('[data-selected]')).toBeNull();
  });

  it('follows the agent replacing the plan, and marks steps under a selected directory', async () => {
    const view = renderExpress(`$/plan=${PLAN}\nroot=Page('T',[plan])\nplan=Steps($/plan,title='Plan')`);
    const cell = view.cell('plan');
    const next = structuredClone(view.getData<Array<{status: string}>>('/plan')!);
    next[1]!.status = 'done';
    next[2]!.status = 'doing';
    view.send({version: '1.0', updateDataModel: {surfaceId: 'test', path: '/plan', value: next}});
    await waitFor(() => expect(cell.querySelector('[data-gl-steps-count]')?.textContent).toBe('2 / 5 done'));
    expect([...cell.querySelectorAll('ol > li')].map(step => step.getAttribute('data-status'))).toEqual(['done', 'done', 'doing', 'blocked', 'skipped']);
    view.setData('/ui/sel', {type: 'dir', id: 'src/api', path: 'src/api'});
    await waitFor(() => expect(cell.querySelectorAll('ol > li[data-selected]')).toHaveLength(2));
  });

  it('covers empty, error, wrong shape and malformed items; plain strings need no status', async () => {
    const view = renderExpress(`$/plan=[]\nroot=Page('T',[a,b])\na=Steps($/plan)\nb=Steps(['Read','Write','Ship'])`);
    expect(state(view.cell('a'))).toBe('empty');
    // untracked steps show neither a count nor a progress rule
    expect([...view.cell('b').querySelectorAll('ol > li')].map(step => step.textContent)).toEqual(['1Read', '2Write', '3Ship']);
    expect(view.cell('b').querySelector('[data-gl-steps-count]')).toBeNull();
    expect(view.cell('b').querySelector('[role="img"]')).toBeNull();

    view.setData('/plan', 'step one');
    await waitFor(() => expect(code(view.cell('a'))).toBe('E_SHAPE'));
    view.setData('/plan', errorDataset('code.todos', 'E_INTERNAL', 'scanner crashed'));
    await waitFor(() => expect(code(view.cell('a'))).toBe('E_INTERNAL'));
    view.setData('/plan', [null, {}, {title: ''}, {title: 'Kept', status: 'paused', file: 42}, {note: 'no title', file: 'a.ts'}, 7]);
    await waitFor(() => expect([...view.cell('a').querySelectorAll('ol > li')].map(step => step.textContent)).toEqual(['1Kept', '2a.tsno titlea.tsTS', '37']));
    expect(view.cell('a').querySelector('ol > li')?.hasAttribute('data-status')).toBe(false);
  });

  it('folds a very long plan behind "Show all" and groups its progress rule by status', async () => {
    const plan = Array.from({length: 250}, (_, i) => ({title: `Step ${i + 1}`, status: i < 100 ? 'done' : 'todo'}));
    const view = renderExpress(`$/plan=[]\nroot=Page('T',[a])\na=Steps($/plan)`, {data: {'/plan': plan}});
    const cell = view.cell('a');
    expect(cell.querySelectorAll('ol > li')).toHaveLength(100);
    expect(cell.querySelector('[data-gl-steps-count]')?.textContent).toBe('100 / 250 done');
    expect(within(cell).getByRole('img', {name: 'Progress: 100 done, 150 to do'}).children).toHaveLength(2);
    fireEvent.click(within(cell).getByRole('button', {name: 'Show all 250'}));
    expect(cell.querySelectorAll('ol > li')).toHaveLength(250);
    fireEvent.click(within(cell).getByRole('button', {name: 'Show first 100'}));
    expect(cell.querySelectorAll('ol > li')).toHaveLength(100);
  });
});

describe('List', () => {
  const rows = (cell: HTMLElement) => [...cell.querySelectorAll('ol > li')] as HTMLElement[];

  it('draws ListItem rows as given: rank, title, subtitle and a value over a proportional bar', async () => {
    const view = renderExpress(`root=Page('T',[a])\na=List([{title:'redis',sub:'npm',value:14},{title:'zod',sub:'npm',value:7,tone:'warn'},{title:'pg',value:'n/a'},{title:'cache',file:'src/auth/cache.ts#L5'}],title='External',note='by importers')`);
    const cell = view.cell('a');
    const items = rows(cell);
    expect(items.map(item => item.textContent)).toEqual(['1redisnpm14', '2zodnpm7', '3pgn/a', '4cache:5TS']);
    const bars = items.map(item => (item.querySelector('span[aria-hidden="true"][style]') as HTMLElement | null)?.style.width);
    expect(bars).toEqual(['100%', '50%', undefined, undefined]);
    expect(within(items[1]!).getByRole('img', {name: 'warning'})).toBeTruthy();
    // titled: a numbered plate with the note as its caption
    const frame = cell.querySelector('.gl-frame') as HTMLElement;
    expect(within(frame).getByRole('heading', {name: 'External'})).toBeTruthy();
    expect(frame.querySelector('.gl-frame-note')?.textContent).toBe('by importers');
    expect(view.errors).toEqual([]);
  });

  it('maps any rows dataset: roles first, then field kinds; a file cell makes the title an entity', async () => {
    const view = renderExpress(`root=Page('T',[ext,todos,churn])\next=List('deps.external top=3')\ntodos=List('code.todos')\nchurn=List('git.churn',limit=2)`, {datasets: 'ready'});
    // roles.label / roles.value, subtitle from the chip field
    expect(rows(view.cell('ext')).map(item => item.textContent)).toEqual(['1redisnpm3', '2zodnpm3', '3pgnpm2']);
    // the dataset was cut by the source: the marginal note says so
    expect(view.cell('ext').querySelector('[data-gl-marginal]')?.textContent).toBe('showing 3 of 5 · top');
    // no numeric field: no value and no bar; the file cell makes the title a file entity with the chip as subtitle
    const todos = rows(view.cell('todos'));
    expect(todos[0]!.querySelector('.gl-path-base')?.textContent).toBe('move to argon2id');
    expect(todos[0]!.textContent).toContain('TODO');
    expect(todos[0]!.querySelector('span[aria-hidden="true"][style]')).toBeNull();
    fireEvent.click(todos[0]!);
    expect(view.getData('/ui/sel')).toEqual({type: 'file', id: 'src/auth/service.ts', path: 'src/auth/service.ts', line: 23});
    expect(todos[0]!.hasAttribute('data-selected')).toBe(true);
    await waitFor(() => expect(view.actions.at(-1)).toMatchObject({name: 'gl_select', sourceComponentId: 'todos'}));
    // a path title is the path itself; `limit` cuts and the footer expands
    const churn = view.cell('churn');
    expect(rows(churn)).toHaveLength(2);
    expect(rows(churn)[0]!.querySelector('.gl-path-base')?.textContent).toBe('service.ts');
    const total = (datasetFixture('git.churn').data as unknown[]).length;
    fireEvent.click(within(churn).getByRole('button', {name: `Show all ${total}`}));
    expect(rows(churn)).toHaveLength(total);
    fireEvent.click(within(churn).getByRole('button', {name: 'Show top 2'}));
    expect(rows(churn)).toHaveLength(2);
  });

  it('sniffs rows that come with no fields, and selects non-file entities by field kind', async () => {
    const view = renderExpress(`$/r=[{name:'auth',loc:1500},{name:'api',loc:'1300'},{name:'ui',loc:null}]\nroot=Page('T',[a,b])\na=List($/r)\nb=List('git.authors')`, {datasets: 'ready'});
    expect(rows(view.cell('a')).map(item => item.textContent)).toEqual(['1auth1,500', '2api1,300', '3ui']);
    const author = rows(view.cell('b'))[0]!;
    fireEvent.click(author);
    expect(view.getData('/ui/sel')).toMatchObject({type: 'author'});
    expect(author.hasAttribute('data-selected')).toBe(true);
  });

  it('is one tab stop with roving focus; Enter selects and Escape clears', async () => {
    const view = renderExpress(`root=Page('T',[a])\na=List('git.churn')`, {datasets: 'ready'});
    const items = rows(view.cell('a'));
    expect(items.filter(item => item.tabIndex === 0)).toHaveLength(1);
    items[0]!.focus();
    fireEvent.keyDown(items[0]!, {key: 'ArrowDown'});
    fireEvent.keyDown(items[1]!, {key: 'ArrowDown'});
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2]!, {key: 'ArrowUp'});
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, {key: 'Enter'});
    expect(view.getData<{path: string}>('/ui/sel')?.path).toBe((datasetFixture('git.churn').data as Array<{path: string}>)[1]!.path);
    expect(items[1]!.hasAttribute('data-selected')).toBe(true);
    fireEvent.keyDown(items[1]!, {key: 'Escape'});
    expect(view.getData('/ui/sel') ?? null).toBeNull();
  });

  it('covers pending, error, empty, wrong shape, a binding update and a huge list', async () => {
    const view = renderExpress(`$/r=[]\nroot=Page('T',[a,b])\na=List('deps.external')\nb=List($/r,title='Bound')`);
    expect(state(view.cell('a'))).toBe('drafting');
    expect(state(view.cell('b'))).toBe('empty');
    view.setData('/ds/deps_external', errorDataset('deps.external', 'E_INTERNAL', 'resolver crashed'));
    await waitFor(() => expect(code(view.cell('a'))).toBe('E_INTERNAL'));
    view.setData('/r', {title: 'not a list'});
    await waitFor(() => expect(code(view.cell('b'))).toBe('E_SHAPE'));
    view.setData('/r', [null, {}, {title: ''}, [1, 2]]);
    await waitFor(() => expect(state(view.cell('b'))).toBe('empty'));
    view.setData('/r', ['alpha', 'beta']);
    await waitFor(() => expect(rows(view.cell('b')).map(item => item.textContent)).toEqual(['1alpha', '2beta']));
    view.setData('/r', Array.from({length: 5000}, (_, i) => ({title: `row ${i}`, value: 5000 - i})));
    await waitFor(() => expect(rows(view.cell('b'))).toHaveLength(10));
    // "show all" is bounded: a list never draws more than 200 rows
    fireEvent.click(within(view.cell('b')).getByRole('button', {name: 'Show 200 of 5,000'}));
    expect(rows(view.cell('b'))).toHaveLength(200);
    expect(view.container.querySelectorAll('[data-gl-state="redline"]')).toHaveLength(1);
  });
});
