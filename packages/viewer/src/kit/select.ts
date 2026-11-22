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
 * 'linked'    the entity and the selection name the same diagram nodes (decision links-through-node-ids, hubOf): a Layers item with
 *             node:'PG' when Flowchart node PG is selected, the boxes a selected message passes through
 */
export type SelectionMatch = 'exact' | 'within' | 'contains' | 'linked';

/** What an entity is matched by: its identity, its place and the diagram nodes it stands for. */
export type SelectionRef = Pick<EntityRef, 'type' | 'id' | 'path' | 'line' | 'endLine' | 'nodes'>;
type Ref = SelectionRef;

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

/** Decision links-through-node-ids: the diagram node ids a ref stands for. A node is itself; `nodes` adds the ones it names. */
export const hubOf = (ref: Ref): string[] => [...new Set([...(ref.type === 'node' ? [ref.id] : []), ...(ref.nodes ?? [])])];
/** Two line ranges meet, or one side has none. */
const meet = (a: Ref, b: Ref) => a.line == null || b.line == null || (a.line <= (b.endLine ?? b.line) && b.line <= (a.endLine ?? a.line));

/**
 * Whether a mark is drawn as selected (design 5.1): it is the selection ('exact'), lies inside it ('within') or
 * names the same diagram nodes ('linked', decision links-through-node-ids). The yes/no form of matchSelection, for components that do
 * not draw 'contains'.
 */
export function marksSelection(selected: EntityRef | null | undefined, entity: Ref | null | undefined): boolean {
  const match = matchSelection(selected, entity);
  return match === 'exact' || match === 'within' || match === 'linked';
}

/**
 * How `entity` relates to the selection; undefined when it is not selected at all. Components draw 'exact', 'within'
 * and 'linked' as selected (design 5.1: "same type and id, a file inside a selected directory, a row whose path equals
 * the selection"); trees and module graphs may also mark 'contains', the directory or module the selection is in.
 *
 * Links (decision links-through-node-ids) go one hop and never chain: an entity standing for one node is linked when the selection names
 * that node; one standing for several, when it stands for every node the selection names.
 */
export function matchSelection(selected: EntityRef | null | undefined, entity: Ref | null | undefined): SelectionMatch | undefined {
  if (!selected || !entity) return undefined;
  if (selected.type === entity.type && selected.id === entity.id) return 'exact';
  const place = placeMatch(selected, entity);
  // Holding the selection is not drawn as selected, so naming the selected node outranks it.
  if (place && place !== 'contains') return place;
  return linksSelection(selected, entity) ? 'linked' : place;
}

/** Decision links-through-node-ids: the entity names the selected diagram nodes (the 'linked' rule of matchSelection, places aside). */
export function linksSelection(selected: Ref, entity: Ref): boolean {
  const chosen = hubOf(selected);
  const own = hubOf(entity);
  if (chosen.length === 0 || own.length === 0) return false;
  return own.length === 1 ? chosen.includes(own[0]!) : chosen.every(id => own.includes(id));
}

function placeMatch(selected: Ref, entity: Ref): SelectionMatch | undefined {
  const chosen = placeOf(selected);
  const own = placeOf(entity);
  if (chosen === undefined || own === undefined) return undefined;
  if (chosen === own) {
    // Decision links-through-node-ids: two diagram nodes of one file (the tables of schema.sql) are one place only where their lines meet.
    if ((selected.type === 'node' || entity.type === 'node') && !meet(selected, entity)) return undefined;
    const narrowChosen = selected.type === 'symbol';
    const narrowOwn = entity.type === 'symbol';
    if (narrowChosen && narrowOwn) return undefined;
    return narrowOwn ? 'within' : narrowChosen ? 'contains' : 'exact';
  }
  if (!cannotHold(selected) && under(own, chosen)) return 'within';
  if (!cannotHold(entity) && under(chosen, own)) return 'contains';
  return undefined;
}

/**
 * Decision links-through-node-ids: what an item naming diagram nodes (`node:'PG'`) selects. Its own entity (a file) carries them; without
 * one, one node is that node, and several are a row standing for them.
 */
export function linkedEntity(own: EntityRef | undefined, ids: readonly string[], row: {id: string; label: string}): EntityRef | undefined {
  if (ids.length === 0) return own;
  if (own) return {...own, nodes: [...ids]};
  if (ids.length === 1) return {type: 'node', id: ids[0]!, label: row.label};
  return {type: 'row', id: row.id, label: row.label, nodes: [...ids]};
}
