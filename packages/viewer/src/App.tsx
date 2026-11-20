// packages/viewer/src/App.tsx
// The shell (design 8.3): a top bar with one tab per surface over the focused surface. Only the focused surface is
// mounted. Keys: `[` and `]` switch surfaces, `t` toggles the theme, `d` the density.
import {useCallback, useEffect, useState, useSyncExternalStore, type JSX} from 'react';
import {arrangeKey, useArrangeStore} from './kit/arrange.tsx';
import {Drafting, Empty, KitProvider} from './kit/index.ts';
import {applyPrefs, loadPrefs, savePrefs, schemeOf, systemScheme, toggleDensity, toggleTheme, type Prefs} from './shell/prefs.ts';
import {surfaceRepoName, type ViewerSession} from './shell/session.ts';
import css from './shell/Shell.module.css';
import {SurfaceView} from './shell/SurfaceView.tsx';
import {TopBar} from './shell/TopBar.tsx';
import {isTokenFragment, parseRoute, showRoute} from './transport/launch.ts';

/** Where a typed character belongs to the focused control (a field, a list with type-ahead), not to the shell. */
const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="tree"], [role="treegrid"], [role="grid"], [role="listbox"], [role="menu"]';

function useSystemScheme(): 'light' | 'dark' {
  const subscribe = useCallback((notify: () => void) => {
    if (typeof matchMedia !== 'function') return () => {};
    const query = matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', notify);
    return () => query.removeEventListener('change', notify);
  }, []);
  return useSyncExternalStore(subscribe, systemScheme);
}

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

  const toggleThemeNow = useCallback(() => setPrefs(current => ({...current, theme: toggleTheme(current.theme)})), []);
  const toggleDensityNow = useCallback(() => setPrefs(current => ({...current, density: toggleDensity(current.density)})), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) return;
      if (event.target instanceof Element && event.target.closest(TYPING)) return;
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

  const reportRenderError = useCallback((message: string) => session.report({code: 'E_RENDER', message, surfaceId: focus}), [session, focus]);

  return (
    <KitProvider host={session.host}>
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
        {status === 'ended' ? <p className={css.banner} role="status" data-gl-banner="ended">Session ended. This is a snapshot.</p> : null}
        <main className={css.main} id="gl-view">
          {surface ? (
            <SurfaceView key={`${surface.id}:${session.instance(surface.id)}`} surface={surface} onError={reportRenderError} />
          ) : (
            <div className={css.waiting}>
              {focus !== undefined && status !== 'ended' ? <Drafting label={`drafting ${info?.title || focus}`} />
                : status === 'connecting' ? <Drafting label="connecting to the session" />
                : status === 'live' ? <Empty message="no views yet · ask the agent to show one, for example an overview" />
                : <Empty message="session ended before a view was shown" />}
            </div>
          )}
        </main>
      </div>
    </KitProvider>
  );
}
