import {cleanLayers} from '@glimpse/catalog';
import {fireEvent, screen, waitFor, within} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {MAX_BANDS, MAX_ITEMS} from '../../src/components/diagrams/Layers.tsx';
import {buildPatch, buildSurface, datasetFixture, errorDataset, pendingDataset, renderExpress, renderSpec} from '../harness.tsx';
import {focus, key} from './util.tsx';

const DATA = `[{name:'Interface',items:['ui',{label:'api',file:'src/api/routes.ts'}]},{name:'Domain',items:[{label:'auth',file:'src/auth/service.ts#L8',note:'sessions'}],note:'owns sessions'},{name:'Storage',items:['postgres','redis']}]`;
const SPEC = `root=Page('T',[l])\nl=Layers(${DATA},title='Tiers')`;
const BOUND = `root=Page('T',[l])\nl=Layers($/layers,title='Tiers',size='l')`;
const ready = async (spec = SPEC, options: Parameters<typeof renderExpress>[1] = {}) => {
  const view = renderExpress(spec, options);
  await screen.findByRole('group', {name: /^Layers/});
  return view;
};
const bands = (cell: HTMLElement) => [...cell.querySelectorAll('[data-layer]')];
const items = (band: Element) => [...band.querySelectorAll('[data-layer-item]')].map(item => item.getAttribute('data-layer-item'));

describe('Layers', () => {
  it('stacks the tiers top first, with their items and notes', async () => {
    const view = await ready();
    const cell = view.cell('l');
    expect(bands(cell).map(band => band.getAttribute('data-layer'))).toEqual(['Interface', 'Domain', 'Storage']);
    expect(bands(cell).map(items)).toEqual([['ui', 'api'], ['auth'], ['postgres', 'redis']]);
    expect(within(bands(cell)[0] as HTMLElement).getByRole('heading', {name: 'Interface'})).toBeTruthy();
    expect(within(bands(cell)[1] as HTMLElement).getByText('owns sessions')).toBeTruthy();
    expect(within(bands(cell)[1] as HTMLElement).getByText('sessions')).toBeTruthy();
    // only the first band is without a separating hairline above it
    expect(bands(cell).map(band => band.hasAttribute('data-first'))).toEqual([true, false, false]);
    expect(screen.getByRole('group', {name: /^Layers/}).getAttribute('aria-label')).toBe('Layers, 3 tiers, 5 items: Interface, Domain, Storage');
    expect(view.errors).toEqual([]);
  });

  it('makes items with a file entities: click selects, the rest dims, Cmd-click opens', async () => {
    const view = await ready();
    const cell = view.cell('l');
    const buttons = within(cell).getAllByRole('button');
    expect(buttons.map(b => b.textContent)).toEqual(['api', 'authsessions']);
    fireEvent.click(buttons[1]!);
    expect(view.getData('/ui/sel')).toEqual({type: 'file', id: 'src/auth/service.ts', path: 'src/auth/service.ts', line: 8, label: 'auth'});
    expect(view.getData('/ui/file')).toBe('src/auth/service.ts#L8');
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_select', sourceComponentId: 'l'});
    const item = (label: string) => [...cell.querySelectorAll('[data-layer-item]')].find(el => el.getAttribute('data-layer-item') === label)!;
    expect(item('auth').hasAttribute('data-selected')).toBe(true);
    expect(item('auth').hasAttribute('data-dim')).toBe(false);
    for (const label of ['ui', 'api', 'postgres']) expect(item(label).hasAttribute('data-dim')).toBe(true);

    fireEvent.click(buttons[0]!, {metaKey: true});
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_open', context: {file: 'src/api/routes.ts'}});
    fireEvent.keyDown(buttons[1]!, {key: 'Escape'});
    expect(cell.querySelector('[data-layer-item][data-selected], [data-dim]')).toBeNull();
  });

  it('highlights the item whose file is selected elsewhere', async () => {
    const view = await ready();
    view.setData('/ui/sel', {type: 'file', id: 'src/api/routes.ts', path: 'src/api/routes.ts'});
    const selected = () => [...view.cell('l').querySelectorAll('[data-layer-item][data-selected]')].map(el => el.getAttribute('data-layer-item'));
    expect(selected()).toEqual(['api']);
    view.setData('/ui/sel', {type: 'dir', id: 'src', path: 'src'});
    expect(selected()).toEqual(['api', 'auth']);
  });

  it('is one tab stop with the arrow keys moving between entities', async () => {
    const data = [
      {name: 'One', items: [{label: 'a', file: 'a.ts'}, {label: 'b', file: 'b.ts'}, 'plain']},
      {name: 'Two', items: ['plain too']},
      {name: 'Three', items: [{label: 'c', file: 'c.ts'}, {label: 'd', file: 'd.ts'}]},
    ];
    const view = await ready(BOUND, {data: {'/layers': data}});
    const buttons = within(view.cell('l')).getAllByRole('button');
    expect(buttons.map(b => b.tabIndex)).toEqual([0, -1, -1, -1]);
    focus(buttons[0]!);
    key(buttons[0]!, 'ArrowRight');
    expect(document.activeElement).toBe(buttons[1]);
    await waitFor(() => expect(buttons.map(b => b.tabIndex)).toEqual([-1, 0, -1, -1]));
    key(buttons[1]!, 'ArrowDown');
    expect(document.activeElement).toBe(buttons[2]);
    key(buttons[2]!, 'End');
    expect(document.activeElement).toBe(buttons[3]);
    key(buttons[3]!, 'ArrowUp');
    expect(document.activeElement).toBe(buttons[0]);
    key(buttons[0]!, 'ArrowLeft');
    expect(document.activeElement).toBe(buttons[0]);
    key(buttons[0]!, 'End');
    key(buttons[3]!, 'Home');
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('shows drafting, redline and empty for dataset envelopes and an unbound path', async () => {
    const view = renderExpress(BOUND);
    await waitFor(() => expect(view.cell('l').querySelector('[data-gl-state="empty"]')).not.toBeNull());
    view.setData('/layers', pendingDataset('files.tree', 'reading the tree'));
    await waitFor(() => expect(view.cell('l').querySelector('[data-gl-state="drafting"]')!.textContent).toContain('reading the tree'));
    view.setData('/layers', errorDataset('files.tree', 'E_INTERNAL', 'boom'));
    await waitFor(() => expect(view.cell('l').querySelector('[data-code="E_INTERNAL"]')!.textContent).toContain('boom'));
    view.setData('/layers', {...datasetFixture('repo.stack'), data: [{name: 'Edge', items: ['cdn']}]});
    await waitFor(() => expect(bands(view.cell('l')).map(items)).toEqual([['cdn']]));
    view.setData('/layers', []);
    await waitFor(() => expect(view.cell('l').querySelector('[data-gl-state="empty"]')).not.toBeNull());
  });

  it('shows an E_SHAPE redline for a value that is not a list of tiers', async () => {
    const view = renderExpress(BOUND, {data: {'/layers': {name: 'not a list'}}});
    // The catalog's cleanLayers' message (decision links-through-node-ids), the one the server gives for inline data.
    await waitFor(() => expect(view.cell('l').querySelector('[data-code="E_SHAPE"]')!.textContent).toMatch(/Layers#l expected tiers \[\{name, items\}\], received an object/));
    view.setData('/layers', 'tiers');
    await waitFor(() => expect(view.cell('l').querySelector('[data-code="E_SHAPE"]')!.textContent).toMatch(/received a string/));
  });

  it('coerces malformed tiers and items, and names what it had to drop (W_DROPPED)', async () => {
    const data = [
      {name: 'Mixed', items: ['ok', 7, null, {note: 'no label'}, {label: 'fine'}, ['nested'], '']},
      {items: ['nameless tier']},
      {name: 'No items', items: 'oops'},
      'bare',
      42,
      null,
    ];
    const view = await ready(BOUND, {data: {'/layers': data}});
    const cell = view.cell('l');
    expect(bands(cell).map(band => band.getAttribute('data-layer'))).toEqual(['Mixed', '—', 'No items', 'bare', '42']);
    expect(bands(cell).map(items)).toEqual([['ok', '7', 'fine'], ['nameless tier'], [], [], []]);
    // Decision links-through-node-ids: each entry left out is named, as Flowchart does, and the tab tells the model.
    expect(cell.querySelector('[data-gl-note]')!.textContent).toBe('6 not drawn');
    await waitFor(() => expect(view.stateOf('l')).toBe('W_DROPPED'));
    expect(view.reports.findLast(report => report.code === 'W_DROPPED')!.message).toBe(
      "Layers#l: not drawn: tier 1 item 3: expected 'label' or {label}, received null; tier 1 item 4: no label; "
      + "tier 1 item 6: expected 'label' or {label}, received an array; tier 1 item 7: no label; "
      + 'tier 3: items: expected a list, received a string; tier 6: expected {name, items} or a name, received null',
    );
  });

  // Decision what-if-as-a2ui-calls: the server checks inline data as drawn here (asDrawn), calls computed and $/paths resolved.
  it('draws a call or a $/path inside inline items as its value, with nothing reported', async () => {
    const view = await ready(`$/w={name:'cache'}\nroot=Page('T',[l])\nl=Layers([{name:'T',items:[div(1,2),{label:add(1,1)},$/w/name,{label:$/w/name,note:mul(2,3)}]}])`);
    expect(bands(view.cell('l')).map(items)).toEqual([['0.5', '2', 'cache', 'cache']]);
    expect(within(view.cell('l')).getByText('6')).toBeTruthy();
    expect(view.stateOf('l')).toBe('OK');
    expect(view.errors).toEqual([]);
  });

  it('counts every entry it left out, past the eight the report names', async () => {
    const view = await ready(BOUND, {data: {'/layers': [{name: 'T', items: [...Array(20).fill(null), 'ok']}]}});
    expect(view.cell('l').querySelector('[data-gl-note]')!.textContent).toBe('20 not drawn');
    await waitFor(() => expect(view.stateOf('l')).toBe('W_DROPPED'));
    expect(view.reports.findLast(report => report.code === 'W_DROPPED')!.message).toMatch(/; and 12 more$/);
  });

  it('reports unknown keys of data a patch wrote (W_DROPPED)', async () => {
    const view = await ready(BOUND, {data: {'/layers': [{name: 'Data', items: [{label: 'pg', colour: 'blue'}]}]}});
    await waitFor(() => expect(view.stateOf('l')).toBe('W_DROPPED'));
    expect(view.reports.findLast(report => report.code === 'W_DROPPED')!.message).toBe('Layers#l: not drawn: ignored item key colour');
    expect(bands(view.cell('l')).map(items)).toEqual([['pg']]);
    // every item is drawn: the tab says nothing is missing
    expect(view.cell('l').querySelector('[data-gl-note]')).toBeNull();
    view.setData('/layers', [{name: 'Data', items: [{label: 'pg'}]}]);
    await waitFor(() => expect(view.stateOf('l')).toBe('OK'));
  });

  // Decision links-through-node-ids: an item that names a diagram node stands for it.
  it('makes an item naming a node an entity: it selects that node and lights with it', async () => {
    const data = [
      {name: 'Edge', items: [{label: 'Gateway', node: 'GW'}, {label: 'API', file: 'src/api.ts', node: 'GW'}]},
      {name: 'Data', items: [{label: 'Postgres', node: 'PG'}, {label: 'Stores', node: ['PG', 'Redis']}, 'plain']},
    ];
    const view = await ready(BOUND, {data: {'/layers': data}});
    const cell = view.cell('l');
    const item = (label: string) => [...cell.querySelectorAll('[data-layer-item]')].find(el => el.getAttribute('data-layer-item') === label)!;
    const button = (label: string) => within(item(label) as HTMLElement).getByRole('button');
    const selected = () => [...cell.querySelectorAll('[data-layer-item][data-selected]')].map(el => el.getAttribute('data-layer-item'));
    expect(within(cell).getAllByRole('button').map(b => b.textContent)).toEqual(['Gateway', 'API', 'Postgres', 'Stores']);

    fireEvent.click(button('Postgres'));
    expect(view.getData('/ui/sel')).toEqual({type: 'node', id: 'PG', label: 'Postgres'});
    // Stores stands for PG and Redis: it is linked to a selection that names PG
    expect(selected()).toEqual(['Postgres', 'Stores']);
    for (const label of ['Gateway', 'API', 'plain']) expect(item(label).hasAttribute('data-dim')).toBe(true);

    fireEvent.click(button('Stores'));
    expect(view.getData('/ui/sel')).toEqual({type: 'row', id: 'l:2.2', label: 'Stores', nodes: ['PG', 'Redis']});
    // Postgres stands for one node the selection names; nothing chains further
    expect(selected()).toEqual(['Postgres', 'Stores']);

    fireEvent.click(button('API'));
    expect(view.getData('/ui/sel')).toEqual({type: 'file', id: 'src/api.ts', path: 'src/api.ts', label: 'API', nodes: ['GW']});
    expect(view.getData('/ui/file')).toBe('src/api.ts');
    expect(selected()).toEqual(['Gateway', 'API']);

    // lit from outside: a Flowchart node, or a message passing through it
    view.setData('/ui/sel', {type: 'node', id: 'GW', label: 'Gateway'});
    expect(selected()).toEqual(['Gateway', 'API']);
    view.setData('/ui/sel', {type: 'message', id: 's:1', label: '1. U to G: go', nodes: ['Client', 'GW']});
    expect(selected()).toEqual(['Gateway', 'API']);
    expect(item('Postgres').hasAttribute('data-dim')).toBe(true);
  });

  it('keeps two items with one label and different nodes apart', async () => {
    const data = [{name: 'Edge', items: [{label: 'cache', node: ['CDN', 'Edge']}]}, {name: 'Data', items: [{label: 'cache', node: ['Redis', 'PG']}]}];
    const view = await ready(BOUND, {data: {'/layers': data}});
    const boxes = [...view.cell('l').querySelectorAll('[data-layer-item]')] as HTMLElement[];
    fireEvent.click(within(boxes[1]!).getByRole('button'));
    expect(view.getData('/ui/sel')).toEqual({type: 'row', id: 'l:2.1', label: 'cache', nodes: ['Redis', 'PG']});
    expect(boxes.map(box => box.hasAttribute('data-selected'))).toEqual([false, true]);
  });

  it('caps a huge tier and keeps a 500-character label on one line', async () => {
    const long = 'z'.repeat(500);
    const view = await ready(BOUND, {data: {'/layers': [{name: long, items: [long, ...Array.from({length: 200}, (_, i) => `item ${i}`)], note: long}]}});
    const cell = view.cell('l');
    expect(cell.querySelectorAll('[data-layer-item]')).toHaveLength(MAX_ITEMS);
    expect(cell.querySelector('[data-more]')!.textContent).toBe('+ 141 more');
    // the full label is the tooltip; CSS cuts the visible text
    expect(cell.querySelector('[data-layer-item]')!.getAttribute('title')).toBe(long);
  });

  it('draws at most 40 tiers and says how many there are', async () => {
    const view = await ready(BOUND, {data: {'/layers': Array.from({length: 100}, (_, i) => ({name: `t${i}`, items: []}))}});
    expect(bands(view.cell('l'))).toHaveLength(MAX_BANDS);
    expect(view.cell('l').querySelector('[data-gl-note]')!.textContent).toBe('showing 40 of 100 tiers');
  });

  it('follows a binding update and a patch', async () => {
    const base = buildSurface('test', BOUND, {data: {layers: [{name: 'A', items: ['one']}]}});
    const view = renderSpec(base);
    await waitFor(() => expect(bands(view.cell('l')).map(items)).toEqual([['one']]));
    view.setData('/layers', [{name: 'A', items: ['one', 'two']}, {name: 'B', items: ['three']}]);
    await waitFor(() => expect(bands(view.cell('l')).map(items)).toEqual([['one', 'two'], ['three']]));
    view.send(buildPatch('test', base, `l=Layers([{name:'Z',items:['last']}],title='Tiers',size='l')`));
    await waitFor(() => expect(bands(view.cell('l')).map(band => band.getAttribute('data-layer'))).toEqual(['Z']));
    expect(view.errors).toEqual([]);
  });

  it('names a band by name, label or title, and an item by label, name or title (accept-familiar-variants, F040)', async () => {
    const clean = cleanLayers([
      {title: 'Interface', items: [{title: 'ui'}, {name: 'api', file: 'src/api.ts'}]},
      {label: 'Domain', items: ['auth']},
      {name: 'Storage', title: 'ignored', items: [{label: 'postgres', name: 'pg'}]},
      {items: ['orphan']},
    ]);
    if (!clean.ok) throw new Error(clean.error);
    expect(clean.ast.bands.map(band => band.name)).toEqual(['Interface', 'Domain', 'Storage', '—']);
    expect(clean.ast.bands.map(band => band.items.map(item => item.label))).toEqual([['ui', 'api'], ['auth'], ['postgres'], ['orphan']]);
    expect(clean.dropped).toEqual([]);
    const view = await ready(BOUND, {data: {'/layers': [{title: 'Interface', items: ['ui']}, {label: 'Domain', items: ['auth']}]}});
    expect(bands(view.cell('l')).map(band => band.getAttribute('data-layer'))).toEqual(['Interface', 'Domain']);
  });
});

// Decision content-sized-plates: the tiers take their natural height, up to the plate's maximum height; past that they scroll.
describe('Layers: content-sized', () => {
  it.each([
    ['no size: the diagram family\'s 640 px', SPEC, () => 640],
    ['size l: 420 px', `root=Page('T',[l])\nl=Layers(${DATA},title='Tiers',size='l')`, () => 420],
    ['size fill: the window less the masthead, never under 420 px', `root=Page('T',[l])\nl=Layers(${DATA},title='Tiers',size='fill')`, () => Math.max(420, window.innerHeight - 160)],
  ])('takes %s as its maximum height', async (_name, spec, cap) => {
    const view = await ready(spec);
    const root = screen.getByRole('group', {name: /^Layers/});
    expect(root.style.maxHeight).toBe(`${cap()}px`);
    expect(root.style.height).toBe('');
    expect(bands(view.cell('l'))).toHaveLength(3);
  });
});
