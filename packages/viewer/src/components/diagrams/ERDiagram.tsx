// ERDiagram: tables with column rows and key marks, joined by relations with crow's-foot ends (design 5.6).
import type * as C from '@glimpse/catalog';
import {cleanSchema, parseFileLoc, type EntityRef, type ErData, type SchemaTable} from '@glimpse/catalog';
import {useCallback, useMemo, useState, type ReactNode} from 'react';
import {DataGate, Empty, Redline, fmtNum, useDataset, useReportState, type GlView} from '../../kit/index.ts';
import {
  Diagram, MONO_11, MONO_12, UI_12, fitText, textWidth,
  type DiagramEdge, type DiagramNode, type Dir, type Mark, type NodeFlags,
} from './flowkit/index.ts';
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

/**
 * Decision links-through-node-ids: a table always selects itself as a node. Its file adds the place (so /ui/file follows and Cmd-click
 * opens it, and the tables of one file stay apart by their lines); its `node` adds the diagram nodes it stands for.
 */
function entityOf(table: SchemaTable): EntityRef {
  const loc = table.file !== undefined ? parseFileLoc(table.file) : undefined;
  return {
    type: 'node', id: table.name, label: table.name,
    ...(loc ? {path: loc.path, ...(loc.line != null ? {line: loc.line} : {}), ...(loc.endLine != null ? {endLine: loc.endLine} : {})} : {}),
    ...(table.nodes ? {nodes: [...table.nodes]} : {}),
  };
}

function ErBody(p: {id: string; data: unknown; dir?: Dir}) {
  const {id, dir} = p;
  const cleaned = useMemo(() => cleanSchema(p.data), [p.data]);
  const clean = cleaned.ok ? cleaned.ast : undefined;
  // What the data asked for but is not drawn is told to the model: data written by a patch was never checked by the server.
  const dropped = cleaned.ok ? cleaned.dropped : [];
  // Entries left out, counted: the list folds past 8, and its lines for unknown keys leave nothing out.
  const notDrawn = cleaned.ok ? cleaned.droppedCount : 0;
  useReportState(dropped.length > 0 ? 'W_DROPPED' : undefined, `not drawn: ${dropped.join('; ')}`);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((name: string) => {
    setUnfolded(prev => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }, []);

  const model = useMemo(() => {
    if (!clean || clean.tables.length > MAX_TABLES) return undefined;
    // Row index of each column a relation can attach to, per table, as drawn right now.
    const rowOf = new Map<string, Map<string, number>>();
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
    // A relation between columns attaches at their rows: a port on the table's side, at the middle of the row.
    const port = (table: string, column: string | undefined): number | undefined => {
      const row = column !== undefined ? rowOf.get(table)?.get(column) : undefined;
      return row === undefined ? undefined : HEAD + row * ROW + ROW / 2;
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
  }, [clean, unfolded]);

  const onNodeClick = useCallback((node: DiagramNode<TableDraw>, target: Element) => {
    if (!target.closest?.('[data-more]')) return false;
    toggle(node.id);
    return true;
  }, [toggle]);
  const onDrill = useCallback((node: DiagramNode<TableDraw>) => toggle(node.id), [toggle]);

  if (!cleaned.ok) return <Redline code="E_SHAPE" id={`ERDiagram#${id}`} message={cleaned.error} />;
  const schema = cleaned.ast;
  if (schema.tables.length === 0) return <Empty message="no tables to draw" />;
  if (!model) {
    return <Redline code="E_TOO_LARGE" id={`ERDiagram#${id}`} message={`${fmtNum(schema.tables.length)} tables is more than a diagram can show (${MAX_TABLES}). Bind a part of the schema.`} />;
  }
  const names = schema.tables.slice(0, 6).map(table => table.name.slice(0, 40)).join(', ');
  const ariaLabel = `Entity-relationship diagram, ${schema.tables.length} ${schema.tables.length === 1 ? 'table' : 'tables'}, ${schema.relations.length} ${schema.relations.length === 1 ? 'relation' : 'relations'}: ${names}${schema.tables.length > 6 ? ' and more' : ''}`;
  return (
    <Diagram
      id={id}
      name="ERDiagram"
      nodes={model.nodes}
      edges={model.edges}
      dir={dir}
      ariaLabel={ariaLabel}
      note={notDrawn > 0 ? `${fmtNum(notDrawn)} not drawn` : undefined}
      renderNode={drawTable}
      onNodeClick={onNodeClick}
      onDrill={onDrill}
      // Column types and edge labels are 11 px: the stage opens no further out than keeps them at 10 px.
      minText={11}
      nodeGap={32}
      layerGap={64}
    />
  );
}

export const ERDiagramView: GlView<typeof C.ERDiagram> = ({id, props}) => {
  const state = useDataset<ErData>(props.data);
  return (
    <DataGate state={state} id={`ERDiagram#${id}`}>
      {/* Without dir= the schema is laid out both ways and drawn the way that reads larger in its plate (a fourth
          table was cut at the edge of a narrow plate when it was always left to right). */}
      {data => <ErBody id={id} data={data} dir={props.dir === 'TB' || props.dir === 'LR' ? props.dir : undefined} />}
    </DataGate>
  );
};
