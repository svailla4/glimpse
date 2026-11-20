// packages/viewer/test/shell/shell-review.test.tsx - regression tests for the shell defects the review found
// (session, App, top bar). Each block names its finding (Fnnn) or decision (Dn).
import type {A2uiMessage, EntityRef, LinkStatus} from '@glimpse/catalog';
import {act, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {App} from '../../src/App.tsx';
import {ArrangeStoreContext, arrangeKey, createArrangeStore} from '../../src/kit/arrange.tsx';
import {createViewerSession} from '../../src/shell/session.ts';
import {TopBar, tabLabel, type TopBarProps} from '../../src/shell/TopBar.tsx';
import type {LinkEnd} from '../../src/transport/hub.ts';
import {formatRoute, parseRoute} from '../../src/transport/launch.ts';
import {buildPatch, installLayout} from '../harness.tsx';
import {actionsOf, errorsOf, fakeStorage, info, scriptedTransport, snapshot, type ScriptedTransport} from './scripted.ts';

const V = '1.0' as const;
const file: EntityRef = {type: 'file', id: 'src/a.ts', path: 'src/a.ts'};
const EMPTY_PAGE = `$/rows=[]\nroot=Page('Alpha',[t,l])\nt=Text('alpha text')\nl=List($/rows,title='Todo')`;
const replace = (messages: A2uiMessage[], id: string): A2uiMessage[] => [{version: V, deleteSurface: {surfaceId: id}}, ...messages];

function mount(options: {route?: string; end?: LinkEnd} = {}) {
  installLayout();
  const transport: ScriptedTransport & {linkEnd?: () => LinkEnd | undefined} = scriptedTransport();
  if (options.end) transport.linkEnd = () => options.end;
  const session = createViewerSession(transport, {route: options.route, selectDelay: 0});
  const store = createArrangeStore(fakeStorage());
  const view = render(
    <ArrangeStoreContext.Provider value={store}>
      <App session={session} />
    </ArrangeStoreContext.Provider>,
  );
  return {transport, session, store, ...view};
}
const live = (transport: ScriptedTransport, id: string, spec: string, title = id) => {
  const surface = info(id, title);
  act(() => {
    transport.status('live');
    transport.hello('e1', [surface], id);
    transport.frame(id, snapshot(id, spec), [surface]);
  });
  return surface;
};
const key = (k: string, target: Element | Window = window) => fireEvent.keyDown(target, {key: k});

let scrolls: number[] = [];
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '#');
  scrolls = [];
  vi.spyOn(window, 'scrollTo').mockImplementation(((_x: number, y: number) => {
    scrolls.push(y);
    Object.defineProperty(window, 'scrollY', {configurable: true, value: y});
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(window, 'scrollY', {configurable: true, value: 0});
});

describe('surface ids with hyphens (D2, F031)', () => {
  it('round-trip through the address bar, the session, the tabs and the arrangement key', () => {
    expect(parseRoute(formatRoute('show-call-flow'))).toBe('show-call-flow');
    expect(parseRoute('#/my-view_2')).toBe('my-view_2');
    expect(arrangeKey('demo', 'show-call-flow')).toBe('demo/show-call-flow');
    const {transport, session} = mount({route: 'auth-flow'});
    const a = info('auth-flow', 'Auth flow');
    const b = info('other-view', 'Other');
    act(() => {
      transport.status('live');
      transport.hello('e1', [a, b], 'other-view');
      transport.frame('auth-flow', snapshot('auth-flow', `root=Page('Auth flow',[Text('auth text')])`), [a, b]);
      transport.frame('other-view', snapshot('other-view', `root=Page('Other',[Text('other text')])`), [a, b]);
    });
    // the reload stays on the surface the address bar names
    expect(session.getSnapshot().focus).toBe('auth-flow');
    expect(screen.getByText('auth text')).toBeTruthy();
    expect(window.location.hash).toBe('#/auth-flow');
    fireEvent.click(screen.getByRole('tab', {name: 'Other'}));
    expect(window.location.hash).toBe('#/other-view');
    expect(screen.getByRole('tab', {name: 'Other'}).getAttribute('data-surface')).toBe('other-view');
  });
});

describe('a component state is state, not an event (D14, V051, V060, V061)', () => {
  /** States arrive at the end of the task that rendered them. */
  const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const statesOf = (transport: ScriptedTransport, label: string) => errorsOf(transport.sent).filter(error => error.message.startsWith(`${label}: `)).map(error => error.code);

  it('says the state of every component when it is drawn: OK, or what it shows instead', async () => {
    const {transport} = mount();
    live(transport, 'a', EMPTY_PAGE, 'Alpha');
    await flush();
    expect(statesOf(transport, 'List#l')).toEqual(['W_EMPTY']);
    expect(errorsOf(transport.sent).find(error => error.message.startsWith('List#l: '))).toEqual({code: 'W_EMPTY', message: 'List#l: no items', surfaceId: 'a'});
    expect(statesOf(transport, 'Text#t')).toEqual(['OK']);
    expect(statesOf(transport, 'Page#root')).toEqual(['OK']);
    // one post for the whole first render
    expect(transport.sent.filter(message => 'error' in message)).toHaveLength(3);
    expect(transport.sent.every(message => message.version === '1.0')).toBe(true);
  });

  it('says it again when an update redefines the component and it is still broken: in-place replace, patch, same props', async () => {
    const {transport} = mount();
    const a = live(transport, 'a', EMPTY_PAGE, 'Alpha');
    await flush();
    const base = snapshot('a', EMPTY_PAGE);
    // the model "fixes" the plate by renaming it: still no rows (V051, V061)
    act(() => transport.frame('a', buildPatch('a', base, `l=List($/rows,title='Todo, revised')`), [a]));
    await flush();
    expect(statesOf(transport, 'List#l')).toEqual(['W_EMPTY', 'W_EMPTY']);
    // a definition with exactly the same properties is a definition too: the host forgot, the tab says it again
    act(() => transport.frame('a', buildPatch('a', base, `l=List($/rows,title='Todo, revised')`), [a]));
    await flush();
    expect(statesOf(transport, 'List#l')).toEqual(['W_EMPTY', 'W_EMPTY', 'W_EMPTY']);
    // a component the update does not name says nothing new
    expect(statesOf(transport, 'Text#t')).toEqual(['OK']);
    // a redline that stays a redline, under a new title
    act(() => transport.frame('a', buildPatch('a', base, `l=List('just text',title='Todo')`), [a]));
    await flush();
    act(() => transport.frame('a', buildPatch('a', base, `l=List('just text',title='Todo again')`), [a]));
    await flush();
    expect(statesOf(transport, 'List#l').slice(-2)).toEqual(['E_SHAPE', 'E_SHAPE']);
  });

  it('withdraws a state with OK once the component draws, whatever ended it (V060)', async () => {
    const {transport, session} = mount();
    const a = live(transport, 'a', EMPTY_PAGE, 'Alpha');
    await flush();
    // data arrives: no update names the List, it simply draws now
    act(() => void session.surface('a')?.dataModel.set('/rows', [{title: 'one'}]));
    await flush();
    expect(statesOf(transport, 'List#l')).toEqual(['W_EMPTY', 'OK']);
    // empty again, then fixed by a patch
    act(() => void session.surface('a')?.dataModel.set('/rows', []));
    await flush();
    act(() => transport.frame('a', buildPatch('a', snapshot('a', EMPTY_PAGE), `$/rows=[{title:'two'}]\nl=List($/rows,title='Todo')`), [a]));
    await flush();
    expect(statesOf(transport, 'List#l')).toEqual(['W_EMPTY', 'OK', 'W_EMPTY', 'OK']);
    // the same state rendered again (a re-render, the selection changing) is not posted again
    const before = transport.sent.length;
    act(() => void session.surface('a')?.dataModel.set('/ui/sel', file));
    await flush();
    expect(transport.sent.slice(before).filter(message => 'error' in message)).toEqual([]);
  });

  it('starts over when the surface is replaced, and drops states of a surface the tab does not have', async () => {
    const {transport, session} = mount();
    const a = live(transport, 'a', EMPTY_PAGE, 'Alpha');
    await flush();
    act(() => transport.frame('a', replace(snapshot('a', EMPTY_PAGE), 'a'), [a]));
    await flush();
    expect(statesOf(transport, 'List#l')).toEqual(['W_EMPTY', 'W_EMPTY']);
    const before = transport.sent.length;
    session.reportState({code: 'W_EMPTY', message: 'List#l: x', surfaceId: 'gone', componentId: 'l'});
    await flush();
    expect(transport.sent).toHaveLength(before);
  });

  it('posts nothing once the session has ended', async () => {
    const {transport, session} = mount();
    live(transport, 'a', `root=Page('Alpha',[Text('alpha text')])`);
    await flush();
    act(() => transport.emit({type: 'bye', reason: 'shutdown'}));
    const before = transport.sent.length;
    session.reportState({code: 'W_EMPTY', message: 'Text#t: nothing', surfaceId: 'a', componentId: 't'});
    await flush();
    expect(transport.sent).toHaveLength(before);
  });
});

describe('Escape clears the selection from anywhere on the page (F023)', () => {
  it('clears /ui/sel and tells the host, with the focus on the body', async () => {
    const {transport, session} = mount();
    live(transport, 'a', `root=Page('Alpha',[Text('alpha text')])`);
    act(() => void session.surface('a')?.dataModel.set('/ui', {sel: file, file: 'src/a.ts'}));
    act(() => void key('Escape', document.body));
    expect(session.surface('a')?.dataModel.get('/ui/sel') ?? null).toBeNull();
    // the followed file stays, as it does when a component clears the selection
    expect(session.surface('a')?.dataModel.get('/ui/file')).toBe('src/a.ts');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(actionsOf(transport.sent).at(-1)).toMatchObject({name: 'gl_select', surfaceId: 'a', context: {ref: null}});
    // with nothing selected, Escape posts nothing
    const sent = transport.sent.length;
    act(() => void key('Escape', document.body));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(transport.sent).toHaveLength(sent);
  });

  it('leaves Escape to a field, a menu or a dialog that has the focus, and to whoever already handled it', () => {
    const {transport, session, container} = mount();
    live(transport, 'a', `root=Page('Alpha',[Text('alpha text')])`);
    const selected = () => session.surface('a')?.dataModel.get('/ui/sel');
    act(() => void session.surface('a')?.dataModel.set('/ui/sel', file));
    const input = document.createElement('input');
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    container.append(input, menu);
    act(() => void key('Escape', input));
    act(() => void key('Escape', menu));
    expect(selected()).toEqual(file);
    const handled = (event: Event) => event.preventDefault();
    document.body.addEventListener('keydown', handled);
    act(() => void key('Escape', document.body));
    document.body.removeEventListener('keydown', handled);
    expect(selected()).toEqual(file);
    // a grid or a tree passes it on
    const grid = document.createElement('div');
    grid.setAttribute('role', 'grid');
    container.append(grid);
    act(() => void key('Escape', grid));
    expect(selected() ?? null).toBeNull();
  });
});

describe('where the page is scrolled belongs to the view (F091)', () => {
  it('a view the agent shows opens at the top; a patch of the view on screen does not scroll; going back restores', () => {
    const {transport} = mount();
    const a = live(transport, 'a', `root=Page('Alpha',[Text('alpha text')])`, 'Alpha');
    expect(scrolls).toEqual([0]);
    // the person scrolls down the overview
    Object.defineProperty(window, 'scrollY', {configurable: true, value: 900});
    fireEvent.scroll(window);
    // a patch of the focused surface: no scrolling
    act(() => transport.frame('a', [{version: V, updateDataModel: {surfaceId: 'a', path: '/x', value: 1}}], [a]));
    expect(scrolls).toEqual([0]);
    // the agent shows another view
    const b = info('b', 'Beta');
    act(() => transport.frame('b', snapshot('b', `root=Page('Beta',[Text('beta text')])`), [a, b], 'b'));
    expect(screen.getByText('beta text')).toBeTruthy();
    expect(scrolls).toEqual([0, 0]);
    expect(window.scrollY).toBe(0);
    // back to the first view by hand: where it was left
    fireEvent.click(screen.getByRole('tab', {name: 'Alpha'}));
    expect(scrolls.at(-1)).toBe(900);
    // the agent replaces that view: it is a new view, from the top
    act(() => transport.frame('a', replace(snapshot('a', `root=Page('Alpha 2',[Text('second text')])`), 'a'), [a, b], 'a'));
    expect(screen.getByText('second text')).toBeTruthy();
    expect(scrolls.at(-1)).toBe(0);
  });
});

describe('why the link ended (F025)', () => {
  const ended = (end: LinkEnd | undefined, withView: boolean) => {
    const view = mount({end});
    if (withView) live(view.transport, 'a', `root=Page('Alpha',[Text('alpha text')])`);
    act(() => view.transport.status('ended'));
    const banner = view.container.querySelector<HTMLElement>('[data-gl-banner="ended"]')!;
    return {...view, banner};
  };

  it('says so when the host refused this tab because it serves enough tabs already', () => {
    const {banner, container, session} = ended({reason: 'refused', tabs: 8}, false);
    expect(banner.getAttribute('data-reason')).toBe('refused');
    expect(banner.textContent).toBe('This session already has 8 viewer tabs open, the most it serves. Close one of them, then reload this tab.');
    expect(container.querySelector('[data-gl-state="empty"]')?.textContent).toBe('no view to show');
    expect(session.getSnapshot().end).toEqual({reason: 'refused', tabs: 8});
  });

  it('tells a wrong token and a host that is gone apart from a session that ended', () => {
    expect(ended({reason: 'unauthorized'}, false).banner.textContent).toContain('does not belong to the running session');
    expect(ended({reason: 'unreachable'}, false).banner.textContent).toContain('No Glimpse session answers');
    const closed = ended({reason: 'closed'}, true);
    expect(closed.banner.textContent).toBe('Session ended. This is a snapshot.');
    expect(screen.getAllByText('alpha text').length).toBeGreaterThan(0);
    // a transport that cannot say why (fixtures, tests) reads as before
    expect(ended(undefined, false).banner.textContent).toBe('Session ended. This is a snapshot.');
  });

  it('explains a stream that stays queued behind the browser\'s connection limit', () => {
    vi.useFakeTimers();
    const {container, transport} = mount();
    expect(container.querySelector('[data-gl-banner="slow"]')).toBeNull();
    act(() => void vi.advanceTimersByTime(6100));
    expect(container.querySelector('[data-gl-banner="slow"]')?.textContent).toContain('close some of them');
    act(() => transport.status('live'));
    expect(container.querySelector('[data-gl-banner="slow"]')).toBeNull();
  });

  it('components learn the link status from the kit', () => {
    const statuses: LinkStatus[] = [];
    const {transport, session} = mount();
    live(transport, 'a', `root=Page('Alpha',[Text('alpha text')])`);
    statuses.push(session.getSnapshot().status);
    act(() => transport.emit({type: 'bye', reason: 'shutdown'}));
    statuses.push(session.getSnapshot().status);
    expect(statuses).toEqual(['live', 'ended']);
  });
});

describe('selection in a snapshot is restored (F082)', () => {
  it('a reload or a second tab starts with what the host says is selected', () => {
    const {transport, session} = mount();
    const a = info('a', 'Alpha');
    const messages = snapshot('a', `root=Page('Alpha',[Text('alpha text')])`);
    const create = messages[0]!;
    if (!('createSurface' in create)) throw new Error('expected a createSurface snapshot');
    create.createSurface.dataModel = {...create.createSurface.dataModel, ui: {sel: file, file: 'src/a.ts'}};
    act(() => {
      transport.status('live');
      transport.hello('e1', [a], 'a');
      transport.frame('a', messages, [a]);
    });
    expect(session.surface('a')?.dataModel.get('/ui')).toEqual({sel: file, file: 'src/a.ts'});
    // and the host's word wins over what this tab carried, when it replaces the surface with one
    act(() => void session.surface('a')?.dataModel.set('/ui/sel', {type: 'file', id: 'old.ts', path: 'old.ts'}));
    act(() => transport.frame('a', replace(structuredClone(messages), 'a'), [a]));
    expect(session.surface('a')?.dataModel.get('/ui/sel')).toEqual(file);
  });
});

describe('top bar (F011)', () => {
  const props = (over: Partial<TopBarProps> = {}): TopBarProps => ({
    surfaces: [], focus: undefined, status: 'live', repo: 'demo', theme: 'auto', scheme: 'light', density: 'compact', arranged: false,
    onFocus: () => {}, onClose: () => {}, onRefresh: () => {}, onResetLayout: () => {}, onToggleTheme: () => {}, onToggleDensity: () => {},
    ...over,
  });

  it('a title that is a path keeps its file name, with the whole path as the name and the tooltip', () => {
    const path = 'typescript/core/web_core/src/resolution/generic-binder.ts';
    expect(tabLabel({id: 'file', title: path})).toBe('…/generic-binder.ts');
    expect(tabLabel({id: 'file', title: 'src/a.ts'})).toBe('src/a.ts');
    expect(tabLabel({id: 'x', title: 'Changes HEAD~8..HEAD'})).toBe('Changes HEAD~8..HEAD');
    expect(tabLabel({id: 'x', title: 'either/or thinking'})).toBe('either/or thinking');
    expect(tabLabel({id: 'my-view', title: ''})).toBe('my-view');
    render(<TopBar {...props({surfaces: [info('file', path)], focus: 'file'})} />);
    const tab = screen.getByRole('tab', {name: path});
    expect(tab.textContent).toBe('…/generic-binder.ts');
    expect(tab.title).toBe(path);
  });

  it('brings the active tab into view, fades the clipped side and lists the tabs out of sight under +N', () => {
    // a 300 px strip over nine 100 px tabs
    const surfaces = Array.from({length: 9}, (_, i) => info(`s${i}`, `View ${i}`));
    const strip = {left: 0, width: 300, scrollLeft: 0};
    const rect = (left: number, width: number) => ({x: left, y: 0, left, top: 0, right: left + width, bottom: 32, width, height: 32, toJSON: () => ({})});
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.getAttribute('role') === 'tablist') return rect(strip.left, strip.width);
      const tab = this.getAttribute('role') === 'tab' ? this : this.querySelector('[role="tab"]');
      const index = surfaces.findIndex(surface => surface.id === (tab as HTMLElement | null)?.dataset.surface);
      return index < 0 ? rect(0, 0) : rect(index * 100 - strip.scrollLeft, 100);
    });
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => 900);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => strip.width);
    vi.spyOn(HTMLElement.prototype, 'scrollLeft', 'get').mockImplementation(() => strip.scrollLeft);
    vi.spyOn(HTMLElement.prototype, 'scrollLeft', 'set').mockImplementation((value: number) => { strip.scrollLeft = Math.max(0, Math.min(600, value)); });

    const onFocus = vi.fn();
    const view = render(<TopBar {...props({surfaces, focus: 's0', onFocus})} />);
    const tabs = screen.getByRole('tablist');
    const more = () => view.container.querySelector<HTMLButtonElement>('[data-gl-more]');
    expect([tabs.hasAttribute('data-clip-start'), tabs.hasAttribute('data-clip-end')]).toEqual([false, true]);
    expect(more()?.textContent).toBe('+6');
    // the agent shows the eighth view: its tab scrolls in, with room for the fade
    view.rerender(<TopBar {...props({surfaces, focus: 's7', onFocus})} />);
    expect(strip.scrollLeft).toBe(524);
    fireEvent.scroll(tabs);
    expect([tabs.hasAttribute('data-clip-start'), tabs.hasAttribute('data-clip-end')]).toEqual([true, true]);
    // the views out of sight are one click away
    fireEvent.click(more()!);
    const items = screen.getAllByRole('menuitem');
    expect(items.map(item => item.textContent)).toEqual(['View 0', 'View 1', 'View 2', 'View 3', 'View 4', 'View 5', 'View 8']);
    expect(more()!.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(items[1]!);
    expect(onFocus).toHaveBeenCalledWith('s1');
    expect(screen.queryByRole('menu')).toBeNull();
    // Escape closes it without reaching the page
    fireEvent.click(more()!);
    const pressed = new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true});
    act(() => void window.dispatchEvent(pressed));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(pressed.defaultPrevented).toBe(true);
  });

  it('shows no +N and no fade while every tab fits', () => {
    installLayout();
    const view = render(<TopBar {...props({surfaces: [info('a', 'Alpha'), info('b', 'Beta')], focus: 'a'})} />);
    expect(view.container.querySelector('[data-gl-more]')).toBeNull();
    expect(screen.getByRole('tablist').hasAttribute('data-clip-end')).toBe(false);
  });

  /** Nine 100 px tabs in a strip whose width the test sets; the strip's ResizeObserver fires when the test says. */
  function resizableStrip(surfaces: ReturnType<typeof info>[]) {
    const strip = {width: 900, scrollLeft: 0};
    const rect = (left: number, width: number) => ({x: left, y: 0, left, top: 0, right: left + width, bottom: 32, width, height: 32, toJSON: () => ({})});
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.getAttribute('role') === 'tablist') return rect(0, strip.width);
      const tab = this.getAttribute('role') === 'tab' ? this : this.querySelector('[role="tab"]');
      const index = surfaces.findIndex(surface => surface.id === (tab as HTMLElement | null)?.dataset.surface);
      return index < 0 ? rect(0, 0) : rect(index * 100 - strip.scrollLeft, 100);
    });
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => 900);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => strip.width);
    vi.spyOn(HTMLElement.prototype, 'scrollLeft', 'get').mockImplementation(() => strip.scrollLeft);
    vi.spyOn(HTMLElement.prototype, 'scrollLeft', 'set').mockImplementation((value: number) => { strip.scrollLeft = Math.max(0, Math.min(900 - strip.width, value)); });
    const callbacks: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class {
      private readonly run: () => void;
      constructor(callback: () => void) { this.run = callback; }
      observe() { callbacks.push(this.run); }
      unobserve() {}
      disconnect() {}
    });
    const resize = (width: number) => {
      strip.width = width;
      act(() => { for (const run of callbacks) run(); });
    };
    return {strip, resize};
  }

  it('keeps the active tab in sight when the window gets narrower (V044)', () => {
    const surfaces = Array.from({length: 9}, (_, i) => info(`s${i}`, `View ${i}`));
    const {strip, resize} = resizableStrip(surfaces);
    render(<TopBar {...props({surfaces, focus: 's7'})} />);
    expect(strip.scrollLeft).toBe(0);
    // 1440 px -> 760 px: the strip is 300 px now, and the active tab was at 700..800
    resize(300);
    vi.unstubAllGlobals();
    expect(strip.scrollLeft).toBe(524);
    const box = screen.getByRole('tab', {name: 'View 7'}).getBoundingClientRect();
    expect([box.left >= 0, box.right <= 300]).toEqual([true, true]);
  });

  it('a long file path keeps its file name even when the host cut the title (V044)', () => {
    const path = 'eval/iterative_format_optimizer/history/atom/run_039_0fcabd8b_ast_implicit_string_child_autowrap/patch.diff';
    const cut = path.slice(0, 80);
    expect(tabLabel({id: 'file', title: cut, view: `file ${path}`})).toBe('…/patch.diff');
    expect(tabLabel({id: 'file', title: cut, view: `file ${path}#L10-20`})).toBe('…/patch.diff');
    // a title the model wrote is its own, whatever the call
    expect(tabLabel({id: 'x', title: 'Overview', view: 'overview'})).toBe('Overview');
    expect(tabLabel({id: 'x', title: 'Auth', view: 'tree src/auth'})).toBe('Auth');
    render(<TopBar {...props({surfaces: [{...info('file', cut), view: `file ${path}`}], focus: 'file'})} />);
    expect(screen.getByRole('tab', {name: path}).textContent).toBe('…/patch.diff');
  });

  it('the +N menu closes for good when every tab fits again: Escape is not swallowed, and it does not reopen (V064)', () => {
    const surfaces = Array.from({length: 9}, (_, i) => info(`s${i}`, `View ${i}`));
    const {resize} = resizableStrip(surfaces);
    const view = render(<TopBar {...props({surfaces, focus: 's0'})} />);
    resize(300);
    fireEvent.click(view.container.querySelector('[data-gl-more]')!);
    expect(screen.queryByRole('menu')).not.toBeNull();
    // the window gets wide: no tab is hidden, the menu and its button go
    resize(900);
    expect(view.container.querySelector('[data-gl-more]')).toBeNull();
    const pressed = new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true});
    act(() => void window.dispatchEvent(pressed));
    expect(pressed.defaultPrevented).toBe(false);
    // and narrow again, with no click: the menu stays closed
    resize(300);
    vi.unstubAllGlobals();
    expect(view.container.querySelector('[data-gl-more]')).not.toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
