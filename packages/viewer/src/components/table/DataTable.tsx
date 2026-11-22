import type * as C from '@glimpse/catalog';
import {parseFileLoc, readColumns, type DataRow, type Dataset, type Rows} from '@glimpse/catalog';
import {memo, useDeferredValue, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject} from 'react';
import {
  DataGate, Empty, Icon, PathText, PlateAside, REPORT_CODES, Redline, fmtNum, useCatSlots, useDataset, useHostActions, useReportState, useSelection, useSize,
  type DataState, type GlView, type GlViewProps,
} from '../../kit/index.ts';
import {CellContent, MAX_CHIPS, chipHasTone, chipLabel, isRightAligned, type CellContext} from './cells.tsx';
import s from './DataTable.module.css';
import {useListNav, useRowHeight, useScrollFade, visibleRange} from './nav.ts';
import {useRemoteRows} from './remote.ts';
import {Shell} from './shell.tsx';
import {
  NUMERIC_KINDS, checkColumns, clipText, copyText, describeType, fieldList, filterRows, formatSort, groupItems, knownFields, normalizeRows, num, parseSort,
  rowEntity, rowFile, selectionMark, sortRows,
  type Column, type NormalRows, type SelectionMark, type SortSpec, type TableItem,
} from './rows.ts';
import {columnBoxFrom, columnTracks, columnWidths, distinctDepths, floorWidth, measureColumns, type ColumnBox} from './widths.ts';

type Props = GlViewProps<typeof C.DataTable>['props'];

const LINE_TRACK = 64;
/** The line column inside a group: a fixed track. */
const LINE_BOX: ColumnBox = {floor: LINE_TRACK, typical: LINE_TRACK, want: LINE_TRACK, grow: 0, fixed: true, textual: false};
const SEARCH_ABOVE = 20;
const EMPTY_MAX: ReadonlyMap<string, number> = new Map();

/** The table pages the full set itself when the server holds more rows than it sent. Groups need every row, so they stay local. */
function pagesRemotely(state: DataState<Rows>, group: string | undefined): boolean {
  const ds = state.ds;
  return !group && ds?.pageable === true && typeof ds.total === 'number' && Array.isArray(state.data) && ds.total > state.data.length;
}

export const DataTableView: GlView<typeof C.DataTable> = ({id, props}) => {
  const state = useDataset<Rows>(props.data);
  const remote = pagesRemotely(state, props.group);
  // With remote paging every row is reachable, so the gate's "showing 500 of 12,840" note would be wrong.
  const gated = useMemo<DataState<Rows>>(() => (remote ? {...state, truncated: undefined, total: undefined} : state), [state, remote]);
  const normal = useMemo(() => (state.status === 'ready' ? normalizeRows(state.data) : undefined), [state]);
  return (
    <Shell>
      <DataGate state={gated} id={`DataTable#${id}`}>
        {data =>
          normal ? (
            <Table id={id} props={props} normal={normal} state={state} remote={remote} />
          ) : (
            <Redline code="E_SHAPE" id={`DataTable#${id}`} message={`expected an array of rows, received ${describeType(data)}`} />
          )
        }
      </DataGate>
    </Shell>
  );
};

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Where columnStats keeps what a column's cells need (characters or px, see widths.ts); the plain key holds a bar's largest value. */
const widthKey = (key: string) => `\u0001w\u0001${key}`;

/** Per column: the largest value of a bar / heat column, and the width its cells need. */
function columnStats(rows: readonly DataRow[], columns: readonly Column[], into: Map<string, number> = new Map()): Map<string, number> {
  for (const column of columns) {
    if (column.kind !== 'bar' && column.kind !== 'heat') continue;
    let max = into.get(column.key) ?? 0;
    for (const row of rows) {
      const n = num(row[column.key]);
      if (n !== undefined && n > max) max = n;
    }
    into.set(column.key, max);
  }
  for (const [key, need] of measureColumns(rows, columns)) into.set(widthKey(key), Math.max(into.get(widthKey(key)) ?? 0, need));
  return into;
}

interface CategoryKeys { lang: string[]; module: string[]; chip: string[] }
const MAX_CATEGORY_KEYS = 256;

/** The categories the rows name, per kind, in order of first appearance: what the kit hands colours out by (stable-category-colours). */
function categoryKeys(rows: readonly DataRow[], columns: readonly Column[], after?: CategoryKeys): CategoryKeys {
  const out: CategoryKeys = {lang: [...(after?.lang ?? [])], module: [...(after?.module ?? [])], chip: [...(after?.chip ?? [])]};
  const seen = {lang: new Set(out.lang), module: new Set(out.module), chip: new Set(out.chip)};
  const add = (kind: keyof CategoryKeys, key: string) => {
    if (key === '' || seen[kind].has(key) || out[kind].length >= MAX_CATEGORY_KEYS) return;
    seen[kind].add(key);
    out[kind].push(key);
  };
  for (const column of columns) {
    if (column.kind !== 'lang' && column.kind !== 'module' && column.kind !== 'chip') continue;
    for (const row of rows) {
      const value = row[column.key];
      if (value === null || value === undefined || value === '') continue;
      if (column.kind !== 'chip') {
        if (typeof value === 'string') add(column.kind, value);
        continue;
      }
      for (const item of Array.isArray(value) ? value.slice(0, MAX_CHIPS) : [value]) {
        const label = chipLabel(item);
        if (!chipHasTone(label)) add('chip', label);
      }
    }
  }
  return out;
}

/** Per path column, per path, the directories its label needs to differ from the other rows (distinctDepths). */
function pathDepths(rows: readonly DataRow[], columns: readonly Column[]): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const column of columns) {
    if (column.kind !== 'path') continue;
    const values = rows.map(row => row[column.key]);
    const depths = distinctDepths(values);
    const byValue = new Map<string, number>();
    values.forEach((value, i) => {
      const depth = depths[i];
      if (typeof value === 'string' && depth !== undefined && depth > 0) byValue.set(value, depth);
    });
    if (byValue.size > 0) out.set(column.key, byValue);
  }
  return out;
}

const boxOf = (column: Column, lineKey: string | undefined, stats: ReadonlyMap<string, number>): ColumnBox =>
  column.key === lineKey ? LINE_BOX : columnBoxFrom(column, stats, widthKey);

/** Priority-3 columns give way, right to left, while the plate is too narrow for every column's floor. */
function fitColumns(columns: readonly Column[], width: number, lineKey: string | undefined, stats: ReadonlyMap<string, number>): Column[] {
  const needed = (list: readonly Column[]) => floorWidth(list.map(column => boxOf(column, lineKey, stats)));
  const kept = [...columns];
  for (let i = kept.length - 1; i > 0 && width > 0 && needed(kept) > width; i--) {
    if (kept[i]?.priority === 3) kept.splice(i, 1);
  }
  return kept;
}

function SortGlyph(p: {desc: boolean}): JSX.Element {
  return (
    <svg className={s.sortGlyph} width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
      <path d={p.desc ? 'M1 2.5 4 6l3-3.5' : 'M1 5.5 4 2l3 3.5'} />
    </svg>
  );
}

function Chevron(p: {open: boolean}): JSX.Element {
  return (
    <svg className={s.chevron} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" data-open={p.open || undefined}>
      <path d="M4.5 2.5 8 6l-3.5 3.5" />
    </svg>
  );
}

/**
 * How many columns are cut off at either side of a table that scrolls sideways (round 4: at 760 px the gallery table
 * hid TREND, DELTA and OK behind a scroll nothing pointed at). Counted from the header cells on every scroll and
 * resize of the scroller.
 */
function useHiddenColumns(scrollRef: RefObject<HTMLDivElement | null>, key: string): {left: number; right: number} {
  const [hidden, setHidden] = useState({left: 0, right: 0});
  // `key` changes when the columns or their widths do: the effect measures again.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => {
      const box = element.getBoundingClientRect();
      const visibleRight = box.left + element.clientWidth;
      // Counted without `++`: the React Compiler cannot compile `++` on a variable of a nested function (decision compiled-viewer).
      const heads = element.scrollWidth - element.clientWidth > 1 ? [...element.querySelectorAll<HTMLElement>('[role="columnheader"]')].map(head => head.getBoundingClientRect()) : [];
      const left = heads.filter(cell => cell.left < box.left - 1).length;
      const right = heads.filter(cell => cell.right > visibleRight + 1).length;
      setHidden(prev => (prev.left === left && prev.right === right ? prev : {left, right}));
    };
    update();
    element.addEventListener('scroll', update, {passive: true});
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : undefined;
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [scrollRef, key]);
  return hidden;
}

/**
 * The sign that a table goes on sideways: over the end of its header row, the number of columns out of view and a
 * chevron. A click scrolls a page that way. Out of the tab order, like the plate's other header controls: the keyboard
 * reaches cut columns through the widgets of a row.
 */
function ScrollMore(p: {side: 'left' | 'right'; count: number; scrollRef: RefObject<HTMLDivElement | null>}): JSX.Element {
  const columns = `${p.count} ${p.count === 1 ? 'column' : 'columns'}`;
  const onClick = () => {
    const element = p.scrollRef.current;
    if (!element) return;
    const page = Math.max(48, element.clientWidth - 64);
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollBy({left: p.side === 'right' ? page : -page, behavior: still ? 'auto' : 'smooth'});
  };
  return (
    <button
      type="button"
      className={s.more}
      data-side={p.side}
      data-gl-table-more={p.side}
      tabIndex={-1}
      aria-label={`${columns} to the ${p.side}: scroll ${p.side}`}
      title={`${columns} to the ${p.side}`}
      onClick={onClick}
    >
      {p.side === 'right' ? <><span>+{p.count}</span><Icon name="chevron-right" /></> : <><Icon name="chevron-right" /><span>+{p.count}</span></>}
    </button>
  );
}

interface RowViewProps {
  index: number;
  top: number;
  /** Undefined while the row's window is on its way: the same element then shows hairline placeholders. */
  row: DataRow | undefined;
  columns: readonly Column[];
  lineKey: string | undefined;
  ctx: CellContext;
  mark: SelectionMark;
  active: boolean;
}

const RowView = memo(function RowView({index, top, row, columns, lineKey, ctx, mark, active}: RowViewProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  // Grid pattern: the row is the tab stop; widgets inside cells are reached with the arrow keys.
  useEffect(() => {
    for (const button of ref.current?.querySelectorAll('button') ?? []) button.tabIndex = -1;
  });
  // A loading row and the row that replaces it are one element: a row that holds focus while its page arrives (End
  // in a paged table) must not be unmounted, or focus falls to <body> and the keyboard goes dead.
  return (
    <div
      ref={ref}
      className={s.row}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={row ? mark === 'exact' : undefined}
      aria-busy={row ? undefined : true}
      data-index={index}
      data-loading={row ? undefined : ''}
      data-selected={row ? mark : undefined}
      tabIndex={active ? 0 : -1}
      style={{transform: `translateY(${top}px)`}}
    >
      {columns.map(column =>
        row ? (
          <div key={column.key} className={s.cell} role="gridcell" data-kind={column.kind} data-align={isRightAligned(column) ? 'end' : undefined}>
            {column.key === lineKey ? <LineCell value={row[column.key]} /> : <CellContent column={column} row={row} ctx={ctx} />}
          </div>
        ) : (
          <div key={column.key} className={s.cell} role="gridcell"><span className={s.skeleton} /></div>
        ),
      )}
    </div>
  );
});

/** The group's own column inside a group: the file is in the header, so a row only shows where in it. */
function LineCell(p: {value: unknown}): ReactNode {
  const {line, endLine} = typeof p.value === 'string' ? parseFileLoc(p.value) : {};
  if (line == null) return null;
  return <span className={s.line}>:{line}{endLine != null && endLine !== line ? `-${endLine}` : ''}</span>;
}

interface TableProps {
  id: string;
  props: Props;
  normal: NormalRows;
  state: DataState<Rows>;
  remote: boolean;
}

function Table({id, props, normal, state, remote}: TableProps): JSX.Element {
  const {rows, skipped} = normal;
  const ds = state.ds as Dataset | undefined;
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const {width} = useSize(rootRef);
  const rowHeight = useRowHeight();
  const {selected, select} = useSelection(id);
  const host = useHostActions(id);

  // Sort starts from the prop, follows the prop when a patch changes it, and then the header.
  const [sort, setSort] = useState<SortSpec | undefined>(() => parseSort(props.sort));
  const [sortProp, setSortProp] = useState(props.sort);
  if (sortProp !== props.sort) {
    setSortProp(props.sort);
    setSort(parseSort(props.sort));
  }
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const remoteQuery = useDebounced(query.trim(), 200);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());

  // A field the spec names that the data lacks is left out and told to the agent (decisions reports-are-component-state, guessed-fields-repaired): a column of
  // dashes, a sort that does nothing or one group of everything would say nothing true.
  // The columns prop is a list or the presets' shorthand string, read as the server reads it (catalog readColumns).
  // What it cannot read is told to the agent (decision no-invented-string-formats): columns bound to a $/path reach the tab unchecked.
  const wanted = useMemo(() => readColumns(props.columns), [props.columns]);
  useReportState(wanted.problems.length > 0 ? 'W_COLUMNS' : undefined, `columns: ${wanted.problems.map(problem => problem.message).join('; ')}`);
  const checked = useMemo(() => checkColumns(wanted.fields, state.fields, rows), [wanted, state.fields, rows]);
  const allColumns = checked.columns;
  const known = useMemo(() => knownFields(state.fields, rows), [state.fields, rows]);
  const sortKey = parseSort(props.sort)?.key;
  const unknown = (key: string | undefined) => key !== undefined && key !== '' && rows.length > 0 && !known.includes(key);
  const fieldProblems = [
    ...(checked.missing.length > 0 ? [`columns ${checked.missing.join(' ')}`] : []),
    ...(unknown(sortKey) ? [`sort ${sortKey}`] : []),
    ...(unknown(props.group) ? [`group ${props.group}`] : []),
  ];
  useReportState(fieldProblems.length > 0 ? REPORT_CODES.field : undefined, `${fieldProblems.join(', ')} not in the data (${fieldList(known)})`);
  const kindOf = useMemo(() => {
    const kinds = new Map(allColumns.map(column => [column.key, column.kind]));
    for (const field of state.fields ?? []) if (field.kind && !kinds.has(field.key)) kinds.set(field.key, field.kind);
    return (key: string) => kinds.get(key);
  }, [allColumns, state.fields]);

  const group = props.group && !unknown(props.group) ? props.group : undefined;
  const groupKind = group ? kindOf(group) : undefined;
  // Inside a group its column repeats the header; it is dropped, or cut down to the line for file locations.
  const lineKey = useMemo(() => {
    if (!group || groupKind !== 'path') return undefined;
    return rows.slice(0, 50).some(row => typeof row[group] === 'string' && (row[group] as string).includes('#L')) ? group : undefined;
  }, [group, groupKind, rows]);

  // Bars and heat scale to the column's largest value, and a content-sized column is as wide as its longest value:
  // over all rows locally, over every row seen so far when paging.
  const baseMax = useMemo(() => columnStats(rows, allColumns), [rows, allColumns]);
  const [seenMax, setSeenMax] = useState<{rows: readonly DataRow[]; max: ReadonlyMap<string, number>}>({rows, max: EMPTY_MAX});
  const extraMax = seenMax.rows === rows ? seenMax.max : EMPTY_MAX;
  const max = useMemo(() => {
    if (extraMax.size === 0) return baseMax;
    const merged = new Map(baseMax);
    for (const [key, value] of extraMax) merged.set(key, Math.max(value, merged.get(key) ?? 0));
    return merged;
  }, [baseMax, extraMax]);

  const columns = useMemo(
    () => fitColumns(group ? allColumns.filter(column => column.key !== group || column.key === lineKey) : allColumns, width, lineKey, max),
    [allColumns, group, lineKey, width, max],
  );
  // Short tabular columns take the width of their text; the spare width goes to the text a reader needs whole first
  // (names, paths, commands, messages), then to chips and bars (widths.ts).
  const boxes = columns.map(column => boxOf(column, lineKey, max));
  const template = columnTracks(boxes, columnWidths(boxes, width)).join(' ');
  const minWidth = floorWidth(boxes);

  const local = useMemo(() => {
    if (remote) return undefined;
    const matched = filterRows(rows, deferredQuery);
    return {matched: matched.length, items: groupItems(sortRows(matched, sort, kindOf), group, groupKind, closed)};
  }, [remote, rows, deferredQuery, sort, kindOf, group, groupKind, closed]);
  const pager = useRemoteRows(remote ? ds : undefined, {sort: formatSort(sort), q: remoteQuery || undefined}, rows);
  const count = local ? local.items.length : pager.total;
  const itemAt = (index: number): TableItem | undefined => {
    if (local) return local.items[index];
    const row = pager.rowAt(index);
    return row ? {type: 'row', row} : undefined;
  };

  const nav = useListNav({count, rowHeight, scrollRef, offsetTop: rowHeight});

  const [firstVisible, lastVisible] = visibleRange(nav.items, nav.active);
  const want = pager.want;
  useEffect(() => {
    if (remote) want(firstVisible, lastVisible);
  }, [remote, want, firstVisible, lastVisible]);

  const visibleRows = remote ? nav.items.map(item => pager.rowAt(item.index)).filter((row): row is DataRow => row !== undefined) : undefined;
  useEffect(() => {
    if (!visibleRows) return;
    const seen = columnStats(visibleRows, allColumns);
    let grew = false;
    for (const [key, value] of seen) if (value > (max.get(key) ?? 0)) grew = true;
    if (grew) setSeenMax({rows, max: columnStats(visibleRows, allColumns, new Map(max))});
  });
  useScrollFade(scrollRef, `${count}:${rowHeight}:${minWidth}:${width}`);
  const hidden = useHiddenColumns(scrollRef, `${template}:${columns.length}:${width}`);

  // Categories are coloured in order of first appearance: the dataset's own rows first, then rows paged in later.
  const ownKeys = useMemo(() => categoryKeys(rows, allColumns), [rows, allColumns]);
  const keys = visibleRows ? categoryKeys(visibleRows, allColumns, ownKeys) : ownKeys;
  const langCat = useCatSlots('lang', keys.lang);
  const moduleCat = useCatSlots('module', keys.module);
  const chipCat = useCatSlots(undefined, keys.chip);
  // The rows of a path column that share a file name keep the directory that tells them apart (kit PathText).
  const depths = useMemo(() => pathDepths(rows, allColumns), [rows, allColumns]);
  const ctx = useMemo<CellContext>(
    () => ({componentId: id, ds, max, depths, cat: {lang: langCat.color, module: moduleCat.color, chip: chipCat.color}}),
    [id, ds, max, depths, langCat, moduleCat, chipCat],
  );

  const toTop = () => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    nav.setActive(0);
  };
  const toggleSort = (column: Column) => {
    const descFirst = NUMERIC_KINDS.has(column.kind) || column.kind === 'delta' || column.kind === 'date';
    setSort(prev => {
      if (prev?.key !== column.key) return {key: column.key, desc: descFirst};
      return prev.desc === descFirst ? {key: column.key, desc: !descFirst} : undefined;
    });
    toTop();
  };
  const toggleGroup = (key: string, open?: boolean) => {
    setClosed(prev => {
      const next = new Set(prev);
      if (open ?? prev.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const entityAt = (index: number, row: DataRow) => rowEntity(row, allColumns, index, ds);
  const openRow = (row: DataRow) => {
    const file = rowFile(row);
    if (file) host.open(file);
  };
  const activate = (index: number, viaModifier: boolean) => {
    const item = itemAt(index);
    if (!item) return;
    if (item.type === 'group') toggleGroup(item.key);
    else if (viaModifier) openRow(item.row);
    else select(entityAt(index, item.row));
  };

  const indexOf = (target: EventTarget): number | undefined => {
    const element = (target as HTMLElement).closest?.('[data-index]');
    const index = element ? Number(element.getAttribute('data-index')) : Number.NaN;
    return Number.isInteger(index) ? index : undefined;
  };
  // Whatever puts focus or the pointer on a row (a click, a cell widget, assistive technology) makes it the tab stop.
  const onBodyReach = (event: {target: EventTarget}) => {
    const index = indexOf(event.target);
    if (index !== undefined && index !== nav.active) nav.setActive(index);
  };
  const onBodyClick = (event: MouseEvent) => {
    const index = indexOf(event.target);
    if (index !== undefined) activate(index, event.metaKey || event.ctrlKey);
  };

  const headButtons = () => [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-head]') ?? [])];
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey;
    if (target.closest('[data-head]')) {
      const buttons = headButtons();
      const at = buttons.indexOf(target.closest<HTMLElement>('[data-head]')!);
      if (!plain) return;
      if (event.key === 'ArrowRight') buttons[Math.min(buttons.length - 1, at + 1)]?.focus();
      else if (event.key === 'ArrowLeft') buttons[Math.max(0, at - 1)]?.focus();
      else if (event.key === 'ArrowDown' && count > 0) nav.setActive(nav.active, true);
      else return;
      event.preventDefault();
      return;
    }
    if (plain && event.key === 'ArrowUp' && nav.active === 0) {
      const buttons = headButtons();
      (buttons.find(button => button.getAttribute('data-head') === sort?.key) ?? buttons[0])?.focus();
      event.preventDefault();
      return;
    }
    if (nav.handleKey(event)) return;
    const item = itemAt(nav.active);
    if (!item) return;
    const onWidget = target.closest('button') !== null;
    if (event.key === 'Enter' || event.key === ' ') {
      if (onWidget) return;
      activate(nav.active, event.metaKey || event.ctrlKey);
    } else if (!plain) {
      return;
    } else if (event.key === 'Escape') {
      select(null);
    } else if (item.type === 'group') {
      if (event.key === 'ArrowRight') toggleGroup(item.key, true);
      else if (event.key === 'ArrowLeft') toggleGroup(item.key, false);
      else return;
    } else if (event.key === 'o') {
      openRow(item.row);
    } else if (event.key === 'c') {
      copyText(clipText(entityAt(nav.active, item.row)));
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const row = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${nav.active}"]`);
      const widgets = [...(row?.querySelectorAll<HTMLElement>('button') ?? [])];
      const at = widgets.indexOf(document.activeElement as HTMLElement);
      if (event.key === 'ArrowRight') widgets[at + 1]?.focus();
      else if (at <= 0) row?.focus();
      else widgets[at - 1]?.focus();
    } else {
      return;
    }
    event.preventDefault();
  };

  const matched = remote ? pager.total : (local?.matched ?? 0);
  const showSearch = props.search ?? (remote ? (ds?.total ?? rows.length) : rows.length) > SEARCH_ABOVE;
  const searching = (remote ? remoteQuery : deferredQuery.trim()) !== '';
  const notes: string[] = [];
  if (searching) notes.push(`${fmtNum(matched)} of ${fmtNum(remote ? ds?.total : rows.length)} match`);
  else if (remote) notes.push(`${fmtNum(pager.total)} rows`);
  if (skipped > 0) notes.push(`${fmtNum(skipped)} malformed ${skipped === 1 ? 'row' : 'rows'} skipped`);
  // Finding V049: a cut dataset sorted by another field reorders only the rows it has ('top 15 by score', sorted by
  // commits, is not the 15 with the most commits). Said beside the gate's 'showing 15 of 320 · top by score'.
  const cut = !remote && (state.truncated !== undefined || (typeof state.total === 'number' && state.total > rows.length));
  if (cut && sort && sort.key !== state.truncated?.by && !searching) notes.push(`sorted: ${sort.key} (${fmtNum(rows.length)} shown)`);
  const label = props.title || 'Table';

  // The root is always mounted, so its width is measured from the first render whatever the rows turn out to hold.
  if (allColumns.length === 0) {
    return (
      <div className={s.root} ref={rootRef} data-gl-table="">
        <Empty message="rows have no fields: DataTable takes a list of {field: value} rows" code="W_SHAPE" />
      </div>
    );
  }
  return (
    <div className={s.root} ref={rootRef} data-gl-table="">
      {showSearch || notes.length > 0 || pager.error ? (
        <PlateAside>
          {pager.error ? <span className={s.failed} role="alert">rows failed to load: {pager.error}</span> : null}
          {notes.length > 0 ? <span className={s.note} data-gl-table-note="" title={notes.join(' · ')}>{notes.join(' · ')}</span> : null}
          {showSearch ? (
            <label className={s.search}>
              <Icon name="search" />
              <input
                className={s.searchInput}
                type="search"
                value={query}
                placeholder="Filter"
                aria-label={`Filter ${label}`}
                spellCheck={false}
                onChange={event => {
                  setQuery(event.target.value);
                  toTop();
                }}
                onKeyDown={event => {
                  if (event.key === 'Escape' && query) {
                    setQuery('');
                    toTop();
                    event.stopPropagation();
                  } else if (event.key === 'ArrowDown' && count > 0) {
                    nav.setActive(0, true);
                    event.preventDefault();
                  }
                }}
              />
            </label>
          ) : null}
        </PlateAside>
      ) : null}
      <div className={s.frame}>
      <div
        className={s.scroll}
        ref={scrollRef}
        role="grid"
        aria-label={label}
        aria-rowcount={count + 1}
        aria-colcount={columns.length}
        aria-busy={remote && pager.loading ? true : undefined}
        onKeyDown={onKeyDown}
      >
        <div className={s.inner} style={{minWidth, '--gl-table-cols': template}}>
          <div className={s.head} role="row" aria-rowindex={1}>
            {columns.map((column, i) => {
              const sorted = sort?.key === column.key ? sort : undefined;
              return (
                <div
                  key={column.key}
                  className={s.headCell}
                  role="columnheader"
                  aria-sort={sorted ? (sorted.desc ? 'descending' : 'ascending') : 'none'}
                  data-align={isRightAligned(column) ? 'end' : undefined}
                >
                  <button
                    type="button"
                    className={s.headButton}
                    data-head={column.key}
                    tabIndex={count === 0 && i === 0 ? 0 : -1}
                    title={`Sort by ${column.label}`}
                    onClick={() => toggleSort(column)}
                  >
                    <span className={s.headLabel}>{column.key === lineKey ? 'Line' : column.label}</span>
                    {sorted ? <SortGlyph desc={sorted.desc} /> : null}
                  </button>
                </div>
              );
            })}
          </div>
          <div className={s.body} role="rowgroup" style={{height: nav.totalSize}} onMouseDown={onBodyReach} onFocus={onBodyReach} onClick={onBodyClick}>
            {nav.items.map(virtual => {
              const item = itemAt(virtual.index);
              const top = virtual.start - nav.offsetTop;
              const active = virtual.index === nav.active;
              if (item?.type === 'group') {
                return (
                  <div key={`g:${item.key}`} className={s.group} role="row" aria-rowindex={virtual.index + 2} aria-expanded={item.open} data-index={virtual.index} data-group={item.key} tabIndex={active ? 0 : -1} style={{transform: `translateY(${top}px)`}}>
                    <div className={s.groupCell} role="gridcell" aria-colspan={columns.length}>
                      <Chevron open={item.open} />
                      <span className={s.groupLabel}>{groupKind === 'path' && item.key ? <PathText file={item.key} /> : item.key || '—'}</span>
                      <span className={s.groupCount}>{fmtNum(item.count)}</span>
                    </div>
                  </div>
                );
              }
              return (
                <RowView
                  key={virtual.index}
                  index={virtual.index}
                  top={top}
                  row={item?.row}
                  columns={columns}
                  lineKey={lineKey}
                  ctx={ctx}
                  mark={item ? selectionMark(selected, entityAt(virtual.index, item.row)) : undefined}
                  active={active}
                />
              );
            })}
          </div>
          {count === 0 ? <div className={s.none} data-gl-table-none="">{searching ? `no rows match “${query.trim()}”` : 'no rows'}</div> : null}
        </div>
      </div>
      {hidden.left > 0 ? <ScrollMore side="left" count={hidden.left} scrollRef={scrollRef} /> : null}
      {hidden.right > 0 ? <ScrollMore side="right" count={hidden.right} scrollRef={scrollRef} /> : null}
      </div>
      <span className={s.live} aria-live="polite">{searching ? `${fmtNum(matched)} rows match` : ''}</span>
    </div>
  );
}
