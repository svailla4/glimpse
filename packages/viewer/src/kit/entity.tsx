// packages/viewer/src/kit/entity.tsx  (first version by WP0; owned by WP4; exported signatures are frozen)
// Anything that names a file, directory, module, symbol, commit or author renders through these, so selection,
// open-in-editor and copy behave the same in every component.
import {formatFileLoc, parseFileLoc, type EntityRef, type FileLoc} from '@glimpse/catalog';
import type {JSX, KeyboardEvent, MouseEvent, ReactNode} from 'react';
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
 * A path as text: dim directory, ink basename, `:line`, extension badge. `label` replaces the path text.
 * When the box is narrower than the path, the directory part gives way first and is elided at its START
 * (`…ers/react/generic-binder.ts`); the basename, line and badge stay. The full location is the tooltip (design
 * rule D12). The element is an inline-flex row capped at the width of its container: put it in a box that has a
 * width (a table cell, a flex item with `min-width: 0`), not in one that grows with its content.
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
          {dir ? <span className="gl-path-dir"><bdi>{dir}</bdi></span> : null}
          <span className="gl-path-base">{base}</span>
        </>
      )}
      {line != null ? <span className="gl-path-line">:{line}{endLine != null && endLine !== line ? `-${endLine}` : ''}</span> : null}
      {ext && ext.length <= 4 && !ext.endsWith('/') ? <span className="gl-path-ext">{ext.toUpperCase()}</span> : null}
    </span>
  );
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
