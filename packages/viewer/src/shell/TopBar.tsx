// packages/viewer/src/shell/TopBar.tsx
// The 32 px bar above every view (design 8.3): one tab per surface, then the session's controls. Nothing here is
// vermilion: the active tab is ink.
// When the tabs do not fit, the strip scrolls: the active tab is always brought into view, the clipped side fades
// out, and a `+N` button lists the views that are out of sight.
import type {LinkStatus, SurfaceInfo} from '@glimpse/catalog';
import {useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent} from 'react';
import {Icon, elidePath} from '../kit/index.ts';
import type {Density, Theme} from './prefs.ts';
import css from './TopBar.module.css';

export interface TopBarProps {
  surfaces: readonly SurfaceInfo[];
  focus: string | undefined;
  status: LinkStatus;
  /** Shown next to the connection dot. */
  repo: string | undefined;
  theme: Theme;
  /** The scheme on screen, which is what the theme button offers to leave. */
  scheme: 'light' | 'dark';
  density: Density;
  /** Whether the focused surface has been rearranged: shows "Reset layout". */
  arranged: boolean;
  onFocus(id: string): void;
  onClose(id: string): void;
  onRefresh(): void;
  onResetLayout(): void;
  onToggleTheme(): void;
  onToggleDensity(): void;
}

const STATUS_LABEL: Record<LinkStatus, string> = {connecting: 'connecting', live: 'live', ended: 'ended'};
/** Longest tab label, in characters, for a title that is a path. */
const TAB_PATH_CHARS = 28;

const PATH_LIKE = /^[^\s/]+(?:\/[^\s/]+)+\/?$/;

/**
 * The whole title of a view. The host caps a title at 80 characters, which can cut a long path inside its file name;
 * a preset call (`view`, such as `file a/b/c.ts#L1-9`) still has the whole path, so a title that is the start of the
 * path the call names is that path.
 */
export function fullTitle(info: Pick<SurfaceInfo, 'id' | 'title' | 'view'>): string {
  const title = info.title || info.id;
  const target = info.view?.match(/^\S+\s+(\S.*)$/)?.[1]?.trim().replace(/#L?\d+(?:-L?\d+)?$/, '');
  return target && target.length > title.length && target.startsWith(title.replace(/…$/, '')) && PATH_LIKE.test(target) ? target : title;
}

/** A title that is a file path keeps its file name: the directories are cut, not the end (design rule D12). */
export function tabLabel(info: Pick<SurfaceInfo, 'id' | 'title' | 'view'>): string {
  const title = fullTitle(info);
  return PATH_LIKE.test(title) ? elidePath(title, TAB_PATH_CHARS) : title;
}

interface Clip { start: boolean; end: boolean; hidden: string[] }
const NO_CLIP: Clip = {start: false, end: false, hidden: []};

export function TopBar(p: TopBarProps): JSX.Element {
  const tabs = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLDivElement>(null);
  const [clip, setClip] = useState<Clip>(NO_CLIP);
  const [open, setOpen] = useState(false);
  const live = p.status !== 'ended';

  /** Which side of the strip is cut, and which tabs are (partly) out of sight. */
  const measure = useCallback(() => {
    const strip = tabs.current;
    if (!strip) return;
    const view = strip.getBoundingClientRect();
    const overflows = strip.scrollWidth > strip.clientWidth + 1;
    const hidden: string[] = [];
    if (overflows) {
      for (const tab of strip.querySelectorAll<HTMLElement>('[role="tab"]')) {
        const box = tab.getBoundingClientRect();
        if ((box.left < view.left - 1 || box.right > view.right + 1) && tab.dataset.surface !== undefined) hidden.push(tab.dataset.surface);
      }
    }
    const next: Clip = {start: overflows && strip.scrollLeft > 1, end: overflows && strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1, hidden};
    setClip(previous => (previous.start === next.start && previous.end === next.end && previous.hidden.join('\n') === next.hidden.join('\n') ? previous : next));
  }, []);

  // The view on screen always has its tab on screen: when it changes, when the tabs change (a new tab can push it out
  // of sight) and when the strip changes width (the window is resized, V044).
  const focus = useRef(p.focus);
  focus.current = p.focus;
  const reveal = useCallback(() => {
    const strip = tabs.current;
    if (!strip) return;
    for (const tab of strip.querySelectorAll<HTMLElement>('[role="tab"]')) {
      if (tab.dataset.surface !== focus.current) continue;
      const item = tab.parentElement ?? tab;
      const view = strip.getBoundingClientRect();
      const box = item.getBoundingClientRect();
      // Scroll the strip itself (never the page), with room for the fade at the edge.
      if (box.left < view.left) strip.scrollLeft -= view.left - box.left + 24;
      else if (box.right > view.right) strip.scrollLeft += box.right - view.right + 24;
    }
    measure();
  }, [measure]);
  // `order` stands for the list of tabs; p.focus and order are the triggers, reveal reads them.
  const order = p.surfaces.map(info => info.id).join('\n');
  useLayoutEffect(reveal, [p.focus, order, reveal]);
  useEffect(() => {
    const strip = tabs.current;
    if (!strip) return;
    strip.addEventListener('scroll', measure, {passive: true});
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(reveal);
    observer?.observe(strip);
    return () => {
      strip.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [measure, reveal]);

  // The menu exists only while some tab is out of sight: when none is, it is closed for good (V064), so it neither
  // keeps its Escape handler nor comes back by itself when the strip narrows again.
  const anyHidden = clip.hidden.length > 0;
  useEffect(() => {
    if (!anyHidden) setOpen(false);
  }, [anyHidden]);
  const menuOpen = open && anyHidden;

  // The menu closes on a press outside it and on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: PointerEvent) => { if (!more.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      more.current?.querySelector<HTMLElement>('button')?.focus();
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menuOpen]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey || !(event.target as Element).matches('[role="tab"]')) return;
    const index = p.surfaces.findIndex(info => info.id === p.focus);
    const last = p.surfaces.length - 1;
    const next =
      event.key === 'ArrowRight' ? (index >= last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index <= 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : undefined;
    const target = next === undefined ? undefined : p.surfaces[next];
    if (!target) return;
    event.preventDefault();
    p.onFocus(target.id);
    for (const tab of tabs.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []) if (tab.dataset.surface === target.id) tab.focus();
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? (at + 1) % items.length : event.key === 'ArrowUp' ? (at <= 0 ? items.length - 1 : at - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  };
  return (
    <header className={css.bar}>
      <div className={css.tabs} role="tablist" aria-label="Views" ref={tabs} onKeyDown={onKeyDown} data-clip-start={clip.start || undefined} data-clip-end={clip.end || undefined}>
        {p.surfaces.map((info, index) => {
          const active = info.id === p.focus;
          // The strip stays reachable with Tab when no view is on screen (a link to a closed one): the first tab takes it.
          const entry = active || (index === 0 && !p.surfaces.some(item => item.id === p.focus));
          const name = fullTitle(info);
          return (
            <div className={css.tab} key={info.id} data-active={active || undefined}>
              <button type="button" role="tab" className={css.tabButton} data-surface={info.id} aria-selected={active} aria-controls="gl-view" aria-label={name} tabIndex={entry ? 0 : -1} title={info.view ? `${name} · ${info.view}` : name} onClick={() => p.onFocus(info.id)}>
                {tabLabel(info)}
              </button>
              {live ? (
                <button type="button" className={css.close} aria-label={`Close ${name}`} tabIndex={active ? 0 : -1} onClick={() => p.onClose(info.id)}>
                  <Icon name="close" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {clip.hidden.length > 0 ? (
        <div className={css.more} ref={more}>
          <button type="button" className={css.text} aria-haspopup="menu" aria-expanded={menuOpen} title={`${clip.hidden.length} more ${clip.hidden.length === 1 ? 'view' : 'views'}`} data-gl-more="" onClick={() => setOpen(value => !value)}>
            +{clip.hidden.length}
          </button>
          {menuOpen ? (
            <div className={css.menu} role="menu" aria-label="More views" onKeyDown={onMenuKeyDown}>
              {p.surfaces.filter(info => clip.hidden.includes(info.id)).map(info => (
                <button type="button" role="menuitem" className={css.item} key={info.id} title={fullTitle(info)} onClick={() => { setOpen(false); p.onFocus(info.id); }}>
                  {tabLabel(info)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={css.controls}>
        {p.arranged ? (
          <button type="button" className={css.text} onClick={p.onResetLayout} title="Put every plate of this view back where the agent placed it">
            <Icon name="reset" /> Reset layout
          </button>
        ) : null}
        <span className={css.link} data-status={p.status} role="status" title={`Session ${STATUS_LABEL[p.status]}`}>
          <span className={css.dot} aria-hidden="true" />
          {p.repo ? <span className={css.repo}>{p.repo}</span> : null}
          <span className={css.state}>{STATUS_LABEL[p.status]}</span>
        </span>
        {p.focus !== undefined && live ? (
          <button type="button" className={css.icon} aria-label="Refresh data" title="Run this view's data sources again" onClick={p.onRefresh}>
            <Icon name="refresh" size={16} />
          </button>
        ) : null}
        <button type="button" className={css.icon} aria-label={p.density === 'compact' ? 'Comfortable density' : 'Compact density'} aria-keyshortcuts="d" title={`Density: ${p.density} (d)`} onClick={p.onToggleDensity}>
          <Icon name={p.density === 'compact' ? 'compact' : 'comfortable'} size={16} />
        </button>
        <button type="button" className={css.icon} aria-label={p.scheme === 'dark' ? 'Light theme' : 'Dark theme'} aria-keyshortcuts="t" title={`Theme: ${p.theme === 'auto' ? `auto, ${p.scheme}` : p.theme} (t)`} onClick={p.onToggleTheme}>
          <Icon name={p.scheme === 'dark' ? 'dark' : 'light'} size={16} />
        </button>
      </div>
    </header>
  );
}
