// packages/viewer/test/shell/app.test.tsx - the shell of design 8.3 over a scripted transport.
import {act, fireEvent, render, screen, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {App} from '../../src/App.tsx';
import {ARRANGE_STORAGE_KEY, ArrangeStoreContext, createArrangeStore} from '../../src/kit/arrange.tsx';
import {createViewerSession} from '../../src/shell/session.ts';
import {installLayout} from '../harness.tsx';
import {actionsOf, errorsOf, fakeStorage, info, scriptedTransport, snapshot, type ScriptedTransport} from './scripted.ts';

const PAGE_A = `root=Page('Alpha',[t])\nt=Text('alpha text')`;
const PAGE_B = `root=Page('Beta',[t])\nt=Text('beta text')`;

function mount(options: {route?: string; storage?: ReturnType<typeof fakeStorage>} = {}) {
  installLayout();
  const transport = scriptedTransport();
  const session = createViewerSession(transport, {route: options.route});
  const store = createArrangeStore(options.storage ?? fakeStorage());
  const view = render(
    <ArrangeStoreContext.Provider value={store}>
      <App session={session} />
    </ArrangeStoreContext.Provider>,
  );
  return {transport, session, store, ...view};
}

/** Two surfaces, the second one focused by the host. */
function twoSurfaces(transport: ScriptedTransport) {
  const a = info('a', 'Alpha');
  const b = info('b', 'Beta');
  act(() => {
    transport.status('live');
    transport.hello('e1', [a, b], 'b');
    transport.frame('a', snapshot('a', PAGE_A), [a, b]);
    transport.frame('b', snapshot('b', PAGE_B), [a, b]);
  });
  return {a, b};
}
const tab = (name: string) => screen.getByRole('tab', {name});
const key = (k: string, target: Element | Window = window) => fireEvent.keyDown(target, {key: k});

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '#');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
});
afterEach(() => {
  document.title = '';
});

describe('App shell', () => {
  it('connects on mount and shows what it is waiting for', () => {
    const {transport, container, unmount} = mount();
    expect(transport.connections).toBe(1);
    expect(container.querySelector('[data-gl-state="drafting"]')?.textContent).toBe('connecting to the session');
    expect(screen.getByRole('status', {name: ''}).textContent).toContain('connecting');
    act(() => {
      transport.status('live');
      transport.hello('e1', []);
    });
    expect(container.querySelector('[data-gl-state="empty"]')?.textContent).toContain('no views yet');
    // a surface the host lists before its snapshot arrives
    const a = info('a', 'Alpha');
    act(() => transport.hello('e1', [a]));
    expect(container.querySelector('[data-gl-state="drafting"]')?.textContent).toBe('drafting Alpha');
    unmount();
    expect(transport.disconnections).toBe(1);
  });

  it('shows one tab per surface and mounts only the focused one', () => {
    const {transport, container} = mount();
    twoSurfaces(transport);
    expect(screen.getAllByRole('tab').map(el => el.textContent)).toEqual(['Alpha', 'Beta']);
    expect(tab('Beta').getAttribute('aria-selected')).toBe('true');
    expect(tab('Alpha').getAttribute('aria-selected')).toBe('false');
    expect(container.querySelectorAll('[data-gl="Page"]')).toHaveLength(1);
    expect(screen.getByText('beta text')).toBeTruthy();
    expect(screen.queryByText('alpha text')).toBeNull();
    expect(screen.getByRole('heading', {level: 1}).textContent).toBe('Beta');
    expect(document.title).toBe('Beta · Glimpse');
    expect(window.location.hash).toBe('#/b');

    fireEvent.click(tab('Alpha'));
    expect(screen.getByText('alpha text')).toBeTruthy();
    expect(screen.queryByText('beta text')).toBeNull();
    expect(window.location.hash).toBe('#/a');
    expect(errorsOf(transport.sent)).toEqual([]);
  });

  it('starts on the surface the address bar names', () => {
    const {transport} = mount({route: 'a'});
    twoSurfaces(transport);
    expect(tab('Alpha').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('alpha text')).toBeTruthy();
  });

  it('[ and ] switch surfaces, arrow keys move along the tab strip, and a #/id link is followed', () => {
    const {transport} = mount();
    twoSurfaces(transport);
    key(']');
    expect(tab('Alpha').getAttribute('aria-selected')).toBe('true');
    key('[');
    expect(tab('Beta').getAttribute('aria-selected')).toBe('true');
    key('[');
    expect(tab('Alpha').getAttribute('aria-selected')).toBe('true');

    tab('Alpha').focus();
    key('ArrowRight', tab('Alpha'));
    expect(tab('Beta').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('Beta'));
    key('Home', tab('Beta'));
    expect(document.activeElement).toBe(tab('Alpha'));

    act(() => {
      window.history.replaceState(null, '', '#/b');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(tab('Beta').getAttribute('aria-selected')).toBe('true');
  });

  // Review finding (swap round): with more than 12 views shown, following #/overview showed another view under the
  // address #/overview, and nothing said the overview had been dropped.
  it('a #/id link to a view the session no longer holds says so, keeps the address, and a tab or ] leaves it', () => {
    const {transport, container} = mount();
    twoSurfaces(transport);
    act(() => {
      window.history.replaceState(null, '', '#/overview');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    const notice = container.querySelector('[data-gl-state="empty"]');
    expect(notice?.textContent).toContain('view “overview” is no longer open');
    expect(notice?.textContent).toContain('ask the agent to show it again, or pick a view above');
    expect(window.location.hash).toBe('#/overview');
    expect(container.querySelectorAll('[data-gl="Page"]')).toHaveLength(0);
    expect(screen.queryByText('beta text')).toBeNull();
    expect(screen.getAllByRole('tab').filter(el => el.getAttribute('aria-selected') === 'true')).toEqual([]);
    // the strip stays reachable with Tab
    expect(tab('Alpha').tabIndex).toBe(0);
    expect(tab('Beta').tabIndex).toBe(-1);
    expect(document.title).toBe('Glimpse');
    key(']');
    expect(tab('Alpha').getAttribute('aria-selected')).toBe('true');
    expect(window.location.hash).toBe('#/a');
    expect(container.querySelector('[data-gl-state="empty"]')).toBeNull();

    act(() => {
      window.history.replaceState(null, '', '#/overview');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    fireEvent.click(tab('Beta'));
    expect(screen.getByText('beta text')).toBeTruthy();
    expect(window.location.hash).toBe('#/b');
  });

  it('a tab opened or reloaded on a view the host no longer holds says so', () => {
    const {transport, container} = mount({route: 'overview'});
    window.history.replaceState(null, '', '#/overview');
    const {a, b} = twoSurfaces(transport);
    expect(container.querySelector('[data-gl-state="empty"]')?.textContent).toContain('view “overview” is no longer open');
    expect(window.location.hash).toBe('#/overview');
    // the agent shows a view: it replaces the notice
    const c = info('c', 'Gamma');
    act(() => transport.frame('c', snapshot('c', `root=Page('Gamma',[Text('gamma text')])`), [a, b, c], 'c'));
    expect(screen.getByText('gamma text')).toBeTruthy();
    expect(window.location.hash).toBe('#/c');
  });

  it('t toggles the theme and d the density, on <html> and in localStorage', () => {
    const {transport} = mount();
    twoSurfaces(transport);
    const root = document.documentElement;
    expect(root.getAttribute('data-theme')).toBe('auto');
    expect(root.getAttribute('data-density')).toBe('compact');
    key('t');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem('glimpse.theme')).toBe('dark');
    key('t');
    expect(root.getAttribute('data-theme')).toBe('auto');
    key('d');
    expect(root.getAttribute('data-density')).toBe('comfortable');
    expect(window.localStorage.getItem('glimpse.density')).toBe('comfortable');
    fireEvent.click(screen.getByRole('button', {name: 'Compact density'}));
    expect(root.getAttribute('data-density')).toBe('compact');
    fireEvent.click(screen.getByRole('button', {name: 'Dark theme'}));
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByRole('button', {name: 'Light theme'})).toBeTruthy();
  });

  it('leaves keys alone while the person is typing or holding a modifier', () => {
    const {transport, container} = mount();
    twoSurfaces(transport);
    const field = document.createElement('input');
    const tree = document.createElement('div');
    tree.setAttribute('role', 'tree');
    container.append(field, tree);
    key('t', field);
    key('d', tree);
    key(']', field);
    fireEvent.keyDown(window, {key: 't', metaKey: true});
    fireEvent.keyDown(window, {key: 'd', ctrlKey: true});
    expect(document.documentElement.getAttribute('data-theme')).toBe('auto');
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
    expect(tab('Beta').getAttribute('aria-selected')).toBe('true');
  });

  it('remembers the theme of an earlier visit', () => {
    window.localStorage.setItem('glimpse.theme', 'light');
    window.localStorage.setItem('glimpse.density', 'comfortable');
    mount();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-density')).toBe('comfortable');
  });

  it('closing a tab and refreshing are host actions', async () => {
    const {transport} = mount();
    twoSurfaces(transport);
    fireEvent.click(screen.getByRole('button', {name: 'Close Alpha'}));
    fireEvent.click(screen.getByRole('button', {name: 'Refresh data'}));
    await act(async () => {});
    expect(actionsOf(transport.sent).map(action => [action.name, action.surfaceId, action.sourceComponentId])).toEqual([
      ['gl_close', 'a', 'root'],
      ['gl_refresh', 'b', 'root'],
    ]);
  });

  it('a replaced surface is mounted again and keeps its selection', () => {
    const {transport, session} = mount();
    const {a, b} = twoSurfaces(transport);
    act(() => void session.surface('b')?.dataModel.set('/ui/file', 'src/a.ts'));
    act(() => transport.frame('b', [{version: '1.0', deleteSurface: {surfaceId: 'b'}}, ...snapshot('b', `root=Page('Beta 2',[t])\nt=Text('second text')`)], [a, b]));
    expect(screen.getByRole('heading', {level: 1}).textContent).toBe('Beta 2');
    expect(screen.getByText('second text')).toBeTruthy();
    expect(screen.queryByText('beta text')).toBeNull();
    expect(session.surface('b')?.dataModel.get('/ui/file')).toBe('src/a.ts');
  });

  it('a new epoch replaces everything on screen', () => {
    const {transport, container} = mount();
    twoSurfaces(transport);
    const c = info('c', 'Gamma');
    act(() => {
      transport.hello('e2', [c], 'c');
      transport.frame('c', snapshot('c', `root=Page('Gamma',[Text('gamma text')])`), [c]);
    });
    expect(screen.getAllByRole('tab').map(el => el.textContent)).toEqual(['Gamma']);
    expect(screen.getByText('gamma text')).toBeTruthy();
    expect(container.querySelectorAll('[data-gl="Page"]')).toHaveLength(1);
  });

  it('bye shows the session-ended banner and keeps the last pixels', () => {
    const {transport, container} = mount();
    twoSurfaces(transport);
    expect(container.querySelector('[data-gl-banner]')).toBeNull();
    act(() => transport.emit({type: 'bye', reason: 'shutdown'}));
    expect(container.querySelector('[data-gl-banner="ended"]')?.textContent).toBe('Session ended. This is a snapshot.');
    expect(screen.getByText('beta text')).toBeTruthy();
    // a dead session offers nothing that needs the host
    expect(screen.queryByRole('button', {name: 'Close Beta'})).toBeNull();
    expect(screen.queryByRole('button', {name: 'Refresh data'})).toBeNull();
    // the other snapshot is still there to look at
    fireEvent.click(tab('Alpha'));
    expect(screen.getByText('alpha text')).toBeTruthy();
  });

  it('puts a surface whose root is not a Page on the page grid, without a masthead', () => {
    const {transport, container} = mount();
    const a = info('a', 'Bare');
    act(() => {
      transport.hello('e1', [a]);
      transport.frame('a', snapshot('a', `root=Column([Text('bare text')])`), [a]);
    });
    const page = container.querySelector('.gl-page');
    expect(page?.hasAttribute('data-bare')).toBe(true);
    expect(page?.querySelector(':scope > .gl-grid12 [data-gl="Column"]')).not.toBeNull();
    expect(screen.queryByRole('heading', {level: 1})).toBeNull();
    expect(screen.getByText('bare text')).toBeTruthy();
  });

  it('offers "Reset layout" only while the focused surface is rearranged', () => {
    const storage = fakeStorage({[ARRANGE_STORAGE_KEY]: JSON.stringify({'demo/a': {root: {order: [], span: {t: 6}}}})});
    const {transport, store} = mount({storage});
    twoSurfaces(transport);
    // the focused surface is b: nothing to reset
    expect(screen.queryByRole('button', {name: /Reset layout/})).toBeNull();
    fireEvent.click(tab('Alpha'));
    const reset = screen.getByRole('button', {name: /Reset layout/});
    expect(screen.getByText('alpha text').closest('.gl-cell')?.getAttribute('data-span')).toBe('6');
    fireEvent.click(reset);
    expect(screen.queryByRole('button', {name: /Reset layout/})).toBeNull();
    expect(store.has('demo/a')).toBe(false);
    expect(JSON.parse(storage.values.get(ARRANGE_STORAGE_KEY) ?? 'null')).toEqual({});
    expect(screen.getByText('alpha text').closest('.gl-cell')?.hasAttribute('data-span')).toBe(false);
  });

  it('names the repository and the link state next to the connection dot', () => {
    const {transport} = mount();
    twoSurfaces(transport);
    const link = screen.getByTitle('Session live');
    expect(within(link).getByText('demo')).toBeTruthy();
    expect(within(link).getByText('live')).toBeTruthy();
    act(() => transport.status('connecting'));
    expect(screen.getByTitle('Session connecting')).toBeTruthy();
  });
});
