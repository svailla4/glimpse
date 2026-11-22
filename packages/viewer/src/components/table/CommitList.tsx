import type * as C from '@glimpse/catalog';
import type {CommitRow, DataRow, Dataset, EntityRef} from '@glimpse/catalog';
import {memo, useEffect, useMemo, useRef, type JSX, type KeyboardEvent, type MouseEvent} from 'react';
import {
  DataGate, PlateAside, Redline, catVar, fmtNum, useCatSlots, useDataset, useSelection,
  type DataState, type GlView, type GlViewProps,
} from '../../kit/index.ts';
import {DateCell} from './cells.tsx';
import s from './CommitList.module.css';
import {useListNav, useRowHeight, useScrollFade, visibleRange} from './nav.ts';
import {useRemoteRows} from './remote.ts';
import {Shell} from './shell.tsx';
import {copyText, describeType, normalizeRows, num, selectionMark, type SelectionMark} from './rows.ts';

type Props = GlViewProps<typeof C.CommitList>['props'];

const MINUS = '−';
/** Ref chips drawn per commit; the rest are counted in a `+n` chip whose tooltip names them. */
const MAX_REFS = 2;

interface Commit {
  sha: string;
  subject: string;
  author: string;
  date: string;
  add?: number;
  del?: number;
  refs: string[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

// Rows keep their identity between renders, so the parsed commit does too and rows off the change path stay memoized.
const parsed = new WeakMap<DataRow, Commit | null>();

/** A row as a commit, or undefined when it has neither a sha nor a subject. */
function toCommit(row: DataRow): Commit | undefined {
  let commit = parsed.get(row);
  if (commit === undefined) {
    commit = parseCommit(row) ?? null;
    parsed.set(row, commit);
  }
  return commit ?? undefined;
}

function parseCommit(row: DataRow): Commit | undefined {
  const sha = text(row.sha).trim();
  const subject = text(row.subject).trim();
  if (!sha && !subject) return undefined;
  return {
    sha,
    subject,
    author: text(row.author).trim(),
    date: text(row.date),
    add: num(row.add),
    del: num(row.del),
    refs: Array.isArray(row.refs) ? row.refs.filter((ref): ref is string => typeof ref === 'string' && ref !== '') : [],
  };
}

/** A line count as the change column prints it: exact below 10,000, compact from there on. */
const countText = (n: number) => fmtNum(n, n >= 10_000 ? 'compact' : 'num');
/** Width of one character of the change counts (11 px IBM Plex Mono). */
const COUNT_CHAR = 6.6;
/** The widest counts text there can be: '+9,999 −9,999' (larger counts are compact). */
const MAX_COUNT_CHARS = 13;

/**
 * Characters of the widest '+add −del' among the rows. Every row reserves that width, so the author and age columns
 * line up whatever a commit's counts are; a paged log may bring wider counts later, so it reserves the most.
 */
function countChars(rows: readonly DataRow[], remote: boolean): number {
  if (remote) return MAX_COUNT_CHARS;
  let chars = 0;
  for (const row of rows) {
    const add = num(row.add);
    const del = num(row.del);
    if (add === undefined && del === undefined) continue;
    chars = Math.max(chars, countText(add ?? 0).length + countText(del ?? 0).length + 3);
  }
  return Math.min(MAX_COUNT_CHARS, Math.max(chars, 6));
}

function initials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '').slice(0, 2);
  return letters.toUpperCase();
}

const entityOf = (commit: Commit): EntityRef => ({type: 'commit', id: commit.sha || commit.subject, ...(commit.subject ? {label: commit.subject} : {})});

function pagesRemotely(state: DataState<CommitRow[]>): boolean {
  const ds = state.ds;
  return ds?.pageable === true && typeof ds.total === 'number' && Array.isArray(state.data) && ds.total > state.data.length;
}

export const CommitListView: GlView<typeof C.CommitList> = ({id, props}) => {
  const state = useDataset<CommitRow[]>(props.data);
  const remote = pagesRemotely(state);
  // With remote paging the whole log is reachable, so the gate's "showing 200 of 3,412" note would be wrong.
  const gated = useMemo<DataState<CommitRow[]>>(() => (remote ? {...state, truncated: undefined, total: undefined} : state), [state, remote]);
  const normal = useMemo(() => (state.status === 'ready' ? normalizeRows(state.data) : undefined), [state]);
  return (
    <Shell>
      <DataGate state={gated} id={`CommitList#${id}`}>
        {data =>
          normal ? (
            <List id={id} props={props} rows={normal.rows} skipped={normal.skipped} ds={state.ds as Dataset | undefined} remote={remote} />
          ) : (
            <Redline code="E_SHAPE" id={`CommitList#${id}`} message={`expected an array of commits, received ${describeType(data)}`} />
          )
        }
      </DataGate>
    </Shell>
  );
};

interface RowProps {
  index: number;
  top: number;
  commit: Commit | undefined;
  loading: boolean;
  slot: number;
  peak: number;
  mark: SelectionMark;
  active: boolean;
  count: number;
  /** False when no commit of the list carries line counts: the bar and count tracks are then not reserved. */
  showChanges: boolean;
}

const CommitItem = memo(function CommitItem({index, top, commit, loading, slot, peak, mark, active, count, showChanges}: RowProps): JSX.Element {
  const common = {
    'aria-posinset': index + 1,
    'aria-setsize': count,
    'data-index': index,
    tabIndex: active ? 0 : -1,
    style: {transform: `translateY(${top}px)`},
  };
  if (!commit) {
    return (
      <div className={s.row} role="option" {...common} aria-selected={false} aria-busy={loading || undefined} data-loading={loading ? '' : undefined} data-malformed={loading ? undefined : ''}>
        <span className={s.sha}>{loading ? '' : '—'}</span>
        <span className={s.subject}>{loading ? <span className={s.skeleton} /> : <span className={s.dim}>not a commit</span>}</span>
      </div>
    );
  }
  const changed = commit.add !== undefined || commit.del !== undefined;
  const add = commit.add ?? 0;
  const del = commit.del ?? 0;
  const total = add + del;
  // Square-root scale: one sweeping commit must not flatten every other bar.
  const share = peak > 0 && total > 0 ? Math.sqrt(Math.min(1, total / peak)) : 0;
  return (
    <div className={s.row} role="option" {...common} aria-selected={mark === 'exact'} data-sha={commit.sha} data-selected={mark}>
      <span className={s.sha}>{commit.sha.slice(0, 7) || '—'}</span>
      <span className={s.subject} title={commit.subject}>{commit.subject || <span className={s.dim}>no subject</span>}</span>
      {commit.refs.length > 0 ? (
        <span className={s.refs}>
          {/* Elided from the start (finding V050): 'python/a2ui-…' twice told two branches apart by nothing. */}
          {commit.refs.slice(0, MAX_REFS).map(ref => <span key={ref} className={s.ref} title={ref} data-gl-ref=""><bdi>{ref}</bdi></span>)}
          {commit.refs.length > MAX_REFS ? <span className={s.refMore} title={commit.refs.slice(MAX_REFS).join(', ')}>+{commit.refs.length - MAX_REFS}</span> : null}
        </span>
      ) : null}
      {commit.author ? (
        <span className={s.author} title={commit.author} style={{['--gl-commit-ink' as never]: catVar(slot)}}>
          <span aria-hidden="true">{initials(commit.author)}</span>
          <span className={s.hidden}>{commit.author}</span>
        </span>
      ) : <span className={s.authorGap} />}
      <span className={s.date}>{commit.date ? <DateCell iso={commit.date} /> : null}</span>
      {showChanges ? (
        <span className={s.changes}>
          {changed ? (
            <>
              <span className={s.bars} aria-hidden="true">
                <span className={s.barAdd} style={{width: total > 0 ? `${(share * add * 100) / total}%` : 0}} />
                <span className={s.barDel} style={{width: total > 0 ? `${(share * del * 100) / total}%` : 0}} />
              </span>
              <span className={s.counts}>
                <span className={add ? s.add : s.zero}>+{countText(add)}</span> <span className={del ? s.del : s.zero}>{MINUS}{countText(del)}</span>
              </span>
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
});

interface ListProps {
  id: string;
  props: Props;
  rows: DataRow[];
  skipped: number;
  ds: Dataset | undefined;
  remote: boolean;
}

function List({id, props, rows, skipped, ds, remote}: ListProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = useRowHeight();
  const {selected, select} = useSelection(id);

  const pager = useRemoteRows(remote ? ds : undefined, {}, rows);
  const count = remote ? pager.total : rows.length;
  const rowAt = (index: number): DataRow | undefined => (remote ? pager.rowAt(index) : rows[index]);
  const nav = useListNav({count, rowHeight, scrollRef});
  useScrollFade(scrollRef, `${count}:${rowHeight}`);

  const [firstVisible, lastVisible] = visibleRange(nav.items, nav.active);
  const want = pager.want;
  useEffect(() => {
    if (remote) want(firstVisible, lastVisible);
  }, [remote, want, firstVisible, lastVisible]);

  // The change bars share one scale: the largest commit among the rows the dataset came with.
  const peak = useMemo(() => {
    let max = 0;
    for (const row of rows) max = Math.max(max, (num(row.add) ?? 0) + (num(row.del) ?? 0));
    return max;
  }, [rows]);
  // A long log comes without line counts (one numstat per commit is too slow): then nothing is reserved for them
  // and the subject takes the width.
  const hasChanges = useMemo(() => rows.some(row => num(row.add) !== undefined || num(row.del) !== undefined), [rows]);
  const countsWidth = useMemo(() => Math.ceil(countChars(rows, remote) * COUNT_CHAR) + 2, [rows, remote]);
  const malformed = useMemo(() => skipped + rows.reduce((n, row) => n + (toCommit(row) ? 0 : 1), 0), [rows, skipped]);

  // Authors are coloured by the kit (stable-category-colours): a session ink where there is one, else the free inks in order of first
  // appearance; the dataset's own rows first, then the rows paged in.
  const authors: string[] = [];
  {
    const seen = new Set<string>();
    const note = (row: DataRow | undefined) => {
      const author = row ? toCommit(row)?.author : undefined;
      if (author && !seen.has(author) && authors.length < 256) {
        seen.add(author);
        authors.push(author);
      }
    };
    for (const row of rows) note(row);
    if (remote) for (const item of nav.items) note(rowAt(item.index));
  }
  const cat = useCatSlots('author', authors);

  const commitAt = (index: number): Commit | undefined => {
    const row = rowAt(index);
    return row ? toCommit(row) : undefined;
  };
  const indexOf = (target: EventTarget): number | undefined => {
    const element = (target as HTMLElement).closest?.('[data-index]');
    const index = element ? Number(element.getAttribute('data-index')) : Number.NaN;
    return Number.isInteger(index) ? index : undefined;
  };
  const activate = (index: number) => {
    const commit = commitAt(index);
    if (commit) select(entityOf(commit));
  };
  // Whatever puts focus or the pointer on a row (a click, assistive technology) makes it the tab stop.
  const onReach = (event: {target: EventTarget}) => {
    const index = indexOf(event.target);
    if (index !== undefined && index !== nav.active) nav.setActive(index);
  };
  const onClick = (event: MouseEvent) => {
    const index = indexOf(event.target);
    if (index !== undefined) activate(index);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (nav.handleKey(event)) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter' || event.key === ' ') activate(nav.active);
    else if (event.key === 'Escape') select(null);
    else if (event.key === 'c') {
      const commit = commitAt(nav.active);
      if (commit?.sha) copyText(commit.sha);
    } else return;
    event.preventDefault();
  };

  const notes: string[] = [];
  if (remote) notes.push(`${fmtNum(pager.total)} commits`);
  if (malformed > 0) notes.push(`${fmtNum(malformed)} malformed ${malformed === 1 ? 'row' : 'rows'}`);

  return (
    <div className={s.root} data-gl-commits="" style={{['--gl-commit-counts' as never]: `${countsWidth}px`}}>
      {notes.length > 0 || pager.error ? (
        <PlateAside>
          {pager.error ? <span className={s.failed} role="alert">commits failed to load: {pager.error}</span> : null}
          {notes.length > 0 ? <span className={s.note} data-gl-commits-note="" title={notes.join(' · ')}>{notes.join(' · ')}</span> : null}
        </PlateAside>
      ) : null}
      <div
        className={s.scroll}
        ref={scrollRef}
        role="listbox"
        aria-label={props.title || 'Commits'}
        aria-busy={remote && pager.loading ? true : undefined}
        onKeyDown={onKeyDown}
        onMouseDown={onReach}
        onFocus={onReach}
        onClick={onClick}
      >
        <div className={s.body} style={{height: nav.totalSize}}>
          {nav.items.map(virtual => {
            const row = rowAt(virtual.index);
            const commit = row ? toCommit(row) : undefined;
            return (
              <CommitItem
                key={virtual.index}
                index={virtual.index}
                top={virtual.start}
                commit={commit}
                loading={row === undefined}
                slot={commit ? cat.slot(commit.author) : 0}
                peak={peak}
                mark={commit ? selectionMark(selected, entityOf(commit)) : undefined}
                active={virtual.index === nav.active}
                count={count}
                showChanges={hasChanges}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
