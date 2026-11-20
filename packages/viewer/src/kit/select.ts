// packages/viewer/src/kit/select.ts
// The red-pencil rule (design 5.1) in one place, with no React in it: which entity a file location names, and how
// an entity relates to the surface selection. useSelection().match and every component's highlight use this.
import {parseFileLoc, type EntityRef, type FileLoc} from '@glimpse/catalog';

/**
 * The entity a FileLoc names: a file, with its line range when the location has one; a directory when the path ends
 * with a slash ('src/auth/'). `label` is what a list would show for it.
 */
export function fileEntity(loc: FileLoc, label?: string): EntityRef {
  const {path, line, endLine} = parseFileLoc(loc);
  const dir = path.length > 1 && path.endsWith('/');
  const clean = dir ? path.replace(/\/+$/, '') : path;
  const entity: EntityRef = {type: dir ? 'dir' : 'file', id: clean, path: clean};
  if (!dir && line != null) entity.line = line;
  if (!dir && endLine != null) entity.endLine = endLine;
  if (label) entity.label = label;
  return entity;
}

/**
 * 'exact'     the entity is the selection: same type and id, or the same file or directory under another type (a
 *             table row whose path is the selected file, a module node whose path is the selected directory)
 * 'within'    the entity lies inside the selection: a file or directory under a selected directory or module, a
 *             symbol of the selected file
 * 'contains'  the entity holds the selection: a directory or module above the selected file, the file of the
 *             selected symbol
 */
export type SelectionMatch = 'exact' | 'within' | 'contains';

type Ref = Pick<EntityRef, 'type' | 'id' | 'path'>;

/** Commits and authors are not places: their `path`, if any, says nothing about containment. */
const PLACELESS: ReadonlySet<string> = new Set(['commit', 'author']);
/** A file cannot hold other paths; a symbol is narrower than the file its path names. */
const cannotHold = (ref: Ref) => ref.type === 'file' || ref.type === 'symbol';

function placeOf(ref: Ref): string | undefined {
  if (PLACELESS.has(ref.type)) return undefined;
  const path = ref.path ?? (ref.type === 'file' || ref.type === 'dir' ? ref.id : undefined);
  return typeof path === 'string' ? path.replace(/^\.\//, '').replace(/\/+$/, '') : undefined;
}
const under = (path: string, dir: string) => dir === '' ? path !== '' : path.startsWith(`${dir}/`);

/**
 * How `entity` relates to the selection; undefined when it is not selected at all. Components draw 'exact' and
 * 'within' as selected (design 5.1: "same type and id, a file inside a selected directory, a row whose path equals
 * the selection"); trees and module graphs may also mark 'contains', the directory or module the selection is in.
 */
/**
 * Whether a mark is drawn as selected (design 5.1): it is the selection ('exact') or lies inside it ('within').
 * The yes/no form of matchSelection, for components that do not draw 'contains'.
 */
export function marksSelection(selected: EntityRef | null | undefined, entity: Ref | null | undefined): boolean {
  const match = matchSelection(selected, entity);
  return match === 'exact' || match === 'within';
}

export function matchSelection(selected: EntityRef | null | undefined, entity: Ref | null | undefined): SelectionMatch | undefined {
  if (!selected || !entity) return undefined;
  if (selected.type === entity.type && selected.id === entity.id) return 'exact';
  const chosen = placeOf(selected);
  const own = placeOf(entity);
  if (chosen === undefined || own === undefined) return undefined;
  if (chosen === own) {
    const narrowChosen = selected.type === 'symbol';
    const narrowOwn = entity.type === 'symbol';
    if (narrowChosen && narrowOwn) return undefined;
    return narrowOwn ? 'within' : narrowChosen ? 'contains' : 'exact';
  }
  if (!cannotHold(selected) && under(own, chosen)) return 'within';
  if (!cannotHold(entity) && under(chosen, own)) return 'contains';
  return undefined;
}
