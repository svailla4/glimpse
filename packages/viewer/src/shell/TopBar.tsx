// packages/viewer/src/shell/TopBar.tsx
// The 32 px bar above every view (design 8.3): one tab per surface, then the session's controls. Nothing here is
// vermilion: the active tab is ink.
import type {LinkStatus, SurfaceInfo} from '@glimpse/catalog';
import {useRef, type JSX, type KeyboardEvent} from 'react';
import {Icon} from '../kit/index.ts';
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

export function TopBar(p: TopBarProps): JSX.Element {
  const tabs = useRef<HTMLDivElement>(null);
  const live = p.status !== 'ended';
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
  return (
    <header className={css.bar}>
      <div className={css.tabs} role="tablist" aria-label="Views" ref={tabs} onKeyDown={onKeyDown}>
        {p.surfaces.map(info => {
          const active = info.id === p.focus;
          return (
            <div className={css.tab} key={info.id} data-active={active || undefined}>
              <button type="button" role="tab" className={css.tabButton} data-surface={info.id} aria-selected={active} aria-controls="gl-view" tabIndex={active ? 0 : -1} title={info.view ? `${info.title} · ${info.view}` : info.title} onClick={() => p.onFocus(info.id)}>
                {info.title || info.id}
              </button>
              {live ? (
                <button type="button" className={css.close} aria-label={`Close ${info.title || info.id}`} tabIndex={active ? 0 : -1} onClick={() => p.onClose(info.id)}>
                  <Icon name="close" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
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
