// Chips and KeyValue: self-formatting values, the numbered plate and the shared state matrix.
import {fireEvent, waitFor, within} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {datasetFixture, errorDataset, renderExpress} from '../harness.tsx';

const state = (cell: HTMLElement) => cell.querySelector('[data-gl-state]')?.getAttribute('data-gl-state');
const code = (cell: HTMLElement) => cell.querySelector('[data-gl-state="redline"]')?.getAttribute('data-code');
const chips = (cell: HTMLElement) => [...cell.querySelectorAll('li')].map(li => li.textContent);

describe('Chips', () => {
  it('draws the default source: pending, then one chip per item with slot and tone dots', async () => {
    const view = renderExpress(`root=Page('T',[stack])\nstack=Chips()`);
    const cell = view.cell('stack');
    expect(state(cell)).toBe('drafting');
    view.setData('/ds/repo_stack', datasetFixture('repo.stack'));
    await waitFor(() => expect(chips(cell)).toEqual(['TypeScript', 'CSS', 'Go', 'SQL', 'React', 'Vite', 'vitest', 'PostgreSQL', 'Redis', 'Docker', 'GitHub Actions']));
    const items = [...cell.querySelectorAll('li')];
    // a language takes the ink the server assigned to it (an unslotted key takes a free ink: see review.test.tsx)
    expect((items[0]!.querySelector('[aria-hidden]') as HTMLElement).style.background).toBe('var(--gl-cat-1)');
    expect((items[2]!.querySelector('[aria-hidden]') as HTMLElement).style.background).toBe('var(--gl-cat-3)');
    // a tone is a labelled dot; a plain string has no dot at all
    expect((within(items[7]!).getByRole('img', {name: 'info'}) as HTMLElement).style.background).toBe('var(--gl-info)');
    expect(items[4]!.querySelectorAll('span span')).toHaveLength(1);
    expect(view.errors).toEqual([]);
  });

  it('takes inline strings and objects, follows a binding and coerces malformed items', async () => {
    const view = renderExpress(`$/c=['React',{label:'1 cycle',tone:'warn'}]\nroot=Page('T',[a])\na=Chips($/c)`);
    expect(chips(view.cell('a'))).toEqual(['React', '1 cycle']);
    expect(within(view.cell('a')).getByRole('img', {name: 'warning'})).toBeTruthy();
    view.setData('/c', ['Vite', 7, null, '', {label: ''}, {name: 'named'}, {label: 'toned', tone: 'sparkly'}, ['nested'], true]);
    await waitFor(() => expect(chips(view.cell('a'))).toEqual(['Vite', '7', 'named', 'toned', '["nested"]', 'true']));
    expect(view.cell('a').querySelectorAll('[role="img"]')).toHaveLength(0);
  });

  it('shows the empty, error and wrong-shape states and folds a very long list', async () => {
    const view = renderExpress(`$/c=[]\nroot=Page('T',[a,b])\na=Chips($/c)\nb=Chips('repo.stack')`);
    expect(state(view.cell('a'))).toBe('empty');
    view.setData('/ds/repo_stack', errorDataset('repo.stack', 'E_INTERNAL', 'boom'));
    await waitFor(() => expect(code(view.cell('b'))).toBe('E_INTERNAL'));
    view.setData('/c', {React: true});
    await waitFor(() => expect(code(view.cell('a'))).toBe('E_SHAPE'));
    expect(view.cell('a').textContent).toContain('received object');
    view.setData('/c', [null, '']);
    await waitFor(() => expect(state(view.cell('a'))).toBe('empty'));
    view.setData('/c', Array.from({length: 500}, (_, i) => `chip ${i}`));
    await waitFor(() => expect(chips(view.cell('a'))).toHaveLength(121));
    expect(chips(view.cell('a')).at(-1)).toBe('+380 more');
  });
});

describe('KeyValue', () => {
  it('formats each value by what it is: path, list, boolean, number, URL, nothing', async () => {
    const view = renderExpress(
      `root=Page('T',[kv])
kv=KeyValue({Language:'TypeScript',Entry:'src/api/routes.ts#L12',Tests:true,Legacy:false,Maintainers:['Mira','Jon'],Size:131072,Docs:'https://example.com/docs',Runtime:'Node.js',Owner:null,Config:{strict:true}},2)`,
    );
    const cell = view.cell('kv');
    const rows = new Map([...cell.querySelectorAll('dl > div')].map(row => [row.querySelector('dt')!.textContent, row.querySelector('dd') as HTMLElement]));
    expect([...rows.keys()]).toEqual(['Language', 'Entry', 'Tests', 'Legacy', 'Maintainers', 'Size', 'Docs', 'Runtime', 'Owner', 'Config']);
    expect(rows.get('Language')!.textContent).toBe('TypeScript');
    // a path is a file entity: selecting it drives every view that follows the selection
    const entry = within(rows.get('Entry')!).getByRole('button');
    expect(entry.getAttribute('data-entity-id')).toBe('src/api/routes.ts');
    fireEvent.click(entry);
    expect(view.getData('/ui/file')).toBe('src/api/routes.ts#L12');
    expect(within(rows.get('Tests')!).getByRole('img', {name: 'yes'})).toBeTruthy();
    expect(within(rows.get('Legacy')!).getByRole('img', {name: 'no'}).textContent).toBe('—');
    expect(rows.get('Maintainers')!.textContent).toBe('MiraJon');
    expect(rows.get('Size')!.textContent).toBe('131,072');
    const docs = rows.get('Docs')!.querySelector('a')!;
    expect(docs.getAttribute('href')).toBe('https://example.com/docs');
    expect(docs.getAttribute('rel')).toBe('noopener noreferrer');
    // a product name with a dot is text, not a file
    expect(rows.get('Runtime')!.querySelector('button')).toBeNull();
    expect(rows.get('Owner')!.textContent).toBe('—');
    expect(rows.get('Config')!.textContent).toBe('{"strict":true}');
    expect((cell.querySelector('dl') as HTMLElement).style.getPropertyValue('--kv-cols')).toBe('2');
    expect(view.errors).toEqual([]);
  });

  it('draws a numbered plate when titled and renders bare without a title', async () => {
    const view = renderExpress(`root=Page('T',[a,b])\na=KeyValue({A:1},title='Facts')\nb=KeyValue([{k:'B',v:2},{k:'C',v:'x'}])`);
    const frame = view.cell('a').querySelector('.gl-frame')!;
    expect(frame.getAttribute('data-gl-frame')).toBe('KeyValue');
    expect(within(frame as HTMLElement).getByRole('heading', {name: 'Facts'})).toBeTruthy();
    expect(frame.querySelector('dt')?.textContent).toBe('A');
    expect(view.cell('b').querySelector('.gl-frame')).toBeNull();
    expect([...view.cell('b').querySelectorAll('dt')].map(dt => dt.textContent)).toEqual(['B', 'C']);
  });

  it('covers pending, error, empty, wrong shape, a binding update and a very long record', async () => {
    const view = renderExpress(`$/kv={}\nroot=Page('T',[a])\na=KeyValue($/kv,title='Facts')`);
    const cell = view.cell('a');
    expect(state(cell)).toBe('empty');
    view.setData('/kv', {...datasetFixture('repo.kpis'), status: 'pending', data: undefined, note: 'reading manifests'});
    await waitFor(() => expect(state(cell)).toBe('drafting'));
    expect(cell.textContent).toContain('reading manifests');
    view.setData('/kv', {...datasetFixture('repo.kpis'), status: 'error', data: undefined, error: {code: 'E_TARGET', message: 'no such path'}});
    await waitFor(() => expect(code(cell)).toBe('E_TARGET'));
    view.setData('/kv', 'just a string');
    await waitFor(() => expect(code(cell)).toBe('E_SHAPE'));
    expect(cell.textContent).toContain('expected an object or [{k, v}], received string');
    view.setData('/kv', [1, 'two', null]);
    await waitFor(() => expect(state(cell)).toBe('empty'));
    view.setData('/kv', {Name: 'demo'});
    await waitFor(() => expect(cell.querySelector('dd')?.textContent).toBe('demo'));
    // the plate survives every state
    expect(within(cell).getByRole('heading', {name: 'Facts'})).toBeTruthy();
    view.setData('/kv', Object.fromEntries(Array.from({length: 500}, (_, i) => [`key${i}`, i])));
    await waitFor(() => expect(cell.querySelectorAll('dt')).toHaveLength(200));
    expect(cell.textContent).toContain('showing 200 of 500');
  });
});
