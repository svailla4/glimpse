import type * as C from '@glimpse/catalog';
import {memo, useMemo, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent, type ReactNode} from 'react';
import {DataGate, PlateAside, fmtNum, useDataset, type GlView, type GlViewProps} from '../../kit/index.ts';
import s from './JsonView.module.css';
import {useListNav, useScrollFade} from './nav.ts';
import {copyText, isRecord} from './rows.ts';
import {Shell} from './shell.tsx';

type Props = GlViewProps<typeof C.JsonView>['props'];

const ROW = 20;
/** Arrays longer than this are shown as ranges of this many items (ranges of ranges for very long ones). */
const CHUNK = 100;
/** Nothing opens by itself past this many lines, whatever `depth` says: a deep default must not flatten a huge value. */
const AUTO_OPEN_LINES = 5000;
const MAX_DEPTH = 100;
const MAX_STRING = 240;

interface Line {
  /** Stable address of the node: the open / closed state is kept by it across data updates. */
  id: string;
  depth: number;
  label?: string;
  labelKind?: 'key' | 'index' | 'range';
  kind: 'object' | 'array' | 'range' | 'leaf';
  value: unknown;
  /** Keys, items, or items in the range. */
  size: number;
  open: boolean;
  /** range: the slice [from, to) of `value`. */
  from?: number;
  to?: number;
  /** The value contains itself (or nests too deep); it is not expanded. */
  blocked?: boolean;
}

/** A key as one id segment: '/' separates segments and '#' introduces a range, so both are escaped. */
const segment = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1').replace(/#/g, '~2');

type IsOpen = (id: string, depth: number, range: boolean, linesSoFar: number) => boolean;

function walkItems(out: Line[], array: unknown[], id: string, depth: number, from: number, to: number, isOpen: IsOpen, onPath: Set<object>): void {
  const count = to - from;
  if (count <= CHUNK) {
    for (let i = from; i < to; i++) walk(out, array[i], `${id}/${i}`, depth, String(i), 'index', isOpen, onPath);
    return;
  }
  let size = CHUNK;
  while (count / size > CHUNK) size *= CHUNK;
  for (let start = from; start < to; start += size) {
    const end = Math.min(to, start + size);
    const rangeId = `${id}#${start}-${end - 1}`;
    const open = isOpen(rangeId, depth, true, out.length);
    out.push({id: rangeId, depth, label: `${fmtNum(start)} … ${fmtNum(end - 1)}`, labelKind: 'range', kind: 'range', value: array, size: end - start, open, from: start, to: end});
    if (open) walkItems(out, array, id, depth + 1, start, end, isOpen, onPath);
  }
}

function walk(out: Line[], value: unknown, id: string, depth: number, label: string | undefined, labelKind: Line['labelKind'], isOpen: IsOpen, onPath: Set<object>): void {
  const array = Array.isArray(value);
  if (!array && !isRecord(value)) {
    out.push({id, depth, label, labelKind, kind: 'leaf', value, size: 0, open: false});
    return;
  }
  const container = value as object;
  const keys = array ? undefined : Object.keys(container);
  const size = array ? (value as unknown[]).length : keys!.length;
  const blocked = onPath.has(container) || depth >= MAX_DEPTH;
  const open = size > 0 && !blocked && isOpen(id, depth, false, out.length);
  out.push({id, depth, label, labelKind, kind: array ? 'array' : 'object', value, size, open, ...(blocked ? {blocked} : {})});
  if (!open) return;
  onPath.add(container);
  if (array) walkItems(out, value as unknown[], id, depth + 1, 0, size, isOpen, onPath);
  else for (const key of keys!) walk(out, (container as Record<string, unknown>)[key], `${id}/${segment(key)}`, depth + 1, key, 'key', isOpen, onPath);
  onPath.delete(container);
}

/** The visible lines. The root container itself is not a line: its entries start at depth 0. */
function flatten(data: unknown, isOpen: IsOpen): Line[] {
  const out: Line[] = [];
  const onPath = new Set<object>();
  if (Array.isArray(data)) {
    onPath.add(data);
    walkItems(out, data, '$', 0, 0, data.length, isOpen, onPath);
  } else if (isRecord(data)) {
    onPath.add(data);
    for (const key of Object.keys(data)) walk(out, data[key], `$/${segment(key)}`, 0, key, 'key', isOpen, onPath);
  } else {
    walk(out, data, '$', 0, undefined, undefined, isOpen, onPath);
  }
  return out;
}

function leaf(value: unknown): ReactNode {
  if (typeof value === 'string') {
    const shown = value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
    return <span className={s.string} title={value.length > MAX_STRING ? value.slice(0, 2000) : undefined}>"{shown}"</span>;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return <span className={s.number}>{String(value)}</span>;
  if (typeof value === 'boolean' || value === null) return <span className={s.constant}>{String(value)}</span>;
  return <span className={s.dim}>{value === undefined ? 'undefined' : typeof value}</span>;
}

function summary(line: Line): ReactNode {
  if (line.blocked) return <span className={s.dim}>{line.kind === 'array' ? '[circular]' : '{circular}'}</span>;
  if (line.kind === 'range') return line.open ? null : <span className={s.dim}>[…{fmtNum(line.size)}]</span>;
  const array = line.kind === 'array';
  if (line.size === 0) return <span className={s.dim}>{array ? '[]' : '{}'}</span>;
  if (line.open) return <span className={s.dim}>{array ? `[${fmtNum(line.size)}]` : `{${fmtNum(line.size)}}`}</span>;
  return <span className={s.dim}>{array ? `[…${fmtNum(line.size)}]` : `{…${fmtNum(line.size)} ${line.size === 1 ? 'key' : 'keys'}}`}</span>;
}

const expandable = (line: Line): boolean => line.kind !== 'leaf' && line.size > 0 && !line.blocked;

const JsonRow = memo(function JsonRow({index, top, line, active}: {index: number; top: number; line: Line; active: boolean}): JSX.Element {
  const canOpen = expandable(line);
  return (
    <div
      className={s.row}
      role="treeitem"
      aria-level={line.depth + 1}
      aria-expanded={canOpen ? line.open : undefined}
      aria-selected={false}
      data-index={index}
      data-json={line.id}
      tabIndex={active ? 0 : -1}
      style={{transform: `translateY(${top}px)`}}
    >
      {line.depth > 0 ? <span className={s.guides} style={{width: line.depth * 16}} aria-hidden="true" /> : null}
      <span className={s.twist} data-twist={canOpen ? '' : undefined} aria-hidden="true">
        {canOpen ? (
          <svg className={s.chevron} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" data-open={line.open || undefined}>
            <path d="M4.5 2.5 8 6l-3.5 3.5" />
          </svg>
        ) : null}
      </span>
      {line.label !== undefined ? (
        <span className={s.label} data-kind={line.labelKind}>
          {line.labelKind === 'range' ? `[${line.label}]` : line.label}
          {line.labelKind === 'range' ? '' : ':'}
        </span>
      ) : null}
      <span className={s.value}>{line.kind === 'leaf' ? leaf(line.value) : summary(line)}</span>
    </div>
  );
});

export const JsonViewView: GlView<typeof C.JsonView> = ({id, props}) => {
  const state = useDataset<unknown>(props.data);
  return (
    <Shell sized={props.size !== undefined}>
      <DataGate state={state} id={`JsonView#${id}`}>
        {data => <Tree props={props} data={data} />}
      </DataGate>
    </Shell>
  );
};

function Tree({props, data}: {props: Props; data: unknown}): JSX.Element {
  // `depth` counts the root, which is always open: 1 lists its entries, 2 opens those entries too.
  const autoDepth = Math.max(0, (props.depth ?? 1) - 1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const lines = useMemo(
    () => flatten(data, (lineId, depth, range, soFar) => toggled.get(lineId) ?? (!range && depth < autoDepth && soFar < AUTO_OPEN_LINES)),
    [data, toggled, autoDepth],
  );
  const nav = useListNav({count: lines.length, rowHeight: ROW, scrollRef});
  useScrollFade(scrollRef, lines.length);

  const setOpen = (line: Line, open: boolean) => {
    if (expandable(line)) setToggled(prev => new Map(prev).set(line.id, open));
  };
  const copy = (line: Line) => {
    const value = line.kind === 'range' ? (line.value as unknown[]).slice(line.from, line.to) : line.value;
    try {
      copyText(typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value)));
    } catch {
      // A value that cannot be serialised (it contains itself) is simply not copied.
    }
  };

  const indexOf = (target: EventTarget): number | undefined => {
    const element = (target as HTMLElement).closest?.('[data-index]');
    const index = element ? Number(element.getAttribute('data-index')) : Number.NaN;
    return Number.isInteger(index) ? index : undefined;
  };
  // Whatever puts focus or the pointer on a row (a click, assistive technology) makes it the tab stop.
  const onReach = (event: {target: EventTarget}) => {
    const index = indexOf(event.target);
    if (index !== undefined && index !== nav.active) nav.setActive(index);
  };
  const onClick = (event: MouseEvent) => {
    const index = indexOf(event.target);
    const line = index === undefined ? undefined : lines[index];
    // A click that ends a text selection is not a toggle.
    if (line && (typeof getSelection !== 'function' || getSelection()?.isCollapsed !== false)) setOpen(line, !line.open);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (nav.handleKey(event)) return;
    const line = lines[nav.active];
    if (!line || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter' || event.key === ' ') {
      setOpen(line, !line.open);
    } else if (event.key === 'ArrowRight') {
      if (!expandable(line)) return;
      if (!line.open) setOpen(line, true);
      else nav.setActive(nav.active + 1, true);
    } else if (event.key === 'ArrowLeft') {
      if (line.open) setOpen(line, false);
      else {
        for (let i = nav.active - 1; i >= 0; i--) {
          if (lines[i]!.depth < line.depth) {
            nav.setActive(i, true);
            break;
          }
        }
      }
    } else if (event.key === 'c') {
      copy(line);
    } else {
      return;
    }
    event.preventDefault();
  };

  const rootSize = Array.isArray(data) ? `${fmtNum(data.length)} ${data.length === 1 ? 'item' : 'items'}` : isRecord(data) ? `${fmtNum(Object.keys(data).length)} keys` : undefined;
  return (
    <div className={s.root} data-sized={props.size ? '' : undefined} data-gl-json="">
      {rootSize ? <PlateAside><span className={s.note} data-gl-json-note="">{rootSize}</span></PlateAside> : null}
      <div className={s.scroll} ref={scrollRef} role="tree" aria-label={props.title || 'JSON'} onKeyDown={onKeyDown} onMouseDown={onReach} onFocus={onReach} onClick={onClick}>
        <div className={s.body} style={{height: nav.totalSize}}>
          {nav.items.map(virtual => {
            const line = lines[virtual.index];
            return line ? <JsonRow key={line.id} index={virtual.index} top={virtual.start} line={line} active={virtual.index === nav.active} /> : null;
          })}
        </div>
      </div>
    </div>
  );
}
