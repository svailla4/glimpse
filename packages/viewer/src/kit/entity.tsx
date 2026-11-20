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
export function DirText(p: {dir: string}): JSX.Element {
  const {dir} = p;
  const dirRef = useRef<HTMLSpanElement>(null);
  // Each new width of the box is a new epoch: the whole directory is shown and measured again.
  const [epoch, setEpoch] = useState(0);
  // Leading directories dropped, measured for one directory at one epoch.
  const [drop, setDrop] = useState<{count: number; key: string} | null>(null);
  const key = `${epoch}\n${dir}`;
  const dropped = drop !== null && drop.key === key ? drop.count : 0;
  useLayoutEffect(() => {
    const element = dirRef.current;
    if (!element || dropped > 0 || dir.length === 0) return;
    // The directory is mono text: its width per character is its full width over its length. Any overflow counts:
    // one pixel over is enough for the stylesheet's ellipsis to cut inside the first directory ('…rt/a2ui_core/').
    if (element.scrollWidth <= element.clientWidth) return;
    const count = dropDirs(dir, Math.floor(element.clientWidth / (element.scrollWidth / dir.length)));
    if (count > 0) setDrop({count, key});
  }, [key, dir, dropped]);
  useEffect(() => watchBox(widthBoxOf(dirRef.current), () => setEpoch(n => n + 1)), []);
  const kept = dir.split('/').filter(Boolean).slice(dropped);
  const shown = dropped > 0 ? `…/${kept.map(part => `${part}/`).join('')}` : dir;
  return <span className="gl-path-dir" ref={dirRef} data-dropped={dropped > 0 ? dropped : undefined}><bdi>{shown}</bdi></span>;
}

/**
 * A path as text: dim directory, ink basename, `:line`, extension badge. `label` replaces the path text.
 * When the box is narrower than the path, the directory part gives way first: whole directories at its start are
 * replaced by `…/` (`…/react/src/generic-binder.ts`, decision D17), and only when not even the last one fits is it
 * cut inside, at its start; the basename, line and badge stay. The full location is the tooltip (design rule D12).
 * The element is an inline-flex row capped at the width of its container: put it in a box that has a width (a table
 * cell, a flex item with `min-width: 0`), not in one that grows with its content.
 */
export function PathText(p: {file: FileLoc; label?: string}): JSX.Element {
  const {path, line, endLine} = parseFileLoc(p.file);
  const {dir, base} = splitPath(path);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : '';
  return (
    <span className="gl-path" title={p.file} data-path={path}>
      {p.label ? (
        <span className="gl-path-base">{p.label}</span>
      ) : (
        <>
          {dir ? <DirText dir={dir} /> : null}
          <span className="gl-path-base">{base}</span>
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
