// packages/viewer/test/shell/arrange.test.tsx - human arrangement of cells (design 12.1.A) with a fake storage.
import {act, fireEvent, screen} from '@testing-library/react';
import type {ReactNode} from 'react';
import {describe, expect, it} from 'vitest';
import {ARRANGE_STORAGE_KEY, ArrangeStoreContext, arrangeKey, createArrangeStore, rebalance, relocate, type ArrangeStore} from '../../src/kit/arrange.tsx';
import {buildPatch, buildSurface, renderExpress, type RenderedSpec} from '../harness.tsx';
import {fakeStorage} from './scripted.ts';

const KEY = 'demo/test';
const SPEC = `root=Page('T',[a,b,c,note])\na=Plate('Alpha',[Text('a')],span=6)\nb=Plate('Beta',[Text('b')],span=6)\nc=DataTable('git.churn',title='Gamma')\nnote=Text('no header here')`;

function mount(spec = SPEC, storage = fakeStorage()) {
  const store = createArrangeStore(storage);
  const wrapper = (surface: ReactNode) => <ArrangeStoreContext.Provider value={store}>{surface}</ArrangeStoreContext.Provider>;
  const view = renderExpress(spec, {wrapper, datasets: 'ready'});
  return {view, store, storage};
}
const stored = (storage: ReturnType<typeof fakeStorage>) => JSON.parse(storage.values.get(ARRANGE_STORAGE_KEY) ?? 'null');
const header = (view: RenderedSpec, id: string) => view.cell(id).querySelector<HTMLElement>('.gl-frame-head')!;
/** [id, CSS order, data-span] of the cells of root, in DOM (spec) order. */
const cells = (view: RenderedSpec, ids = ['a', 'b', 'c', 'note']) => ids.map(id => [id, view.cell(id).style.order, view.cell(id).getAttribute('data-span')]);
const alt = (target: Element, key: string, shiftKey = false) => fireEvent.keyDown(target, {key, altKey: true, shiftKey});

describe('arrange store', () => {
  it('keeps entries per surface and container, and notifies', () => {
    const storage = fakeStorage();
    const store = createArrangeStore(storage);
    let notified = 0;
    const off = store.subscribe(() => notified++);
    expect(arrangeKey('demo', 'overview')).toBe('demo/overview');
    expect(arrangeKey(undefined, 'main')).toBe('/main');
    expect(store.has(KEY)).toBe(false);
    store.update(KEY, 'root', {order: ['b', 'a'], span: {}});
    store.update(KEY, 'sec', {order: [], span: {x: 4}});
    store.update('demo/other', 'root', {order: ['z', 'y'], span: {}});
    expect(notified).toBe(3);
    expect(store.entry(KEY, 'root')).toEqual({order: ['b', 'a'], span: {}});
    expect(store.entry(KEY, 'root')).toBe(store.entry(KEY, 'root'));
    expect(stored(storage)).toEqual({
      'demo/test': {root: {order: ['b', 'a'], span: {}}, sec: {order: [], span: {x: 4}}},
      'demo/other': {root: {order: ['z', 'y'], span: {}}},
    });
    store.update(KEY, 'root', undefined);
    expect(store.has(KEY)).toBe(true);
    store.reset(KEY);
    expect(store.has(KEY)).toBe(false);
    expect(store.has('demo/other')).toBe(true);
    expect(stored(storage)).toEqual({'demo/other': {root: {order: ['z', 'y'], span: {}}}});
    // nothing to forget: no write, no notification
    const before = notified;
    store.reset(KEY);
    store.update(KEY, 'nope', undefined);
    expect(notified).toBe(before);
    off();
    store.reset('demo/other');
    expect(notified).toBe(before);
  });

  it('reads what an earlier visit stored and drops whatever has the wrong shape', () => {
    const good = {'demo/test': {root: {order: ['b', 'a'], span: {a: 4}}}};
    expect(createArrangeStore(fakeStorage({[ARRANGE_STORAGE_KEY]: JSON.stringify(good)})).entry(KEY, 'root')).toEqual({order: ['b', 'a'], span: {a: 4}});
    const damaged = {
      'demo/test': {root: {order: ['b', 7, null, 'a'], span: {a: 4, b: 99, c: 'wide', d: 2.5, e: 0}}, bad: 'x', empty: {order: [], span: {}}},
      'demo/list': ['not', 'an', 'object'],
      'demo/none': null,
    };
    const store = createArrangeStore(fakeStorage({[ARRANGE_STORAGE_KEY]: JSON.stringify(damaged)}));
    expect(store.entry(KEY, 'root')).toEqual({order: ['b', 'a'], span: {a: 4}});
    expect(store.entry(KEY, 'bad')).toBeUndefined();
    expect(store.entry(KEY, 'empty')).toBeUndefined();
    expect(store.has('demo/list')).toBe(false);
    for (const text of ['{not json', '[]', '"text"', 'null', '42']) {
      expect(createArrangeStore(fakeStorage({[ARRANGE_STORAGE_KEY]: text})).has(KEY), text).toBe(false);
    }
  });

  it('degrades to memory when storage is missing or throws', () => {
    for (const storage of [null, undefined, fakeStorage({}, true)]) {
      const store: ArrangeStore = createArrangeStore(storage);
      expect(store.has(KEY)).toBe(false);
      store.update(KEY, 'root', {order: ['b', 'a'], span: {}});
      expect(store.entry(KEY, 'root')).toEqual({order: ['b', 'a'], span: {}});
      store.reset(KEY);
      expect(store.has(KEY)).toBe(false);
    }
  });
});

describe('arranging the plates of a container', () => {
  it('leaves cells exactly as specified until someone arranges them', async () => {
    const {view, storage} = mount();
    await view.settle();
    expect(cells(view)).toEqual([['a', '', '6'], ['b', '', '6'], ['c', '', null], ['note', '', null]]);
    expect(storage.writes).toEqual([]);
    // plate headers of an arrangeable container are handles; they say so to assistive technology
    expect(header(view, 'a').tabIndex).toBe(0);
    expect(header(view, 'a').hasAttribute('data-arrange')).toBe(true);
    expect(header(view, 'c').getAttribute('aria-roledescription')).toBe('movable plate');
    expect(view.cell('a').querySelector('.gl-resize')).not.toBeNull();
  });

  it('Alt+Arrow moves a plate within its container and persists the order', async () => {
    const {view, storage, store} = mount();
    await view.settle();
    header(view, 'a').focus();
    alt(header(view, 'a'), 'ArrowRight');
    expect(cells(view)).toEqual([['a', '1', '6'], ['b', '0', '6'], ['c', '2', null], ['note', '3', null]]);
    expect(stored(storage)).toEqual({[KEY]: {root: {order: ['b', 'a', 'c', 'note'], span: {}}}});
    expect(store.has(KEY)).toBe(true);
    expect(document.activeElement).toBe(header(view, 'a'));
    expect(header(view, 'a').querySelector('[role="status"]')?.textContent).toBe('Position 2 of 4');
    alt(header(view, 'a'), 'ArrowDown');
    expect(stored(storage)[KEY].root.order).toEqual(['b', 'c', 'a', 'note']);
    alt(header(view, 'a'), 'ArrowUp');
    alt(header(view, 'a'), 'ArrowLeft');
    // back where the spec put it: nothing is left to remember
    expect(cells(view)).toEqual([['a', '', '6'], ['b', '', '6'], ['c', '', null], ['note', '', null]]);
    expect(stored(storage)).toEqual({});
    expect(store.has(KEY)).toBe(false);
    // at the edge a move is a no-op
    alt(header(view, 'a'), 'ArrowLeft');
    expect(stored(storage)).toEqual({});
  });

  it('Alt+Shift+Left/Right changes the span, from the spec span or the full row, within 1..12, and the row stays full', async () => {
    const {view, storage} = mount();
    await view.settle();
    alt(header(view, 'a'), 'ArrowLeft', true);
    expect(view.cell('a').getAttribute('data-span')).toBe('5');
    expect(view.cell('a').style.getPropertyValue('--gl-span')).toBe('5');
    // the row-mate takes the column: 5 + 7, no hole (D17, V037)
    expect(view.cell('b').getAttribute('data-span')).toBe('7');
    expect(stored(storage)).toEqual({[KEY]: {root: {order: [], span: {a: 5, b: 7}}}});
    expect(header(view, 'a').querySelector('[role="status"]')?.textContent).toBe('Span 5 of 12');
    alt(header(view, 'a'), 'ArrowRight', true);
    alt(header(view, 'a'), 'ArrowRight', true);
    expect(view.cell('a').getAttribute('data-span')).toBe('7');
    expect(view.cell('b').getAttribute('data-span')).toBe('5');
    // a cell without a span is the full row: it cannot get wider, and narrowing starts from 12
    alt(header(view, 'c'), 'ArrowRight', true);
    expect(view.cell('c').getAttribute('data-span')).toBeNull();
    expect(header(view, 'c').querySelector('[role="status"]')?.textContent).toBe('Span 12 of 12');
    alt(header(view, 'c'), 'ArrowLeft', true);
    expect(view.cell('c').getAttribute('data-span')).toBe('11');
    for (let i = 0; i < 20; i++) alt(header(view, 'c'), 'ArrowLeft', true);
    expect(view.cell('c').getAttribute('data-span')).toBe('1');
    // order is untouched by resizing
    expect(cells(view).map(([, order]) => order)).toEqual(['', '', '', '']);
  });

  it('rebalance keeps every row full: what a plate gains or gives up, its row-mates give or take (D17, V037)', () => {
    const span = (spans: Record<string, number>) => (id: string) => spans[id] ?? 12;
    const overview = {kpis: 12, map: 7, langs: 5, deps: 8, side: 4};
    const order = ['kpis', 'map', 'langs', 'deps', 'side'];
    // the verifier's step: "Where the code is" one column wider. Languages gives the column and stays beside it.
    expect(rebalance(order, span(overview), 'map', 8, 12)).toEqual({map: 8, langs: 4});
    // dragged 300 px narrower: Languages takes the columns, no ragged gap at the right
    expect(rebalance(order, span(overview), 'map', 4, 12)).toEqual({map: 4, langs: 8});
    // a row-mate gives columns down to a quarter; past that it moves down to a row it fills, and the plate takes
    // the row
    expect(rebalance(order, span(overview), 'map', 9, 12)).toEqual({map: 9, langs: 3});
    expect(rebalance(order, span(overview), 'map', 10, 12)).toEqual({map: 12, langs: 12});
    // three plates: the last one moves down, the one that stays gets what it leaves over
    expect(rebalance(['a', 'b', 'c'], span({a: 4, b: 4, c: 4}), 'a', 7, 12)).toEqual({a: 7, b: 5, c: 12});
    // a hole in the row is filled first
    expect(rebalance(['a', 'b'], span({a: 4, b: 4}), 'a', 7, 12)).toEqual({a: 7});
    // a plate alone in its row: narrowing pulls the next plate up when that one is alone too
    expect(rebalance(['a', 'b'], span({}), 'a', 8, 12)).toEqual({a: 8, b: 4});
    expect(rebalance(['a', 'b', 'c'], span({b: 6, c: 6}), 'a', 8, 12)).toEqual({a: 8});
    // and nothing for a span it already has, or for an id that is not a child
    expect(rebalance(order, span(overview), 'map', 7, 12)).toEqual({});
    expect(rebalance(order, span(overview), 'nope', 3, 12)).toEqual({});
    // every row of every result is full or a single plate
    for (const [id, to] of [['map', 1], ['map', 11], ['langs', 9], ['deps', 2], ['side', 12], ['kpis', 6]] as const) {
      const next = {...overview, ...rebalance(order, span(overview), id, to, 12)};
      let used = 0;
      const rows: number[] = [];
      for (const other of order) {
        const s = next[other as keyof typeof next];
        if (used + s > 12) { rows.push(used); used = 0; }
        used += s;
      }
      rows.push(used);
      expect(rows.filter(sum => sum !== 12), `${id} -> ${to}`).toEqual(id === 'kpis' ? [6] : []);
    }
  });

  it('relocate keeps every row full when a plate moves to another row (D17)', () => {
    const overview: Record<string, number> = {kpis: 12, map: 7, langs: 5, deps: 8, side: 4, activity: 6, hot: 6, pkgs: 12};
    const order = Object.keys(overview);
    const span = (spans: Record<string, number>) => (id: string) => spans[id] ?? 12;
    const natural = (id: string) => overview[id];
    /** Row sums of an order packed the way the grid packs it. */
    const sums = (ids: readonly string[], spans: Record<string, number>, tracks = 12) => {
      const rows: number[] = [];
      let used = tracks;
      for (const id of ids) {
        const s = spans[id] ?? 12;
        if (used + s > tracks) { rows.push(0); used = 0; }
        rows[rows.length - 1]! += s;
        used += s;
      }
      return rows;
    };

    // The verifier's drag: Hotspots dropped on the left of the module graph joins that row, which shares its 12
    // columns out in proportion; Activity, left alone, takes its whole row. Before: hot alone (6 empty columns), then
    // deps + side, then activity alone (6 empty columns).
    const dropped = relocate(order, span(overview), 'hot', 3, 12, 'deps', natural);
    expect(dropped).toEqual({order: ['kpis', 'map', 'langs', 'hot', 'deps', 'side', 'activity', 'pkgs'], span: {hot: 4, deps: 5, side: 3, activity: 12}});
    expect(sums(dropped.order, {...overview, ...dropped.span})).toEqual([12, 12, 12, 12, 12]);
    // on its right: the same row, in that order
    expect(relocate(order, span(overview), 'hot', 5, 12, 'side', natural).span).toEqual({deps: 5, side: 3, hot: 4, activity: 12});
    // above or below a plate that has a full row of its own, it gets a full row of its own too
    expect(relocate(order, span(overview), 'hot', 7, 12, 'pkgs', natural)).toEqual({order: ['kpis', 'map', 'langs', 'deps', 'side', 'activity', 'pkgs', 'hot'], span: {activity: 12, hot: 12}});

    // The keyboard: Alt+ArrowUp twice. The first step stays inside the row (nothing changes but the order); the
    // second steps over side into the graph's row. Before: deps alone (4 empty columns), hot + side, activity alone.
    let spans = {...overview};
    let ids: readonly string[] = order;
    const step = (id: string, by: number) => {
      const next = relocate(ids, span(spans), id, ids.indexOf(id) + by, 12, undefined, natural);
      spans = {...spans, ...next.span};
      ids = next.order;
      return next.span;
    };
    expect(step('hot', -1)).toEqual({});
    expect(step('hot', -1)).toEqual({deps: 5, hot: 4, side: 3, activity: 12});
    expect(ids.slice(3, 7)).toEqual(['deps', 'hot', 'side', 'activity']);
    expect(sums(ids, spans)).toEqual([12, 12, 12, 12, 12]);
    // and back down: the plates get their spec spans again
    expect(step('hot', 1)).toEqual({});
    expect(step('hot', 1)).toEqual({deps: 8, side: 4, hot: 6, activity: 6});
    expect(ids).toEqual(order);
    // Up to the top, row by row: each row it passes through shares out and gets its spans back after it.
    for (let i = 0; i < 6; i++) step('hot', -1);
    expect(ids).toEqual(['hot', 'kpis', 'map', 'langs', 'deps', 'side', 'activity', 'pkgs']);
    expect([spans.map, spans.langs, spans.deps, spans.side, spans.activity, spans.hot]).toEqual([7, 5, 8, 4, 12, 12]);

    // Every move of every plate, next to either neighbour, leaves every row full.
    for (const id of order) {
      for (let to = 0; to < order.length; to++) {
        const rest = order.filter(other => other !== id);
        for (const beside of [undefined, rest[to - 1], rest[to]]) {
          const moved = relocate(order, span(overview), id, to, 12, beside, natural);
          expect(sums(moved.order, {...overview, ...moved.span}).filter(sum => sum !== 12), `${id} -> ${to} beside ${beside}`).toEqual([]);
        }
      }
    }

    // A grid of equal tracks reflows as before: nothing changes but the order, and its short last row stays.
    expect(relocate(['g1', 'g2', 'g3', 'g4'], () => 1, 'g2', 3, 3)).toEqual({order: ['g1', 'g3', 'g4', 'g2'], span: {}});
    // A plate leaving a full row for the short last one: both rows end full.
    const grid = relocate(['a', 'b', 'c', 'd'], span({a: 1, b: 1, c: 1, d: 2}), 'c', 3, 3);
    expect(grid).toEqual({order: ['a', 'b', 'd', 'c'], span: {a: 2}});
    // A row that cannot give each plate a quarter breaks in two, never between the plate and its neighbour.
    const crowded = relocate(['a', 'b', 'c', 'd', 'e'], span({a: 3, b: 3, c: 3, d: 3, e: 12}), 'e', 2, 12, 'b');
    expect(crowded.order).toEqual(['a', 'b', 'e', 'c', 'd']);
    expect(sums(crowded.order, {a: 3, b: 3, c: 3, d: 3, e: 12, ...crowded.span})).toEqual([12, 12]);
    // nothing for a move that goes nowhere, or for an id that is not a child
    expect(relocate(order, span(overview), 'map', 1, 12)).toEqual({order, span: {}});
    expect(relocate(order, span(overview), 'nope', 1, 12)).toEqual({order, span: {}});
  });

  it('a plate dragged or stepped into another row joins it and every row stays full; stepping back restores the spec (D17)', async () => {
    const spec = `root=Page('T',[map,langs,deps,side,activity,hot,pkgs])
map=Plate('Map',[Text('m')],span=7)
langs=Plate('Langs',[Text('l')],span=5)
deps=Plate('Deps',[Text('d')],span=8)
side=Plate('Side',[Text('s')],span=4)
activity=Plate('Activity',[Text('a')],span=6)
hot=Plate('Hot',[Text('h')],span=6)
pkgs=Plate('Packages',[Text('p')])`;
    const plates = ['map', 'langs', 'deps', 'side', 'activity', 'hot', 'pkgs'];
    /** [id, span] of the plates in the order the page shows them (the DOM follows the visual order). */
    const shown = (view: RenderedSpec) => [...view.container.querySelectorAll<HTMLElement>('.gl-cell[data-id]')]
      .map(cell => cell.getAttribute('data-id')!)
      .filter(id => plates.includes(id))
      .map(id => [id, Number(view.cell(id).getAttribute('data-span') ?? 12)] as const);
    const rows = (view: RenderedSpec) => {
      const out: string[][] = [];
      let used = 12;
      for (const [id, span] of shown(view)) {
        if (used + span > 12) { out.push([]); used = 0; }
        out.at(-1)!.push(`${id} ${span}`);
        used += span;
      }
      return out;
    };
    const mounted = mount(spec);
    const {view} = mounted;
    // The cells laid out on a 960 px grid of 80 px columns and 100 px rows, from their order and spans (after the
    // harness installed its own layout).
    const original = Element.prototype.getBoundingClientRect;
    const box = (left: number, top: number, width: number, height: number) =>
      ({left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({})}) as DOMRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.classList.contains('gl-grid12')) return box(0, 0, 960, 1000);
      const id = this.getAttribute('data-id');
      if (!this.classList.contains('gl-cell') || !id || !plates.includes(id)) return original.call(this);
      let row = 0;
      let used = 0;
      for (const [other, span] of shown(view)) {
        if (used + span > 12) { row++; used = 0; }
        if (other === id) return box(used * 80, row * 100, span * 80, 100);
        used += span;
      }
      return box(0, 0, 0, 0);
    };
    try {
      await view.settle();
      expect(rows(view)).toEqual([['map 7', 'langs 5'], ['deps 8', 'side 4'], ['activity 6', 'hot 6'], ['pkgs 12']]);

      // Hotspots dragged onto the left half of the graph's plate (row 2)
      fireEvent.pointerDown(header(view, 'hot'), {button: 0, clientX: 600, clientY: 210, pointerType: 'mouse'});
      fireEvent.pointerMove(window, {clientX: 100, clientY: 150});
      expect(document.querySelector<HTMLElement>('.gl-drop-marker')!.style.height).toBe('100px');
      fireEvent.pointerUp(window);
      expect(rows(view)).toEqual([['map 7', 'langs 5'], ['hot 4', 'deps 5', 'side 3'], ['activity 12'], ['pkgs 12']]);

      act(() => mounted.store.reset(KEY));
      expect(rows(view)).toEqual([['map 7', 'langs 5'], ['deps 8', 'side 4'], ['activity 6', 'hot 6'], ['pkgs 12']]);

      // Alt+ArrowUp twice: past activity, then past side into the graph's row
      header(view, 'hot').focus();
      alt(header(view, 'hot'), 'ArrowUp');
      expect(rows(view)).toEqual([['map 7', 'langs 5'], ['deps 8', 'side 4'], ['hot 6', 'activity 6'], ['pkgs 12']]);
      alt(header(view, 'hot'), 'ArrowUp');
      expect(rows(view)).toEqual([['map 7', 'langs 5'], ['deps 5', 'hot 4', 'side 3'], ['activity 12'], ['pkgs 12']]);
      expect(header(view, 'hot').querySelector('[role="status"]')?.textContent).toBe('Position 4 of 7');
      // and back: the spec layout again, with nothing left to remember
      alt(header(view, 'hot'), 'ArrowDown');
      alt(header(view, 'hot'), 'ArrowDown');
      expect(rows(view)).toEqual([['map 7', 'langs 5'], ['deps 8', 'side 4'], ['activity 6', 'hot 6'], ['pkgs 12']]);
      expect(stored(mounted.storage)).toEqual({});
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });

  it('a moved plate moves in the DOM too: the focus order and the plate numbers follow what the person sees (V049)', async () => {
    const {view} = mount();
    await view.settle();
    const order = () => [...view.container.querySelectorAll<HTMLElement>('.gl-grid12 > * .gl-cell, .gl-grid12 > .gl-cell')].map(cell => cell.getAttribute('data-id')).filter(id => ['a', 'b', 'c', 'note'].includes(id!));
    expect(order()).toEqual(['a', 'b', 'c', 'note']);
    const head = header(view, 'c');
    head.focus();
    alt(head, 'ArrowUp');
    await view.settle();
    expect(order()).toEqual(['a', 'c', 'b', 'note']);
    // the header that was moved keeps the focus, so the next Alt+Arrow moves it on
    expect(document.activeElement).toBe(header(view, 'c'));
  });

  it('ignores keys without Alt, with other modifiers, and keys pressed inside the header controls', async () => {
    const {view, storage} = mount();
    await view.settle();
    const head = header(view, 'a');
    fireEvent.keyDown(head, {key: 'ArrowRight'});
    fireEvent.keyDown(head, {key: 'ArrowRight', altKey: true, metaKey: true});
    fireEvent.keyDown(head, {key: 'Enter', altKey: true});
    alt(head.querySelector('button')!, 'ArrowRight');
    expect(storage.writes).toEqual([]);
  });

  it('dragging a header past the threshold reorders on drop; a hairline marks the slot', async () => {
    const {view, storage} = mount();
    await view.settle();
    const head = header(view, 'c');
    fireEvent.pointerDown(head, {button: 0, clientX: 100, clientY: 100, pointerType: 'mouse'});
    // under 6 px: still a click
    fireEvent.pointerMove(window, {clientX: 103, clientY: 102});
    expect(document.querySelector('.gl-drop-marker')).toBeNull();
    expect(view.cell('c').hasAttribute('data-dragging')).toBe(false);
    // the fake layout puts every cell at 0,0 with 960 x 600: the upper half means "before"
    fireEvent.pointerMove(window, {clientX: 120, clientY: 120});
    const marker = document.querySelector<HTMLElement>('.gl-drop-marker')!;
    expect(marker.hidden).toBe(false);
    expect(marker.style.height).toBe('1px');
    expect(marker.style.width).toBe('960px');
    expect(view.cell('c').hasAttribute('data-dragging')).toBe(true);
    // the tooltips of the views it passes over stay down meanwhile (kit.css, V049)
    expect(document.documentElement.hasAttribute('data-gl-arranging')).toBe(true);
    expect(storage.writes).toEqual([]);
    fireEvent.pointerUp(window);
    expect(document.documentElement.hasAttribute('data-gl-arranging')).toBe(false);
    expect(document.querySelector('.gl-drop-marker')).toBeNull();
    expect(view.cell('c').hasAttribute('data-dragging')).toBe(false);
    expect(stored(storage)[KEY].root.order).toEqual(['c', 'a', 'b', 'note']);
    expect(cells(view).map(([id, order]) => [id, order])).toEqual([['a', '1'], ['b', '2'], ['c', '0'], ['note', '3']]);
    // the listeners are gone: moving the pointer afterwards does nothing
    fireEvent.pointerMove(window, {clientX: 500, clientY: 500});
    expect(document.querySelector('.gl-drop-marker')).toBeNull();
  });

  it('dropping below the middle of a cell inserts after it; Escape and pointercancel abandon the drag', async () => {
    const {view, storage} = mount();
    await view.settle();
    fireEvent.pointerDown(header(view, 'a'), {button: 0, clientX: 10, clientY: 10, pointerType: 'mouse'});
    fireEvent.pointerMove(window, {clientX: 10, clientY: 500});
    fireEvent.pointerUp(window);
    // every other cell sits in the same fake box, so the nearest is the first one: a lands after b
    expect(stored(storage)[KEY].root.order).toEqual(['b', 'a', 'c', 'note']);

    const writes = storage.writes.length;
    fireEvent.pointerDown(header(view, 'c'), {button: 0, clientX: 10, clientY: 10, pointerType: 'mouse'});
    fireEvent.pointerMove(window, {clientX: 10, clientY: 100});
    expect(document.querySelector('.gl-drop-marker')).not.toBeNull();
    fireEvent.keyDown(window, {key: 'Escape'});
    expect(document.querySelector('.gl-drop-marker')).toBeNull();
    fireEvent.pointerUp(window);
    fireEvent.pointerDown(header(view, 'c'), {button: 0, clientX: 10, clientY: 10, pointerType: 'mouse'});
    fireEvent.pointerMove(window, {clientX: 10, clientY: 100});
    fireEvent.pointerCancel(window);
    expect(view.cell('c').hasAttribute('data-dragging')).toBe(false);
    expect(storage.writes.length).toBe(writes);
  });

  it('does not start a drag from a control in the header, with another button, or by touch', async () => {
    const {view, storage} = mount();
    await view.settle();
    const head = header(view, 'a');
    const attempts: Array<[Element, object]> = [
      [head.querySelector('button')!, {button: 0, pointerType: 'mouse'}],
      [head, {button: 2, pointerType: 'mouse'}],
      [head, {button: 0, pointerType: 'touch'}],
    ];
    for (const [target, init] of attempts) {
      fireEvent.pointerDown(target, {clientX: 10, clientY: 10, ...init});
      fireEvent.pointerMove(window, {clientX: 10, clientY: 400});
      expect(document.querySelector('.gl-drop-marker')).toBeNull();
      fireEvent.pointerUp(window);
    }
    expect(storage.writes).toEqual([]);
  });

  it('dragging the right edge snaps the span to the 12 columns and shows the count', async () => {
    const {view, storage} = mount();
    await view.settle();
    const edge = view.cell('a').querySelector<HTMLElement>('.gl-resize')!;
    expect(edge.hasAttribute('data-resizing')).toBe(false);
    fireEvent.pointerDown(edge, {button: 0, clientX: 480, pointerId: 1});
    expect(edge.hasAttribute('data-resizing')).toBe(true);
    expect(edge.textContent).toBe('6 / 12 COL');
    // the fake container is 960 px wide with no gap: a column is 80 px
    fireEvent.pointerMove(window, {clientX: 330});
    expect(view.cell('a').getAttribute('data-span')).toBe('4');
    expect(view.cell('b').getAttribute('data-span')).toBe('8');
    expect(edge.textContent).toBe('4 / 12 COL');
    // the whole row: the row-mate gets a row of its own, which it fills
    fireEvent.pointerMove(window, {clientX: 5000});
    expect([view.cell('a').getAttribute('data-span'), view.cell('b').getAttribute('data-span')]).toEqual(['12', '12']);
    // every step starts from where the drag started: back at 6 + 6 first, then 1 + 11
    fireEvent.pointerMove(window, {clientX: -50});
    expect([view.cell('a').getAttribute('data-span'), view.cell('b').getAttribute('data-span')]).toEqual(['1', '11']);
    fireEvent.pointerMove(window, {clientX: 720});
    fireEvent.pointerUp(window);
    expect(edge.hasAttribute('data-resizing')).toBe(false);
    expect(stored(storage)).toEqual({[KEY]: {root: {order: [], span: {a: 9, b: 3}}}});
    fireEvent.pointerMove(window, {clientX: 100});
    expect(view.cell('a').getAttribute('data-span')).toBe('9');
  });

  it('restores a stored arrangement, ignores ids that no longer exist and appends new children in spec order', async () => {
    const storage = fakeStorage({[ARRANGE_STORAGE_KEY]: JSON.stringify({[KEY]: {root: {order: ['gone', 'c', 'a'], span: {b: 4, gone: 3}}}})});
    const {view} = mount(SPEC, storage);
    await view.settle();
    // c, a from the stored order; then b and note, which it does not name, in spec order
    expect(cells(view)).toEqual([['a', '1', '6'], ['b', '2', '4'], ['c', '0', null], ['note', '3', null]]);
    expect(storage.writes).toEqual([]);

    // the agent adds a part and removes another: the arrangement adapts without being rewritten
    view.send(buildPatch('test', buildSurface('test', SPEC), `root=Page('T',[fresh,a,c,note])\nfresh=Plate('Fresh',[Text('f')])`));
    await view.settle();
    expect(cells(view, ['fresh', 'a', 'c', 'note'])).toEqual([['fresh', '2', null], ['a', '1', '6'], ['c', '0', null], ['note', '3', null]]);
    // the next change by the person drops what is stale
    alt(header(view, 'fresh'), 'ArrowLeft');
    expect(stored(storage)).toEqual({[KEY]: {root: {order: ['c', 'fresh', 'a', 'note'], span: {}}}});
  });

  it('reset puts every plate of the surface back and clears the storage entry', async () => {
    const {view, storage, store} = mount();
    await view.settle();
    alt(header(view, 'c'), 'ArrowUp');
    alt(header(view, 'a'), 'ArrowLeft', true);
    expect(store.has(KEY)).toBe(true);
    act(() => store.reset(KEY));
    expect(cells(view)).toEqual([['a', '', '6'], ['b', '', '6'], ['c', '', null], ['note', '', null]]);
    expect(stored(storage)).toEqual({});
  });

  it('keeps arrangements of different surfaces and repositories apart', async () => {
    const storage = fakeStorage();
    const store = createArrangeStore(storage);
    const wrapper = (surface: ReactNode) => <ArrangeStoreContext.Provider value={store}>{surface}</ArrangeStoreContext.Provider>;
    const view = renderExpress(SPEC, {wrapper, surfaceId: 'other', meta: {repo: {name: 'acme', root: '/repo', dirty: false}}});
    await view.settle();
    alt(header(view, 'b'), 'ArrowLeft');
    expect(Object.keys(stored(storage))).toEqual(['acme/other']);
  });

  it('works with storage that throws: the arrangement lasts as long as the page', async () => {
    const {view} = mount(SPEC, fakeStorage({}, true));
    await view.settle();
    alt(header(view, 'a'), 'ArrowRight');
    expect(cells(view).map(([id, order]) => [id, order])).toEqual([['a', '1'], ['b', '0'], ['c', '2'], ['note', '3']]);
  });

  it('animates moved cells from where they were (and not under reduced motion)', async () => {
    const {view} = mount();
    await view.settle();
    const calls: Array<[string | null, Keyframe[]]> = [];
    const original = Element.prototype.animate;
    const rects: Record<string, number> = {a: 0, b: 480};
    Element.prototype.animate = function (this: Element, keyframes: Keyframe[]) {
      calls.push([this.getAttribute('data-id'), keyframes]);
      return {} as Animation;
    } as never;
    const rect = Element.prototype.getBoundingClientRect;
    // a and b sit side by side; after the move they have swapped places
    let swapped = false;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const id = this.getAttribute('data-id') ?? '';
      const left = id in rects ? (swapped ? 480 - rects[id]! : rects[id]!) : 0;
      return {left, top: 0, right: left + 480, bottom: 300, width: 480, height: 300, x: left, y: 0, toJSON: () => ({})} as DOMRect;
    };
    try {
      const head = header(view, 'a');
      act(() => {
        fireEvent.keyDown(head, {key: 'ArrowRight', altKey: true});
        swapped = true;
      });
      expect(calls.map(([id]) => id).sort()).toEqual(['a', 'b']);
      expect(calls.find(([id]) => id === 'a')?.[1]).toEqual([{transform: 'translate(-480px, 0px)'}, {transform: 'none'}]);
      expect(calls.find(([id]) => id === 'b')?.[1]).toEqual([{transform: 'translate(480px, 0px)'}, {transform: 'none'}]);
    } finally {
      Element.prototype.animate = original;
      Element.prototype.getBoundingClientRect = rect;
    }
  });
});

describe('which containers arrange', () => {
  it('Section, Grid and Row arrange their own children; Column, Tabs, Plate and Split do not', async () => {
    const spec = `root=Page('T',[sec,grid,row,col,tabs,split])
sec=Section('S',[s1,s2])
s1=Plate('S one',[Text('x')],span=6)
s2=Plate('S two',[Text('x')],span=6)
grid=Grid([g1,g2,g3],'3')
g1=Plate('G one',[inner])
inner=Plate('Nested',[Text('x')])
g2=Plate('G two',[Text('x')])
g3=Plate('G three',[Text('x')])
row=Row([r1,r2])
r1=Plate('R one',[Text('x')])
r2=Plate('R two',[Text('x')])
col=Column([c1])
c1=Plate('C one',[Text('x')])
tabs=Tabs(['One'],[t1])
t1=Plate('T one',[Text('x')])
split=Split(p1,p2)
p1=Plate('P one',[Text('x')])
p2=Plate('P two',[Text('x')])`;
    const {view, storage} = mount(spec);
    await view.settle();
    const arrangeable = (id: string) => header(view, id).hasAttribute('data-arrange');
    expect(['s1', 's2', 'g1', 'g2', 'g3', 'r1', 'r2'].map(arrangeable)).toEqual([true, true, true, true, true, true, true]);
    expect(['inner', 'c1', 't1', 'p1', 'p2'].map(arrangeable)).toEqual([false, false, false, false, false]);
    // such a header is still a stop (Enter collapses the plate), but it is not announced as movable
    expect(header(view, 'c1').getAttribute('aria-roledescription')).toBeNull();
    expect(header(view, 'c1').hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(view.cell('c1').querySelector('.gl-resize')).toBeNull();

    // each container keeps its own entry; a move never leaves the container
    alt(header(view, 's2'), 'ArrowLeft');
    alt(header(view, 'g3'), 'ArrowLeft');
    alt(header(view, 'r1'), 'ArrowRight');
    expect(stored(storage)[KEY]).toEqual({
      sec: {order: ['s2', 's1'], span: {}},
      grid: {order: ['g1', 'g3', 'g2'], span: {}},
      row: {order: ['r2', 'r1'], span: {}},
    });
    expect([view.cell('s1').style.order, view.cell('s2').style.order]).toEqual(['1', '0']);

    // a Grid snaps spans to its own tracks, a Row to flex shares, both starting from 1. In a full row of one-track
    // plates the last one moves down to a row it fills (g1 and g3 come first in the visual order now)
    alt(header(view, 'g1'), 'ArrowRight', true);
    expect(view.cell('g1').getAttribute('data-span')).toBe('2');
    expect(view.cell('g2').getAttribute('data-span')).toBe('3');
    for (let i = 0; i < 5; i++) alt(header(view, 'g1'), 'ArrowRight', true);
    expect(view.cell('g1').getAttribute('data-span')).toBe('3');
    alt(header(view, 'r2'), 'ArrowRight', true);
    expect(view.cell('r2').getAttribute('data-span')).toBe('2');

    // the Section is itself a cell of the Page: its heading moves it
    const heading = screen.getByRole('heading', {level: 2, name: 'S'}).parentElement!;
    expect(heading.hasAttribute('data-arrange')).toBe(true);
    alt(heading, 'ArrowRight');
    expect(stored(storage)[KEY].root.order.slice(0, 2)).toEqual(['grid', 'sec']);
  });
});
