import {act, fireEvent, waitFor} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {errorDataset, pendingDataset, renderExpress, type RenderedSpec} from '../harness.tsx';

const page = (json: string, data = '') => `${data}\nroot=Page('T',[t])\nt=${json}`;
const rowsOf = (view: RenderedSpec) => [...view.cell('t').querySelectorAll<HTMLElement>('[role="treeitem"]')];
const texts = (view: RenderedSpec) => rowsOf(view).map(row => row.textContent);
const row = (view: RenderedSpec, id: string) => view.cell('t').querySelector<HTMLElement>(`[data-json="${id}"]`)!;
const key = (name: string) => fireEvent.keyDown(document.activeElement!, {key: name});

async function ready(view: RenderedSpec): Promise<HTMLElement> {
  const tree = await waitFor(() => {
    const found = view.container.querySelector<HTMLElement>('[role="tree"]');
    if (!found) throw new Error('no tree yet');
    return found;
  });
  await view.settle();
  return tree;
}

const CONFIG = {name: 'demo', private: true, version: 3, nothing: null, scripts: {dev: 'vite', test: 'vitest run'}, workspaces: ['packages/*'], empty: {}, none: []};

describe('JsonView', () => {
  it('lists the top level and summarises nested values', async () => {
    const view = renderExpress(page("JsonView($/config,title='Config')"), {data: {'/config': CONFIG}});
    const tree = await ready(view);
    expect(tree.getAttribute('aria-label')).toBe('Config');
    expect(texts(view)).toEqual(['name:"demo"', 'private:true', 'version:3', 'nothing:null', 'scripts:{…2 keys}', 'workspaces:[…1]', 'empty:{}', 'none:[]']);
    expect(row(view, '$/scripts').getAttribute('aria-expanded')).toBe('false');
    expect(row(view, '$/name').hasAttribute('aria-expanded')).toBe(false);
    expect(row(view, '$/empty').hasAttribute('aria-expanded')).toBe(false);
    expect(view.cell('t').querySelector('[data-gl-json-note]')!.textContent).toBe('8 keys');
    expect(view.errors).toEqual([]);
  });

  it('opens `depth` levels initially', async () => {
    const view = renderExpress(page('JsonView($/config,2)'), {data: {'/config': CONFIG}});
    await ready(view);
    expect(texts(view)).toEqual(['name:"demo"', 'private:true', 'version:3', 'nothing:null', 'scripts:{2}', 'dev:"vite"', 'test:"vitest run"', 'workspaces:[1]', '0:"packages/*"', 'empty:{}', 'none:[]']);
    expect(row(view, '$/scripts/dev').getAttribute('aria-level')).toBe('2');
  });

  it('toggles with a click and with the keyboard, and copies a value', async () => {
    const view = renderExpress(page('JsonView($/config)'), {data: {'/config': CONFIG}});
    const tree = await ready(view);
    fireEvent.click(row(view, '$/scripts'));
    expect(row(view, '$/scripts').getAttribute('aria-expanded')).toBe('true');
    expect(row(view, '$/scripts/dev').textContent).toBe('dev:"vite"');
    fireEvent.click(row(view, '$/scripts'));
    expect(view.cell('t').querySelector('[data-json="$/scripts/dev"]')).toBeNull();

    expect([...tree.querySelectorAll('[tabindex="0"]')]).toHaveLength(1);
    act(() => row(view, '$/scripts').focus());
    key('ArrowRight');
    expect(row(view, '$/scripts').getAttribute('aria-expanded')).toBe('true');
    key('ArrowRight');
    expect(document.activeElement).toBe(row(view, '$/scripts/dev'));
    key('ArrowDown');
    expect(document.activeElement).toBe(row(view, '$/scripts/test'));
    key('ArrowLeft');
    expect(document.activeElement).toBe(row(view, '$/scripts'));
    key('c');
    expect(JSON.parse(view.clipboard[0]!)).toEqual(CONFIG.scripts);
    key('ArrowLeft');
    expect(row(view, '$/scripts').getAttribute('aria-expanded')).toBe('false');
    key('Enter');
    expect(row(view, '$/scripts').getAttribute('aria-expanded')).toBe('true');
    key('Home');
    expect(document.activeElement).toBe(row(view, '$/name'));
    key('c');
    expect(view.clipboard[1]).toBe('demo');
    key('End');
    expect(document.activeElement).toBe(row(view, '$/none'));
  });

  it('chunks long arrays into ranges and keeps only visible lines in the DOM', async () => {
    const big = {items: Array.from({length: 340}, (_, i) => i * 2), huge: Array.from({length: 25_000}, (_, i) => ({i}))};
    const view = renderExpress(page('JsonView($/big)'), {data: {'/big': big}});
    await ready(view);
    expect(texts(view)).toEqual(['items:[…340]', 'huge:[…25,000]']);
    fireEvent.click(row(view, '$/items'));
    expect(texts(view).slice(0, 5)).toEqual(['items:[340]', '[0 … 99][…100]', '[100 … 199][…100]', '[200 … 299][…100]', '[300 … 339][…40]']);
    fireEvent.click(row(view, '$/items#100-199'));
    expect(row(view, '$/items/100').textContent).toBe('100:200');
    expect(rowsOf(view).length).toBeLessThan(70);

    // 25,000 items: ranges of 10,000, then of 100
    fireEvent.click(row(view, '$/items'));
    fireEvent.click(row(view, '$/huge'));
    expect(texts(view).slice(1)).toEqual(['huge:[25,000]', '[0 … 9,999][…10,000]', '[10,000 … 19,999][…10,000]', '[20,000 … 24,999][…5,000]']);
    fireEvent.click(row(view, '$/huge#20000-24999'));
    expect(row(view, '$/huge#20000-20099').textContent).toBe('[20,000 … 20,099][…100]');
    expect(rowsOf(view).length).toBeLessThan(70);
    expect(view.errors).toEqual([]);
  });

  it('does not auto-open a huge value however deep `depth` asks', async () => {
    const wide = Object.fromEntries(Array.from({length: 400}, (_, i) => [`k${i}`, Object.fromEntries(Array.from({length: 40}, (_, j) => [`v${j}`, {leaf: j}]))]));
    const view = renderExpress(page('JsonView($/wide,12)'), {data: {'/wide': wide}});
    const tree = await ready(view);
    expect(rowsOf(view).length).toBeLessThan(70);
    // 400 x 40 x 2 lines would be 32,400: the automatic opening stops near the budget
    expect(Number.parseFloat(tree.querySelector<HTMLElement>('[role="tree"] > div')!.style.height) / 20).toBeLessThan(6000);
  });

  it('renders scalars, long strings and odd keys', async () => {
    const view = renderExpress(`root=Page('T',[t,u])\nt=JsonView($/odd)\nu=JsonView($/n)`, {data: {'/odd': {'a/b#c': 'x'.repeat(1000), flag: false, 'has space': 0}, '/n': 42}});
    await ready(view);
    expect(row(view, '$/a~1b~2c').textContent).toBe(`a/b#c:"${'x'.repeat(240)}…"`);
    expect(texts(view).slice(1)).toEqual(['flag:false', 'has space:0']);
    expect(view.cell('u').querySelector('[role="treeitem"]')!.textContent).toBe('42');
  });

  it('shows drafting, redline and empty states, and keeps what is open across a data update', async () => {
    const view = renderExpress(page('JsonView($/v)'), {data: {'/v': pendingDataset('repo.packages')}});
    await view.settle();
    expect(view.cell('t').querySelector('[data-gl-state="drafting"]')).not.toBeNull();
    view.setData('/v', errorDataset('repo.packages', 'E_INTERNAL', 'boom'));
    await view.settle();
    expect(view.cell('t').querySelector('[data-gl-state="redline"]')!.getAttribute('data-code')).toBe('E_INTERNAL');
    view.setData('/v', {});
    await view.settle();
    expect(view.cell('t').querySelector('[data-gl-state="empty"]')).not.toBeNull();

    view.setData('/v', CONFIG);
    await ready(view);
    fireEvent.click(row(view, '$/scripts'));
    view.setData('/v', {...CONFIG, scripts: {dev: 'vite --host', lint: 'biome check'}});
    await view.settle();
    expect(row(view, '$/scripts').getAttribute('aria-expanded')).toBe('true');
    expect(row(view, '$/scripts/dev').textContent).toBe('dev:"vite --host"');
    expect(row(view, '$/scripts/lint').textContent).toBe('lint:"biome check"');
  });
});
