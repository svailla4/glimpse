// EntityLink behaviour for a whole row (Steps, List, SegmentedBar): the row is the roving-focus item, so the entity
// cannot be a nested button. Same contract as kit/entity.tsx: click or Enter selects, Cmd/Ctrl-click or `o` opens the
// editor, `c` copies path:line, Escape clears the selection.
import {formatFileLoc, type EntityRef} from '@glimpse/catalog';
import type {KeyboardEvent, MouseEvent} from 'react';
import {entityClipText, marksSelection, useHostActions, useSelection} from '../../../kit/index.ts';

export interface EntityRows {
  selected: EntityRef | null;
  isMarked(entity: EntityRef | undefined): boolean;
  onClick(entity: EntityRef | undefined, event: MouseEvent): void;
  /** Returns true when the key was an entity key. */
  onKeyDown(entity: EntityRef | undefined, event: KeyboardEvent): boolean;
}

export function useEntityRows(componentId: string): EntityRows {
  const {selected, select} = useSelection(componentId);
  const host = useHostActions(componentId);
  const open = (entity: EntityRef) => {
    if (entity.path) host.open(formatFileLoc({path: entity.path, line: entity.line, endLine: entity.endLine}));
  };
  return {
    selected,
    isMarked: entity => marksSelection(selected, entity),
    onClick(entity, event) {
      if (!entity) return;
      if (event.metaKey || event.ctrlKey) open(entity);
      else select(entity);
    },
    onKeyDown(entity, event) {
      if (event.metaKey || event.ctrlKey || event.altKey) return false;
      if (event.key === 'Escape') {
        if (!selected) return false;
        select(null);
      } else if (!entity) return false;
      else if (event.key === 'Enter' || event.key === ' ') select(entity);
      else if (event.key === 'o') open(entity);
      else if (event.key === 'c') void navigator.clipboard?.writeText(entityClipText(entity))?.catch(() => {});
      else return false;
      event.preventDefault();
      return true;
    },
  };
}
