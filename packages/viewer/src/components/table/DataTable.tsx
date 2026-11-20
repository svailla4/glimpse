import type * as C from '@glimpse/catalog';
import {parseFileLoc, type DataRow, type Dataset, type Rows} from '@glimpse/catalog';
import {memo, useDeferredValue, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent, type ReactNode} from 'react';
import {
  DataGate, Empty, Icon, PathText, PlateAside, Redline, fmtNum, useCatSlots, useDataset, useHostActions, useSelection, useSize,
  type DataState, type GlView, type GlViewProps,
} from '../../kit/index.ts';
import {CellContent, MAX_CHIPS, chipHasTone, chipLabel, contentChars, isContentSized, isFlexible, isRightAligned, minWidthOf, trackOf, type CellContext} from './cells.tsx';
import s from './DataTable.module.css';
import {useListNav, useRowHeight, useScrollFade, visibleRange} from './nav.ts';
import {useRemoteRows} from './remote.ts';
import {Shell} from './shell.tsx';
import {
  NUMERIC_KINDS, clipText, copyText, describeType, filterRows, formatSort, groupItems, normalizeRows, num, parseSort, resolveColumns,
  rowEntity, rowFile, selectionMark, sortRows,
  type Column, type NormalRows, type SelectionMark, type SortSpec, type TableItem,
} from './rows.ts';

type Props = GlViewProps<typeof C.DataTable>['props'];

const COLUMN_GAP = 12;
const SIDE_PADDING = 14;
const LINE_TRACK = 64;
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
    <Shell sized={props.size !== undefined}>
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

/** Where columnStats keeps the longest text of a content-sized column (the plain key holds a bar's largest value). */
const widthKey = (key: string) => `\u0001w\u0001${key}`;

/** Per column: the largest value of a bar / heat column, and the longest text (in characters) of a content-sized one. */
function columnStats(rows: readonly DataRow[], columns: readonly Column[], into: Map<string, number> = new Map()): Map<string, number> {
  for (const column of columns) {
    if (column.kind === 'bar' || column.kind === 'heat') {
      let max = into.get(column.key) ?? 0;
      for (const row of rows) {
        const n = num(row[column.key]);
        if (n !== undefined && n > max) max = n;
      }
      into.set(column.key, max);
    } else if (isContentSized(column)) {
      const key = widthKey(column.key);
      let chars = into.get(key) ?? 0;
      for (const row of rows) chars = Math.max(chars, contentChars(row[column.key], column));
      into.set(key, chars);
    }
  }
  return into;
}

interface CategoryKeys { lang: string[]; module: string[]; chip: string[] }
const MAX_CATEGORY_KEYS = 256;

/** The categories the rows name, per kind, in order of first appearance: what the kit hands colours out by (D6). */
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

/** Priority-3 columns give way, right to left, while the plate is too narrow for every column's floor. */
function fitColumns(columns: readonly Column[], width: number, lineKey: string | undefined, stats: ReadonlyMap<string, number>): Column[] {
  const floor = (column: Column) => (column.key === lineKey ? LINE_TRACK : minWidthOf(column, stats.get(widthKey(column.key))));
  const needed = (list: readonly Column[]) => list.reduce((sum, column) => sum + floor(column), 0) + COLUMN_GAP * Math.max(0, list.length - 1) + SIDE_PADDING * 2;
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

  const allColumns = useMemo(() => resolveColumns(props.columns, state.fields, rows), [props.columns, state.fields, rows]);
  const kindOf = useMemo(() => {
    const kinds = new Map(allColumns.map(column => [column.key, column.kind]));
    for (const field of state.fields ?? []) if (field.kind && !kinds.has(field.key)) kinds.set(field.key, field.kind);
    return (key: string) => kinds.get(key);
  }, [allColumns, state.fields]);

  const group = props.group || undefined;
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
  // Short tabular columns take the width of their text; the spare width goes to the columns that can use it.
  const flexible = columns.some(column => column.key !== lineKey && isFlexible(column));
  const widthOf = (column: Column) => (column.key === lineKey ? LINE_TRACK : minWidthOf(column, max.get(widthKey(column.key))));
  const template = columns.map(column => (column.key === lineKey ? `${LINE_TRACK}px` : trackOf(column, max.get(widthKey(column.key)), flexible))).join(' ');
  const minWidth = columns.reduce((sum, column) => sum + widthOf(column), 0) + COLUMN_GAP * Math.max(0, columns.length - 1) + SIDE_PADDING * 2;

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

  // Categories are coloured in order of first appearance: the dataset's own rows first, then rows paged in later.
  const ownKeys = useMemo(() => categoryKeys(rows, allColumns), [rows, allColumns]);
  const keys = visibleRows ? categoryKeys(visibleRows, allColumns, ownKeys) : ownKeys;
  const langCat = useCatSlots('lang', keys.lang);
  const moduleCat = useCatSlots('module', keys.module);
  const chipCat = useCatSlots(undefined, keys.chip);
  const ctx = useMemo<CellContext>(
    () => ({componentId: id, ds, max, cat: {lang: langCat.color, module: moduleCat.color, chip: chipCat.color}}),
    [id, ds, max, langCat, moduleCat, chipCat],
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
  const label = props.title || 'Table';

  // The root is always mounted, so its width is measured from the first render whatever the rows turn out to hold.
  if (allColumns.length === 0) {
    return (
      <div className={s.root} ref={rootRef} data-sized={props.size ? '' : undefined} data-gl-table="">
        <Empty message="rows have no fields" />
      </div>
    );
  }
  return (
    <div className={s.root} ref={rootRef} data-sized={props.size ? '' : undefined} data-gl-table="">
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
        <div className={s.inner} style={{minWidth, ['--gl-table-cols' as never]: template}}>
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
      <span className={s.live} aria-live="polite">{searching ? `${fmtNum(matched)} rows match` : ''}</span>
    </div>
  );
}
