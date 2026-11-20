// packages/viewer/src/kit/entity.tsx  (first version by WP0; owned by WP4; exported signatures are frozen)
// Anything that names a file, directory, module, symbol, commit or author renders through these, so selection,
// open-in-editor and copy behave the same in every component.
import {formatFileLoc, parseFileLoc, type EntityRef, type FileLoc} from '@glimpse/catalog';
import {useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent, type ReactNode} from 'react';
import {useHostActions, useSelection} from './hooks.ts';

/** Directory part and basename of a path: `splitPath('src/a/b.ts')` is `{dir: 'src/a/', base: 'b.ts'}`. A trailing slash (a directory) stays on the base. */
export function splitPath(path: string): {dir: string; base: string} {
  const end = path.endsWith('/') ? path.length - 1 : path.length;
  const slash = path.lastIndexOf('/', end - 1);
  return slash >= 0 ? {dir: path.slice(0, slash + 1), base: path.slice(slash + 1)} : {dir: '', base: path};
}

/**
 * A path cut to `max` characters for places CSS cannot elide (SVG labels, tab titles, canvas): the directory part is
 * cut at its start and the file name is kept whole (`…/renderers/react/generic-binder.ts`); only a name longer than
 * `max` is itself cut, in the middle, so its extension survives. Design rule D12: never hide the basename.
 */
export function elidePath(path: string, max: number): string {
  if (path.length <= max || max < 2) return path;
  const {dir, base} = splitPath(path);
  if (base.length + 2 > max) {
    if (base.length <= max) return base;
    const tail = Math.max(1, Math.floor((max - 1) / 3));
    return `${base.slice(0, max - 1 - tail)}…${base.slice(-tail)}`;
  }
  // Whole directories only: the cut starts at a slash, so `…/react/` and never `…act/`.
  const cut = dir.slice(dir.length - (max - base.length - 1));
  return `…${cut.slice(cut.indexOf('/'))}${base}`;
}

/**
 * One ResizeObserver for every PathText: each watches the table cell or the plate it is in, whose width never depends
 * on its text, and hears only of a new width.
 */
const boxWatchers = new Map<Element, Set<() => void>>();
const boxWidths = new WeakMap<Element, number>();
let boxObserver: ResizeObserver | undefined;
function watchBox(box: Element, changed: () => void): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};
  boxObserver ??= new ResizeObserver(entries => {
    for (const entry of entries) {
      const width = Math.round(entry.contentRect.width);
      if (boxWidths.get(entry.target) === width) continue;
      boxWidths.set(entry.target, width);
      for (const run of [...(boxWatchers.get(entry.target) ?? [])]) run();
    }
  });
  let set = boxWatchers.get(box);
  if (!set) {
    set = new Set();
    boxWatchers.set(box, set);
    boxObserver.observe(box);
  }
  set.add(changed);
  return () => {
    set.delete(changed);
    if (set.size > 0) return;
    boxWatchers.delete(box);
    boxObserver?.unobserve(box);
  };
}

/**
 * How many leading directories of `dir` to drop so that `…/` and the rest fit in `room` characters (decision D17:
 * whole directories go before a name is cut). 0 when it fits as it is; all of them when not even the last one fits
 * beside `…/` (the line reads `…/name.ts`); 0 again when not even `…/` fits (the stylesheet cuts what is there).
 */
export function dropDirs(dir: string, room: number): number {
  if (dir.length <= room) return 0;
  const parts = dir.split('/').filter(Boolean);
  let used = 2;
  let keep = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = used + parts[i]!.length + 1;
    if (next > room) break;
    used = next;
    keep++;
  }
  return room < 2 ? 0 : parts.length - keep;
}

/**
 * The directory part of a path as a box of `room` characters shows it (decision D17): whole directories at its start
 * give way to `…/`, so the last ones and the name stay. `keep` is how many directories the label needs to tell the
 * file apart from the others of its column (distinctDepths in table/widths.ts): when they do not all fit, the one
 * that differs is kept and the ones between it and the name go (`…/a2ui-kanban/…/`), so two rows never read the same
 * while the name is whole. When not even that fits, the directory that differs is all that is shown, cut at its
 * start to the room (`cut`: `…ger_core/` beside `…er_agent/`): the last resort before two rows read the same, and
 * only once every other directory has gone (D17). `dropped` counts the directories left out; 0 with the directory
 * as it is when it fits (or not even `…/` does: the stylesheet then cuts what is there).
 */
export function fitDir(dir: string, room: number, keep = 0): {text: string; dropped: number; cut?: true} {
  const count = dropDirs(dir, room);
  if (count === 0) return {text: dir, dropped: 0};
  const parts = dir.split('/').filter(Boolean);
  const kept = parts.length - count;
  if (keep > kept && keep <= parts.length) {
    const differs = parts[parts.length - keep]!;
    const shown = keep > 1 ? `${differs}/…/` : `${differs}/`;
    if (shown.length + 2 <= room) return {text: `…/${shown}`, dropped: parts.length - 1};
    // Cut here rather than by the stylesheet, so the `…` that leads it sits where every other row's `…/` does.
    if (room >= 4) return {text: `…${shown.slice(Math.max(0, shown.length - (room - 1)))}`, dropped: parts.length - 1, cut: true};
  }
  return {text: `…/${parts.slice(count).map(part => `${part}/`).join('')}`, dropped: count};
}

/**
 * The box whose new width makes a path measure itself again: the nearest one whose width does not follow the path's
 * text. A table cell (its column is sized from the data, and narrows after the first measure once the table learns
 * its width: a hotspot path was then cut inside 'dart/'), else the plate, else the page.
 */
export function widthBoxOf(element: Element | null): Element {
  return element?.closest('[role="gridcell"], [role="cell"], td, .gl-cell') ?? document.documentElement;
}

/**
 * The directory part of a path ('src/core/'), dim, in a `.gl-path-dir` box that gives way before the name beside it:
 * whole directories at its start are replaced by `…/` (decision D17), and only when not even the last one fits is it
 * cut inside, at its start. PathText draws its directory with it; so does any header that writes a path its own way
 * (the code views' crumbs), so a path is never cut inside a directory while whole ones could go.
 */
export function DirText(p: {dir: string; keep?: number}): JSX.Element {
  const {dir} = p;
  const keep = p.keep ?? 0;
  const dirRef = useRef<HTMLSpanElement>(null);
  // Each new width of the box is a new epoch: the whole directory is shown and measured again.
  const [epoch, setEpoch] = useState(0);
  // What is shown of the directory, measured for one directory at one epoch.
  const [fit, setFit] = useState<{text: string; dropped: number; cut?: true; key: string} | null>(null);
  const key = `${epoch}\n${keep}\n${dir}`;
  const fitted = fit !== null && fit.key === key ? fit : undefined;
  const dropped = fitted?.dropped ?? 0;
  useLayoutEffect(() => {
    const element = dirRef.current;
    if (!element || fitted || dir.length === 0) return;
    // The directory is mono text: its width per character is its full width over its length. Any overflow counts:
    // one pixel over is enough for the stylesheet's ellipsis to cut inside the first directory ('…rt/a2ui_core/').
    if (element.scrollWidth <= element.clientWidth) return;
    // An exact fit is no fit: clientWidth is rounded and text widths snap up to the layout grid, so a directory that
    // fills its box to the pixel ('…/v0_9/…/' in 64.8 px beside a 115.2 px name in a 180 px cell) overflowed by a
    // fraction of a pixel and the name beside it was cut in its middle. One pixel is kept free.
    const next = fitDir(dir, Math.floor((element.clientWidth - 1) / (element.scrollWidth / dir.length)), keep);
    if (next.dropped > 0) setFit({...next, key});
  }, [key, dir, keep, fitted]);
  useEffect(() => watchBox(widthBoxOf(dirRef.current), () => setEpoch(n => n + 1)), []);
  return (
    <span className="gl-path-dir" ref={dirRef} data-dropped={dropped > 0 ? dropped : undefined} data-cut={fitted?.cut ? '' : undefined}>
      <bdi>{fitted?.text ?? dir}</bdi>
    </span>
  );
}

/** A file name this long or shorter is never split: cut, it would keep too little either side of the `…`. */
const SPLIT_ABOVE = 12;

/**
 * Where a file name too long for its box is cut (D12): the index its kept end starts at, or -1 to cut it at its end.
 * The end that tells files apart stays whole: the extension and the word before it (`message-proc…test.ts`,
 * `contact_form_ex…test.json`), or the last three letters of the stem (`AccountsPan…ort.tsx`).
 */
export function nameTail(base: string): number {
  if (base.length <= SPLIT_ABOVE) return -1;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || base.length - dot > 6) return base.length - Math.min(6, Math.floor(base.length / 3));
  const sep = Math.max(base.lastIndexOf('.', dot - 1), base.lastIndexOf('_', dot - 1), base.lastIndexOf('-', dot - 1));
  return sep >= 3 && dot - sep - 1 >= 1 && dot - sep - 1 <= 10 ? sep + 1 : Math.max(3, dot - 3);
}

/**
 * A path as text: dim directory, ink basename, `:line`, extension badge. `label` replaces the path text.
 * When the box is narrower than the path, the directory part gives way first: whole directories at its start are
 * replaced by `…/` (`…/react/src/generic-binder.ts`, decision D17), and only when not even the last one fits is it
 * cut inside, at its start; the basename, line and badge stay. Once only `…/` is left it stays, and a name still too
 * long is cut in its middle, its end kept (`…/message-proc…test.ts`, see nameTail). The full location is the tooltip
 * (design rule D12).
 * `keep`: how many directories tell this file apart from the others it is listed with (table/widths.ts
 * distinctDepths over the column): the one that differs stays even when those after it go (`…/kanban/…/x.ts`).
 * The element is an inline-flex row capped at the width of its container: put it in a box that has a width (a table
 * cell, a flex item with `min-width: 0`), not in one that grows with its content.
 */
export function PathText(p: {file: FileLoc; label?: string; keep?: number}): JSX.Element {
  const {path, line, endLine} = parseFileLoc(p.file);
  const {dir, base} = splitPath(path);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : '';
  const tail = p.label ? -1 : nameTail(base);
  return (
    <span className="gl-path" title={p.file} data-path={path}>
      {p.label ? (
        <span className="gl-path-base">{p.label}</span>
      ) : (
        <>
          {dir ? <DirText dir={dir} keep={p.keep} /> : null}
          {tail > 0 ? (
            <span className="gl-path-base" data-split="">
              <span className="gl-path-head">{base.slice(0, tail)}</span>
              <span className="gl-path-tail">{base.slice(tail)}</span>
            </span>
          ) : (
            <span className="gl-path-base">{base}</span>
          )}
        </>
      )}
      {line != null ? <span className="gl-path-line">:{line}{endLine != null && endLine !== line ? `-${endLine}` : ''}</span> : null}
      {ext && ext.length <= 4 && !ext.endsWith('/') ? <span className="gl-path-ext">{ext.toUpperCase()}</span> : null}
    </span>
  );
}

/**
 * Text that may hold paths, with a line-break opportunity after every `/`: a long path in a heading or a state line
 * wraps between its directories (`…/run_039_ast/` | `patch.diff`) instead of inside a name (`patch.dif` | `f`). The
 * text stays the same for copy and for assistive technology (<wbr> adds nothing).
 */
export function wrapAtSlashes(text: string): ReactNode {
  if (!text.includes('/')) return text;
  // A directory name too long for a line of its own may also break after its underscores.
  const name = (part: string, at: number): ReactNode[] =>
    part.length <= 24 ? [part] : part.split(/(?<=_)/).flatMap((piece, j, all) => (j === all.length - 1 ? [piece] : [piece, <wbr key={`${at}.${j}`} />]));
  const parts = text.split('/');
  return parts.flatMap((part, i) => (i === parts.length - 1 ? name(part, i) : [...name(part, i), '/', <wbr key={i} />]));
}

/** `path:line` as an editor or a terminal takes it; the label or id for entities without a path. */
export function entityClipText(entity: EntityRef): string {
  if (!entity.path) return entity.label ?? entity.id;
  return entity.line != null ? `${entity.path}:${entity.line}` : entity.path;
}

/**
 * Makes its children the handle of an entity. Click or Enter selects (writes /ui/sel and /ui/file, tells the server);
 * Cmd/Ctrl-click or `o` opens the file in the editor; `c` copies `path:line`; Escape clears the selection.
 * `data-selected` is set while this entity is the surface selection.
 */
export function EntityLink(p: {entity: EntityRef; componentId: string; children: ReactNode}): JSX.Element {
  const {entity, componentId} = p;
  const {select, isSelected} = useSelection(componentId);
  const host = useHostActions(componentId);
  const open = () => {
    if (entity.path) host.open(formatFileLoc({path: entity.path, line: entity.line, endLine: entity.endLine}));
  };
  const onClick = (event: MouseEvent) => {
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey) open();
    else select(entity);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'o') open();
    else if (event.key === 'c') void navigator.clipboard?.writeText(entityClipText(entity))?.catch(() => {});
    else if (event.key === 'Escape') select(null);
    else return;
    event.stopPropagation();
  };
  return (
    <button
      type="button"
      className="gl-entity"
      data-entity-type={entity.type}
      data-entity-id={entity.id}
      data-selected={isSelected(entity) || undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {p.children}
    </button>
  );
}
