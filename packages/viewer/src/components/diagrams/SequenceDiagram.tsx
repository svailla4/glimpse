// SequenceDiagram: lifelines, messages, notes and blocks written as data (design 5.6, decision diagrams-are-data). No layout
// library: columns are actors, rows are steps, a block is a frame round its rows.
import type * as C from '@glimpse/catalog';
import {cleanSequence, seqLeaves, type EntityRef, type SeqArrow, type SeqAst} from '@glimpse/catalog';
import {useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode} from 'react';
import {
  DataGate, Empty, Redline, fmtNum, marksSelection, useDataset, useReportState, useSelection, useSize, useSizeCap, useTooltip, type GlView,
} from '../../kit/index.ts';
import {MONO_11, UI_12, fitText, markPath, roundedPath, textWidth, wrapText, type Face} from './flowkit/index.ts';
import css from './SequenceDiagram.module.css';

const PAD = 16;
/** From the outer lifelines to the edge: half an actor box and some air. */
const SIDE = 76;
/** An actor's name is drawn whole up to this box width; only a plate too narrow for the names cuts them to the second. */
const ACTOR_MAX_W = 224;
const ACTOR_TIGHT_W = 128;
/** Between the boxes of two neighbouring actors, at least. */
const ACTOR_GAP = 16;
const HEAD_H = 44;
const ACTOR_H = 28;
const MIN_COL = 140;
const MAX_COL = 280;
/** A label longer than a gap of MAX_COL may widen it this far per lifeline crossed, to fit on two lines. */
const MAX_WRAP_COL = 400;
/** In a cell too narrow for the diagram the gaps between lifelines give way first, down to this share (95 px)... */
const TIGHT = 0.68;
/**
 * ...then the whole drawing is scaled down, to this at most: its smallest text (11 px step numbers and notes) stays
 * 10 px on screen (design rule diagrams-open-readable). After that it scrolls.
 */
const MIN_SCALE = 0.91;
/** A message label too long for its gap takes a second line before it is cut. */
const LABEL_LINES = 2;
const LABEL_LINE = 15;
const ROW = 36;
const SELF_ROW = 46;
const SELF_REACH = 30;
const NOTE_LINE = 14;
/** Steps drawn; the rest are counted in the last row. A diagram this long is not read as a picture. */
export const MAX_STEPS = 400;
export const MAX_ACTORS = 40;
/**
 * A message's selection label is what it says, cut to this length: the server keeps no label over 1,024 characters,
 * and a selection restored without its label would name no row here (ownRow matches the number and the words).
 */
export const MAX_SAID = 200;
const saidLabel = (said: string) => (said.length > MAX_SAID ? `${said.slice(0, MAX_SAID - 1)}…` : said);

interface ActorDraw { id: string; label: string; text: string; x: number; w: number }
type RowDraw =
  | {kind: 'message'; index: number; y: number; h: number; n: number; from: number; to: number; arrow: SeqArrow; lines: string[]; full: string; said: string}
  | {kind: 'note'; index: number; y: number; h: number; x: number; w: number; lines: string[]; full: string; said: string};
/** An alt, opt, loop ... block: a labelled frame round its steps, a dashed divider per else. */
export interface FrameDraw {
  op: string;
  /** The condition as drawn (in brackets, cut to the frame) and as written. */
  label: string;
  full: string;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  dividers: Array<{y: number; label: string; full: string}>;
}
interface Plan {
  width: number;
  height: number;
  /** What the drawing is scaled by to fit the container: 1, or down to MIN_SCALE in a narrow cell. */
  scale: number;
  actors: ActorDraw[];
  rows: RowDraw[];
  frames: FrameDraw[];
  hidden: number;
}

/** A frame's head (its tab), the band an else divider takes, and the space under a frame's bottom edge. */
const FRAME_HEAD = 28;
const FRAME_ELSE = 26;
const FRAME_END = 12;
const FRAME_TAB_H = 18;
/** How far an outer frame reaches past the lifelines it holds; each nested frame reaches 10 px less. */
const FRAME_REACH = 60;
const FRAME_FACE: Face = {size: 10.5, mono: true};
const FRAME_LABEL: Face = {size: 11};

/** The narrowest width at which `label` fits on LABEL_LINES lines without being cut (a word is never split). */
export function wrapWidth(label: string, face: Face = UI_12): number {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const whole = words.join(' ');
  const full = Math.ceil(textWidth(whole, face));
  if (words.length <= 1) return full;
  let lo = Math.ceil(Math.max(full / LABEL_LINES, ...words.map(word => textWidth(word, face))));
  let hi = full;
  const fits = (w: number) => wrapText(whole, w, LABEL_LINES, face).join(' ') === whole;
  if (fits(lo)) return lo;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Lifeline positions and rows for the parsed diagram at a given container width. Every gap between two lifelines is
 * as wide as the labels that cross it want (at least MIN_COL; on one line up to MAX_COL per lifeline crossed, longer
 * labels on two lines), and a diagram narrower than its container is stretched to fill it. A diagram wider than its
 * container first gives up what its labels do not need to be read whole on two lines, then closes its gaps up (to 95
 * px between lifelines, labels cut to what is left), then is scaled down (to 91%), and only then is wider than the
 * container, which scrolls. A width of 0 plans the diagram at its natural size. alt, opt, loop ... are frames.
 */
export function planSequence(ast: SeqAst, containerWidth: number): Plan {
  const wide = planAt(ast, containerWidth, ACTOR_MAX_W);
  // Whole names first; cut to the narrower box only when that is what keeps the diagram inside its plate.
  // (Scaled down less than the most it may be, it was scaled to the container: it fits, whatever the rounding.)
  if (containerWidth <= 0 || wide.scale > MIN_SCALE + 1e-6 || wide.width * wide.scale <= containerWidth + 0.5) return wide;
  const tight = planAt(ast, containerWidth, ACTOR_TIGHT_W);
  return tight.width * tight.scale < wide.width * wide.scale - 0.5 ? tight : wide;
}

function planAt(ast: SeqAst, containerWidth: number, actorMax: number): Plan {
  const actors = ast.actors.slice(0, MAX_ACTORS);
  const column = new Map(actors.map((actor, i) => [actor.id, i]));
  const steps = ast.steps.slice(0, MAX_STEPS);
  const last = actors.length - 1;
  // The actor boxes, first: two neighbours never come closer than their half-widths and a gap, however the
  // messages between them are spaced (two boxes shared a border, and two overlapped by 15 px at 760 px).
  const heads = actors.map(actor => {
    const text = fitText(actor.label, actorMax - 24, UI_12);
    return {text, w: Math.ceil(Math.max(64, textWidth(text, UI_12) + 24))};
  });
  // (Rounded up, and a pixel more: lifelines are drawn at whole pixels.)
  const hard = heads.map((head, i) => (i === 0 ? 0 : Math.ceil((heads[i - 1]!.w + head.w) / 2) + ACTOR_GAP + 1));

  // wants[hi]: the distance lifeline `hi` keeps from an earlier lifeline `lo`, as the labels want it (natural: on one
  // line when a gap of MAX_COL holds it, else on two up to MAX_WRAP_COL) and as they need it to be read whole on two
  // lines (compact). A label of one long word ('auth-flow-2026-11-20.html') needs all of its width.
  const natural: Array<Array<[lo: number, distance: number]>> = actors.map(() => []);
  const compact: Array<Array<[lo: number, distance: number]>> = actors.map(() => []);
  let overhang = 0;
  for (const step of steps) {
    if (step.kind !== 'message') continue;
    const from = column.get(step.from);
    const to = column.get(step.to);
    if (from === undefined || to === undefined) continue;
    const width = textWidth(step.label, UI_12);
    const two = wrapWidth(step.label);
    const want = (extra: number, span: number) => Math.min(width + extra, Math.max(MAX_COL * span, Math.min(two + extra, MAX_WRAP_COL * span)));
    const need = (extra: number, span: number) => Math.min(want(extra, span), two + extra);
    if (from !== to) {
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      natural[hi]!.push([lo, want(44, hi - lo)]);
      compact[hi]!.push([lo, need(44, hi - lo)]);
    } else if (from === last) overhang = Math.max(overhang, want(SELF_REACH + 24, 1));
    else {
      natural[from + 1]!.push([from, want(SELF_REACH + 28, 1)]);
      compact[from + 1]!.push([from, need(SELF_REACH + 28, 1)]);
    }
  }
  const place = (wants: typeof natural, floor: number) => {
    const out: number[] = [];
    actors.forEach((_, i) => {
      let position = i === 0 ? 0 : out[i - 1]! + Math.max(floor, hard[i]!);
      for (const [lo, distance] of wants[i]!) position = Math.max(position, out[lo]! + distance);
      out.push(position);
    });
    return out;
  };
  // As the labels want them; as they need them, MIN_COL apart; as they need them and no more than the boxes ask.
  const roomy = place(natural, MIN_COL);
  const least = place(compact, MIN_COL);
  const bare = place(compact, 0);
  const sideL = Math.max(SIDE, (heads[0]?.w ?? 0) / 2 + 12);
  const right = Math.max(SIDE, overhang, (heads[last]?.w ?? 0) / 2 + 12);
  const available = containerWidth - sideL - right;
  // Narrower than the labels want: first give up what they do not need to be read whole on two lines, then the even
  // spacing. Every placement between two of these keeps each two-line need (they all do), so the widest that fits is
  // taken; when even the barest does not, it is scaled down (to MIN_SCALE) before anything is cut. Only past that do
  // the gaps the labels want close up (below), which cuts them.
  let at = roomy;
  let closeUp = true;
  if (containerWidth > 0 && (roomy[last] ?? 0) > available) {
    const between = (u: number) => (u <= 1
      ? least.map((p, i) => bare[i]! + (p - bare[i]!) * u)
      : roomy.map((p, i) => least[i]! + (p - least[i]!) * (u - 1)));
    if ((bare[last] ?? 0) <= available) {
      let lo = 0;
      let hi = 2;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if ((between(mid)[last] ?? 0) <= available) lo = mid;
        else hi = mid;
      }
      at = between(lo);
    } else {
      // Closing up cuts labels: worth it only when it then fits the plate. A diagram that scrolls anyway keeps them whole.
      const closed = roomy.reduce((sum, p, i) => (i === 0 ? 0 : sum + Math.max(hard[i]!, (p - roomy[i - 1]!) * TIGHT)), 0);
      if (((bare[last] ?? 0) + sideL + right) * MIN_SCALE <= containerWidth) {
        at = bare;
        closeUp = false;
      } else if ((closed + sideL + right) * MIN_SCALE > containerWidth + 0.5) {
        // It scrolls: closed up as far as it would be, but never so far that a label is cut.
        const scrolled = [0];
        for (let i = 1; i < roomy.length; i++) scrolled.push(scrolled[i - 1]! + Math.max(hard[i]!, (roomy[i]! - roomy[i - 1]!) * TIGHT, bare[i]! - bare[i - 1]!));
        at = scrolled;
        closeUp = false;
      }
    }
  }
  // Gaps between neighbours at a stretch: the messages' gap stretched, never under the boxes' own.
  const gaps = (stretch: number) => at.map((p, i) => (i === 0 ? 0 : Math.max(hard[i]!, (p - at[i - 1]!) * stretch)));
  const spanAt = (stretch: number) => gaps(stretch).reduce((sum, gap) => sum + gap, 0);
  const span = at[last] ?? 0;
  // Wider than needed: spread out. Still narrower: close up (the largest stretch that fits, not under TIGHT), and
  // scale down what closing up cannot gain.
  let stretch = !closeUp ? 1 : containerWidth > 0 && span > 0 ? Math.max(TIGHT, Math.min(2, available / span)) : 1;
  if (closeUp && containerWidth > 0 && span > 0 && spanAt(stretch) > available) {
    let lo = TIGHT;
    let hi = stretch;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (spanAt(mid) <= available) lo = mid;
      else hi = mid;
    }
    stretch = lo;
  }
  const steps0 = gaps(stretch);
  const content = steps0.reduce((sum, gap) => sum + gap, 0) + sideL + right;
  const scale = containerWidth > 0 && content > containerWidth ? Math.max(MIN_SCALE, containerWidth / content) : 1;
  const width = Math.max(Math.ceil(containerWidth / scale), Math.ceil(content));
  const left = sideL + (width - content) / 2;
  const offsets: number[] = [];
  for (const [i, gap] of steps0.entries()) offsets.push((offsets[i - 1] ?? 0) + gap);
  const x = (i: number) => Math.round(left + (offsets[i] ?? 0));

  const actorDraws = actors.map((actor, i) => ({id: actor.id, label: actor.label, text: heads[i]!.text, x: x(i), w: heads[i]!.w}));

  const rows: RowDraw[] = [];
  const frames: FrameDraw[] = [];
  // Open frames, innermost last: how far left and right what they hold reaches (drawing x), and the branch they are in.
  const open: Array<{frame: FrameDraw; lo: number; hi: number; branch: string}> = [];
  const hold = (lo: number, hi: number) => {
    for (const entry of open) {
      entry.lo = Math.min(entry.lo, lo);
      entry.hi = Math.max(entry.hi, hi);
    }
  };
  const close = (bottom: number) => {
    const {frame, lo, hi} = open.pop()!;
    const reach = Math.max(24, FRAME_REACH - frame.depth * 10);
    const tab = tabWidth(frame.op);
    // A frame that holds nothing spans every lifeline.
    let x0 = (lo <= hi ? lo : x(0)) - reach;
    let x1 = (lo <= hi ? hi : x(Math.max(0, last))) + reach;
    // Room for the tab and the condition beside it, then inside the drawing.
    const head = tab + (frame.full ? Math.min(textWidth(`[${frame.full}]`, FRAME_LABEL), 280) + 16 : 8);
    if (x1 - x0 < head) x1 = x0 + head;
    x0 = Math.max(4 + frame.depth * 4, x0);
    x1 = Math.min(width - 4 - frame.depth * 4, x1);
    frame.x = Math.round(x0);
    frame.w = Math.round(x1 - x0);
    frame.h = bottom - frame.y;
    frame.label = frame.full ? fitText(`[${frame.full}]`, frame.w - tab - 16, FRAME_LABEL) : '';
    for (const divider of frame.dividers) divider.label = divider.full ? fitText(`[${divider.full}]`, frame.w - 16, FRAME_LABEL) : '';
  };
  const where = () => {
    const top = open.at(-1);
    return top ? ` (${top.frame.op}${top.branch ? ` ${top.branch}` : ''})` : '';
  };
  let y = 8;
  let n = 0;
  steps.forEach((step, index) => {
    if (step.kind === 'frame') {
      if (step.edge === 'open') {
        const frame: FrameDraw = {op: step.op, label: '', full: step.label, x: 0, y: y + 4, w: 0, h: 0, depth: open.length, dividers: []};
        frames.push(frame);
        open.push({frame, lo: Infinity, hi: -Infinity, branch: step.label});
        y += FRAME_HEAD;
      } else if (step.edge === 'else') {
        const top = open.at(-1);
        if (!top) return;
        top.frame.dividers.push({y: y + 2, label: '', full: step.label});
        top.branch = step.label;
        y += FRAME_ELSE;
      } else if (open.length > 0) {
        close(y + 2);
        y += FRAME_END;
      }
      return;
    }
    if (step.kind === 'message') {
      const from = column.get(step.from);
      const to = column.get(step.to);
      if (from === undefined || to === undefined) return;
      n++;
      const self = from === to;
      const room = Math.max(24, self ? (from === last ? right : x(from + 1) - x(from)) - SELF_REACH - 20 : Math.abs(x(to) - x(from)) - 40);
      // Cut only what two lines cannot hold (V014).
      const lines = textWidth(step.label, UI_12) <= room ? [step.label] : wrapText(step.label, room, LABEL_LINES, UI_12);
      const h = (self ? SELF_ROW : ROW) + (lines.length - 1) * LABEL_LINE;
      const said = `${n}. ${actors[from]!.label} to ${self ? 'itself' : actors[to]!.label}${step.arrow === 'reply' ? ', reply' : step.arrow === 'async' ? ', async' : ''}: ${step.label}${where()}`;
      rows.push({kind: 'message', index, y, h, n, from: x(from), to: x(to), arrow: step.arrow, lines, full: step.label, said});
      // A self-message's label lies to the right of its loop: the frame holds it too.
      const end = self ? x(from) + SELF_REACH + 8 + Math.max(...lines.map(line => textWidth(line, UI_12))) + 12 - FRAME_REACH : x(Math.max(from, to));
      hold(x(Math.min(from, to)), Math.max(x(from), end));
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
      rows.push({kind: 'note', index, y: y + 6, h, x: Math.round(centre - boxWidth / 2), w: Math.round(boxWidth), lines, full: step.text, said: `Note over ${step.over.join(', ')}: ${step.text}${where()}`});
      hold(Math.min(x(lo), centre - boxWidth / 2 - 12 + FRAME_REACH), Math.max(x(hi), centre + boxWidth / 2 + 12 - FRAME_REACH));
      y += h + 14;
    }
  });
  // Frames the cut at MAX_STEPS left open end with the drawing.
  while (open.length > 0) {
    close(y + 2);
    y += FRAME_END;
  }
  return {width, height: y + 16, scale, actors: actorDraws, rows, frames, hidden: ast.steps.length - steps.length};
}

const tabWidth = (op: string) => Math.ceil(textWidth(op, FRAME_FACE)) + 18;

function frameView(frame: FrameDraw, i: number): ReactNode {
  const tab = tabWidth(frame.op);
  const {x, y} = frame;
  return (
    <g key={i} data-frame={frame.op} data-depth={frame.depth}>
      <rect className={css.frameBox} x={x} y={y} width={frame.w} height={frame.h} />
      <path className={css.frameTab} d={`M${x} ${y}H${x + tab}V${y + FRAME_TAB_H - 6}L${x + tab - 6} ${y + FRAME_TAB_H}H${x}Z`} />
      <text className={css.frameOp} x={x + 7} y={y + FRAME_TAB_H / 2 + 0.5}>{frame.op}</text>
      {frame.label ? <text className={css.frameLabel} x={x + tab + 8} y={y + FRAME_TAB_H / 2 + 0.5}>{frame.label}</text> : null}
      {frame.dividers.map((divider, j) => (
        <g key={j} data-divider="">
          <line className={css.frameDivider} x1={x} x2={x + frame.w} y1={divider.y} y2={divider.y} />
          {divider.label ? <text className={css.frameLabel} x={x + 8} y={divider.y + 11}>{divider.label}</text> : null}
        </g>
      ))}
    </g>
  );
}

function messageRow(row: Extract<RowDraw, {kind: 'message'}>): ReactNode {
  const self = row.from === row.to;
  const dashed = row.arrow === 'reply';
  const more = (row.lines.length - 1) * LABEL_LINE;
  if (self) {
    const top = row.y + 14 + more / 2;
    const points = [{x: row.from, y: top}, {x: row.from + SELF_REACH, y: top}, {x: row.from + SELF_REACH, y: top + 18}, {x: row.from, y: top + 18}];
    return (
      <>
        <path className={css.line} d={roundedPath(points)} data-dashed={dashed || undefined} />
        <path className={row.arrow === 'sync' ? css.headSolid : css.headOpen} d={markPath('arrow', points[3], points[2]) + (row.arrow === 'sync' ? 'Z' : '')} />
        <rect className={css.numberPlate} x={row.from} y={top - 7} width={18} height={14} />
        <text className={css.number} x={row.from + 9} y={top + 0.5}>{row.n}</text>
        <text className={css.label} data-self="">
          {row.lines.map((line, i) => <tspan key={i} x={row.from + SELF_REACH + 8} y={top + 9.5 + (i - (row.lines.length - 1) / 2) * LABEL_LINE}>{line}</tspan>)}
        </text>
      </>
    );
  }
  const y = row.y + 24 + more;
  const dir = row.to > row.from ? 1 : -1;
  const from = {x: row.from, y};
  const to = {x: row.to, y};
  return (
    <>
      <path className={css.line} d={`M${from.x} ${y}H${to.x}`} data-dashed={dashed || undefined} />
      <path className={row.arrow === 'sync' ? css.headSolid : css.headOpen} d={markPath('arrow', to, from) + (row.arrow === 'sync' ? 'Z' : '')} />
      <rect className={css.numberPlate} x={row.from + dir * 9 - 9} y={y - 7} width={18} height={14} />
      <text className={css.number} x={row.from + dir * 9} y={y + 0.5}>{row.n}</text>
      <text className={css.label}>
        {row.lines.map((line, i) => <tspan key={i} x={(row.from + row.to) / 2} y={y - 8 - (row.lines.length - 1 - i) * LABEL_LINE}>{line}</tspan>)}
      </text>
    </>
  );
}

/**
 * Decision links-through-node-ids: what selecting a drawn row writes, by row: a message is `{type:'message', id:'<component>:<n>'}`
 * standing for the nodes it passes, in order (its sender's node, its `via`, its receiver's node; an actor's node is
 * its id unless written); a note selects nothing. And what selecting an actor's head writes: its node.
 */
function entitiesOf(id: string, ast: SeqAst, plan: Plan): {rows: Array<EntityRef | undefined>; actors: Map<string, EntityRef>; ends: Array<[string, string] | undefined>} {
  const byId = new Map(ast.actors.map(actor => [actor.id, actor]));
  const nodeOf = (actor: string) => byId.get(actor)?.node ?? actor;
  const ends: Array<[string, string] | undefined> = [];
  const rows = plan.rows.map((row): EntityRef | undefined => {
    const step = ast.steps[row.index];
    if (row.kind !== 'message' || step?.kind !== 'message') {
      ends.push(undefined);
      return undefined;
    }
    ends.push([step.from, step.to]);
    // A self-message stands for its node twice: [A, A].
    return {type: 'message', id: `${id}:${row.n}`, label: saidLabel(row.said), nodes: [nodeOf(step.from), ...(step.via ?? []), nodeOf(step.to)]};
  });
  const actors = new Map<string, EntityRef>(plan.actors.map(actor => [actor.id, {type: 'node', id: nodeOf(actor.id), label: actor.label}]));
  return {rows, actors, ends};
}

function SequenceBody(p: {id: string; ast: SeqAst}) {
  const {id, ast} = p;
  // As tall as its steps, up to the plate's maximum height (decision content-sized-plates); past that it scrolls under sticky actors.
  const cap = useSizeCap();
  const boxRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const {width} = useSize(boxRef);
  const tooltip = useTooltip();
  const plan = useMemo(() => planSequence(ast, Math.floor(width)), [ast, width]);
  const [active, setActive] = useState<number>();
  const activeRow = active !== undefined ? plan.rows[active] : undefined;
  const {scale} = plan;
  const {selected, select} = useSelection(id);
  const entities = useMemo(() => entitiesOf(id, ast, plan), [id, ast, plan]);
  // The row of this diagram's message that is the selection, matched by its number and its words: a patch that
  // renumbered the messages leaves the selection naming no row here (its trace still shows elsewhere).
  const ownRow = useMemo(() => {
    if (selected?.type !== 'message' || !selected.id.startsWith(`${id}:`)) return undefined;
    const at = entities.rows.findIndex(entity => entity?.id === selected.id && entity.label === selected.label);
    return at < 0 ? -1 : at;
  }, [selected, entities, id]);
  // A selection restored (a reload, a second tab) or made by a click moves the keyboard's row to it.
  useEffect(() => {
    if (ownRow !== undefined && ownRow >= 0) setActive(ownRow);
  }, [ownRow]);
  const marks = useMemo(() => {
    const rows = new Set<number>();
    const actors = new Set<string>();
    if (ownRow !== undefined) {
      // Stepping through this diagram: its row and the two actors it joins, nothing dimmed, so the sequence stays readable.
      const ends = ownRow >= 0 ? entities.ends[ownRow] : undefined;
      if (ends) {
        rows.add(ownRow);
        for (const actor of ends) actors.add(actor);
      }
      return {rows, actors, dim: false};
    }
    entities.rows.forEach((entity, i) => { if (entity && marksSelection(selected, entity)) rows.add(i); });
    for (const [actor, entity] of entities.actors) if (marksSelection(selected, entity)) actors.add(actor);
    return {rows, actors, dim: rows.size > 0};
  }, [ownRow, entities, selected]);

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
    } else if (event.key === 'Escape' && (active !== undefined || selected)) {
      // The kit's rule (EntityLink): Escape also clears the selection.
      setActive(undefined);
      if (selected) select(null);
    } else return;
    if (next !== undefined && lastRow >= 0) {
      setActive(next);
      // Decision links-through-node-ids: the selection follows the keyboard onto a message (the trace moves with it); a note leaves it.
      const entity = entities.rows[next];
      if (entity && next !== ownRow) select(entity);
    }
    event.preventDefault();
    event.stopPropagation();
  };
  // A click on a message selects it, on a note moves the keyboard's row there; empty space changes nothing (a plain
  // click never deselects, as in the other diagrams).
  const onStepClick = (event: MouseEvent<SVGSVGElement>) => {
    const index = (event.target as Element).closest?.('[data-step]')?.getAttribute('data-step');
    if (index == null) return;
    const at = Number(index);
    setActive(at);
    const entity = entities.rows[at];
    if (entity) select(entity);
  };
  const onActorClick = (event: MouseEvent<SVGSVGElement>) => {
    const actor = (event.target as Element).closest?.('[data-actor]')?.getAttribute('data-actor');
    const entity = actor != null ? entities.actors.get(actor) : undefined;
    if (entity) select(entity);
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
    <div ref={boxRef} className={css.root}>
      <div ref={scrollRef} className={css.scroll} style={{maxHeight: cap}} role="img" aria-label={ariaLabel} tabIndex={0} onKeyDown={onKeyDown} onScroll={measure}>
        {width > 0 ? (
          <>
            <svg className={css.head} width={plan.width * scale} height={HEAD_H * scale} viewBox={`0 0 ${plan.width} ${HEAD_H}`} aria-hidden="true" onClick={onActorClick}>
              {plan.actors.map(actor => (
                <g key={actor.id} className={css.actorHead} data-actor={actor.id} data-selected={marks.actors.has(actor.id) || undefined}>
                  <line className={css.lifeline} x1={actor.x} x2={actor.x} y1={8 + ACTOR_H} y2={HEAD_H} />
                  <rect className={css.actor} x={actor.x - actor.w / 2} y={8} width={actor.w} height={ACTOR_H} />
                  <text className={css.actorText} x={actor.x} y={8 + ACTOR_H / 2 + 0.5}>{actor.text}</text>
                </g>
              ))}
            </svg>
            <svg className={css.steps} width={plan.width * scale} height={plan.height * scale} viewBox={`0 0 ${plan.width} ${plan.height}`} data-scale={scale < 1 ? scale.toFixed(2) : undefined} aria-hidden="true" onPointerMove={onPointerMove} onPointerLeave={() => tooltip.hide()} onClick={onStepClick}>
              {plan.actors.map(actor => <line key={actor.id} className={css.lifeline} x1={actor.x} x2={actor.x} y1={0} y2={plan.height} />)}
              {plan.frames.map(frameView)}
              {plan.rows.map((row, i) => (
                <g
                  key={row.index}
                  className={css.step}
                  data-step={i}
                  data-kind={row.kind}
                  data-arrow={row.kind === 'message' ? row.arrow : undefined}
                  data-active={i === active || undefined}
                  data-selected={marks.rows.has(i) || undefined}
                  data-dim={(marks.dim && !marks.rows.has(i)) || undefined}
                >
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

function SequenceData(p: {id: string; data: unknown}) {
  const cleaned = useMemo(() => cleanSequence(p.data), [p.data]);
  // What the data asked for but is not drawn is told to the model: data written by a patch was never checked by the server.
  const dropped = cleaned.ok ? cleaned.dropped : [];
  // Entries left out, counted: the list folds past 8, and its lines for unknown keys leave nothing out.
  const notDrawn = cleaned.ok ? cleaned.droppedCount : 0;
  useReportState(dropped.length > 0 ? 'W_DROPPED' : undefined, `not drawn: ${dropped.join('; ')}`);
  if (!cleaned.ok) return <Redline code="E_SHAPE" id={`SequenceDiagram#${p.id}`} message={cleaned.error} />;
  if (seqLeaves(cleaned.ast.steps).length === 0) return <Empty message="no steps to draw: SequenceDiagram takes {actors?, steps}" />;
  return (
    <>
      <SequenceBody id={p.id} ast={cleaned.ast} />
      {notDrawn > 0 ? <div className={css.dropped}>{`${fmtNum(notDrawn)} not drawn: ${dropped.join('; ')}`}</div> : null}
    </>
  );
}

export const SequenceDiagramView: GlView<typeof C.SequenceDiagram> = ({id, props}) => {
  const state = useDataset<unknown>(props.data);
  return <DataGate state={state} id={`SequenceDiagram#${id}`}>{data => <SequenceData id={id} data={data} />}</DataGate>;
};
