// packages/viewer/test/shell/arrange.test.tsx - human arrangement of cells (design 12.1.A) with a fake storage.
import {act, fireEvent, screen} from '@testing-library/react';
import type {ReactNode} from 'react';
import {describe, expect, it} from 'vitest';
import {ARRANGE_STORAGE_KEY, ArrangeStoreContext, arrangeKey, createArrangeStore, type ArrangeStore} from '../../src/kit/arrange.tsx';
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

  it('Alt+Shift+Left/Right changes the span, from the spec span or the full row, within 1..12', async () => {
    const {view, storage} = mount();
    await view.settle();
    alt(header(view, 'a'), 'ArrowLeft', true);
    expect(view.cell('a').getAttribute('data-span')).toBe('5');
    expect(view.cell('a').style.getPropertyValue('--gl-span')).toBe('5');
    expect(stored(storage)).toEqual({[KEY]: {root: {order: [], span: {a: 5}}}});
    expect(header(view, 'a').querySelector('[role="status"]')?.textContent).toBe('Span 5 of 12');
    alt(header(view, 'a'), 'ArrowRight', true);
    alt(header(view, 'a'), 'ArrowRight', true);
    expect(view.cell('a').getAttribute('data-span')).toBe('7');
    // a cell without a span is the full row: narrowing starts from 12
    alt(header(view, 'c'), 'ArrowRight', true);
    expect(view.cell('c').getAttribute('data-span')).toBe('12');
    alt(header(view, 'c'), 'ArrowLeft', true);
    expect(view.cell('c').getAttribute('data-span')).toBe('11');
    for (let i = 0; i < 20; i++) alt(header(view, 'c'), 'ArrowLeft', true);
    expect(view.cell('c').getAttribute('data-span')).toBe('1');
    // order is untouched by resizing
    expect(cells(view).map(([, order]) => order)).toEqual(['', '', '', '']);
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
    expect(storage.writes).toEqual([]);
    fireEvent.pointerUp(window);
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
    expect(edge.textContent).toBe('4 / 12 COL');
    fireEvent.pointerMove(window, {clientX: 5000});
    expect(view.cell('a').getAttribute('data-span')).toBe('12');
    fireEvent.pointerMove(window, {clientX: -50});
    expect(view.cell('a').getAttribute('data-span')).toBe('1');
    fireEvent.pointerMove(window, {clientX: 720});
    fireEvent.pointerUp(window);
    expect(edge.hasAttribute('data-resizing')).toBe(false);
    expect(stored(storage)).toEqual({[KEY]: {root: {order: [], span: {a: 9}}}});
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

    // a Grid snaps spans to its own tracks, a Row to flex shares, both starting from 1
    alt(header(view, 'g1'), 'ArrowRight', true);
    expect(view.cell('g1').getAttribute('data-span')).toBe('2');
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
