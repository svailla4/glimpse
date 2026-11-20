import type * as C from '@glimpse/catalog';
import {formatFileLoc, parseFileLoc, type TokenLine} from '@glimpse/catalog';
import {useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode} from 'react';
import {
  Drafting, Empty, Icon, PathText, REPORT_CODES, Redline, fmtNum, toNumber, useFollowedFile, useHost, useHostActions, useRev, useSelection, useSize, type GlView,
} from '../../kit/index.ts';
import s from './DiffView.module.css';
import {coerceLine, cx, textCols, TokenSpans, useCapStyle, type CharMarks} from './codekit/lines.tsx';
import k from './codekit/lines.module.css';
import {useFetched} from './codekit/useFetched.ts';
import {VirtualRows, type VirtualRowsHandle} from './codekit/VirtualRows.tsx';

type Status = 'A' | 'M' | 'D' | 'R';
type Mode = 'unified' | 'split';
interface Line { t: ' ' | '+' | '-'; o?: number; n?: number; tokens: TokenLine; marks?: CharMarks; cols: number }
/**
 * `note` is set on a hunk that has no lines: what the host says in place of hunks it left out ('@@ 4,120 more diff
 * lines not shown: the change is too large for one view @@'). It is drawn as a note row, not as a hunk to jump to.
 */
interface Hunk { header: string; lines: Line[]; note?: string }
interface FileEntry { path: string; from?: string; status: Status; add: number; del: number; binary: boolean; hunks?: Hunk[] }
/** `hunk` is the ordinal of the hunk among those that have lines (what j / k step through). */
type Row =
  | {kind: 'hunk'; hunk: number; header: string}
  | {kind: 'line'; hunk: number; line: Line}
  | {kind: 'pair'; hunk: number; left?: Line; right?: Line}
  | {kind: 'note'; text: string};

const STATUS: Record<Status, string> = {A: 'added', M: 'modified', D: 'deleted', R: 'renamed'};
const LINE = 20;
const HUNK = 24;
const FILE_ROW = 28;
const SPLIT_AT = 960;
const STACK_BELOW = 720;
const MINUS = '−';

const lineNumber = (value: unknown): number | undefined => {
  const n = toNumber(value);
  return n !== undefined && n >= 0 ? Math.floor(n) : undefined;
};

/** The text of a line-less hunk's header, without its `@@` fences; undefined when there is nothing to say. */
function noteOf(header: string): string | undefined {
  const text = header.replace(/^@@\s*/, '').replace(/\s*@@$/, '').trim();
  return text === '' ? undefined : text;
}

function readHunks(input: unknown): Hunk[] | undefined {
  if (!Array.isArray(input)) return undefined;
  return input.filter(hunk => hunk && typeof hunk === 'object').map((hunk): Hunk => {
    const header = typeof hunk.header === 'string' ? hunk.header : '@@';
    const lines = readLines(hunk.lines);
    const note = lines.length === 0 ? noteOf(header) : undefined;
    return note === undefined ? {header, lines} : {header, lines, note};
  });
}

function readLines(input: unknown): Line[] {
  return (Array.isArray(input) ? input : []).filter((line: unknown) => line && typeof line === 'object').map((line: any): Line => {
    const tokens = coerceLine(line.tokens);
    const marks = Array.isArray(line.marks)
      ? (line.marks as unknown[]).filter((m): m is [number, number] => Array.isArray(m) && Number.isFinite(m[0]) && Number.isFinite(m[1]))
      : undefined;
    return {
      t: line.t === '+' || line.t === '-' ? line.t : ' ',
      o: lineNumber(line.o),
      n: lineNumber(line.n),
      tokens,
      marks: marks && marks.length > 0 ? marks : undefined,
      cols: tokens.reduce((sum, token) => sum + textCols(token[0]), 0),
    };
  });
}

/** The payload is JSON from the host: keep the files that name a path once, count the rest. */
function readDiff(payload: unknown): {files: FileEntry[]; dropped: number} | undefined {
  const list = (payload as {files?: unknown} | null | undefined)?.files;
  if (!Array.isArray(list)) return undefined;
  const files: FileEntry[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of list) {
    const path = typeof item?.path === 'string' ? item.path : '';
    if (path === '' || seen.has(path)) {
      dropped++;
      continue;
    }
    seen.add(path);
    files.push({
      path,
      from: typeof item.from === 'string' && item.from !== path ? item.from : undefined,
      status: item.status in STATUS ? item.status : 'M',
      add: Math.max(0, toNumber(item.add) ?? 0),
      del: Math.max(0, toNumber(item.del) ?? 0),
      binary: item.binary === true,
      hunks: readHunks(item.hunks),
    });
  }
  return {files, dropped};
}

function buildRows(hunks: Hunk[], mode: Mode): Row[] {
  const rows: Row[] = [];
  let index = -1;
  for (const hunk of hunks) {
    if (hunk.note !== undefined) {
      rows.push({kind: 'note', text: hunk.note});
      continue;
    }
    index++;
    rows.push({kind: 'hunk', hunk: index, header: hunk.header});
    if (mode === 'unified') {
      for (const line of hunk.lines) rows.push({kind: 'line', hunk: index, line});
      continue;
    }
    // Split: a run of removals is set beside the run of additions that follows it, line for line.
    let removed: Line[] = [];
    let added: Line[] = [];
    const at = index;
    const flush = () => {
      for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push({kind: 'pair', hunk: at, left: removed[i], right: added[i]});
      removed = [];
      added = [];
    };
    for (const line of hunk.lines) {
      if (line.t === '-') {
        if (added.length > 0) flush();
        removed.push(line);
      } else if (line.t === '+') added.push(line);
      else {
        flush();
        rows.push({kind: 'pair', hunk: index, left: line, right: line});
      }
    }
    flush();
  }
  return rows;
}

/** `+12 −3`. A zero is not a change: it is printed dim, never in green or red. */
function Delta(p: {add: number; del: number}): ReactNode {
  return (
    <span className={s.delta}>
      <span data-add={p.add > 0 ? '' : undefined}>+{fmtNum(p.add)}</span> <span data-del={p.del > 0 ? '' : undefined}>{MINUS}{fmtNum(p.del)}</span>
    </span>
  );
}

/** What an empty diff says, in the reader's words rather than the range keyword. */
function emptyText(range: string, only: string | undefined): string {
  const what = range === 'wt' ? 'no uncommitted changes' : range === 'staged' ? 'no staged changes' : 'no changes';
  const where = range === 'wt' || range === 'staged' ? '' : ` in ${range}`;
  return only ? `${what} to ${only}${where}` : `${what}${where}`;
}

function StatusChip(p: {status: Status}): ReactNode {
  return <span className={s.status} data-status={p.status} title={STATUS[p.status]} role="img" aria-label={STATUS[p.status]}>{p.status}</span>;
}

export const DiffViewView: GlView<typeof C.DiffView> = ({id, props}) => {
  const host = useHost();
  const rev = useRev();
  const range = typeof props.range === 'string' && props.range.trim() !== '' ? props.range.trim() : 'wt';
  const only = typeof props.file === 'string' && props.file.trim() !== '' ? parseFileLoc(props.file).path : undefined;
  const fetched = useFetched(`${range}\n${only ?? ''}`, rev, signal => host.diff(only ? {range, path: only} : {range}, signal));
  const diff = useMemo(() => (fetched.data === undefined ? undefined : readDiff(fetched.data)), [fetched.data]);

  if (fetched.error) return <Redline code="E_DIFF" id={`DiffView#${id}`} message={`${range}: ${fetched.error}`} />;
  if (fetched.data === undefined) return <Drafting label={`reading diff ${range}`} />;
  if (!diff) return <Redline code="E_SHAPE" id={`DiffView#${id}`} message={`expected a diff {files: [...]}, received ${fetched.data === null ? 'null' : typeof fetched.data}`} />;
  // A clean working tree or an empty range is the truth, not a fault of the spec (decision D14).
  if (diff.files.length === 0) return <Empty message={emptyText(range, only)} code={REPORT_CODES.truthful} />;
  return (
    <DiffPanel
      id={id}
      range={range}
      files={diff.files}
      dropped={diff.dropped}
      given={props.mode}
      boxed={!(typeof props.title === 'string' && props.title !== '')}
      busy={fetched.loading}
    />
  );
};

interface DiffPanelProps {
  id: string;
  range: string;
  /** At least one file. */
  files: FileEntry[];
  dropped: number;
  given: 'auto' | Mode | undefined;
  boxed: boolean;
  busy: boolean;
}

function DiffPanel({id, range, files, dropped, given, boxed, busy}: DiffPanelProps): ReactNode {
  const host = useHost();
  const rev = useRev();
  const {selected, select} = useSelection(id);
  const actions = useHostActions(id);
  const listId = useId();

  // The file on show follows the surface selection when that names a changed file; otherwise it stays where it was.
  const followed = useFollowedFile(undefined);
  const followedPath = followed ? parseFileLoc(followed).path : undefined;
  const [picked, setPicked] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (followedPath && files.some(file => file.path === followedPath)) setPicked(followedPath);
  }, [followedPath, files]);
  const fileIndex = Math.max(0, files.findIndex(entry => entry.path === picked));
  const file = files[fileIndex]!;

  // Files past the payload budget arrive without hunks: ask for that one file.
  const missing = file.hunks === undefined && !file.binary;
  const extra = useFetched(missing ? `${range}\n${file.path}` : undefined, rev, signal => host.diff({range, path: file.path}, signal));
  const hunks = useMemo(() => {
    if (file.hunks) return file.hunks;
    return readDiff(extra.data)?.files.find(entry => entry.path === file.path)?.hunks;
  }, [file, extra.data]);

  const root = useRef<HTMLDivElement | null>(null);
  const pane = useRef<HTMLDivElement | null>(null);
  const probe = useRef<HTMLSpanElement | null>(null);
  const {width} = useSize(root);
  const paneWidth = useSize(pane).width;
  const charWidth = useSize(probe).width / 20 || 7.2;
  const [choice, setChoice] = useState<{given: string | undefined; mode: Mode} | undefined>(undefined);
  const mode: Mode = choice && choice.given === given ? choice.mode : given === 'split' || (given !== 'unified' && width >= SPLIT_AT) ? 'split' : 'unified';

  const rows = useMemo(() => (hunks ? buildRows(hunks, mode) : []), [hunks, mode]);
  const hunkRows = useMemo(() => rows.flatMap((row, index) => (row.kind === 'hunk' ? [index] : [])), [rows]);
  const digits = useMemo(() => {
    let max = 0;
    for (const hunk of hunks ?? []) for (const line of hunk.lines) max = Math.max(max, line.o ?? 0, line.n ?? 0);
    return String(max).length;
  }, [hunks]);
  const capStyle = useCapStyle({'--gl-digits': digits});
  const cols = useMemo(() => {
    let max = 0;
    for (const hunk of hunks ?? []) for (const line of hunk.lines) max = Math.max(max, line.cols);
    return Math.min(max, 2016);
  }, [hunks]);
  // In split mode long lines wrap at a known number of characters (monospace), so row heights need no measuring.
  const perLine = Math.max(8, Math.floor(((paneWidth - 1) / 2 - (digits * charWidth + 22) - 18 - 24) / charWidth));
  const wraps = (line: Line | undefined) => (line ? Math.max(1, Math.ceil(line.cols / perLine)) : 1);
  const rowHeight = (index: number) => {
    const row = rows[index];
    if (!row || row.kind === 'line') return LINE;
    if (row.kind === 'hunk' || row.kind === 'note') return HUNK;
    return LINE * Math.max(wraps(row.left), wraps(row.right));
  };

  const view = useRef<VirtualRowsHandle>(null);
  const list = useRef<VirtualRowsHandle>(null);
  const [activeHunk, setActiveHunk] = useState(0);
  const shownPath = file.path;
  // A different file starts at its first hunk.
  useEffect(() => {
    setActiveHunk(0);
    view.current?.reveal(0, {always: true});
  }, [shownPath]);

  const choose = (index: number) => {
    const next = files[Math.min(files.length - 1, Math.max(0, index))];
    if (!next || next.path === file.path) return;
    setPicked(next.path);
    select({type: 'file', id: next.path, path: next.path});
    list.current?.reveal(files.indexOf(next), {near: true});
  };
  const goHunk = (step: number) => {
    const next = Math.min(hunkRows.length - 1, Math.max(0, activeHunk + step));
    setActiveHunk(next);
    const index = hunkRows[next];
    if (index !== undefined) view.current?.reveal(index, {always: true, smooth: true});
  };
  const selFrom = selected && selected.path === file.path ? Math.floor(toNumber(selected.line) ?? 0) : 0;
  const selTo = selFrom > 0 ? Math.max(selFrom, Math.floor(toNumber(selected?.endLine) ?? selFrom)) : 0;
  const isSelected = (line: Line | undefined) => line?.n !== undefined && selFrom > 0 && line.n >= selFrom && line.n <= selTo;
  // The red pencil marks a file that is selected, or that lies inside a selected directory.
  const marked = (path: string) =>
    selected?.path !== undefined && (selected.path === path || (selected.type === 'dir' && path.startsWith(`${selected.path}/`)));
  const pickLine = (n: number) => select({type: 'file', id: file.path, path: file.path, line: n});

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key) {
      case 'j': goHunk(1); break;
      case 'k': goHunk(-1); break;
      case ']': choose(fileIndex + 1); break;
      case '[': choose(fileIndex - 1); break;
      case 's': setChoice({given, mode: mode === 'split' ? 'unified' : 'split'}); break;
      case 'o': actions.open(formatFileLoc({path: file.path, line: selFrom || undefined})); break;
      case 'c': void navigator.clipboard?.writeText(selFrom ? `${file.path}:${selFrom}` : file.path)?.catch(() => {}); break;
      case 'Escape': if (selected) select(null); break;
      default: return;
    }
    event.preventDefault();
  };
  const onListKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const to = event.key === 'ArrowDown' ? fileIndex + 1 : event.key === 'ArrowUp' ? fileIndex - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? files.length - 1 : undefined;
    if (to === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    choose(to);
  };
  const onFileClick = (event: MouseEvent, index: number) => {
    const target = files[index];
    if (!target) return;
    list.current?.element?.focus({preventScroll: true});
    if (event.metaKey || event.ctrlKey) actions.open(target.path);
    else if (target.path === file.path) select({type: 'file', id: target.path, path: target.path});
    else choose(index);
  };

  const number = (line: Line, value: number | undefined, extra?: string) =>
    value !== undefined && value === line.n ? (
      <button type="button" className={cx(k.num, extra)} tabIndex={-1} aria-label={`Select line ${value}`} onClick={() => pickLine(value)}>{value}</button>
    ) : (
      <span className={cx(k.num, extra)}>{value ?? ''}</span>
    );
  const sign = (line: Line) => (line.t === '+' ? '+' : line.t === '-' ? MINUS : '');
  const side = (line: Line | undefined, which: 'old' | 'new') => {
    if (!line) return <div className={s.blank} data-side={which} />;
    return (
      <div className={k.line} data-diff="split" data-side={which} data-t={line.t === ' ' ? undefined : line.t} data-hl={which === 'new' && isSelected(line) ? '' : undefined}>
        {number(line, which === 'old' ? line.o : line.n)}
        <span className={k.mk}>{sign(line)}</span>
        <span className={k.src}><TokenSpans tokens={line.tokens} marks={line.marks} /></span>
      </div>
    );
  };
  const renderRow = (index: number): ReactNode => {
    const row = rows[index];
    if (!row) return null;
    if (row.kind === 'note') {
      // What the host left out, said in words where the hunks stop: not a hunk, so j / k never land on it.
      return (
        <div className={s.cut} data-gl-diff-note="" role="note" title={row.text}>
          <span className={s.cutText}>{row.text}</span>
        </div>
      );
    }
    if (row.kind === 'hunk') {
      const at = /^(@@[^@]*@@)\s?(.*)$/.exec(row.header);
      return (
        <div className={s.hunk} data-gl-hunk={row.hunk} data-active={row.hunk === activeHunk ? '' : undefined}>
          <span className={s.hunkText}>{at ? at[1] : row.header}{at?.[2] ? <span className={s.hunkContext}> {at[2]}</span> : null}</span>
        </div>
      );
    }
    if (row.kind === 'pair') {
      return (
        <div className={s.pair} style={{height: rowHeight(index)}} data-gl-pair="">
          {side(row.left && row.left.t !== '+' ? row.left : undefined, 'old')}
          {side(row.right && row.right.t !== '-' ? row.right : undefined, 'new')}
        </div>
      );
    }
    const {line} = row;
    return (
      <div className={k.line} data-diff="unified" data-t={line.t === ' ' ? undefined : line.t} data-hl={isSelected(line) ? '' : undefined}>
        {number(line, line.o, s.old)}
        {number(line, line.n, s.new)}
        <span className={k.mk}>{sign(line)}</span>
        <span className={k.src}><TokenSpans tokens={line.tokens} marks={line.marks} /></span>
      </div>
    );
  };

  const multi = files.length > 1;
  const totals = files.reduce((sum, entry) => ({add: sum.add + entry.add, del: sum.del + entry.del}), {add: 0, del: 0});
  const body = file.binary ? (
    // One file of the diff: its state is a part of the view, never the DiffView's own (decision D14, V062).
    <Empty message={`${file.path} is a binary file`} part />
  ) : !hunks ? (
    extra.error ? <Redline code="E_DIFF" id={`DiffView#${id}`} message={`${file.path}: ${extra.error}`} part /> : extra.loading ? <Drafting label={`reading ${file.path}`} part /> : <Empty message={`no hunks for ${file.path}`} part />
  ) : rows.length === 0 ? (
    <Empty message={`no line changes in ${file.path}`} part />
  ) : (
    <VirtualRows
      handle={view}
      role="region"
      aria-label={`Diff of ${file.path}, ${mode}, ${hunkRows.length} ${hunkRows.length === 1 ? 'hunk' : 'hunks'}${rows.some(row => row.kind === 'note') ? ', cut' : ''}`}
      tabIndex={0}
      count={rows.length}
      rowHeight={rowHeight}
      sizeKey={`${file.path}:${mode}:${rows.length}:${mode === 'split' ? perLine : 0}`}
      cols={mode === 'unified' ? cols : undefined}
      colsPad="2 * var(--gl-gutter) + 34px"
    >
      {renderRow}
    </VirtualRows>
  );

  return (
    <div
      ref={root}
      className={cx(k.code, s.diff)}
      data-gl-code="diff"
      data-mode={mode}
      data-fit="cap"
      data-boxed={boxed ? '' : undefined}
      data-stack={width > 0 && width < STACK_BELOW ? '' : undefined}
      data-multi={multi ? '' : undefined}
      aria-busy={busy || undefined}
      style={capStyle}
      onKeyDown={onKeyDown}
    >
      <span ref={probe} className={s.probe} aria-hidden="true">{'0'.repeat(20)}</span>
      {multi ? (
        <div className={s.files}>
          <div className={cx(k.head, s.listHead)}>
            <span className={cx(k.meta, s.listMeta)} title={`${range} · ${fmtNum(files.length)} files`}>
              <span className={s.listRange}>{range}</span>
              <span className={s.listCount}> · {fmtNum(files.length)} files</span>
            </span>
            <Delta add={totals.add} del={totals.del} />
          </div>
          <VirtualRows
            handle={list}
            role="listbox"
            aria-label={`Changed files in ${range}`}
            aria-activedescendant={`${listId}-${fileIndex}`}
            tabIndex={0}
            onKeyDown={onListKey}
            count={files.length}
            rowHeight={FILE_ROW}
          >
            {index => {
              const entry = files[index]!;
              const current = index === fileIndex;
              return (
                <div
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={current}
                  className={s.file}
                  data-path={entry.path}
                  data-current={current ? '' : undefined}
                  data-selected={marked(entry.path) ? '' : undefined}
                  onClick={event => onFileClick(event, index)}
                >
                  <StatusChip status={entry.status} />
                  <span className={s.name}><PathText file={entry.path} /></span>
                  <Delta add={entry.add} del={entry.del} />
                </div>
              );
            }}
          </VirtualRows>
        </div>
      ) : null}
      <div className={s.pane} ref={pane}>
        <div className={k.head}>
          <StatusChip status={file.status} />
          <span className={s.name} data-gl-path={file.path}>
            {file.from ? <span className={s.from}>{file.from} → </span> : null}
            <PathText file={file.path} />
          </span>
          <Delta add={file.add} del={file.del} />
          {multi ? null : <span className={k.meta}>{range}</span>}
          {dropped > 0 ? <span className={k.meta} data-gl-marginal="">{fmtNum(dropped)} malformed dropped</span> : null}
          <span className={k.grow} />
          <span className={s.modes} role="group" aria-label="Layout">
            {(['unified', 'split'] as const).map(option => (
              <button
                key={option}
                type="button"
                className={s.mode}
                tabIndex={-1}
                aria-pressed={mode === option}
                aria-keyshortcuts="s"
                onClick={() => setChoice({given, mode: option})}
              >
                {option}
              </button>
            ))}
          </span>
          <button type="button" className={k.tool} tabIndex={-1} aria-label={`Open ${file.path} in the editor`} aria-keyshortcuts="o" title="Open in editor (o)" onClick={() => actions.open(file.path)}>
            <Icon name="external" />
          </button>
        </div>
        {body}
      </div>
    </div>
  );
};
