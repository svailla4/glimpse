// The React half of chartkit: the figure every chart draws in, mark navigation (pointer, keyboard, selection,
// tooltips), axes, legend and the one-time draw-in.
import {PATHS, formatFileLoc, type DataInput, type EntityRef, type Rows, type SurfaceMeta} from '@glimpse/catalog';
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type JSX, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject,
} from 'react';
import {
  DataGate, Empty, PlateAside, REPORT_CODES, Redline, assignSlots, useDataset, useHostActions, usePath, useReportState, useSelection, useSize,
  useTooltip, type DataState,
} from '../../../kit/index.ts';
import css from './chartkit.module.css';
import {cleanRows, clipName, clipText, matches, missText, received, say, type FieldMiss, type FieldSet, type Unfit} from './data.ts';
import type {ValueAxis} from './scale.ts';

export interface TipRow {
  label: string;
  value: string;
  /** CSS colour of the series sample drawn before the label. */
  color?: string;
  strong?: boolean;
}

/** One thing a reader can point at: its box in SVG pixels, what the tooltip says and the entity it stands for. */
export interface Mark {
  x: number;
  y: number;
  w: number;
  h: number;
  round?: boolean;
  title: string;
  rows?: TipRow[];
  foot?: string;
  entity?: EntityRef;
  /** Text announced when the keyboard lands on the mark. */
  say: string;
}

export type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export interface NavOptions {
  /** Component id: the source of selection and host actions. */
  id: string;
  marks: readonly Mark[];
  /** The scrolling plot box, so a mark reached by keyboard is scrolled into view. */
  box?: RefObject<HTMLElement | null>;
  /** Arrow movement for grids and spatial layouts. Default: left/up is the previous mark, right/down the next. */
  move?: (from: number, key: ArrowKey) => number;
  /** Enter and double-click. Return true when handled; otherwise Enter selects the mark's entity. Space always selects. */
  activate?: (index: number) => boolean;
  /** Any other key. Return true when handled. */
  key?: (event: KeyboardEvent, index: number) => boolean;
  /** Finds the mark under a point (SVG pixels) when the pointer is not on a `data-i` element. */
  hit?: (x: number, y: number) => number;
  /** False keeps marks from being selected by click or Enter (bins and day cells are not entities). */
  selectable?: boolean;
  /** Replaces the default selection test (same entity, same path, a file inside a selected directory). */
  matcher?: (selected: EntityRef, mark: Mark, index: number) => boolean;
}

export interface Nav {
  /** Index of the mark under the pointer or the keyboard, -1 for none. */
  active: number;
  /** True when `active` was reached by keyboard: the focus ring shows. */
  keyboard: boolean;
  selected: EntityRef | null;
  /** Per mark: is it the selection? Null when the selection is not in this chart, so nothing dims. */
  picked: boolean[] | null;
  svg: RefObject<SVGSVGElement | null>;
  marks: readonly Mark[];
  handlers: {
    onKeyDown(event: KeyboardEvent): void;
    onBlur(): void;
    onPointerMove(event: PointerEvent): void;
    onPointerLeave(): void;
    onClick(event: MouseEvent): void;
    onDoubleClick(event: MouseEvent): void;
  };
}

/** The tooltip body: a title, then label and mono value rows with a line sample for series. */
export function Tip(p: {title: string; rows?: TipRow[]; foot?: string}): JSX.Element {
  return (
    <div className={css.tip}>
      <div className={css.tipTitle}>{say(p.title, 120)}</div>
      {p.rows?.map((row, i) => (
        <div key={i} className={css.tipRow} data-strong={row.strong || undefined}>
          {row.color ? <span className={css.tipKey} style={{background: row.color}} /> : null}
          <span className={css.tipLabel}>{say(row.label, 48)}</span>
          <span className={css.tipValue}>{row.value}</span>
        </div>
      ))}
      {p.foot ? <div className={css.tipFoot}>{p.foot}</div> : null}
    </div>
  );
}

/**
 * Pointer, keyboard and selection behaviour over a list of marks. Marks are drawn by the chart with `data-i` set to
 * their index; events are delegated from the SVG, so thousands of marks carry no handlers of their own.
 */
export function useMarkNav(opts: NavOptions): Nav {
  const {id, marks} = opts;
  const svg = useRef<SVGSVGElement | null>(null);
  const tooltip = useTooltip();
  const {selected, select} = useSelection(id);
  const host = useHostActions(id);
  const [state, setState] = useState({active: -1, keyboard: false});
  const live = useRef(opts);
  live.current = opts;

  const active = state.active < marks.length ? state.active : -1;
  const picked = useMemo(() => {
    if (!selected) return null;
    let any = false;
    const matcher = live.current.matcher;
    const flags = marks.map((mark, index) => {
      const hit = matcher ? matcher(selected, mark, index) : matches(selected, mark.entity);
      any ||= hit;
      return hit;
    });
    return any ? flags : null;
  }, [marks, selected]);

  const tipShown = useRef(false);
  const showTip = useCallback((mark: Mark, x: number, y: number) => {
    tipShown.current = true;
    tooltip.show(<Tip title={mark.title} rows={mark.rows} foot={mark.foot} />, x, y);
  }, [tooltip]);
  const clear = useCallback(() => {
    setState(prev => (prev.active === -1 ? prev : {active: -1, keyboard: false}));
    if (tipShown.current) tooltip.hide();
    tipShown.current = false;
  }, [tooltip]);
  // A new layout (zoom, resize, data) moves the marks: the pointer and its tooltip no longer name what is under them.
  useEffect(clear, [marks, clear]);

  const indexAt = (event: {target: EventTarget; clientX: number; clientY: number}): number => {
    const element = event.target instanceof Element ? event.target.closest('[data-i]') : null;
    if (element) return Number(element.getAttribute('data-i'));
    const hit = live.current.hit;
    const rect = svg.current?.getBoundingClientRect();
    return hit && rect ? hit(event.clientX - rect.left, event.clientY - rect.top) : -1;
  };

  const focusMark = (index: number) => {
    const mark = marks[index];
    if (!mark) return;
    setState({active: index, keyboard: true});
    const box = live.current.box?.current;
    if (box && box.scrollHeight > box.clientHeight) {
      if (mark.y < box.scrollTop) box.scrollTop = Math.max(0, mark.y - 8);
      else if (mark.y + mark.h > box.scrollTop + box.clientHeight) box.scrollTop = mark.y + mark.h + 8 - box.clientHeight;
    }
    const rect = svg.current?.getBoundingClientRect();
    if (rect) showTip(mark, rect.left + mark.x + mark.w, rect.top + mark.y + mark.h / 2);
  };

  const open = (entity: EntityRef | undefined) => {
    if (entity?.path) host.open(formatFileLoc({path: entity.path, line: entity.line, endLine: entity.endLine}));
  };

  const activate = (index: number) => {
    if (live.current.activate?.(index)) return;
    const entity = marks[index]?.entity;
    if (entity && live.current.selectable !== false) select(entity);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const count = marks.length;
    const key = event.key;
    let handled = true;
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
      if (count === 0) return;
      if (active < 0) focusMark(0);
      else if (live.current.move) focusMark(live.current.move(active, key));
      else focusMark(Math.min(count - 1, Math.max(0, active + (key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1))));
    } else if (key === 'Home') focusMark(0);
    else if (key === 'End') focusMark(count - 1);
    else if (key === 'PageUp') focusMark(Math.max(0, active - 10));
    else if (key === 'PageDown') focusMark(Math.min(count - 1, Math.max(0, active) + 10));
    else if (key === 'Escape') {
      select(null);
      clear();
    } else if (live.current.key?.(event, active)) {
      // handled by the chart
    } else if (active < 0) handled = false;
    else if (key === 'Enter') activate(active);
    else if (key === ' ') {
      const entity = marks[active]?.entity;
      if (entity && live.current.selectable !== false) select(entity);
    } else if (key === 'o') open(marks[active]?.entity);
    else if (key === 'c') {
      const entity = marks[active]?.entity;
      if (entity) void navigator.clipboard?.writeText(clipText(entity))?.catch(() => {});
    } else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    const index = indexAt(event);
    const mark = marks[index];
    if (!mark) {
      clear();
      return;
    }
    setState(prev => (prev.active === index && !prev.keyboard ? prev : {active: index, keyboard: false}));
    showTip(mark, event.clientX, event.clientY);
  };

  const onClick = (event: MouseEvent) => {
    const index = indexAt(event);
    const entity = marks[index]?.entity;
    if (!entity) return;
    if (event.metaKey || event.ctrlKey) open(entity);
    else if (live.current.selectable !== false) select(entity);
  };

  const onDoubleClick = (event: MouseEvent) => {
    const index = indexAt(event);
    if (index >= 0 && index < marks.length) live.current.activate?.(index);
  };

  return {
    active,
    keyboard: state.keyboard,
    selected,
    picked,
    svg,
    marks,
    handlers: {onKeyDown, onBlur: clear, onPointerMove, onPointerLeave: clear, onClick, onDoubleClick},
  };
}

/** Nearest mark in the direction of an arrow key. Distance across the direction counts double, so movement stays on course. */
export function spatialStep(marks: readonly Mark[], from: number, key: ArrowKey): number {
  const origin = marks[from];
  if (!origin) return from;
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const sign = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  const ox = origin.x + origin.w / 2;
  const oy = origin.y + origin.h / 2;
  let best = from;
  let bestCost = Infinity;
  for (let i = 0; i < marks.length; i++) {
    if (i === from) continue;
    const mark = marks[i]!;
    const dx = mark.x + mark.w / 2 - ox;
    const dy = mark.y + mark.h / 2 - oy;
    const along = (horizontal ? dx : dy) * sign;
    if (along <= 0) continue;
    const cost = along + Math.abs(horizontal ? dy : dx) * 2;
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  return best;
}

/**
 * True for the first moments after a chart mounts with data, so marks draw in once and never again on refresh.
 * The motion itself is CSS under `[data-draw]`, inside a prefers-reduced-motion query.
 */
export function useDrawIn(): boolean {
  const [drawing, setDrawing] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setDrawing(false), 900);
    return () => clearTimeout(timer);
  }, []);
  return drawing;
}

const MAX_RINGS = 24;

/** `kind` is a frozen test hook (`data-ring`): hot = pointer, focus = keyboard, sel = the surface selection. */
function Ring(p: {mark: Mark; kind: 'hot' | 'focus' | 'sel'; pad: number}): JSX.Element {
  const {mark, pad} = p;
  if (mark.round) return <circle className={css[p.kind]} data-ring={p.kind} cx={mark.x + mark.w / 2} cy={mark.y + mark.h / 2} r={mark.w / 2 + pad} />;
  return <rect className={css[p.kind]} data-ring={p.kind} x={mark.x - pad} y={mark.y - pad} width={Math.max(0, mark.w + pad * 2)} height={Math.max(0, mark.h + pad * 2)} />;
}

export interface FigureProps {
  /** Component name: `data-chart`, used by tests and styles. */
  name: string;
  /** The generated aria-label. */
  label: string;
  nav: Nav;
  /** Ref of the measured plot box; pass the same ref to useSize. */
  boxRef: RefObject<HTMLDivElement | null>;
  /** The cell has a size: fill the box instead of taking the natural height. */
  fill: boolean;
  width: number;
  /** Height of the drawing. Without `fill` it is also the height of the plot box. */
  height: number;
  drawing?: boolean;
  /** HTML above and below the plot: legends, breadcrumbs. */
  header?: ReactNode;
  footer?: ReactNode;
  /** The drawing has its own height (rows, day cells): in a sized cell the footer follows it instead of sitting at the bottom. */
  compact?: boolean;
  /** HTML directly under the drawing, inside the plot box: a legend that stays with a drawing shorter than its box. */
  under?: ReactNode;
  /** False when the chart draws its own selection outline. */
  rings?: boolean;
  /** False when the chart draws its own hover emphasis (a crosshair) instead of the ink outline. */
  hover?: boolean;
  children: ReactNode;
}

/**
 * The box every chart draws in: an optional header, the measured plot holding one SVG that is the component's
 * single tab stop (`role="img"` with the generated label), the focus and selection rings, and a live region that
 * announces the mark under the keyboard.
 */
export function Figure(p: FigureProps): JSX.Element {
  const {nav, width, height} = p;
  const activeMark = nav.active >= 0 ? nav.marks[nav.active] : undefined;
  const rings = useMemo(() => {
    if (p.rings === false || !nav.picked) return [];
    const out: Mark[] = [];
    for (let i = 0; i < nav.picked.length && out.length <= MAX_RINGS; i++) if (nav.picked[i]) out.push(nav.marks[i]!);
    return out.length > MAX_RINGS ? [] : out;
  }, [p.rings, nav.picked, nav.marks]);
  return (
    <div className={css.figure} data-chart={p.name} data-fill={p.fill || undefined}>
      {p.header}
      <div className={css.plot} ref={p.boxRef} data-compact={p.compact || undefined} style={p.fill ? undefined : {height}}>
        {width > 0 && height > 0 ? (
          <div className={css.stage} style={{width, height}}>
            <svg
              ref={nav.svg}
              className={css.svg}
              role="img"
              aria-label={p.label}
              tabIndex={0}
              width={width}
              height={height}
              viewBox={`0 0 ${width} ${height}`}
              data-draw={p.drawing || undefined}
              {...nav.handlers}
            >
              {p.children}
              {rings.map((mark, i) => <Ring key={i} mark={mark} kind="sel" pad={1.5} />)}
              {activeMark && !nav.keyboard && p.hover !== false ? <Ring mark={activeMark} kind="hot" pad={0.5} /> : null}
              {activeMark && nav.keyboard ? <Ring mark={activeMark} kind="focus" pad={3} /> : null}
            </svg>
          </div>
        ) : null}
        {p.under && width > 0 && height > 0 ? <div className={css.under}>{p.under}</div> : null}
      </div>
      {p.footer}
      <span className={css.sr} aria-live="polite">{activeMark && nav.keyboard ? activeMark.say : ''}</span>
    </div>
  );
}

// ---------------------------------------------------------------- axes
/**
 * Value axis: grid lines in the grid ink, the zero baseline (or the axis floor when zero is off the scale) in the
 * strong rule, tick labels in mono 11. `dir: 'y'` draws horizontal lines for a vertical axis with labels at the
 * left of `from`; `dir: 'x'` draws vertical lines for a horizontal axis with labels under `to`.
 */
export function ValueGrid(p: {
  axis: ValueAxis;
  dir: 'x' | 'y';
  from: number;
  to: number;
  fmt: (value: number) => string;
  title?: string;
  /** Where the far end of the plot is when the scale is inset from it (top for `y`, right for `x`): the title sits there. */
  end?: number;
}): JSX.Element {
  const {axis, dir, from, to} = p;
  const [lo, hi] = axis.scale.domain() as [number, number];
  const base = lo <= 0 && hi >= 0 && !axis.log ? 0 : lo;
  const ticks = axis.ticks.includes(base) ? axis.ticks : [base, ...axis.ticks];
  return (
    <g>
      {ticks.map(tick => {
        const at = Math.round(axis.scale(tick)) + 0.5;
        const line = tick === base ? css.baseline : css.grid;
        return dir === 'y' ? (
          <g key={tick}>
            <line className={line} x1={from} x2={to} y1={at} y2={at} />
            {axis.ticks.includes(tick) ? <text className={css.tick} x={from - 8} y={at} dy="0.32em" textAnchor="end">{p.fmt(tick)}</text> : null}
          </g>
        ) : (
          <g key={tick}>
            <line className={line} x1={at} x2={at} y1={from} y2={to} />
            {axis.ticks.includes(tick) ? <text className={css.tick} x={at} y={to + 16} textAnchor="middle">{p.fmt(tick)}</text> : null}
          </g>
        );
      })}
      {p.title ? (
        dir === 'y'
          ? <text className={css.axisTitle} x={from} y={(p.end ?? Math.min(axis.scale(hi), axis.scale(lo))) - 10}>{p.title}</text>
          : <text className={css.axisTitle} x={p.end ?? axis.scale(hi)} y={to + 30} textAnchor="end">{p.title}</text>
      ) : null}
    </g>
  );
}

// ---------------------------------------------------------------- legend
export interface LegendItem {
  key: string;
  label: string;
  /** CSS colour of the swatch. */
  color: string;
  value?: string;
  entity?: EntityRef;
  dim?: boolean;
  selected?: boolean;
}

/** Room for a legend label: 28 characters of mono 11. */
const LEGEND_LABEL_PX = 28 * 6.6;

/**
 * Swatch, label in ink and an optional mono value per series. Items with an entity select it on click; they are not
 * tab stops (the chart is the tab stop and its marks reach the same entities).
 */
export function Legend(p: {items: readonly LegendItem[]; onPick?: (item: LegendItem) => void; start?: ReactNode; end?: ReactNode}): JSX.Element | null {
  if (p.items.length === 0 && !p.end && !p.start) return null;
  return (
    <div className={css.legend} data-chart-legend="">
      {p.start ? <span className={css.legendValue} data-chart-summary="">{p.start}</span> : null}
      {p.items.map(item => {
        // a long name gives way in the middle and keeps its last segment (design D12); the tooltip has all of it
        const name = clipName(item.label, LEGEND_LABEL_PX);
        const body = (
          <>
            <span className={css.swatch} style={{background: item.color}} />
            <span className={css.legendLabel} title={say(item.label, 200)}>
              {name.dir ? <span className={css.legendDir}>{name.dir}</span> : null}
              {name.base}
            </span>
            {item.value ? <span className={css.legendValue}>{item.value}</span> : null}
          </>
        );
        return p.onPick && item.entity ? (
          <button
            key={item.key}
            type="button"
            tabIndex={-1}
            className={`${css.legendItem} ${css.legendPick}`}
            data-dim={item.dim || undefined}
            data-selected={item.selected || undefined}
            data-series={item.key}
            onClick={() => p.onPick?.(item)}
          >
            {body}
          </button>
        ) : (
          <span key={item.key} className={css.legendItem} data-dim={item.dim || undefined} data-series={item.key}>{body}</span>
        );
      })}
      {p.end}
    </div>
  );
}

/** A stepped ramp with its low and high values, for heat legends. */
export function Ramp(p: {steps: readonly string[]; low: string; high: string}): JSX.Element {
  return (
    <span className={css.ramp} data-chart-ramp="">
      <span className={css.rampText}>{p.low}</span>
      {p.steps.map((color, i) => <span key={i} className={css.rampStep} style={{background: color}} />)}
      <span className={css.rampText}>{p.high}</span>
    </span>
  );
}

// ---------------------------------------------------------------- notes and errors
/** A mono marginal note in the plate header: rows skipped, points left off a log scale, weeks dropped. */
export function Note(p: {children: ReactNode}): JSX.Element | null {
  if (p.children == null || p.children === '' || p.children === false) return null;
  return <PlateAside><span className={css.note} data-chart-note="">{p.children}</span></PlateAside>;
}

/** Joins the parts of a note that have something to say. */
export function notes(...parts: Array<string | false | undefined | null>): string {
  return parts.filter(Boolean).join(' · ');
}

/** The redline for a wrong top-level type, stating what was expected and what arrived. */
export function ShapeError(p: {name: string; id: string; expected: string; value: unknown}): JSX.Element {
  return <Redline code="E_SHAPE" id={`${p.name}#${p.id}`} message={`expected ${p.expected}, received ${received(p.value)}`} />;
}

/**
 * A chart that has nothing to draw: the kit's empty look, reported under the code that says why (W_FIELD for a
 * field the data does not have, W_SHAPE for data with nothing the chart can draw; decision D14) instead of the
 * kit's W_EMPTY, which is about missing data.
 */
export function Unable(p: Unfit): JSX.Element {
  return <Empty code={p.code} message={p.message} />;
}

/**
 * A chart that drew its default encoding for field names the data does not have (decision D15) still tells the
 * model which names it could not find (W_FIELD, D14); the plate header says it to the person (missNote). It is the
 * component's state while the chart draws that way, and goes when the spec names fields the data has.
 */
export function MissReport(p: {misses: readonly FieldMiss[]; fields: FieldSet; source?: string}): null {
  useReportState(p.misses.length > 0 ? REPORT_CODES.field : undefined, p.misses.length > 0 ? missText(p.misses, p.fields, p.source) : '');
  return null;
}

// ---------------------------------------------------------------- canvas
/**
 * A canvas inside the SVG, for marks too many to be elements. It sits in the drawing order like any other layer
 * (above the grid, below labels and rings) and takes no pointer events: the chart finds marks by position.
 */
export function CanvasLayer(p: {canvasRef: RefObject<HTMLCanvasElement | null>; width: number; height: number}): JSX.Element {
  return (
    <foreignObject className={css.canvasLayer} x={0} y={0} width={p.width} height={p.height} data-chart-canvas="">
      <canvas ref={p.canvasRef} className={css.canvas} />
    </foreignObject>
  );
}

/** Sizes a canvas for the device pixel ratio and returns its cleared 2D context, or null where canvas is unavailable. */
export function prepareCanvas(canvas: HTMLCanvasElement | null, width: number, height: number): CanvasRenderingContext2D | null {
  const context = canvas?.getContext('2d') ?? null;
  if (!canvas || !context) return null;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return context;
}

function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick(n => n + 1);
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme', 'class']});
    const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
    media?.addEventListener?.('change', bump);
    return () => {
      observer.disconnect();
      media?.removeEventListener?.('change', bump);
    };
  }, []);
  return tick;
}

/**
 * Resolves CSS colour expressions (`var(--gl-seq-3)`) to concrete colours for a canvas, which cannot read tokens.
 * Resolved again when the theme changes. Null until the element is mounted.
 */
export function useInks(ref: RefObject<Element | null>, exprs: readonly string[]): string[] | null {
  const tick = useThemeTick();
  const key = exprs.join('|');
  const [inks, setInks] = useState<{key: string; tick: number; colors: string[]} | null>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const probe = document.createElement('span');
    probe.style.display = 'none';
    host.appendChild(probe);
    const colors = key.split('|').map(expr => {
      probe.style.color = '';
      probe.style.color = expr;
      return getComputedStyle(probe).color || 'gray';
    });
    probe.remove();
    setInks({key, tick, colors});
  }, [ref, key, tick]);
  return inks && inks.key === key ? inks.colors : null;
}

// ---------------------------------------------------------------- gates and boxes
/**
 * While a dataset is pending in a cell without a `size`, the drafting frame holds the height the chart is going to
 * take, so the page does not reflow when the data arrives (design 5.1: drafting "at final size"). A sized cell
 * already has its height.
 */
export function reserve(state: DataState<unknown>, size: string | undefined, gate: JSX.Element, height: number = DEFAULT_HEIGHT): JSX.Element {
  return state.status === 'pending' && size == null ? <div style={{height}} data-chart-reserve="">{gate}</div> : gate;
}

/**
 * The first lines of every rows chart: dataset states through DataGate, then the shape check. `children` gets the
 * object rows, the ready state and how many entries were dropped for not being objects. `size` is the cell's size
 * prop and `height` the height the chart takes without one (see reserve).
 */
export function RowsGate(p: {
  name: string;
  id: string;
  input: DataInput<Rows>;
  size?: string;
  height?: number;
  children: (rows: Rows, state: DataState<Rows>, skipped: number) => ReactNode;
}): JSX.Element {
  const state = useDataset<Rows>(p.input);
  return reserve(state, p.size, (
    <DataGate state={state} id={`${p.name}#${p.id}`}>
      {(data, ready) => {
        const cleaned = cleanRows(data);
        if (!cleaned || cleaned.rows.length === 0) return <ShapeError name={p.name} id={p.id} expected="an array of row objects" value={data} />;
        return p.children(cleaned.rows, ready, cleaned.skipped);
      }}
    </DataGate>
  ), p.height);
}

/** The measured plot box of a chart. Width and height are 0 until the first layout pass. */
export function useChartBox(size: string | undefined): {boxRef: RefObject<HTMLDivElement | null>; fill: boolean; width: number; height: number} {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const measured = useSize(boxRef);
  return {boxRef, fill: size != null, width: Math.floor(measured.width), height: Math.floor(measured.height)};
}

/** The server's colour slots for this surface (design 2.4), so an entity keeps its ink across plates. */
export function useSlots(): SurfaceMeta['slots'] | undefined {
  return usePath<SurfaceMeta['slots']>(PATHS.metaSlots);
}

export type Slotter = (names: readonly string[], known?: Record<string, number>) => Map<string, number>;

/**
 * The kit's slot assignment for one chart, remembering what it gave last time (design D6): a series without a
 * session slot keeps the ink it took when it first appeared, so a refresh that adds, drops or re-orders series does
 * not repaint the ones that stay.
 */
export function useSlotter(): Slotter {
  const held = useRef<Map<string, number> | null>(null);
  return useCallback((names, known) => {
    const next = assignSlots(names, known, held.current);
    held.current = next;
    return next;
  }, []);
}

/** Height of a chart that is not given a size: the family default. */
export const DEFAULT_HEIGHT = 280;
