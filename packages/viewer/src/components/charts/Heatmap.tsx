// Heatmap: a matrix of cells on seven quantised steps. With the same entities on both axes it is a dependency
// matrix: one order for rows and columns and a hatched diagonal. Above 60 x 60 the cells move to a canvas.
import type {EntityRef, Field, Roles, Rows} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {useEffect, useId, useMemo, useRef, type JSX} from 'react';
import {Empty, fmtNum, seqVar, useSelection, type DataState, type GlView} from '../../kit/index.ts';
import css from './Heatmap.module.css';
import {
  CanvasLayer, DEFAULT_HEIGHT, Figure, Legend, Note, Ramp, RowsGate, clip, clipName, count, entityOf, fmtValue, inspect, kit, label, matches, notes, num, pick,
  roleY, say, textWidth, time, useChartBox, useDrawIn, prepareCanvas, useInks, useMarkNav, type ArrowKey, type FieldInfo, type Mark,
} from './chartkit/index.ts';

const CANVAS_ABOVE = 60 * 60;
/** Rows and columns kept per axis; the grid is allocated densely, so it must stay bounded whatever the data. */
const MAX_AXIS = 400;
const DIV = ['var(--gl-div-n3)', 'var(--gl-div-n2)', 'var(--gl-div-n1)', 'var(--gl-div-0)', 'var(--gl-div-p1)', 'var(--gl-div-p2)', 'var(--gl-div-p3)'];
const SEQ = [1, 2, 3, 4, 5, 6, 7].map(seqVar);

interface Model {
  rows: string[];
  cols: string[];
  /** Value per cell, row-major; NaN where the data has no cell. */
  values: Float64Array;
  rowEntities: Array<EntityRef | undefined>;
  colEntities: Array<EntityRef | undefined>;
  matrix: boolean;
  lo: number;
  hi: number;
  valueInfo: FieldInfo;
  xInfo: FieldInfo;
  yInfo: FieldInfo;
  bad: number;
  /** Cells left out because their row or column is beyond the axis cap. */
  cut: number;
}

function ordered(labels: Map<string, unknown>, info: FieldInfo): string[] {
  const names = [...labels.keys()];
  if (info.cls === 'cat') return names;
  const key = (name: string) => (info.cls === 'date' ? time(labels.get(name), true) : num(labels.get(name))) ?? Infinity;
  return names.sort((a, b) => key(a) - key(b));
}

function buildModel(rows: Rows, fieldList: Field[] | undefined, roles: Roles | undefined, opts: {x?: string; y?: string; value?: string}): Model | string {
  const fields = inspect(rows, fieldList);
  const valueKey = pick(opts.value, roles?.value, fields.first('num', [opts.x, opts.y])?.key);
  const xKey = pick(opts.x, roles?.x, fields.first('cat', [valueKey, opts.y])?.key, fields.first('date', [valueKey, opts.y])?.key);
  const yKey = pick(opts.y, roleY(roles).find(key => key !== xKey && key !== valueKey), fields.first('cat', [valueKey, xKey])?.key, fields.first('date', [valueKey, xKey])?.key);
  if (!xKey || !yKey || !valueKey) return 'two category fields and a numeric field are needed';
  const xInfo = fields.get(xKey);
  const yInfo = fields.get(yKey);

  const colSeen = new Map<string, unknown>();
  const rowSeen = new Map<string, unknown>();
  const cells: Array<[string, string, number]> = [];
  let bad = 0;
  for (const row of rows) {
    const value = num(row[valueKey]);
    if (value === undefined || row[xKey] == null || row[yKey] == null) {
      bad++;
      continue;
    }
    const col = label(row[xKey]);
    const line = label(row[yKey]);
    if (!colSeen.has(col)) colSeen.set(col, row[xKey]);
    if (!rowSeen.has(line)) rowSeen.set(line, row[yKey]);
    cells.push([line, col, value]);
  }
  if (cells.length === 0) return `no numeric values in "${say(valueKey, 40)}"`;

  const bothModules = xInfo.kind === 'module' && yInfo.kind === 'module';
  const sameDomain = xInfo.kind === undefined && yInfo.kind === undefined && xInfo.cls === 'cat' && yInfo.cls === 'cat'
    && ([...colSeen.keys()].every(name => rowSeen.has(name)) || [...rowSeen.keys()].every(name => colSeen.has(name)));
  const matrix = bothModules || sameDomain;
  let rowNames = ordered(rowSeen, yInfo);
  let colNames = ordered(colSeen, xInfo);
  if (matrix) {
    const union = [...rowNames];
    for (const name of colNames) if (!rowSeen.has(name)) union.push(name);
    rowNames = union;
    colNames = union;
  }
  rowNames = rowNames.slice(0, MAX_AXIS);
  colNames = matrix ? rowNames : colNames.slice(0, MAX_AXIS);
  const rowAt = new Map(rowNames.map((name, i) => [name, i]));
  const colAt = new Map(colNames.map((name, i) => [name, i]));
  const values = new Float64Array(rowNames.length * colNames.length).fill(Number.NaN);
  let lo = Infinity;
  let hi = -Infinity;
  let cut = 0;
  for (const [line, col, value] of cells) {
    const r = rowAt.get(line);
    const c = colAt.get(col);
    if (r === undefined || c === undefined) {
      cut++;
      continue;
    }
    const at = r * colNames.length + c;
    values[at] = Number.isNaN(values[at]!) ? value : values[at]! + value;
  }
  for (const value of values) {
    if (Number.isNaN(value)) continue;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  const entityInfo = (info: FieldInfo): FieldInfo => (matrix && info.kind === undefined ? {...info, kind: 'module'} : info);
  return {
    rows: rowNames,
    cols: colNames,
    values,
    rowEntities: rowNames.map(name => entityOf(entityInfo(yInfo), name)),
    colEntities: colNames.map(name => entityOf(entityInfo(xInfo), name)),
    matrix,
    lo,
    hi,
    valueInfo: fields.get(valueKey),
    xInfo,
    yInfo,
    bad,
    cut,
  };
}

/**
 * Ramp index 0..6 of a value. Diverging: around zero. Sequential over values that are never negative: zero is the
 * first step and everything above it shares the other six, so a cell that has any value at all is never the
 * faintest ink (a dependency matrix is first of all about which cells are there). With negative values: seven
 * equal steps from the low end.
 */
function stepOf(value: number, model: Model, diverging: boolean): number {
  if (diverging) {
    const reach = Math.max(Math.abs(model.lo), Math.abs(model.hi));
    return reach === 0 ? 3 : 3 + Math.round((value / reach) * 3);
  }
  const lo = Math.min(0, model.lo);
  if (model.hi === lo) return 3;
  if (lo === 0) return value <= 0 ? 0 : Math.min(6, 1 + Math.floor((value / model.hi) * 6));
  return Math.min(6, Math.floor(((value - lo) / (model.hi - lo)) * 7));
}

interface Layout {
  width: number;
  height: number;
  left: number;
  top: number;
  cw: number;
  ch: number;
  upright: boolean;
  rowLabelW: number;
  colLabelW: number;
  marks: Mark[];
  /** Mark index per cell, -1 where there is none. */
  cellMark: Int32Array;
  /** Cell index per mark. */
  markCell: number[];
  steps: Uint8Array;
}

function layoutCells(model: Model, diverging: boolean, width: number, boxHeight: number, fill: boolean): Layout {
  const nRows = model.rows.length;
  const nCols = model.cols.length;
  let widestRow = 0;
  for (const name of model.rows) widestRow = Math.max(widestRow, textWidth(name));
  let widestCol = 0;
  for (const name of model.cols) widestCol = Math.max(widestCol, textWidth(name));
  // row names take up to 180 px, less when the columns would then not fit at their smallest
  const rowLabelW = Math.min(widestRow, 180, width * 0.3, Math.max(96, width - nCols * 12 - 8));
  const left = Math.ceil(rowLabelW) + 8;
  // a small grid takes larger cells instead of leaving most of the plate blank
  const cw = Math.max(12, Math.min(model.matrix ? 72 : 96, Math.floor((width - left) / nCols)));
  const upright = widestCol + 6 <= cw;
  const colLabelW = upright ? cw - 4 : Math.min(widestCol, 120);
  const top = upright ? 18 : Math.ceil(colLabelW) + 8;
  const room = (fill ? Math.max(120, boxHeight) : DEFAULT_HEIGHT) - top - 2;
  const ch = model.matrix ? Math.min(cw, 40) : Math.max(12, Math.min(40, Math.floor(room / nRows)));

  const steps = new Uint8Array(nRows * nCols);
  const cellMark = new Int32Array(nRows * nCols).fill(-1);
  const markCell: number[] = [];
  const marks: Mark[] = [];
  const arrow = model.matrix ? ' → ' : ' · ';
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      const at = r * nCols + c;
      const value = model.values[at]!;
      if (Number.isNaN(value)) continue;
      steps[at] = stepOf(value, model, diverging);
      cellMark[at] = marks.length;
      markCell.push(at);
      const text = fmtValue(value, model.valueInfo);
      marks.push({
        x: left + c * cw, y: top + r * ch, w: cw - 2, h: ch - 2,
        title: `${model.rows[r]}${arrow}${model.cols[c]}`,
        rows: [{label: model.valueInfo.label, value: text}],
        entity: model.rowEntities[r],
        say: `${say(model.rows[r]!, 40)}${model.matrix ? ' to ' : ', '}${say(model.cols[c]!, 40)}, ${text}`,
      });
    }
  }
  return {width: Math.max(width, left + nCols * cw), height: top + nRows * ch + 2, left, top, cw, ch, upright, rowLabelW, colLabelW, marks, cellMark, markCell, steps};
}

function Plot(p: {id: string; rows: Rows; state: DataState<Rows>; skipped: number; props: C.ViewProps<typeof C.Heatmap>}): JSX.Element {
  const {id, rows, state, props} = p;
  const model = useMemo(
    () => buildModel(rows, state.fields, state.roles, {x: props.x, y: props.y, value: props.value}),
    [rows, state.fields, state.roles, props.x, props.y, props.value],
  );
  if (typeof model === 'string') return <Empty message={`${model}${state.ds ? ` (${state.ds.source})` : ''}`} />;
  return <Cells id={id} model={model} skipped={p.skipped} props={props} />;
}

function Cells(p: {id: string; model: Model; skipped: number; props: C.ViewProps<typeof C.Heatmap>}): JSX.Element {
  const {id, model, props} = p;
  const {boxRef, fill, width, height: boxHeight} = useChartBox(props.size);
  const diverging = props.mode === 'div';
  const layout = useMemo(
    () => (width <= 0 ? undefined : layoutCells(model, diverging, width, boxHeight, fill)),
    [model, diverging, width, boxHeight, fill],
  );
  const nCols = model.cols.length;
  const nRows = model.rows.length;
  const onCanvas = nRows * nCols > CANVAS_ABOVE;
  const {selected, select} = useSelection(id);
  const nav = useMarkNav({
    id,
    marks: layout?.marks ?? [],
    box: boxRef,
    move: (from: number, key: ArrowKey) => {
      if (!layout) return from;
      const cell = layout.markCell[from] ?? 0;
      const dr = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0;
      const dc = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
      let r = Math.floor(cell / nCols) + dr;
      let c = (cell % nCols) + dc;
      while (r >= 0 && r < nRows && c >= 0 && c < nCols) {
        const mark = layout.cellMark[r * nCols + c]!;
        if (mark >= 0) return mark;
        r += dr;
        c += dc;
      }
      return from;
    },
    hit: (x, y) => {
      if (!layout || x < layout.left || y < layout.top) return -1;
      const c = Math.floor((x - layout.left) / layout.cw);
      const r = Math.floor((y - layout.top) / layout.ch);
      return c < nCols && r < nRows ? (layout.cellMark[r * nCols + c] ?? -1) : -1;
    },
  });
  const drawing = useDrawIn();
  const hatch = `gl-hatch-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const ramp = diverging ? DIV : SEQ;
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const inks = useInks(boxRef, ramp);

  // a selected entity lights its whole row and, in a matrix, its column too
  const lit = useMemo(() => {
    if (!selected) return undefined;
    const row = model.rowEntities.findIndex(entity => matches(selected, entity));
    const col = model.colEntities.findIndex(entity => matches(selected, entity));
    return row < 0 && col < 0 ? undefined : {row, col};
  }, [model, selected]);
  useEffect(() => {
    if (!layout || !onCanvas || !inks) return;
    const context = prepareCanvas(canvas.current, layout.width, layout.height);
    if (!context) return;
    for (const cell of layout.markCell) {
      const off = lit !== undefined && Math.floor(cell / nCols) !== lit.row && cell % nCols !== lit.col;
      context.globalAlpha = off ? 0.35 : 1;
      context.fillStyle = inks[layout.steps[cell]!] ?? inks[0]!;
      context.fillRect(layout.left + (cell % nCols) * layout.cw, layout.top + Math.floor(cell / nCols) * layout.ch, layout.cw - 2, layout.ch - 2);
    }
  }, [layout, onCanvas, inks, lit, nCols]);

  const cells = useMemo(() => {
    if (!layout || onCanvas) return null;
    const {left, top, cw, ch} = layout;
    let blank = '';
    for (let cell = 0; cell < layout.cellMark.length; cell++) {
      if (layout.cellMark[cell]! >= 0) continue;
      const r = Math.floor(cell / nCols);
      const c = cell % nCols;
      if (model.matrix && r === c) continue;
      blank += `M${left + c * cw + 0.5},${top + r * ch + 0.5}h${cw - 3}v${ch - 3}h${-(cw - 3)}z`;
    }
    const printed = cw >= 28 && ch >= 14;
    return (
      <>
        {blank ? <path className={css.blank} d={blank} /> : null}
        {model.matrix ? model.rows.map((_, i) => <rect key={i} x={left + i * cw} y={top + i * ch} width={cw - 2} height={ch - 2} fill={`url(#${hatch})`} data-diagonal="" />) : null}
        {layout.markCell.map((cell, i) => {
          const step = layout.steps[cell]!;
          const x = left + (cell % nCols) * cw;
          const y = top + Math.floor(cell / nCols) * ch;
          const strong = diverging ? Math.abs(step - 3) >= 2 : step >= 4;
          const value = model.values[cell]!;
          return (
            <g key={cell} data-i={i} data-entity="" data-step={step + 1} data-dim={lit !== undefined && Math.floor(cell / nCols) !== lit.row && cell % nCols !== lit.col ? '' : undefined}>
              <rect x={x} y={y} width={cw - 2} height={ch - 2} style={{fill: ramp[step]}} />
              {printed ? <text className={strong ? css.onStrong : css.onLight} x={x + (cw - 2) / 2} y={y + (ch - 2) / 2} dy="0.32em" textAnchor="middle">{clip(fmtNum(value, Math.abs(value) >= 10_000 ? 'compact' : 'num'), cw - 4)}</text> : null}
            </g>
          );
        })}
      </>
    );
  }, [layout, onCanvas, model, nCols, diverging, ramp, hatch, lit]);

  let peak = 0;
  for (let cell = 0; cell < model.values.length; cell++) {
    const value = model.values[cell]!;
    if (!Number.isNaN(value) && (Number.isNaN(model.values[peak]!) || value > model.values[peak]!)) peak = cell;
  }
  const aria = `${model.matrix ? 'Dependency matrix' : 'Heatmap'}, ${nRows} ${nRows === 1 ? 'row' : 'rows'} by ${nCols} ${nCols === 1 ? 'column' : 'columns'}, ${say(model.valueInfo.label, 40)} ${fmtValue(model.lo, model.valueInfo)} to ${fmtValue(model.hi, model.valueInfo)}, highest ${say(model.rows[Math.floor(peak / nCols)]!, 40)} ${model.matrix ? 'to' : 'and'} ${say(model.cols[peak % nCols]!, 40)}`;
  const reach = Math.max(Math.abs(model.lo), Math.abs(model.hi));
  // every label up to 400 per axis, then every nth: the tooltip names the rest
  const stride = (count: number) => Math.ceil(count / 400);
  // the row and the column of the cell under the pointer or the keyboard: their labels step forward
  const at = nav.active >= 0 && layout ? layout.markCell[nav.active] : undefined;
  const hotRow = at === undefined ? -1 : Math.floor(at / nCols);
  const hotCol = at === undefined ? -1 : at % nCols;
  const gridWidth = layout ? layout.left + nCols * layout.cw : 0;
  // names keep their last segment (D12): 'typescript/renderers/lit' gives way in the middle, not at the end
  const axisLabel = (name: string, room: number, hot: boolean) => {
    const parts = clipName(name, room);
    return (
      <>
        {parts.dir ? <tspan className={hot ? kit.label : kit.labelDim}>{parts.dir}</tspan> : null}
        <tspan className={hot || at === undefined ? kit.label : css.labelRest}>{parts.base}</tspan>
      </>
    );
  };

  return (
    <>
      <Note>{notes(p.skipped > 0 && `${count(p.skipped, 'row')} skipped`, model.bad > 0 && `${count(model.bad, 'row')} without a value`, model.cut > 0 && `${count(model.cut, 'cell')} beyond ${MAX_AXIS} × ${MAX_AXIS}`)}</Note>
      <Figure
        name="Heatmap"
        label={aria}
        nav={nav}
        boxRef={boxRef}
        fill={fill}
        width={layout?.width ?? 0}
        height={layout?.height ?? (fill ? 0 : DEFAULT_HEIGHT)}
        drawing={drawing}
        rings={false}
        header={(
          // the legend ends where the grid ends, not at the far side of a wide plate
          <div style={gridWidth > 0 ? {maxWidth: Math.max(220, gridWidth)} : undefined} data-chart-key="">
            <Legend
              items={[]}
              end={<Ramp steps={ramp} low={fmtValue(diverging ? -reach : Math.min(0, model.lo), model.valueInfo)} high={fmtValue(diverging ? reach : model.hi, model.valueInfo)} />}
            />
          </div>
        )}
      >
        {layout ? (
          <>
            <defs>
              <pattern id={hatch} width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line className={css.hatch} x1={0} y1={0} x2={0} y2={4} />
              </pattern>
            </defs>
            {model.rows.map((name, r) => (r % stride(nRows) === 0 ? (
              <text key={r} x={layout.left - 8} y={layout.top + r * layout.ch + (layout.ch - 2) / 2} dy="0.32em" textAnchor="end" data-row-label={r} data-hot={r === hotRow || undefined} data-entity="" onClick={() => select(model.rowEntities[r] ?? null)}>
                {axisLabel(name, layout.rowLabelW, r === hotRow)}
              </text>
            ) : null))}
            {model.cols.map((name, c) => {
              if (c % stride(nCols) !== 0) return null;
              const x = layout.left + c * layout.cw + (layout.cw - 2) / 2;
              return (
                <text
                  key={c}
                  data-col-label={c}
                  data-hot={c === hotCol || undefined}
                  data-entity=""
                  onClick={() => select(model.colEntities[c] ?? null)}
                  {...(layout.upright ? {x, y: layout.top - 8, textAnchor: 'middle'} : {transform: `translate(${x + 4},${layout.top - 6}) rotate(-90)`})}
                >
                  {axisLabel(name, layout.colLabelW, c === hotCol)}
                </text>
              );
            })}
            {onCanvas ? <CanvasLayer canvasRef={canvas} width={layout.width} height={layout.height} /> : <g className={kit.fade}>{cells}</g>}
            {lit && lit.row >= 0 ? <rect className={kit.sel} x={layout.left - 2} y={layout.top + lit.row * layout.ch - 2} width={nCols * layout.cw + 2} height={layout.ch + 2} data-selected-row="" /> : null}
            {lit && lit.col >= 0 ? <rect className={kit.sel} x={layout.left + lit.col * layout.cw - 2} y={layout.top - 2} width={layout.cw + 2} height={nRows * layout.ch + 2} data-selected-col="" /> : null}
          </>
        ) : null}
      </Figure>
    </>
  );
}

export const HeatmapView: GlView<typeof C.Heatmap> = ({id, props}) => (
  <RowsGate name="Heatmap" id={id} input={props.data} size={props.size}>
    {(rows, state, skipped) => <Plot id={id} rows={rows} state={state} skipped={skipped} props={props} />}
  </RowsGate>
);
