// SequenceDiagram: lifelines and messages from Mermaid-style notation (design 5.6). No layout library: columns are
// actors, rows are steps.
import type * as C from '@glimpse/catalog';
import {parseSequence, type SeqArrow, type SeqAst} from '@glimpse/catalog';
import {useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode} from 'react';
import {Empty, Redline, useSize, useTooltip, type GlView} from '../../kit/index.ts';
import {MONO_11, UI_12, fitText, markPath, roundedPath, textWidth, wrapText} from './edgekit/index.ts';
import css from './SequenceDiagram.module.css';

const PAD = 16;
/** From the outer lifelines to the edge: half an actor box and some air. */
const SIDE = 76;
const ACTOR_MAX_W = 128;
const HEAD_H = 44;
const ACTOR_H = 28;
const MIN_COL = 140;
const MAX_COL = 280;
/** In a cell too narrow for the diagram the gaps between lifelines give way first, down to this share (95 px)... */
const TIGHT = 0.68;
/** ...then the whole drawing is scaled down, to this at most (12 px labels are still 9.6 px); after that it scrolls. */
const MIN_SCALE = 0.8;
const ROW = 36;
const SELF_ROW = 46;
const SELF_REACH = 30;
const NOTE_LINE = 14;
/** Steps drawn; the rest are counted in the last row. A diagram this long is not read as a picture. */
export const MAX_STEPS = 400;
export const MAX_ACTORS = 40;

interface ActorDraw { id: string; label: string; text: string; x: number; w: number }
type RowDraw =
  | {kind: 'message'; index: number; y: number; h: number; n: number; from: number; to: number; arrow: SeqArrow; text: string; full: string; said: string}
  | {kind: 'note'; index: number; y: number; h: number; x: number; w: number; lines: string[]; full: string; said: string};
interface Plan {
  width: number;
  height: number;
  /** What the drawing is scaled by to fit the container: 1, or down to MIN_SCALE in a narrow cell. */
  scale: number;
  actors: ActorDraw[];
  rows: RowDraw[];
  hidden: number;
}

/**
 * Lifeline positions and rows for the parsed diagram at a given container width. Every gap between two lifelines is
 * as wide as the labels that cross it need (at least MIN_COL, at most MAX_COL per lifeline crossed; longer labels
 * are cut), and a diagram narrower than its container is stretched to fill it. A diagram wider than its container
 * first closes its gaps up (to 95 px between lifelines, labels cut to what is left), then is scaled down (to 80%),
 * and only then is wider than the container, which scrolls. A width of 0 plans the diagram at its natural size.
 */
export function planSequence(ast: SeqAst, containerWidth: number): Plan {
  const actors = ast.actors.slice(0, MAX_ACTORS);
  const column = new Map(actors.map((actor, i) => [actor.id, i]));
  const steps = ast.steps.slice(0, MAX_STEPS);
  const last = actors.length - 1;

  // wants[hi]: the distance lifeline `hi` must keep from an earlier lifeline `lo`.
  const wants: Array<Array<[lo: number, distance: number]>> = actors.map(() => []);
  let overhang = 0;
  for (const step of steps) {
    if (step.kind !== 'message') continue;
    const from = column.get(step.from);
    const to = column.get(step.to);
    if (from === undefined || to === undefined) continue;
    const width = textWidth(step.label, UI_12);
    if (from !== to) {
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      wants[hi]!.push([lo, Math.min(width + 44, MAX_COL * (hi - lo))]);
    } else if (from === last) overhang = Math.max(overhang, Math.min(MAX_COL, width + SELF_REACH + 24));
    else wants[from + 1]!.push([from, Math.min(MAX_COL, width + SELF_REACH + 28)]);
  }
  const at: number[] = [];
  actors.forEach((_, i) => {
    let position = i === 0 ? 0 : at[i - 1]! + MIN_COL;
    for (const [lo, distance] of wants[i]!) position = Math.max(position, at[lo]! + distance);
    at.push(position);
  });
  const right = Math.max(SIDE, overhang);
  const span = at[last] ?? 0;
  const room = containerWidth > 0 && span > 0 ? (containerWidth - SIDE - right) / span : 1;
  // Wider than needed: spread out. Narrower: close up, and scale down what closing up cannot gain.
  const stretch = Math.max(TIGHT, Math.min(2, room));
  const content = span * stretch + SIDE + right;
  const scale = containerWidth > 0 && content > containerWidth ? Math.max(MIN_SCALE, containerWidth / content) : 1;
  const width = Math.max(Math.ceil(containerWidth / scale), Math.ceil(content));
  const left = SIDE + (width - content) / 2;
  const x = (i: number) => Math.round(left + (at[i] ?? 0) * stretch);

  const actorDraws = actors.map((actor, i) => {
    const text = fitText(actor.label, ACTOR_MAX_W - 24, UI_12);
    return {id: actor.id, label: actor.label, text, x: x(i), w: Math.ceil(Math.max(64, textWidth(text, UI_12) + 24))};
  });

  const rows: RowDraw[] = [];
  let y = 8;
  let n = 0;
  steps.forEach((step, index) => {
    if (step.kind === 'message') {
      const from = column.get(step.from);
      const to = column.get(step.to);
      if (from === undefined || to === undefined) return;
      n++;
      const self = from === to;
      const room = self ? (from === last ? right : x(from + 1) - x(from)) - SELF_REACH - 20 : Math.abs(x(to) - x(from)) - 40;
      const h = self ? SELF_ROW : ROW;
      const said = `${n}. ${actors[from]!.label} to ${self ? 'itself' : actors[to]!.label}${step.arrow === 'reply' ? ', reply' : step.arrow === 'async' ? ', async' : ''}: ${step.label}`;
      rows.push({kind: 'message', index, y, h, n, from: x(from), to: x(to), arrow: step.arrow, text: fitText(step.label, Math.max(24, room), UI_12), full: step.label, said});
      y += h;
    } else {
      const over = step.over.map(id => column.get(id)).filter((i): i is number => i !== undefined);
      if (over.length === 0) return;
      const lo = Math.min(...over);
      const hi = Math.max(...over);
      const boxWidth = lo === hi ? Math.min(220, Math.max(96, textWidth(step.text, MONO_11) + 20)) : x(hi) - x(lo) + 96;
      const lines = wrapText(step.text, boxWidth - 20, 4, MONO_11);
      const h = lines.length * NOTE_LINE + 10;
      const centre = (x(lo) + x(hi)) / 2;
      rows.push({kind: 'note', index, y: y + 6, h, x: Math.round(centre - boxWidth / 2), w: Math.round(boxWidth), lines, full: step.text, said: `Note over ${step.over.join(', ')}: ${step.text}`});
      y += h + 14;
    }
  });
  return {width, height: y + 16, scale, actors: actorDraws, rows, hidden: ast.steps.length - steps.length};
}

function messageRow(row: Extract<RowDraw, {kind: 'message'}>): ReactNode {
  const self = row.from === row.to;
  const dashed = row.arrow === 'reply';
  if (self) {
    const top = row.y + 14;
    const points = [{x: row.from, y: top}, {x: row.from + SELF_REACH, y: top}, {x: row.from + SELF_REACH, y: top + 18}, {x: row.from, y: top + 18}];
    return (
      <>
        <path className={css.line} d={roundedPath(points)} data-dashed={dashed || undefined} />
        <path className={row.arrow === 'sync' ? css.headSolid : css.headOpen} d={markPath('arrow', points[3], points[2]) + (row.arrow === 'sync' ? 'Z' : '')} />
        <rect className={css.numberPlate} x={row.from + 1} y={top - 6} width={16} height={12} />
        <text className={css.number} x={row.from + 9} y={top + 0.5}>{row.n}</text>
        <text className={css.label} x={row.from + SELF_REACH + 8} y={top + 9.5} data-self="">{row.text}</text>
      </>
    );
  }
  const y = row.y + 24;
  const dir = row.to > row.from ? 1 : -1;
  const from = {x: row.from, y};
  const to = {x: row.to, y};
  return (
    <>
      <path className={css.line} d={`M${from.x} ${y}H${to.x}`} data-dashed={dashed || undefined} />
      <path className={row.arrow === 'sync' ? css.headSolid : css.headOpen} d={markPath('arrow', to, from) + (row.arrow === 'sync' ? 'Z' : '')} />
      <rect className={css.numberPlate} x={row.from + dir * 9 - 8} y={y - 6} width={16} height={12} />
      <text className={css.number} x={row.from + dir * 9} y={y + 0.5}>{row.n}</text>
      <text className={css.label} x={(row.from + row.to) / 2} y={y - 8}>{row.text}</text>
    </>
  );
}

function SequenceBody(p: {ast: SeqAst; sized: boolean}) {
  const {ast} = p;
  const boxRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const {width} = useSize(boxRef);
  const tooltip = useTooltip();
  const plan = useMemo(() => planSequence(ast, Math.floor(width)), [ast, width]);
  const [active, setActive] = useState<number>();
  const activeRow = active !== undefined ? plan.rows[active] : undefined;
  const {scale} = plan;

  // Keep the step the keyboard is on inside the scrolled window, below the sticky actors.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !activeRow) return;
    const top = activeRow.y * scale;
    const bottom = (activeRow.y + activeRow.h + HEAD_H) * scale;
    if (top < scroll.scrollTop) scroll.scrollTop = top;
    else if (bottom > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = bottom - scroll.clientHeight;
  }, [activeRow, scale]);

  // A diagram that is still wider than its cell scrolls sideways: say so at the edge that has more.
  const [more, setMore] = useState({left: false, right: false});
  const measure = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const left = scroll.scrollLeft > 1;
    const right = scroll.scrollLeft + scroll.clientWidth < scroll.scrollWidth - 1;
    setMore(prev => (prev.left === left && prev.right === right ? prev : {left, right}));
  }, []);
  // Measured again whenever the drawing or the cell changes size.
  useEffect(measure, [measure, plan.width, scale, width]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const lastRow = plan.rows.length - 1;
    let next: number | undefined;
    if (event.key === 'ArrowDown') next = active === undefined ? 0 : Math.min(lastRow, active + 1);
    else if (event.key === 'ArrowUp') next = active === undefined ? lastRow : Math.max(0, active - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = lastRow;
    else if (event.key === 'PageDown') next = Math.min(lastRow, (active ?? -1) + 8);
    else if (event.key === 'PageUp') next = Math.max(0, (active ?? 8) - 8);
    else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      if (scrollRef.current) scrollRef.current.scrollLeft += event.key === 'ArrowRight' ? 80 : -80;
    } else if (event.key === 'Escape' && active !== undefined) setActive(undefined);
    else return;
    if (next !== undefined && lastRow >= 0) setActive(next);
    event.preventDefault();
    event.stopPropagation();
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const index = (event.target as Element).closest?.('[data-step]')?.getAttribute('data-step');
    const row = index != null ? plan.rows[Number(index)] : undefined;
    if (row) tooltip.show(<span className={css.tip}>{row.said}</span>, event.clientX, event.clientY);
    else tooltip.hide();
  };

  const messages = plan.rows.filter(row => row.kind === 'message').length;
  const names = plan.actors.slice(0, 8).map(actor => actor.label.slice(0, 40)).join(', ');
  const ariaLabel = `Sequence diagram, ${plan.actors.length} ${plan.actors.length === 1 ? 'participant' : 'participants'}, ${messages} ${messages === 1 ? 'message' : 'messages'}: ${names}${plan.actors.length > 8 ? ' and more' : ''}`;

  return (
    <div ref={boxRef} className={css.root} data-sized={p.sized || undefined}>
      <div ref={scrollRef} className={css.scroll} role="img" aria-label={ariaLabel} tabIndex={0} onKeyDown={onKeyDown} onScroll={measure}>
        {width > 0 ? (
          <>
            <svg className={css.head} width={plan.width * scale} height={HEAD_H * scale} viewBox={`0 0 ${plan.width} ${HEAD_H}`} aria-hidden="true">
              {plan.actors.map(actor => (
                <g key={actor.id} data-actor={actor.id}>
                  <line className={css.lifeline} x1={actor.x} x2={actor.x} y1={8 + ACTOR_H} y2={HEAD_H} />
                  <rect className={css.actor} x={actor.x - actor.w / 2} y={8} width={actor.w} height={ACTOR_H} />
                  <text className={css.actorText} x={actor.x} y={8 + ACTOR_H / 2 + 0.5}>{actor.text}</text>
                </g>
              ))}
            </svg>
            <svg className={css.steps} width={plan.width * scale} height={plan.height * scale} viewBox={`0 0 ${plan.width} ${plan.height}`} data-scale={scale < 1 ? scale.toFixed(2) : undefined} aria-hidden="true" onPointerMove={onPointerMove} onPointerLeave={() => tooltip.hide()}>
              {plan.actors.map(actor => <line key={actor.id} className={css.lifeline} x1={actor.x} x2={actor.x} y1={0} y2={plan.height} />)}
              {plan.rows.map((row, i) => (
                <g key={row.index} className={css.step} data-step={i} data-kind={row.kind} data-arrow={row.kind === 'message' ? row.arrow : undefined} data-active={i === active || undefined}>
                  <rect className={css.stepHit} x={0} y={row.kind === 'note' ? row.y - 6 : row.y} width={plan.width} height={row.kind === 'note' ? row.h + 14 : row.h} />
                  {row.kind === 'message' ? messageRow(row) : (
                    <>
                      <rect className={css.note} x={row.x} y={row.y} width={row.w} height={row.h} />
                      <text className={css.noteText}>
                        {row.lines.map((line, j) => <tspan key={j} x={row.x + row.w / 2} y={row.y + 5 + NOTE_LINE / 2 + j * NOTE_LINE}>{line}</tspan>)}
                      </text>
                    </>
                  )}
                </g>
              ))}
              {plan.hidden > 0 ? <text className={css.hidden} x={PAD} y={plan.height - 4}>{`${plan.hidden} more steps not drawn`}</text> : null}
            </svg>
          </>
        ) : null}
      </div>
      {more.left ? <div className={css.more} data-more="left" aria-hidden="true" /> : null}
      {more.right ? <div className={css.more} data-more="right" aria-hidden="true"><span className={css.moreHint}>scroll →</span></div> : null}
      <div className={css.live} aria-live="polite">{activeRow?.said ?? ''}</div>
    </div>
  );
}

export const SequenceDiagramView: GlView<typeof C.SequenceDiagram> = ({id, props}) => {
  const src = typeof props.src === 'string' ? props.src : '';
  const parsed = useMemo(() => (src.trim() === '' ? undefined : parseSequence(src)), [src]);
  if (!parsed) return <Empty message="no sequence source" />;
  if (!parsed.ok) {
    const shown = parsed.errors.slice(0, 3).map(error => `statement ${error.statement}: ${error.message}`);
    const more = parsed.errors.length - shown.length;
    return <Redline code="E_NOTATION" id={`SequenceDiagram#${id}`} message={shown.join('; ') + (more > 0 ? `; and ${more} more` : '')} />;
  }
  return <SequenceBody ast={parsed.ast} sized={props.size != null} />;
};
