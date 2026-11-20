// packages/viewer/src/kit/entity.tsx  (first version by WP0; owned by WP4; exported signatures are frozen)
// Anything that names a file, directory, module, symbol, commit or author renders through these, so selection,
// open-in-editor and copy behave the same in every component.
import {formatFileLoc, parseFileLoc, type EntityRef, type FileLoc} from '@glimpse/catalog';
import type {JSX, KeyboardEvent, MouseEvent, ReactNode} from 'react';
import {useHostActions, useSelection} from './hooks.ts';

/** A path as text: dim directory, ink basename, `:line`, extension badge. `label` replaces the path text. */
export function PathText(p: {file: FileLoc; label?: string}): JSX.Element {
  const {path, line, endLine} = parseFileLoc(p.file);
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : '';
  return (
    <span className="gl-path" title={p.file} data-path={path}>
      {p.label ? (
        <span className="gl-path-base">{p.label}</span>
      ) : (
        <>
          {dir ? <span className="gl-path-dir">{dir}</span> : null}
          <span className="gl-path-base">{base}</span>
        </>
      )}
      {line != null ? <span className="gl-path-line">:{line}{endLine != null && endLine !== line ? `-${endLine}` : ''}</span> : null}
      {ext && ext.length <= 4 ? <span className="gl-path-ext">{ext.toUpperCase()}</span> : null}
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
