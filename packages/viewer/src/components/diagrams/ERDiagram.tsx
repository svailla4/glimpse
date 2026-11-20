// ERDiagram: tables with column rows and key marks, joined by relations with crow's-foot ends (design 5.6).
import type * as C from '@glimpse/catalog';
import {parseFileLoc, type EntityRef, type ErData} from '@glimpse/catalog';
import {useCallback, useMemo, useState, type ReactNode} from 'react';
import {DataGate, Empty, Redline, fmtNum, useDataset, type GlView} from '../../kit/index.ts';
import {
  Diagram, MONO_11, MONO_12, UI_12, fitText, textWidth,
  type DiagramEdge, type DiagramNode, type Dir, type Mark, type NodeFlags,
} from './edgekit/index.ts';
import css from './ERDiagram.module.css';

const HEAD = 26;
const ROW = 22;
const MIN_W = 168;
const MAX_W = 320;
/** A table with more columns than this shows this many and folds the rest (design 5.6). */
export const VISIBLE_COLUMNS = 12;
/** Columns drawn in an unfolded table, whatever the data says. */
const MAX_COLUMNS = 200;
export const MAX_TABLES = 150;

const CARDINALITY: Record<string, readonly [Mark, Mark]> = {
  '1-1': ['one', 'one'], '1-n': ['one', 'many'], 'n-1': ['many', 'one'], 'n-n': ['many', 'many'],
};
const CARD_TEXT: Record<string, string> = {'1-1': 'one to one', '1-n': 'one to many', 'n-1': 'many to one', 'n-n': 'many to many'};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const textOf = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);
const describe = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);

interface Column { name: string; type?: string; pk: boolean; fk: boolean; nullable: boolean }
interface Table { name: string; file?: string; columns: Column[] }
interface Relation { from: string; fromColumn?: string; to: string; toColumn?: string; label?: string; card?: string }
export interface CleanSchema { tables: Table[]; relations: Relation[]; dropped: {tables: number; relations: number} }

/**
 * Coerces the bound value into tables and relations, or returns a message when it is not a schema at all. The value
 * is `{tables, relations?}` or the bare list of tables. A column's `fk` is true, or names what it points at
 * ('users.id', or just 'users'; `ref` and `references` are read the same way): that also draws the relation, many
 * rows to one, unless `relations` already has one between the two ends.
 */
export function cleanSchema(data: unknown): CleanSchema | string {
  const rawTables = Array.isArray(data) ? data : isRecord(data) ? data.tables : undefined;
  if (!Array.isArray(data) && !isRecord(data)) return `expected tables [{name, columns}] or {tables, relations}, received ${describe(data)}`;
  if (!Array.isArray(rawTables)) return `expected tables to be an array, received ${describe(rawTables)}`;
  const rawRelations: unknown[] = isRecord(data) && Array.isArray(data.relations) ? data.relations : [];
  const dropped = {tables: 0, relations: 0};
  const tables: Table[] = [];
  const byName = new Map<string, Table>();
  /** What the columns say they point at, in table and column order. */
  const pointers: Array<{from: string; to: string}> = [];
  for (const raw of rawTables) {
    const name = isRecord(raw) ? textOf(raw.name) : undefined;
    if (!isRecord(raw) || name === undefined || byName.has(name)) {
      dropped.tables++;
      continue;
    }
    const columns: Column[] = [];
    for (const col of Array.isArray(raw.columns) ? raw.columns : []) {
      // A bare string is a column name.
      const colName = isRecord(col) ? textOf(col.name) : textOf(col);
      if (colName === undefined) continue;
      const c = isRecord(col) ? col : {};
      const target = [c.fk, c.ref, c.references].map(v => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)).find(v => v !== undefined);
      if (target !== undefined) pointers.push({from: `${name}.${colName}`, to: target});
      columns.push({name: colName, type: textOf(c.type), pk: c.pk === true, fk: c.fk === true || target !== undefined, nullable: c.nullable === true});
    }
    const table = {name, file: textOf(raw.file), columns};
    byName.set(name, table);
    tables.push(table);
  }
  if (rawTables.length > 0 && tables.length === 0) return `expected tables [{name, columns}], but none of the ${rawTables.length} ${rawTables.length === 1 ? 'entry has' : 'entries have'} a name`;
  // 'table.column' or 'table'. A table name may itself contain dots, so whole names are tried first.
  const end = (ref: unknown): {table: string; column?: string} | undefined => {
    const text = textOf(ref);
    if (text === undefined) return undefined;
    if (byName.has(text)) return {table: text};
    const dot = text.lastIndexOf('.');
    const table = dot > 0 ? text.slice(0, dot) : undefined;
    return table !== undefined && byName.has(table) ? {table, column: text.slice(dot + 1)} : undefined;
  };
  const relations: Relation[] = [];
  for (const raw of rawRelations) {
    const from = isRecord(raw) ? end(raw.from) : undefined;
    const to = isRecord(raw) ? end(raw.to) : undefined;
    if (!isRecord(raw) || !from || !to) {
      dropped.relations++;
      continue;
    }
    const card = textOf(raw.card);
    relations.push({from: from.table, fromColumn: from.column, to: to.table, toColumn: to.column, label: textOf(raw.label), card: card !== undefined && card in CARDINALITY ? card : undefined});
  }
  const joins = (rel: Relation, a: {table: string; column?: string}, b: {table: string; column?: string}) =>
    rel.from === a.table && rel.to === b.table && (rel.fromColumn ?? a.column) === a.column && (rel.toColumn ?? b.column) === b.column;
  for (const pointer of pointers) {
    const from = end(pointer.from);
    const to = end(pointer.to);
    if (!from || !to) {
      dropped.relations++;
      continue;
    }
    // Written out in `relations` as well, in either direction: one line is enough.
    if (relations.some(rel => joins(rel, from, to) || joins(rel, to, from))) continue;
    relations.push({from: from.table, fromColumn: from.column, to: to.table, toColumn: to.column, card: 'n-1'});
  }
  return {tables, relations, dropped};
}

interface RowDraw { name: string; type?: string; pk: boolean; fk: boolean }
interface TableDraw { title: string; rows: RowDraw[]; foldable: boolean; folded: boolean; more: number }

function drawTable(node: DiagramNode<TableDraw>, flags: NodeFlags): ReactNode {
  const {title, rows, foldable, folded, more} = node.data;
  return (
    <g className={css.body} data-selected={flags.selected || undefined}>
      <rect className={css.box} width={node.w} height={node.h} />
      <rect className={css.head} x={0.5} y={0.5} width={node.w - 1} height={HEAD - 0.5} />
      <line className={css.headRule} x1={0} x2={node.w} y1={HEAD} y2={HEAD} />
      <text className={css.title} x={10} y={HEAD / 2 + 0.5}>{title}</text>
      {rows.map((row, i) => {
        const y = HEAD + i * ROW;
        return (
          <g key={i} transform={`translate(0 ${y})`} data-column={row.name}>
            {i > 0 ? <line className={css.rowRule} x1={1} x2={node.w - 1} /> : null}
            {row.pk || row.fk ? (
              <g className={css.key} data-key={row.pk ? 'pk' : 'fk'}>
                <circle cx={11.5} cy={ROW / 2} r={2.5} />
                <path d={`M14 ${ROW / 2}H20.5M18 ${ROW / 2}V${ROW / 2 + 2.5}M20.5 ${ROW / 2}V${ROW / 2 + 2}`} />
              </g>
            ) : null}
            <text className={css.column} x={26} y={ROW / 2 + 0.5}>{row.name}</text>
            {row.type ? <text className={css.type} x={node.w - 10} y={ROW / 2 + 0.5}>{row.type}</text> : null}
          </g>
        );
      })}
      {foldable ? (
        <g transform={`translate(0 ${HEAD + rows.length * ROW})`} data-more="">
          <line className={css.rowRule} x1={1} x2={node.w - 1} />
          <rect className={css.moreHit} x={1} y={1} width={node.w - 2} height={ROW - 2} />
          <text className={css.more} x={26} y={ROW / 2 + 0.5}>{folded ? `+ ${fmtNum(more)} more` : 'show fewer'}</text>
        </g>
      ) : null}
    </g>
  );
}

function entityOf(table: Table): EntityRef {
  if (!table.file) return {type: 'node', id: table.name, label: table.name};
  const loc = parseFileLoc(table.file);
  return {type: 'file', id: loc.path, path: loc.path, ...(loc.line != null ? {line: loc.line} : {}), ...(loc.endLine != null ? {endLine: loc.endLine} : {}), label: table.name};
}

function ErBody(p: {id: string; data: unknown; dir: Dir; sized: boolean}) {
  const {id, dir} = p;
  const clean = useMemo(() => cleanSchema(p.data), [p.data]);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((name: string) => {
    setUnfolded(prev => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }, []);

  const model = useMemo(() => {
    if (typeof clean === 'string' || clean.tables.length > MAX_TABLES) return undefined;
    // Row index of each column a relation can attach to, per table, as drawn right now.
    const rowOf = new Map<string, Map<string, number>>();
    const heights = new Map<string, number>();
    const nodes: Array<DiagramNode<TableDraw>> = clean.tables.map(table => {
      const foldable = table.columns.length > VISIBLE_COLUMNS;
      const folded = foldable && !unfolded.has(table.name);
      const visible = table.columns.slice(0, folded ? VISIBLE_COLUMNS : MAX_COLUMNS);
      const more = table.columns.length - visible.length;
      const footer = foldable ? 1 : 0;
      const wanted = Math.max(
        textWidth(table.name, UI_12) + 24,
        ...visible.map(col => 26 + textWidth(col.name, MONO_12) + (col.type ? 16 + textWidth(col.type, MONO_11) + (col.nullable ? 7 : 0) : 0) + 10),
      );
      const w = Math.ceil(Math.max(MIN_W, Math.min(MAX_W, wanted)) / 2) * 2;
      const h = HEAD + Math.max(1, visible.length + footer) * ROW;
      const rows = new Map<string, number>();
      visible.forEach((col, i) => { if (!rows.has(col.name)) rows.set(col.name, i); });
      // A relation to a folded column attaches to the fold row.
      if (folded) for (const col of table.columns.slice(VISIBLE_COLUMNS)) if (!rows.has(col.name)) rows.set(col.name, visible.length);
      rowOf.set(table.name, rows);
      heights.set(table.name, h);
      const keys = table.columns.filter(col => col.pk).map(col => col.name);
      return {
        id: table.name,
        w, h,
        entity: entityOf(table),
        label: table.name,
        detail: [`${fmtNum(table.columns.length)} ${table.columns.length === 1 ? 'column' : 'columns'}`, keys.length > 0 ? `key ${keys.join(', ')}` : undefined].filter(Boolean).join(' · '),
        drillable: foldable,
        data: {
          title: fitText(table.name, w - 20, UI_12),
          rows: visible.map(col => {
            const type = col.type ? col.type + (col.nullable ? '?' : '') : col.nullable ? '?' : undefined;
            // The type gets what the name leaves, and never less than 45% of the row.
            const typeText = type ? fitText(type, Math.max((w - 36) * 0.45, w - 48 - textWidth(col.name, MONO_12)), MONO_11) : undefined;
            return {name: fitText(col.name, w - 36 - (typeText ? textWidth(typeText, MONO_11) + 12 : 0), MONO_12), type: typeText, pk: col.pk, fk: col.fk};
          }),
          foldable,
          folded,
          more,
        },
      };
    });
    const port = (table: string, column: string | undefined): number | undefined => {
      const row = column !== undefined ? rowOf.get(table)?.get(column) : undefined;
      // Rows only line up with an edge that arrives from the side.
      return row === undefined || dir !== 'LR' ? undefined : HEAD + row * ROW + ROW / 2 - (heights.get(table) ?? 0) / 2;
    };
    const edges: DiagramEdge[] = clean.relations.map((rel, i) => {
      const marks = rel.card ? CARDINALITY[rel.card] : undefined;
      const ends = `${rel.from}${rel.fromColumn ? '.' + rel.fromColumn : ''} to ${rel.to}${rel.toColumn ? '.' + rel.toColumn : ''}`;
      return {
        key: String(i),
        from: rel.from,
        to: rel.to,
        label: rel.label,
        fromPort: port(rel.from, rel.fromColumn),
        toPort: port(rel.to, rel.toColumn),
        startMark: marks ? marks[0] : 'none',
        endMark: marks ? marks[1] : 'arrow',
        detail: [ends, rel.card ? CARD_TEXT[rel.card] : undefined, rel.label].filter(Boolean).join(' · '),
      };
    });
    return {nodes, edges};
  }, [clean, unfolded, dir]);

  const onNodeClick = useCallback((node: DiagramNode<TableDraw>, target: Element) => {
    if (!target.closest?.('[data-more]')) return false;
    toggle(node.id);
    return true;
  }, [toggle]);
  const onDrill = useCallback((node: DiagramNode<TableDraw>) => toggle(node.id), [toggle]);

  if (typeof clean === 'string') return <Redline code="E_SHAPE" id={`ERDiagram#${id}`} message={clean} />;
  if (clean.tables.length === 0) return <Empty message="no tables to draw" />;
  if (!model) {
    return <Redline code="E_TOO_LARGE" id={`ERDiagram#${id}`} message={`${fmtNum(clean.tables.length)} tables is more than a diagram can show (${MAX_TABLES}). Bind a part of the schema.`} />;
  }
  const {dropped} = clean;
  const notes = [
    dropped.relations > 0 ? `${fmtNum(dropped.relations)} ${dropped.relations === 1 ? 'relation' : 'relations'} to unknown tables dropped` : undefined,
    dropped.tables > 0 ? `${fmtNum(dropped.tables)} unnamed or repeated ${dropped.tables === 1 ? 'table' : 'tables'} dropped` : undefined,
  ].filter(Boolean);
  const names = clean.tables.slice(0, 6).map(table => table.name.slice(0, 40)).join(', ');
  const ariaLabel = `Entity-relationship diagram, ${clean.tables.length} ${clean.tables.length === 1 ? 'table' : 'tables'}, ${clean.relations.length} ${clean.relations.length === 1 ? 'relation' : 'relations'}: ${names}${clean.tables.length > 6 ? ' and more' : ''}`;
  return (
    <Diagram
      id={id}
      name="ERDiagram"
      nodes={model.nodes}
      edges={model.edges}
      dir={dir}
      sized={p.sized}
      ariaLabel={ariaLabel}
      note={notes.join(' · ') || undefined}
      renderNode={drawTable}
      onNodeClick={onNodeClick}
      onDrill={onDrill}
      nodesep={32}
      ranksep={72}
    />
  );
}

export const ERDiagramView: GlView<typeof C.ERDiagram> = ({id, props}) => {
  const state = useDataset<ErData>(props.data);
  return (
    <DataGate state={state} id={`ERDiagram#${id}`}>
      {data => <ErBody id={id} data={data} dir={props.dir === 'TB' ? 'TB' : 'LR'} sized={props.size != null} />}
    </DataGate>
  );
};
