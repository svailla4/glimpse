// Regression tests for the verification findings in the content family: KeyValue and Stats take each other's row
// shapes and name the shapes they take when nothing matches (V002); List rows keep the file name and a short tag
// whole (V039).
import {waitFor} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {datasetFixture, renderExpress} from '../harness.tsx';

const state = (cell: HTMLElement) => cell.querySelector('[data-gl-state]')?.getAttribute('data-gl-state');
const keys = (cell: HTMLElement) => [...cell.querySelectorAll('dt')].map(dt => dt.textContent);
const values = (cell: HTMLElement) => [...cell.querySelectorAll('dd')].map(dd => dd.textContent);
const statLabels = (cell: HTMLElement) => [...cell.querySelectorAll('[data-gl-stat]')].map(stat => stat.querySelector('[data-gl-stat-label]')?.textContent ?? '');
const statValues = (cell: HTMLElement) => [...cell.querySelectorAll('[data-gl-stat-value]')].map(node => node.textContent);

describe('KeyValue and Stats share their row shapes (V002)', () => {
  it('KeyValue draws [{k,v}], [{key,value}], [{label,value}] and [{name,value}] alike', async () => {
    const view = renderExpress(
      `root=Page('KV shapes',[a,b,c,d])\na=KeyValue([{k:'A',v:'1'}])\nb=KeyValue([{key:'A',value:'1'}])\nc=KeyValue([{label:'A',value:'1'}])\nd=KeyValue([{name:'A',value:'1'}])`,
    );
    for (const id of ['a', 'b', 'c', 'd']) {
      const cell = view.cell(id);
      expect(state(cell), id).toBeUndefined();
      expect(keys(cell), id).toEqual(['A']);
      expect(values(cell), id).toEqual(['1']);
    }
    expect(view.reports).toEqual([]);
  });

  it('KeyValue takes a StatItem dataset (repo.kpis) as label and value', async () => {
    const view = renderExpress(`root=Page('T',[kv])\nkv=KeyValue('repo.kpis')`);
    view.setData('/ds/repo_kpis', datasetFixture('repo.kpis'));
    const cell = view.cell('kv');
    await waitFor(() => expect(keys(cell)).toContain('Commits (30d)'));
    expect(keys(cell)).not.toContain('');
    expect(state(cell)).toBeUndefined();
  });

  it('KeyValue names the shapes it takes when rows match none of them', async () => {
    const view = renderExpress(`$/kv=[]\nroot=Page('T',[a])\na=KeyValue($/kv)`);
    view.setData('/kv', [{foo: 1, bar: 2, baz: 3}]);
    const cell = view.cell('a');
    await waitFor(() => expect(state(cell)).toBe('empty'));
    expect(cell.textContent).toContain('{Label: value} or [{label, value}]');
    expect(cell.textContent).toContain('got [{foo, bar, baz}]');
    // the report says the same, as a shape problem, so the model can fix its spec from the result alone (D14)
    await view.settle();
    expect(view.reports.at(-1)?.message).toContain('[{label, value}]');
    expect(view.stateOf('a')).toBe('W_SHAPE');
    // a truly empty object is still just empty, with no list of shapes
    view.setData('/kv', {});
    await waitFor(() => expect(cell.textContent).not.toContain('[{label, value}]'));
    expect(state(cell)).toBe('empty');
  });

  it('a two-field row is a pair: its text field is the key', async () => {
    const view = renderExpress(`$/kv=[]\nroot=Page('T',[a])\na=KeyValue($/kv)`, {data: {'/kv': [{loc: 120, lang: 'TypeScript'}, {loc: 30, lang: 'CSS'}]}});
    expect(keys(view.cell('a'))).toEqual(['TypeScript', 'CSS']);
    expect(values(view.cell('a'))).toEqual(['120', '30']);
    // two numbers are not a pair: nothing says which one is the label
    view.setData('/kv', [{foo: 1, bar: 2}]);
    await waitFor(() => expect(state(view.cell('a'))).toBe('empty'));
    expect(view.cell('a').textContent).toContain('got [{foo, bar}]');
  });

  it('Stats labels [{key,value}] cells and draws the object form {Label: value}', async () => {
    const view = renderExpress(`root=Page('T',[a,b,c])\na=Stats([{key:'A',value:1}])\nb=Stats({Files:412,Tests:1866})\nc=Stats([{name:'Lines',v:9000}])`);
    expect(statLabels(view.cell('a'))).toEqual(['A']);
    expect(statValues(view.cell('a'))).toEqual(['1']);
    expect(statLabels(view.cell('b'))).toEqual(['Files', 'Tests']);
    expect(statValues(view.cell('b'))).toEqual(['412', '1,866']);
    expect(statLabels(view.cell('c'))).toEqual(['Lines']);
    expect(view.container.querySelector('[data-gl-state]')).toBeNull();
    expect(view.reports).toEqual([]);
  });

  it('Stats reads a {value, delta} item inside the object form, and one StatItem object as one cell', async () => {
    const view = renderExpress(`root=Page('T',[a,b])\na=Stats({Files:{value:412,delta:3}})\nb=Stats({label:'Files',value:412})`);
    expect(statLabels(view.cell('a'))).toEqual(['Files']);
    expect(statValues(view.cell('a'))).toEqual(['412']);
    expect(view.cell('a').textContent).toContain('up 3');
    expect(statLabels(view.cell('b'))).toEqual(['Files']);
    expect(statValues(view.cell('b'))).toEqual(['412']);
  });

  it('Stats names the shapes it takes when items match none of them', async () => {
    const view = renderExpress(`$/k=[]\nroot=Page('T',[a])\na=Stats($/k)`);
    view.setData('/k', [{foo: 1}]);
    const cell = view.cell('a');
    await waitFor(() => expect(state(cell)).toBe('empty'));
    expect(cell.textContent).toContain('[{label, value}] or {Label: value}');
    expect(cell.textContent).toContain('got [{foo}]');
    await view.settle();
    expect(view.stateOf('a')).toBe('W_SHAPE');
  });

  it('a component that draws its pairs says OK', async () => {
    const view = renderExpress(`root=Page('T',[a,b])\na=KeyValue([{label:'A',value:'1'}])\nb=Stats({Files:412})`);
    await view.settle();
    expect(view.stateOf('a')).toBe('OK');
    expect(view.stateOf('b')).toBe('OK');
  });
});

describe('List rows keep where they are (V039)', () => {
  const rows = (cell: HTMLElement) => [...cell.querySelectorAll('ol > li')] as HTMLElement[];
  const TODOS = [
    {tag: 'TODO', file: '.github/workflows/community_code.yml#L83', text: '(https://github.com/a2ui-project/a2ui/issues/1698): remove once the composer is gone'},
    {tag: 'FIXME', file: 'renderers/lit/src/0.8/ui/root.ts#L208', text: 'Description is currently not used in the Maps.'},
  ];

  it('a row titled by its text shows the file name and line in a box of their own', async () => {
    const view = renderExpress(`$/t=[]\nroot=Page('T',[a])\na=List($/t,title='Open TODOs')`);
    view.setData('/t', {...datasetFixture('code.todos'), data: TODOS});
    const cell = view.cell('a');
    await waitFor(() => expect(rows(cell)).toHaveLength(2));
    const [first, second] = rows(cell);
    // the text is the title; the location is a separate box with the whole path, the file name and the line
    const where = first!.querySelector<HTMLElement>('[data-gl-list-where]')!;
    expect(where).not.toBeNull();
    expect(where.querySelector('.gl-path-base')?.textContent).toBe('community_code.yml');
    expect(where.querySelector('.gl-path-line')?.textContent).toBe(':83');
    expect(where.querySelector('.gl-path')?.getAttribute('title')).toBe(TODOS[0]!.file);
    // the text gives way inside its own box; the location is outside it
    const title = first!.querySelector<HTMLElement>(`[title="${TODOS[0]!.text}"]`)!;
    expect(title.contains(where)).toBe(false);
    expect(first!.hasAttribute('data-where')).toBe(true);
    expect(second!.querySelector('[data-gl-list-where] .gl-path-base')?.textContent).toBe('root.ts');
  });

  it('never cuts a short tag', async () => {
    const view = renderExpress(`root=Page('T',[a])\na=List('code.todos')`, {datasets: 'ready'});
    const tags = rows(view.cell('a')).map(row => row.querySelector<HTMLElement>('[data-short]')?.textContent);
    expect(tags).toEqual(['TODO', 'FIXME', 'HACK']);
  });

  it('a row titled by its file draws the path once', async () => {
    const view = renderExpress(`root=Page('T',[a])\na=List([{file:'src/auth/cache.ts#L5'}])`);
    const [row] = rows(view.cell('a'));
    expect(row!.querySelectorAll('.gl-path')).toHaveLength(1);
    expect(row!.querySelector('[data-gl-list-where]')).toBeNull();
    expect(row!.hasAttribute('data-where')).toBe(false);
  });
});
