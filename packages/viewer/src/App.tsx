// packages/viewer/src/App.tsx
// The shell (design 8.3): a top bar with one tab per surface over the focused surface. Only the focused surface is
// mounted. Keys: `[` and `]` switch surfaces, `t` toggles the theme, `d` the density, Escape clears the selection.
import {useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type JSX} from 'react';
import {arrangeKey, useArrangeStore} from './kit/arrange.tsx';
import {Drafting, Empty, KitProvider} from './kit/index.ts';
import {applyPrefs, loadPrefs, savePrefs, schemeOf, systemScheme, toggleDensity, toggleTheme, type Prefs} from './shell/prefs.ts';
import {surfaceRepoName, type SessionSnapshot, type ViewerSession} from './shell/session.ts';
import css from './shell/Shell.module.css';
import {SurfaceView} from './shell/SurfaceView.tsx';
import {TopBar} from './shell/TopBar.tsx';
import {isTokenFragment, parseRoute, showRoute} from './transport/launch.ts';

/** Where a typed character belongs to the focused control (a field, a list with type-ahead), not to the shell. */
const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="tree"], [role="treegrid"], [role="grid"], [role="listbox"], [role="menu"]';
/** Where Escape belongs to the focused control: it leaves a field, closes a menu or a dialog. Lists and grids pass it on. */
const ESCAPABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="menu"], [role="dialog"], dialog';
/** A stream that has not opened after this long is probably waiting behind the browser's connection limit. */
const SLOW_CONNECT_MS = 6000;

function useSystemScheme(): 'light' | 'dark' {
  const subscribe = useCallback((notify: () => void) => {
    if (typeof matchMedia !== 'function') return () => {};
    const query = matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', notify);
    return () => query.removeEventListener('change', notify);
  }, []);
  return useSyncExternalStore(subscribe, systemScheme);
}

/** What the banner under the top bar says once the link has ended: why, and what to do about it. */
function endedText(end: SessionSnapshot['end']): string {
  switch (end?.reason) {
    case 'refused':
      return `This session already has ${end.tabs ?? 'the most'} viewer tabs open${end.tabs === undefined ? ' it serves' : ', the most it serves'}. Close one of them, then reload this tab.`;
    case 'unauthorized':
      return 'This link does not belong to the running session. Ask your agent to show a view again and open the link it prints.';
    case 'unreachable':
      return 'No Glimpse session answers at this address any more. Ask your agent to show a view again.';
    default:
      return 'Session ended. This is a snapshot.';
  }
}

const scrollTop = (y: number) => {
  try {
    window.scrollTo(0, y);
  } catch {
    // a document without a view (tests, a detached frame) has nothing to scroll
  }
};

export function App(p: {session: ViewerSession}): JSX.Element {
  const {session} = p;
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const system = useSystemScheme();
  const store = useArrangeStore();

  useEffect(() => session.start(), [session]);
  useEffect(() => {
    applyPrefs(prefs);
    savePrefs(prefs);
  }, [prefs]);

  const {focus, surfaces, status} = state;
  const info = surfaces.find(surface => surface.id === focus);
  const surface = focus === undefined ? undefined : session.surface(focus);
  const repo = surfaceRepoName(surface) ?? state.session?.repo?.name;
  const layoutKey = surface ? arrangeKey(surfaceRepoName(surface), surface.id) : undefined;
  const arranged = useSyncExternalStore(store.subscribe, () => layoutKey !== undefined && store.has(layoutKey));

  // The address bar names the surface on screen, and following a `#/<surfaceId>` link switches to it.
  useEffect(() => {
    if (focus !== undefined) showRoute(focus);
  }, [focus]);
  useEffect(() => {
    const onHashChange = () => {
      // A link with a token pasted into this tab belongs to another session: start over with it.
      if (isTokenFragment(window.location.hash)) return window.location.reload();
      const route = parseRoute(window.location.hash);
      if (route !== undefined) session.focus(route);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [session]);
  useEffect(() => {
    document.title = info ? `${info.title || info.id} · Glimpse` : 'Glimpse';
  }, [info]);

  // Where the page is scrolled belongs to the view on screen. A view the agent has just shown (a new surface, or
  // one it replaced) opens at its top; going back to a view that is still the same object returns to where it was
  // left. A patch of the view on screen changes neither id nor instance, so it never scrolls.
  const viewKey = surface ? `${surface.id}:${session.instance(surface.id)}` : undefined;
  const offsets = useRef(new Map<string, number>());
  const shown = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const previous = shown.current;
    if (previous === viewKey) return;
    shown.current = viewKey;
    if (viewKey === undefined) return;
    const saved = offsets.current.get(viewKey) ?? 0;
    // Views of surfaces that no longer exist are never returned to.
    if (offsets.current.size > 64) offsets.current.clear();
    scrollTop(saved);
    if (saved === 0) return;
    // The view has just mounted and may not be tall enough yet: try once more when it has laid out.
    const frame = requestAnimationFrame(() => { if (shown.current === viewKey) scrollTop(saved); });
    return () => cancelAnimationFrame(frame);
  }, [viewKey]);
  useEffect(() => {
    const onScroll = () => { if (shown.current !== undefined) offsets.current.set(shown.current, window.scrollY); };
    window.addEventListener('scroll', onScroll, {passive: true});
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const toggleThemeNow = useCallback(() => setPrefs(current => ({...current, theme: toggleTheme(current.theme)})), []);
  const toggleDensityNow = useCallback(() => setPrefs(current => ({...current, density: toggleDensity(current.density)})), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (event.key === 'Escape') {
        // Escape clears the selection wherever the focus is (design 5.1), unless it means something to the control.
        const current = session.getSnapshot().focus;
        if (current !== undefined && !target?.closest(ESCAPABLE)) session.clearSelection(current);
        return;
      }
      if (target?.closest(TYPING)) return;
      if (event.key === 't') toggleThemeNow();
      else if (event.key === 'd') toggleDensityNow();
      else if (event.key === '[' || event.key === ']') {
        const {surfaces: list, focus: current} = session.getSnapshot();
        if (list.length < 2) return;
        const index = list.findIndex(item => item.id === current);
        const next = list[(index + (event.key === ']' ? 1 : list.length - 1)) % list.length];
        if (next) session.focus(next.id);
      } else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [session, toggleThemeNow, toggleDensityNow]);

  // A tab that stays on "connecting" is usually queued behind other tabs of the same session: a browser opens six
  // connections to one host, and every viewer tab holds one for its event stream.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (status !== 'connecting') return setSlow(false);
    const timer = setTimeout(() => setSlow(true), SLOW_CONNECT_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const reportRenderError = useCallback((message: string) => session.report({code: 'E_RENDER', message, surfaceId: focus}), [session, focus]);

  return (
    <KitProvider host={session.host} link={status} report={session.reportState} watch={session.watch}>
      <div className={css.app}>
        <TopBar
          surfaces={surfaces}
          focus={focus}
          status={status}
          repo={repo}
          theme={prefs.theme}
          scheme={schemeOf(prefs.theme, system)}
          density={prefs.density}
          arranged={arranged}
          onFocus={session.focus}
          onClose={session.close}
          onRefresh={() => { if (focus !== undefined) session.refresh(focus); }}
          onResetLayout={() => { if (layoutKey !== undefined) store.reset(layoutKey); }}
          onToggleTheme={toggleThemeNow}
          onToggleDensity={toggleDensityNow}
        />
        {status === 'ended' ? <p className={css.banner} role="status" data-gl-banner="ended" data-reason={state.end?.reason}>{endedText(state.end)}</p> : null}
        {slow && status === 'connecting' ? (
          <p className={css.banner} role="status" data-gl-banner="slow">
            Still connecting. If this session is open in several tabs of this browser, close some of them: a browser keeps six connections to one site, and every viewer tab uses one.
          </p>
        ) : null}
        <main className={css.main} id="gl-view">
          {surface ? (
            <SurfaceView key={viewKey} surface={surface} onError={reportRenderError} />
          ) : (
            <div className={css.waiting}>
              {focus !== undefined && status !== 'ended' ? <Drafting label={`drafting ${info?.title || focus}`} />
                : status === 'connecting' ? <Drafting label="connecting to the session" />
                : status === 'live' ? <Empty message="no views yet · ask the agent to show one, for example an overview" />
                : <Empty message={state.end && state.end.reason !== 'closed' ? 'no view to show' : 'session ended before a view was shown'} />}
            </div>
          )}
        </main>
      </div>
    </KitProvider>
  );
}
